// SPDX-License-Identifier: Apache-2.0
//
// kungfu::view implementation — the ONLY translation unit in kungfu that names
// `flatbuffers::` / `reflection::` (ADR-0039): the open-layer reflection path
// (regime 2) and the `.fbs` -> `.bfbs` compile entry both live behind this file;
// the header exposes only reflection-free types.
#include <kungfu/view/schema.h>

#include <flatbuffers/idl.h> // Parser for the .fbs -> .bfbs compile entry
#include <flatbuffers/reflection.h>
#include <flatbuffers/util.h> // LoadFile for the .bfbs import boundary
#include <sqlite3.h>

#include <stdexcept>

namespace kungfu::view {

namespace {

// reflection BaseType -> SQLite column type (kept identical to the retired
// projector::sqlite_type: enum/integral -> INTEGER, float/double -> REAL,
// string -> TEXT, array/vector/obj -> BLOB).
const char *sqlite_type(reflection::BaseType bt) {
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

bind_kind kind_of(reflection::BaseType bt) {
  if (bt == reflection::String)
    return bind_kind::as_text;
  if (bt == reflection::Float || bt == reflection::Double)
    return bind_kind::as_double;
  return bind_kind::as_int;
}

bool has_attr(const reflection::Field *f, const char *k) {
  return f->attributes() && f->attributes()->LookupByKey(k) != nullptr;
}

// Resolve the private reflection view from the co-owned bytes. GetSchema is a
// single root-pointer read over an already-verified buffer; the returned pointer
// is valid only while `bytes` (co-owned by the handle) lives, and never escapes
// this file.
const reflection::Schema *schema_of(const std::string &bytes) { return reflection::GetSchema(bytes.c_str()); }

} // namespace

schema_handle schema_handle::from_bytes(std::string bfbs) {
  flatbuffers::Verifier v(reinterpret_cast<const uint8_t *>(bfbs.data()), bfbs.size());
  if (!reflection::VerifySchemaBuffer(v))
    throw std::runtime_error("kungfu::view: malformed .bfbs reflection schema buffer");
  // VerifySchemaBuffer still accepts a structurally-valid schema that declares no
  // root_type (root_table() == nullptr) — reflection makes root_type optional.
  // The whole access path (plan_columns / bind_frame / verify_table) reflects
  // through the root table on every call, so a rootless schema would otherwise
  // drive a null-pointer member read downstream. Reject it here at the sole load
  // boundary so every live handle guarantees a non-null root table (ADR-0039
  // spatial safety). Object.fields / Field.name / Field.type are `required` in
  // reflection.fbs, so the verifier already guarantees those once the root exists.
  const reflection::Schema *s = schema_of(bfbs);
  if (s == nullptr || s->root_table() == nullptr)
    throw std::runtime_error("kungfu::view: .bfbs reflection schema declares no root_type");
  schema_handle h;
  h.bfbs_ = std::make_shared<const std::string>(std::move(bfbs));
  return h;
}

schema_handle schema_handle::load_file(const std::string &path) {
  std::string bfbs;
  if (!flatbuffers::LoadFile(path.c_str(), /*binary*/ true, &bfbs))
    throw std::runtime_error("kungfu::view: cannot read .bfbs file " + path);
  return from_bytes(std::move(bfbs));
}

void schema_handle::evolve(std::string new_bfbs) {
  // Verify then swap. shared_ptr assignment releases the old bytes once no
  // outstanding handle copy references them; a plan cached against the old
  // schema must be re-planned by the caller (the registry does this).
  *this = from_bytes(std::move(new_bfbs));
}

std::vector<col_plan> schema_handle::plan_columns(bool thin) const {
  std::vector<col_plan> cols;
  if (!bfbs_)
    return cols;
  const reflection::Schema *s = schema_of(*bfbs_);
  const auto *fields = s->root_table()->fields();
  for (uint16_t i = 0; i < fields->size(); ++i) {
    const reflection::Field *f = fields->Get(i);
    bool pk = has_attr(f, "pk"), ts = has_attr(f, "ts"), st = has_attr(f, "status");
    if (thin && !(pk || ts || st))
      continue;
    const auto bt = f->type()->base_type();
    cols.push_back({f->name()->str(), sqlite_type(bt), pk, ts, st, i, kind_of(bt)});
  }
  return cols;
}

std::optional<int> schema_handle::bind_frame(sqlite3_stmt *st, const std::vector<col_plan> &cols, const uint8_t *buf,
                                             size_t len) const {
  // Bounds-check the whole table graph against the schema before any field
  // access — a malformed/truncated frame is skipped, never dereferenced.
  if (!verify_table(buf, len))
    return std::nullopt;
  const reflection::Schema *s = schema_of(*bfbs_);
  const auto *fields = s->root_table()->fields();
  const flatbuffers::Table *root = flatbuffers::GetAnyRoot(buf);
  int idx = 1;
  for (const auto &c : cols) {
    // Spatial safety: a col_plan cached against a larger/older schema (e.g. one
    // planned before an evolve() shrank the field set) can carry a field_index
    // past the current schema's fields. Bounds-check before fields->Get so the
    // sole FB access path never issues an unchecked out-of-range reflection read
    // (ADR-0039). A stale plan can't bind this frame correctly, so skip it whole,
    // like a failed verify.
    if (c.field_index >= fields->size())
      return std::nullopt;
    const reflection::Field *f = fields->Get(c.field_index);
    switch (c.kind) {
    case bind_kind::as_text: {
      auto sv = flatbuffers::GetAnyFieldS(*root, *f, s);
      sqlite3_bind_text(st, idx, sv.c_str(), -1, SQLITE_TRANSIENT);
      break;
    }
    case bind_kind::as_double:
      sqlite3_bind_double(st, idx, flatbuffers::GetAnyFieldF(*root, *f));
      break;
    case bind_kind::as_int:
      sqlite3_bind_int64(st, idx, flatbuffers::GetAnyFieldI(*root, *f));
      break;
    }
    ++idx;
  }
  return idx;
}

bool schema_handle::verify_table(const uint8_t *buf, size_t len) const {
  if (!bfbs_ || buf == nullptr)
    return false;
  const reflection::Schema *s = schema_of(*bfbs_);
  // reflection Verify constructs its own Verifier over (buf, len); no separate
  // flatbuffers::Verifier needed here.
  return flatbuffers::Verify(*s, *s->root_table(), buf, len);
}

std::string create_ddl(const std::vector<col_plan> &cols, std::string_view table, bool thin) {
  std::string ddl = "CREATE TABLE IF NOT EXISTS " + std::string(table) + " (";
  std::vector<std::string> pk;
  for (const auto &c : cols) {
    ddl += c.name + " " + c.sqltype + ", ";
    if (c.pk)
      pk.push_back(c.name);
  }
  // Thin rows carry the journal loop-back coordinates: kf_gen_time is the sole
  // seek key for reader::seek_to_time, kf_frame_uid pins the exact frame after
  // the seek, kf_stream_id filters the stream. (No mmap offset: the reader has
  // no seek-by-offset API and address() is a process-local pointer.)
  if (thin)
    ddl += "kf_gen_time INTEGER, kf_frame_uid INTEGER, kf_stream_id INTEGER, ";
  ddl += "PRIMARY KEY(";
  for (size_t i = 0; i < pk.size(); ++i)
    ddl += (i ? "," : "") + pk[i];
  ddl += "))";
  return ddl;
}

std::string insert_sql(const std::vector<col_plan> &cols, std::string_view table, bool thin) {
  std::string sql = "INSERT OR REPLACE INTO " + std::string(table) + " (";
  std::string ph = ") VALUES (";
  const size_t n = cols.size();
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

std::vector<std::string> alter_add_missing(sqlite3 *db, const std::vector<col_plan> &cols, std::string_view table) {
  const std::string tbl(table);
  std::vector<std::string> existing;
  sqlite3_stmt *st = nullptr;
  sqlite3_prepare_v2(db, ("PRAGMA table_info(" + tbl + ")").c_str(), -1, &st, nullptr);
  while (sqlite3_step(st) == SQLITE_ROW) {
    // PRAGMA table_info.name is never NULL in practice, but guard the cast so a
    // NULL text column can never construct std::string(nullptr) (UB).
    const auto *name = sqlite3_column_text(st, 1);
    if (name != nullptr)
      existing.push_back(reinterpret_cast<const char *>(name));
  }
  sqlite3_finalize(st);
  std::vector<std::string> added;
  for (const auto &c : cols) {
    bool found = false;
    for (const auto &e : existing)
      if (e == c.name)
        found = true;
    if (!found) {
      std::string sql = "ALTER TABLE " + tbl + " ADD COLUMN " + c.name + " " + c.sqltype;
      sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
      added.push_back(c.name);
    }
  }
  return added;
}

compiled_schema compile_schema(std::string_view fbs_text, bool allow_includes) {
  compiled_schema out;
  // In-memory compile against the already-linked FlatBuffers library. With no
  // include directories provided, a schema that pulls in other files fails to
  // resolve — the safe default for the in-process open-layer path.
  flatbuffers::IDLOptions idl_opts;
  flatbuffers::Parser parser(idl_opts);
  const char *no_includes[] = {nullptr};
  if (!parser.Parse(std::string(fbs_text).c_str(), allow_includes ? nullptr : no_includes)) {
    out.error = parser.error_;
    return out;
  }
  parser.Serialize(); // parsed schema -> reflection binary (.bfbs)
  const auto *buf = reinterpret_cast<const char *>(parser.builder_.GetBufferPointer());
  out.bfbs.assign(buf, parser.builder_.GetSize());
  out.ok = true;
  return out;
}

} // namespace kungfu::view
