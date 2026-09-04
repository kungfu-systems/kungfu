// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_ACTION_CONTRACT_REGISTRY_H
#define KUNGFU_RUNTIME_ACTION_ACTION_CONTRACT_REGISTRY_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

struct registered_contract {
  nlohmann::json document; // parsed welded contract artifact
  std::string root;        // "sha256:<hex>" over the artifact's raw bytes
  std::string path;        // resolved artifact filesystem path
};

// Resolve a welded KFD-1 contract by welded surface through the existing
// kungfu-contracts.registry.json. This mirrors the Python authority
// (kungfu.contract) so the C++ layer reuses the same registry and roots rather
// than minting a second registry:
//   - registry path: $KUNGFU_CONTRACT_REGISTRY, else the nearest
//     framework/spec/contract/<file> or config/<file> found by walking upward from
//     search_base and the current directory.
//   - contract path: the registry entry's env override, else the nearest
//     source/artifact/config path found by walking upward.
//   - root: "sha256:" + sha256(raw artifact bytes), identical to Python
//     contract_hash() (the raw welded bytes, not a re-serialized form).
// The parsed schema field and, when the entry declares it, contractSchemaRoot
// are verified so callers receive exactly the welded authority named in the
// registry, fail-closed otherwise.
[[nodiscard]] registered_contract load_registered_contract(const std::string &surface,
                                                           const std::string &search_base = {});

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_ACTION_CONTRACT_REGISTRY_H
