// SPDX-License-Identifier: Apache-2.0
//
// 开放层运行时 schema 注册表（投影层之上的有状态层）。
// 职责：
//   1. **own .bfbs 字节** —— reflection::GetSchema 返回的是 .bfbs 缓冲区的视图（不拷贝）；
//      若 .bfbs 字节先于 Schema* 析构 -> use-after-free。注册表把字节 move 进稳定 node 后再取视图，
//      令 schema 与其字节生命周期绑定（Step 2 spike 实测过的真实坑）。
//   2. **多类型按 msg_type 路由** —— 每个开放层类型用一个保留的 open-layer msg_type(>0) 注册；
//      reader 读到帧后凭 msg_type 找到对应 schema/表，运行时新增类型不重编内核。
//   3. **缓存反射计划** —— 列计划 / CREATE DDL / INSERT SQL 注册时算一次，避免逐帧重反射。
//
// 与 hana×sqlite_orm 闭集**并存**：只服务 open-layer 运行时类型，绝不进 longfist 闭集/热路径。
#ifndef KUNGFU_YIJINJING_CACHE_FB_SCHEMA_REGISTRY_H
#define KUNGFU_YIJINJING_CACHE_FB_SCHEMA_REGISTRY_H

#include <kungfu/yijinjing/cache/fb_projector.h>

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace kungfu::cache::projector {

class SchemaRegistry {
public:
  // 一个已注册的开放层类型。schema 是 bfbs 的视图，二者生命周期绑定 -> Entry 禁拷贝、地址恒定。
  struct Entry {
    int32_t msg_type = 0;
    std::string table;
    std::string bfbs;                            // 接管的 .bfbs 字节（真相所有者）
    const reflection::Schema *schema = nullptr;  // bfbs 的视图
    bool thin = false;
    std::vector<ColPlan> cols;                   // 缓存列计划（thin: pk/ts/status；full: 全列）
    std::string create_ddl;                      // 缓存 CREATE TABLE
    std::string insert_sql;                      // 缓存 INSERT OR REPLACE 占位 SQL

    Entry() = default;
    Entry(const Entry &) = delete;               // schema 视图绑定本 Entry 的 bfbs，禁拷贝防悬垂
    Entry &operator=(const Entry &) = delete;
  };

  // 注册一个开放层类型；bfbs_bytes 被 move 接管。重复 msg_type 抛错。返回稳定 Entry 引用。
  const Entry &add(int32_t msg_type, std::string table, std::string bfbs_bytes, bool thin) {
    auto [it, ok] = entries_.try_emplace(msg_type); // map node 地址稳定
    if (!ok)
      throw std::runtime_error("SchemaRegistry: duplicate msg_type " + std::to_string(msg_type));
    Entry &e = it->second;
    e.msg_type = msg_type;
    e.table = std::move(table);
    e.bfbs = std::move(bfbs_bytes);
    e.thin = thin;
    // 关键：Entry 已落入 map 稳定 node、bfbs 已就位后再取视图，schema 指向最终内存（不受 SSO/move 影响）。
    e.schema = reflection::GetSchema(e.bfbs.c_str());
    e.cols = plan_columns(e.schema, thin);
    e.create_ddl = projector::create_ddl(e.schema, e.table, thin);
    e.insert_sql = projector::insert_sql(e.cols, e.table, thin);
    return e;
  }

  // 演进已注册类型到新 .bfbs（FB 兼容规则：字段尾部追加、不重排/删 id）。接管新字节、刷新
  // 视图与缓存计划；Entry 地址不变（map node 稳定），但旧 schema 视图随旧字节释放而失效——
  // 注册表是单一所有者，外部不得跨 evolve 缓存裸 schema 指针。表结构经 reconcile_all 跟上。
  const Entry &evolve(int32_t msg_type, std::string new_bfbs) {
    auto it = entries_.find(msg_type);
    if (it == entries_.end())
      throw std::runtime_error("SchemaRegistry: evolve unknown msg_type " + std::to_string(msg_type));
    Entry &e = it->second;
    e.bfbs = std::move(new_bfbs); // 释放旧字节、接管新字节（Entry 地址不变）
    e.schema = reflection::GetSchema(e.bfbs.c_str());
    e.cols = plan_columns(e.schema, e.thin);
    e.create_ddl = projector::create_ddl(e.schema, e.table, e.thin);
    e.insert_sql = projector::insert_sql(e.cols, e.table, e.thin);
    return e;
  }

  // 凭 msg_type 路由到已注册类型；未注册返回 nullptr。
  [[nodiscard]] const Entry *find(int32_t msg_type) const {
    auto it = entries_.find(msg_type);
    return it == entries_.end() ? nullptr : &it->second;
  }

  [[nodiscard]] size_t size() const { return entries_.size(); }

  // 对所有已注册类型建表（幂等 CREATE TABLE IF NOT EXISTS）。
  void create_all(sqlite3 *db) const {
    for (auto &kv : entries_)
      sqlite3_exec(db, kv.second.create_ddl.c_str(), nullptr, nullptr, nullptr);
  }

  // 生产形态的 startup/演进调用：对所有已注册类型幂等建表 + 对演进新增的可查询列 ALTER ADD COLUMN。
  // 既适用首次建表，也适用 evolve 后让既有表结构跟上新 schema（旧行新列取 NULL）。
  void reconcile_all(sqlite3 *db) const {
    for (auto &kv : entries_) {
      sqlite3_exec(db, kv.second.create_ddl.c_str(), nullptr, nullptr, nullptr);
      projector::alter_add_missing(db, kv.second.schema, kv.second.table, kv.second.thin);
    }
  }

private:
  std::map<int32_t, Entry> entries_; // node 稳定：Entry 地址恒定 -> bfbs/schema 视图安全
};

// 把一帧零拷贝投影入库：反射 bind 业务列；thin 模式追加 journal 回环坐标
// (kf_gen_time/kf_frame_uid/kf_stream_id)，列序与 fb_projector::insert_sql 一致。
inline void project_frame(sqlite3 *db, const SchemaRegistry::Entry &e, const uint8_t *buf, int64_t gen_time,
                          uint64_t frame_uid, uint64_t stream_id) {
  sqlite3_stmt *ins = nullptr;
  sqlite3_prepare_v2(db, e.insert_sql.c_str(), -1, &ins, nullptr);
  int next = bind_reflect(ins, e.schema, e.cols, buf);
  if (e.thin) {
    sqlite3_bind_int64(ins, next, gen_time);
    sqlite3_bind_int64(ins, next + 1, static_cast<int64_t>(frame_uid));
    sqlite3_bind_int64(ins, next + 2, static_cast<int64_t>(stream_id));
  }
  sqlite3_step(ins);
  sqlite3_finalize(ins);
}

} // namespace kungfu::cache::projector

#endif // KUNGFU_YIJINJING_CACHE_FB_SCHEMA_REGISTRY_H
