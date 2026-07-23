// SPDX-License-Identifier: Apache-2.0
//
// kungfu::view regime 2 — the sole FlatBuffers reflection access point (KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc).
//
// The zero-copy hazard lives entirely in borrow-heavy reflection: a
// `reflection::Schema *` / `GetAnyRoot` table / `GetAnyFieldS` result points
// *into* a backing buffer (the `.bfbs` bytes) that must outlive it. In C++
// nothing ties a bare view's lifetime to its buffer, so a registry that dropped
// the `.bfbs` bytes early left the schema pointer dangling — the real bug that
// motivated this ADR.
//
// `schema_handle` makes that bug structurally unrepresentable: it **co-owns the
// `.bfbs` bytes** (shared_ptr, so a copy handed across the binding boundary keeps
// the buffer alive) and the `reflection::Schema *` view is a private
// implementation detail resolved inside schema.cpp — it is never handed out. No
// header here includes `<flatbuffers/reflection.h>`; the entire `flatbuffers::` /
// `reflection::` surface is confined to schema.cpp. `col_plan` is deliberately
// reflection-free (a `field_index` + a `bind_kind`, not a bare `reflection::Field
// *`) so callers can cache a plan without holding a view.
//
// Untrusted `.bfbs` input runs `flatbuffers::Verifier` (VerifySchemaBuffer) at
// the load boundary before any access — spatial safety at the same chokepoint as
// temporal safety.
#ifndef KUNGFU_VIEW_SCHEMA_H
#define KUNGFU_VIEW_SCHEMA_H

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// C structs, forward-declared so this header pulls in neither sqlite3.h nor any
// FlatBuffers header. reflection::Schema is not even named here — it is resolved
// privately from the co-owned bytes inside schema.cpp.
struct sqlite3;
struct sqlite3_stmt;

namespace kungfu::view {

// How a projected column binds to SQLite, decided once at plan time from the
// reflection BaseType so bind_frame() needs no reflection enum in this header.
enum class bind_kind : uint8_t { as_int, as_double, as_text };

// A reflection-free projection plan for one column. `field_index` is the
// absolute position in the schema's root-table field vector; schema_handle
// re-resolves the field from its co-owned schema at bind time. Holds no bare
// reflection pointer, so it is safe to cache across frames.
struct col_plan {
  std::string name;
  const char *sqltype; // static string literal ("INTEGER"/"REAL"/"TEXT"/"BLOB")
  bool pk = false;
  bool ts = false;
  bool status = false;
  uint16_t field_index = 0;
  bind_kind kind = bind_kind::as_int;
};

struct table_codec_result {
  bool ok = false;
  std::string bytes;
  std::string json;
  std::string error;
};

// Owning handle over a `.bfbs` reflection schema: the only way to reach
// FlatBuffers reflection in kungfu C++. Copyable and movable — copies share the
// co-owned bytes, so a handle can outlive the caller (e.g. crossing the binding
// boundary) without dangling.
class schema_handle {
public:
  schema_handle() = default;

  // Take ownership of already-in-hand `.bfbs` bytes (e.g. freshly compiled).
  // Runs VerifySchemaBuffer; throws std::runtime_error on a malformed buffer.
  static schema_handle from_bytes(std::string bfbs);

  // Read a `.bfbs` file from disk (an untrusted import boundary) and verify it.
  // Throws std::runtime_error if the file cannot be read or fails verification.
  static schema_handle load_file(const std::string &path);

  // Replace the backing bytes with an evolved `.bfbs` (FlatBuffers-compatible
  // evolution). The old bytes are released; any col_plan cached against the old
  // schema must be re-planned. Throws on a malformed buffer.
  void evolve(std::string new_bfbs);

  [[nodiscard]] bool valid() const noexcept { return static_cast<bool>(bfbs_); }

  // Reflect the root table into a column plan. thin=true projects only
  // (pk)/(ts)/(status)-attributed columns (the thin index); full projects all.
  [[nodiscard]] std::vector<col_plan> plan_columns(bool thin) const;

  // Verify then bind one frame's projected columns into a prepared statement.
  // `buf`/`len` delimit the FlatBuffers table buffer; this runs
  // flatbuffers::Verify against the schema *before* any field access, so a
  // malformed or truncated frame cannot drive an out-of-bounds reflection read
  // (spatial safety at the access boundary, not left to the caller). On a
  // buffer that fails verification returns std::nullopt and binds nothing; on
  // success reflects each field by BaseType and returns the next 1-based
  // placeholder index. This is the only way to read a frame through the handle;
  // there is no unchecked variant (the open-layer projection path is cold, so
  // per-frame verification is negligible next to the SQLite write).
  [[nodiscard]] std::optional<int> bind_frame(sqlite3_stmt *st, const std::vector<col_plan> &cols, const uint8_t *buf,
                                              size_t len) const;

  // Verify a data FlatBuffers table buffer against this schema (bounds-check the
  // whole table graph). With an empty object_name the declared root_type is
  // used; otherwise the named table (qualified or unique suffix) is selected,
  // which is required for action manifests that bind several tables from one
  // `.bfbs`. bind_frame runs the root-table form internally.
  [[nodiscard]] bool verify_table(const uint8_t *buf, size_t len, std::string_view object_name = {}) const;

  // Encode/decode one root table through this co-owned reflection schema.
  // This keeps generic FlatBuffers JSON translation behind the same KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc
  // chokepoint as compile/verify/reflection. JSON is an edge form only; the
  // returned bytes remain the persisted schema-owned payload.
  [[nodiscard]] table_codec_result encode_json(std::string_view json) const;

  // KF-ADR-019f86da-4f90-7499-9152-520599d089ae Decision 3: `enum_as_int` renders enum fields as their underlying
  // integer instead of the schema identifier. The default (false) keeps the
  // identifier form the domain-runtime decode_json consumers already rely on;
  // the generic membrane decode primitive (decode_flatbuffer_payload_json) opts
  // into the integer form so it matches the three reflection decoders
  // (Python BundleDecoder, TS ReflectionDecoder, the generated accessors).
  // `object_name` decodes a specific table instead of the .bfbs root_type,
  // resolved through the same suffix-tolerant lookup as verify_table; empty
  // means the root table (the existing single-root consumers).
  [[nodiscard]] table_codec_result decode_json(const uint8_t *buf, size_t len, bool enum_as_int = false,
                                               std::string_view object_name = {}) const;

private:
  // Co-owned `.bfbs` bytes. shared_ptr<const> so copies share one immutable
  // buffer and the reflection::Schema view (resolved from these bytes in
  // schema.cpp) can never outlive them.
  std::shared_ptr<const std::string> bfbs_;
};

// Pure SQL builders over a reflection-free col_plan (no reflection, no view).
// thin=true appends the journal loop-back coordinate columns
// (kf_gen_time/kf_frame_uid/kf_stream_id) so a thin row can be seeked back to
// its journal frame.
[[nodiscard]] std::string create_ddl(const std::vector<col_plan> &cols, std::string_view table, bool thin);
[[nodiscard]] std::string insert_sql(const std::vector<col_plan> &cols, std::string_view table, bool thin);

// For each planned column missing from the live table, emit and run
// ALTER TABLE ADD COLUMN (schema evolution: old rows read NULL for new columns).
// Returns the added column names. Coordinate columns are created by create_ddl,
// not altered here.
std::vector<std::string> alter_add_missing(sqlite3 *db, const std::vector<col_plan> &cols, std::string_view table);

// Result of compiling `.fbs` schema text to a `.bfbs` reflection binary.
struct compiled_schema {
  bool ok = false;
  std::string bfbs;  // reflection binary bytes on success, empty on failure
  std::string error; // FlatBuffers parser diagnostic (file:line: message) on failure
};

// Compile `.fbs` schema text to a `.bfbs` reflection binary in-process (the
// linked FlatBuffers parser; no flatc, no subprocess) — the sole FB compile
// entry, so `flatbuffers::Parser` stays inside kungfu::view (KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc). Never
// throws: a parse failure returns ok=false with the parser diagnostic. This is
// schema parsing, not code execution. `allow_includes=false` blocks cross-file
// includes (callers force it off for untrusted input); trust-tier size bounds
// stay with the caller, not here.
[[nodiscard]] compiled_schema compile_schema(std::string_view fbs_text, bool allow_includes);

} // namespace kungfu::view

#endif // KUNGFU_VIEW_SCHEMA_H
