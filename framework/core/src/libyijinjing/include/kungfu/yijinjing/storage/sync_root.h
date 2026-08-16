// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SYNC_ROOT_H
#define KUNGFU_YIJINJING_STORAGE_SYNC_ROOT_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/storage/common.h>

namespace kungfu::yijinjing::storage {

inline constexpr const char *SYNC_ROOT_SCHEMA_V1 = "kungfu.sync-root/v1";
inline constexpr const char *SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST = "source.import.manifest";
inline constexpr const char *SYNC_ROOT_CHAIN_LINK_SCHEMA_V1 = "kungfu.sync-chain-link/v1";
inline constexpr const char *SYNC_ROOT_PROOF_LINEAR_CHAIN_V1 = "linear-chain-v1";
inline constexpr const char *SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1 = "manifest-entry-sort-v1";
inline constexpr const char *SYNC_ROOT_INITIAL_SHA256 =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

struct sync_root_issue {
  std::string code = {};
  std::string field = {};
  nlohmann::json expected = nullptr;
  nlohmann::json actual = nullptr;
};

[[nodiscard]] nlohmann::json make_sync_root_entry_commitment(const nlohmann::json &entry);

// The leaf hash of one entry commitment — the exact per-entry input of the
// linear chain. Recorded per entry by the manifest catalog (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5) so the
// chain is recomputable from kernel records without the entries document.
[[nodiscard]] std::string sync_root_entry_leaf_hash(const nlohmann::json &entry);

// Fold pre-computed leaf hashes into the linear-chain sync root. Identical
// proof semantics to compute_linear_sync_root; the leaves are its per-entry
// hashes.
[[nodiscard]] nlohmann::json compute_linear_sync_root_from_leaves(const std::vector<std::string> &leaf_hashes);

[[nodiscard]] nlohmann::json compute_linear_sync_root(const std::vector<nlohmann::json> &entries);

[[nodiscard]] std::vector<sync_root_issue> verify_linear_sync_root(const nlohmann::json &actual,
                                                                   const std::vector<nlohmann::json> &entries);

[[nodiscard]] std::string verify_payload_ref(const void *data, size_t size, const std::string &expected_hash,
                                             uint64_t expected_byte_length,
                                             const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

[[nodiscard]] std::string verify_payload_ref(const std::string &data, const std::string &expected_hash,
                                             uint64_t expected_byte_length,
                                             const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_SYNC_ROOT_H
