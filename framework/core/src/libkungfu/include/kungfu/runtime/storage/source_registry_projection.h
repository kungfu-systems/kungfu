// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SOURCE_REGISTRY_PROJECTION_H
#define KUNGFU_RUNTIME_STORAGE_SOURCE_REGISTRY_PROJECTION_H

#include <string>

#include <nlohmann/json.hpp>

#include <kungfu/runtime/storage/projection_types.h>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *SOURCE_REGISTRY_PROJECTION_SCHEMA_V1 = "kungfu.storage.source-registry-projection/v1";

// ADR-0037: rebuildable SQLite projection of the source-registry kernel journal.
// It reuses the compile-time Hana closed-set -> SQLite column path
// (cache::make_storage_ptr over SourceRegistryDataTypes), the same path the
// profile / session / state caches use, not the hand-written raw-SQL projection
// that serves the JSON manifest layer, and not the .bfbs reflection projector
// (which serves the FlatBuffers open layer). The journal remains the authority;
// this projection is derived and can be rebuilt at any time.
class source_registry_projection {
public:
  explicit source_registry_projection(std::string runtime_dir);

  [[nodiscard]] std::string sqlite_path() const;

  [[nodiscard]] bool exists() const;

  // Rebuild the SQLite projection from the journal: sync schema, clear tables,
  // replace every journal record. Returns per-table row counts.
  [[nodiscard]] nlohmann::json rebuild() const;

  // Verify the projection against the journal fold. Reports drift (projection
  // row counts diverging from journal record counts) as degraded, missing
  // projection as a distinct honest state, not silently ok.
  [[nodiscard]] nlohmann::json verify() const;

  [[nodiscard]] storage_projection_verify_result verify_typed() const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_SOURCE_REGISTRY_PROJECTION_H
