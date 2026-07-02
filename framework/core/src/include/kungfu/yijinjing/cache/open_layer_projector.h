// SPDX-License-Identifier: Apache-2.0
//
// 开放层运行时投影器（生产 reader seam）：把 open-layer FB 帧（msg_type 不在 longfist 闭集）
// 按 .bfbs 运行时反射投影到独立 sqlite db。挂在 `cached::feed()` 上，与 hana×sqlite_orm 闭集**并存**：
//   - feed(event) 只处理已注册的 open-layer msg_type，其余帧一律 no-op（交给 hana 路径），互不干扰；
//   - 默认 OFF：cached 仅在环境变量 KF_OPEN_LAYER_SCHEMAS 指向 schemas 目录时才启用本投影器。
// schemas 来源（本切片口径）：KF_OPEN_LAYER_SCHEMAS 目录下 `manifest.txt`，每行 `msg_type table bfbs_file`
//   （`#` 开头为注释），逐行 own .bfbs 字节注册进 SchemaRegistry。真正配置格式待后续定。
//
// **批量/异步（镜像 cached 后台 worker 模式）**：feed() 不在 reader 热路径上同步写 sqlite——只把帧字节
// **拷贝**进内存缓冲（journal mmap page 会被回收，故必须拷出，不能存 mmap 指针）；后台 worker 线程定时
// 把缓冲在**一个事务**里批量投影。flush()/pending_count() 显式暴露供确定性测试与收尾；dtor 收尾 flush。
// 生命周期：own SchemaRegistry(own .bfbs 字节) + own sqlite3 db + own worker 线程。
#ifndef KUNGFU_YIJINJING_CACHE_OPEN_LAYER_PROJECTOR_H
#define KUNGFU_YIJINJING_CACHE_OPEN_LAYER_PROJECTOR_H

#include <kungfu/common.h>
#include <kungfu/yijinjing/cache/fb_schema_registry.h>

#include <flatbuffers/util.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace kungfu::cache {

class open_layer_projector {
public:
  open_layer_projector() = default;
  ~open_layer_projector() {
    stop_worker(); // 收尾：停 worker 并 join
    try {
      flush(); // 最终批量 flush，确保 buffer 落盘
    } catch (...) {
    }
    if (db_ != nullptr)
      sqlite3_close(db_);
  }
  open_layer_projector(const open_layer_projector &) = delete;
  open_layer_projector &operator=(const open_layer_projector &) = delete;

  // 从 schemas_dir/manifest.txt 注册全部开放层类型，open db_path、reconcile 建表。返回注册类型数。
  // 不启动 worker —— 由调用方按需 start_worker()，便于测试用纯同步 flush()。
  size_t setup(const std::string &schemas_dir, const std::string &db_path) {
    if (sqlite3_open(db_path.c_str(), &db_) != SQLITE_OK)
      throw std::runtime_error("open_layer_projector: cannot open db " + db_path);
    sqlite3_exec(db_, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;", nullptr, nullptr, nullptr);

    const std::string manifest = schemas_dir + "/manifest.txt";
    std::ifstream mf(manifest);
    if (!mf)
      throw std::runtime_error("open_layer_projector: no manifest at " + manifest);
    std::string line;
    while (std::getline(mf, line)) {
      size_t b = line.find_first_not_of(" \t\r\n");
      if (b == std::string::npos || line[b] == '#')
        continue; // 空行 / 注释
      std::istringstream iss(line.substr(b));
      int32_t msg_type = 0;
      std::string table, bfbs_file;
      if (!(iss >> msg_type >> table >> bfbs_file))
        continue;
      std::string bfbs;
      if (!flatbuffers::LoadFile((schemas_dir + "/" + bfbs_file).c_str(), /*binary*/ true, &bfbs))
        throw std::runtime_error("open_layer_projector: cannot read bfbs " + bfbs_file);
      registry_.add(msg_type, table, std::move(bfbs), /*thin*/ true);
    }
    registry_.reconcile_all(db_);
    return registry_.size();
  }

  // 投影一帧：已注册 msg_type -> **拷贝帧字节进内存缓冲**（不碰 sqlite，不在 reader 热路径上同步写）；
  // 未注册 -> no-op（留给 hana 路径）。返回是否纳入缓冲。
  bool feed(const event_ptr &event) {
    if (registry_.find(event->msg_type()) == nullptr)
      return false;
    pending p;
    p.msg_type = event->msg_type();
    p.gen_time = event->gen_time();
    p.frame_uid = event->frame_uid();
    p.stream_id = event->stream_id();
    p.payload.assign(reinterpret_cast<const char *>(event->data_address()), event->data_length());
    std::lock_guard<std::mutex> lk(buf_mtx_);
    buffer_.push_back(std::move(p));
    return true;
  }

  // 把内存缓冲在一个事务里批量投影入库。返回本次投影帧数。worker 与显式调用经 flush_mtx_ 串行化。
  size_t flush() {
    std::vector<pending> batch;
    {
      std::lock_guard<std::mutex> lk(buf_mtx_);
      batch.swap(buffer_);
    }
    if (batch.empty())
      return 0;
    std::lock_guard<std::mutex> lk(flush_mtx_); // 串行化 db_ 访问（worker vs 显式 flush）
    sqlite3_exec(db_, "BEGIN", nullptr, nullptr, nullptr);
    for (auto &p : batch) {
      const auto *entry = registry_.find(p.msg_type);
      if (entry == nullptr)
        continue;
      projector::project_frame(db_, *entry, reinterpret_cast<const uint8_t *>(p.payload.data()), p.gen_time,
                               p.frame_uid, p.stream_id);
    }
    sqlite3_exec(db_, "COMMIT", nullptr, nullptr, nullptr);
    return batch.size();
  }

  // 启动后台 flush worker（生产异步模式）。幂等：已启动则忽略。
  void start_worker(int64_t interval_ms = 100) {
    if (worker_running_.exchange(true))
      return;
    quit_ = false;
    worker_ = std::thread([this, interval_ms]() {
      while (!quit_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
        try {
          flush();
        } catch (...) {
        }
      }
    });
  }

  void stop_worker() {
    if (!worker_running_.load())
      return;
    quit_ = true;
    if (worker_.joinable())
      worker_.join();
    worker_running_ = false;
  }

  [[nodiscard]] size_t pending_count() {
    std::lock_guard<std::mutex> lk(buf_mtx_);
    return buffer_.size();
  }

  [[nodiscard]] const projector::SchemaRegistry &registry() const { return registry_; }
  [[nodiscard]] sqlite3 *db() const { return db_; }

private:
  // 缓冲一帧：拷出 FB 字节 + journal 坐标（journal mmap 帧之后会被回收，故必须拷贝）。
  struct pending {
    int32_t msg_type = 0;
    int64_t gen_time = 0;
    uint64_t frame_uid = 0;
    uint64_t stream_id = 0;
    std::string payload;
  };

  projector::SchemaRegistry registry_;
  sqlite3 *db_ = nullptr;
  std::vector<pending> buffer_;
  std::mutex buf_mtx_;   // 保护 buffer_（feed push / flush swap）
  std::mutex flush_mtx_; // 串行化 db_ 批量写
  std::thread worker_;
  std::atomic<bool> worker_running_{false};
  std::atomic<bool> quit_{false};
};

DECLARE_PTR(open_layer_projector)
} // namespace kungfu::cache

#endif // KUNGFU_YIJINJING_CACHE_OPEN_LAYER_PROJECTOR_H
