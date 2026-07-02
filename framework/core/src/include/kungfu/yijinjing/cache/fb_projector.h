// SPDX-License-Identifier: Apache-2.0
//
// 开放层运行时投影层（薄封装）：FlatBuffers .bfbs 反射 -> 裸 sqlite3 DDL / bind / extract。
// 这是 v4「FB 替 hana/sqlite_orm」的投影一端：取代 sqlite_orm 编译期模板壳（backend.h make_storage_ptr），
// 让开放层类型在运行时（.bfbs）定义表/列/绑定，不重编内核。
//
// 与 hana×sqlite_orm 闭集**并存**：本层只服务 open-layer 运行时类型，绝不进 longfist 闭集路径。
// 验证见 agent-journal/designs/multiagent-infra/flatbuffers-sqlite-projection-spike-report.md（GO）。
#ifndef KUNGFU_YIJINJING_CACHE_FB_PROJECTOR_H
#define KUNGFU_YIJINJING_CACHE_FB_PROJECTOR_H

#include <flatbuffers/reflection.h>
#include <sqlite3.h>
#include <string>
#include <vector>

namespace kungfu::cache::projector {

// reflection BaseType -> SQLite 列类型（对齐 sqlite_orm_ext.h 的映射：
// enum/算术整型 -> INTEGER，float/double -> REAL，string -> TEXT，array/vector/obj -> BLOB）。
inline const char *sqlite_type(reflection::BaseType bt) {
  switch (bt) {
  case reflection::Float:
  case reflection::Double:
    return "REAL";
  case reflection::String:
    return "TEXT";
  case reflection::Vector:
  case reflection::Obj:
    return "BLOB";
  default:
    return "INTEGER"; // bool/byte..ulong/enum
  }
}

inline bool has_attr(const reflection::Field *f, const char *k) {
  return f->attributes() && f->attributes()->LookupByKey(k) != nullptr;
}

struct ColPlan {
  const reflection::Field *field;
  std::string name;
  const char *sqltype;
  bool pk, ts, status;
};

// 反射 root_table -> 列计划。thin=true 仅投影 (pk)/(ts)/(status) 列（瘦索引），其余字段留 journal。
inline std::vector<ColPlan> plan_columns(const reflection::Schema *s, bool thin) {
  std::vector<ColPlan> cols;
  for (auto f : *s->root_table()->fields()) {
    bool pk = has_attr(f, "pk"), ts = has_attr(f, "ts"), st = has_attr(f, "status");
    if (thin && !(pk || ts || st))
      continue;
    cols.push_back({f, f->name()->str(), sqlite_type(f->type()->base_type()), pk, ts, st});
  }
  return cols;
}

// 运行时拼 CREATE TABLE（含复合 PRIMARY KEY；thin 模式追加 journal 坐标列）。
inline std::string create_ddl(const reflection::Schema *s, const std::string &table, bool thin) {
  auto cols = plan_columns(s, thin);
  std::string ddl = "CREATE TABLE IF NOT EXISTS " + table + " (";
  std::vector<std::string> pk;
  for (auto &c : cols) {
    ddl += c.name + " " + c.sqltype + ", ";
    if (c.pk)
      pk.push_back(c.name);
  }
  // 瘦索引的 journal 回环坐标：kf_gen_time 是 reader::seek_to_time 的唯一 seek key，
  // kf_frame_uid 用于 seek 落点后的精确帧匹配，kf_stream_id 用于流过滤。
  // （不存 mmap offset：reader 无按 offset/uid seek 的 API，address() 是进程内绝对地址、持久化无意义。）
  if (thin)
    ddl += "kf_gen_time INTEGER, kf_frame_uid INTEGER, kf_stream_id INTEGER, ";
  ddl += "PRIMARY KEY(";
  for (size_t i = 0; i < pk.size(); ++i)
    ddl += (i ? "," : "") + pk[i];
  ddl += "))";
  return ddl;
}

// 运行时拼 INSERT OR REPLACE 的占位符 SQL。
inline std::string insert_sql(const std::vector<ColPlan> &cols, const std::string &table, bool thin) {
  std::string sql = "INSERT OR REPLACE INTO " + table + " (";
  std::string ph = ") VALUES (";
  size_t n = cols.size();
  for (size_t i = 0; i < n; ++i) {
    sql += (i ? "," : "") + cols[i].name;
    ph += (i ? ",?" : "?");
  }
  if (thin) {
    sql += ",kf_gen_time,kf_frame_uid,kf_stream_id";
    ph += ",?,?,?";
  }
  return sql + ph + ")";
}

// 运行时 bind：对每个投影列，按反射 BaseType 从 buffer 取值 bind（无 codegen）。返回下一个占位索引。
inline int bind_reflect(sqlite3_stmt *st, const reflection::Schema *s, const std::vector<ColPlan> &cols,
                        const uint8_t *buf) {
  const flatbuffers::Table *root = flatbuffers::GetAnyRoot(buf);
  int idx = 1;
  for (auto &c : cols) {
    auto bt = c.field->type()->base_type();
    if (bt == reflection::String) {
      auto sv = flatbuffers::GetAnyFieldS(*root, *c.field, s);
      sqlite3_bind_text(st, idx, sv.c_str(), -1, SQLITE_TRANSIENT);
    } else if (bt == reflection::Float || bt == reflection::Double) {
      sqlite3_bind_double(st, idx, flatbuffers::GetAnyFieldF(*root, *c.field));
    } else {
      sqlite3_bind_int64(st, idx, flatbuffers::GetAnyFieldI(*root, *c.field));
    }
    idx++;
  }
  return idx;
}

// 运行时演进：反射新 schema 列 vs 现有表列，对缺失列发 ALTER TABLE ADD COLUMN。
inline std::vector<std::string> alter_add_missing(sqlite3 *db, const reflection::Schema *s,
                                                  const std::string &table, bool thin) {
  std::vector<std::string> existing;
  sqlite3_stmt *st = nullptr;
  sqlite3_prepare_v2(db, ("PRAGMA table_info(" + table + ")").c_str(), -1, &st, nullptr);
  while (sqlite3_step(st) == SQLITE_ROW)
    existing.push_back(reinterpret_cast<const char *>(sqlite3_column_text(st, 1)));
  sqlite3_finalize(st);
  std::vector<std::string> added;
  for (auto &c : plan_columns(s, thin)) {
    bool found = false;
    for (auto &e : existing)
      if (e == c.name)
        found = true;
    if (!found) {
      std::string sql = "ALTER TABLE " + table + " ADD COLUMN " + c.name + " " + c.sqltype;
      sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
      added.push_back(c.name);
    }
  }
  return added;
}

} // namespace kungfu::cache::projector

#endif // KUNGFU_YIJINJING_CACHE_FB_PROJECTOR_H
