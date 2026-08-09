// SPDX-License-Identifier: Apache-2.0
//
// 开放层运行时 schema 注册表（view 层之上的有状态层）。
// 职责：
//   1. **绑定 .bfbs 生命周期** —— 每个类型持一个 kungfu::view::schema_handle,
//      handle 共有(shared_ptr)自己的 .bfbs 字节、私有持有 reflection 视图,
//      二者生命周期天然绑定；不再有裸反射 Schema 指针可悬垂（KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc）。
//      Step 2 spike 实测的 .bfbs 悬垂坑在类型层已不可表达。
//   2. **多类型按 carrier_type 路由** —— 每个开放层类型用一个保留的 open-layer carrier_type(>0) 注册；
//      reader 读到帧后凭 carrier_type 找到对应 schema/表，运行时新增类型不重编内核。
//   3. **缓存反射计划** —— 列计划 / CREATE DDL / INSERT SQL 注册时算一次，避免逐帧重反射。
//
// 与 hana×sqlite_orm 闭集**并存**：只服务 open-layer 运行时类型，绝不进 schema 闭集/热路径。
// 本头不含任何 flatbuffers/reflection 符号——全部收进 kungfu::view（KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc 门禁）。
#ifndef KUNGFU_RUNTIME_PROJECTION_FLATBUFFER_SCHEMA_REGISTRY_H
#define KUNGFU_RUNTIME_PROJECTION_FLATBUFFER_SCHEMA_REGISTRY_H

#include <kungfu/runtime/common.h>

#include <kungfu/view/schema.h>

#include <cstdint>
#include <map>
#include <optional>
#include <sqlite3.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace kungfu::runtime::projection::flatbuffer {

class SchemaRegistry {
public:
  // 一个已注册的开放层类型。schema_handle 共有并保活自己的 .bfbs 字节,
  // 列计划/DDL/SQL 注册时算一次缓存。
  struct Entry {
    int32_t carrier_type = 0;
    std::string table;
    kungfu::view::schema_handle handle; // 共有 .bfbs 字节 + 私有反射视图（无裸 Schema* 外发）
    bool thin = false;
    std::vector<kungfu::view::col_plan> cols; // 缓存列计划（thin: pk/ts/status；full: 全列）
    std::string create_ddl;                   // 缓存 CREATE TABLE
    std::string insert_sql;                   // 缓存 INSERT OR REPLACE 占位 SQL
  };

  // 注册一个开放层类型；bfbs_bytes 被 move 进 handle 并验证。重复 carrier_type 抛错。返回稳定 Entry 引用。
  const Entry &add(int32_t carrier_type, std::string table, std::string bfbs_bytes, bool thin) {
    auto [it, ok] = entries_.try_emplace(carrier_type); // map node 地址稳定：find() 返回的 Entry* 恒定
    if (!ok)
      throw std::runtime_error("SchemaRegistry: duplicate carrier_type " + std::to_string(carrier_type));
    Entry &e = it->second;
    e.carrier_type = carrier_type;
    e.table = std::move(table);
    e.handle = kungfu::view::schema_handle::from_bytes(std::move(bfbs_bytes));
    e.thin = thin;
    e.cols = e.handle.plan_columns(thin);
    e.create_ddl = kungfu::view::create_ddl(e.cols, e.table, thin);
    e.insert_sql = kungfu::view::insert_sql(e.cols, e.table, thin);
    return e;
  }

  // 演进已注册类型到新 .bfbs（FB 兼容规则：字段尾部追加、不重排/删 id）。handle 释放旧字节、接管并验证
  // 新字节；刷新缓存列计划。Entry 地址不变（map node 稳定）。表结构经 reconcile_all 跟上。
  const Entry &evolve(int32_t carrier_type, std::string new_bfbs) {
    auto it = entries_.find(carrier_type);
    if (it == entries_.end())
      throw std::runtime_error("SchemaRegistry: evolve unknown carrier_type " + std::to_string(carrier_type));
    Entry &e = it->second;
    e.handle.evolve(std::move(new_bfbs)); // 验证 + 换字节；旧视图随旧字节释放而作废
    e.cols = e.handle.plan_columns(e.thin);
    e.create_ddl = kungfu::view::create_ddl(e.cols, e.table, e.thin);
    e.insert_sql = kungfu::view::insert_sql(e.cols, e.table, e.thin);
    return e;
  }

  // 凭 carrier_type 路由到已注册类型；未注册返回 nullptr。
  [[nodiscard]] const Entry *find(int32_t carrier_type) const {
    auto it = entries_.find(carrier_type);
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
      kungfu::view::alter_add_missing(db, kv.second.cols, kv.second.table);
    }
  }

private:
  std::map<int32_t, Entry> entries_; // node 稳定：find() 返回的 Entry* 地址恒定
};

// 把一帧零拷贝投影入库：经 handle 反射 bind 业务列；thin 模式追加 journal 回环坐标
// (kf_gen_time/kf_frame_uid/kf_stream_id)，列序与 kungfu::view::insert_sql 一致。
// 把一帧零拷贝投影入库：handle.bind_frame 先按 schema verify 再 bind 业务列，坏帧(verify 失败)
// 直接跳过、不入库并返回 false；thin 模式追加 journal 回环坐标。返回是否成功投影。
[[nodiscard]] inline bool project_frame(sqlite3 *db, const SchemaRegistry::Entry &e, const uint8_t *buf, size_t len,
                                        int64_t gen_time, uint64_t frame_uid, uint64_t stream_id) {
  sqlite3_stmt *ins = nullptr;
  sqlite3_prepare_v2(db, e.insert_sql.c_str(), -1, &ins, nullptr);
  const std::optional<int> next = e.handle.bind_frame(ins, e.cols, buf, len);
  if (!next) { // 坏/截断 buffer：一列都不 bind，跳过该帧
    sqlite3_finalize(ins);
    return false;
  }
  if (e.thin) {
    sqlite3_bind_int64(ins, *next, gen_time);
    sqlite3_bind_int64(ins, *next + 1, static_cast<int64_t>(frame_uid));
    sqlite3_bind_int64(ins, *next + 2, static_cast<int64_t>(stream_id));
  }
  sqlite3_step(ins);
  sqlite3_finalize(ins);
  return true;
}

} // namespace kungfu::runtime::projection::flatbuffer

#endif // KUNGFU_RUNTIME_PROJECTION_FLATBUFFER_SCHEMA_REGISTRY_H
