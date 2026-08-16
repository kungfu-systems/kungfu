// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/sync_root.h>

#include <array>

#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::yijinjing::storage {

namespace {

constexpr std::array<const char *, 10> SYNC_ROOT_ENTRY_FIELDS = {
    "kind",         "source_id",    "source_path", "source_time",   "schema_version",
    "content_type", "payload_hash", "byte_len",    "payload_state", "action"};

constexpr std::array<const char *, 3> SYNC_ROOT_ORDERING_FIELDS = {"kind", "source_id", "source_path"};

std::string canonical_json(const nlohmann::json &value) { return value.dump(-1, ' ', false); }

std::string hash_json(const nlohmann::json &value) {
  return format_content_hash(compute_content_hash(canonical_json(value)));
}

sync_root_issue make_issue(const std::string &code, const std::string &field = {}, nlohmann::json expected = nullptr,
                           nlohmann::json actual = nullptr) {
  sync_root_issue issue{};
  issue.code = code;
  issue.field = field;
  issue.expected = std::move(expected);
  issue.actual = std::move(actual);
  return issue;
}

} // namespace

nlohmann::json make_sync_root_entry_commitment(const nlohmann::json &entry) {
  nlohmann::json commitment = nlohmann::json::object();
  if (!entry.is_object()) {
    return commitment;
  }
  for (const auto *field : SYNC_ROOT_ENTRY_FIELDS) {
    if (entry.contains(field)) {
      commitment[field] = entry.at(field);
    }
  }
  return commitment;
}

std::string sync_root_entry_leaf_hash(const nlohmann::json &entry) {
  return hash_json(make_sync_root_entry_commitment(entry));
}

nlohmann::json compute_linear_sync_root_from_leaves(const std::vector<std::string> &leaf_hashes) {
  auto previous = std::string{SYNC_ROOT_INITIAL_SHA256};
  for (size_t index = 0; index < leaf_hashes.size(); ++index) {
    previous = hash_json({
        {"schema", SYNC_ROOT_CHAIN_LINK_SCHEMA_V1},
        {"index", index},
        {"previous", previous},
        {"entry", leaf_hashes[index]},
    });
  }

  nlohmann::json ordering_fields = nlohmann::json::array();
  for (const auto *field : SYNC_ROOT_ORDERING_FIELDS) {
    ordering_fields.push_back(field);
  }

  return {
      {"schema", SYNC_ROOT_SCHEMA_V1},
      {"scope", SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST},
      {"proof", SYNC_ROOT_PROOF_LINEAR_CHAIN_V1},
      {"algorithm", CONTENT_HASH_ALGORITHM_SHA256},
      {"value", previous},
      {"entry_count", leaf_hashes.size()},
      {"initial", SYNC_ROOT_INITIAL_SHA256},
      {"ordering",
       {
           {"policy", SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
           {"fields", ordering_fields},
       }},
  };
}

nlohmann::json compute_linear_sync_root(const std::vector<nlohmann::json> &entries) {
  std::vector<std::string> leaves;
  leaves.reserve(entries.size());
  for (const auto &entry : entries) {
    leaves.push_back(sync_root_entry_leaf_hash(entry));
  }
  return compute_linear_sync_root_from_leaves(leaves);
}

std::vector<sync_root_issue> verify_linear_sync_root(const nlohmann::json &actual,
                                                     const std::vector<nlohmann::json> &entries) {
  std::vector<sync_root_issue> issues;
  if (!actual.is_object()) {
    issues.emplace_back(make_issue("sync_root_invalid", {}, nullptr, actual));
    return issues;
  }

  const auto expected = compute_linear_sync_root(entries);
  for (const auto &[field, expected_value] : expected.items()) {
    const auto actual_value = actual.contains(field) ? actual.at(field) : nlohmann::json(nullptr);
    if (actual_value != expected_value) {
      issues.emplace_back(make_issue("sync_root_mismatch", field, expected_value, actual_value));
    }
  }
  return issues;
}

std::string verify_payload_ref(const void *data, size_t size, const std::string &expected_hash,
                               uint64_t expected_byte_length, const std::string &algorithm) {
  if (data == nullptr && size != 0) {
    return "payload_decode_error";
  }
  if (size != expected_byte_length) {
    return "byte_len_mismatch";
  }
  if (!verify_content_hash(data, size, make_content_hash(expected_hash, algorithm))) {
    return "hash_mismatch";
  }
  return {};
}

std::string verify_payload_ref(const std::string &data, const std::string &expected_hash, uint64_t expected_byte_length,
                               const std::string &algorithm) {
  return verify_payload_ref(data.data(), data.size(), expected_hash, expected_byte_length, algorithm);
}

} // namespace kungfu::yijinjing::storage
