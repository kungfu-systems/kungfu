// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/storage/service.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/manifest_catalog_projection.h>
#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>
#include <kungfu/yijinjing/storage/sync_root.h>
#include <rocksdb/db.h>
#include <rocksdb/iterator.h>
#include <sqlite3.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace {

inline constexpr const char *PAYLOAD_STATE_PRESENT = "present";
inline constexpr const char *PAYLOAD_STATE_REDACTED = "redacted";
inline constexpr const char *PAYLOAD_STATE_ABSENT = "absent";
inline constexpr const char *CONTENT_TYPE_JSON = "application/json";

template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0') {
    ++length;
  }
  return std::string(value.value, length);
}

const char *source_kind_text(yy_enums::SourceKind kind) {
  switch (kind) {
  case yy_enums::SourceKind::Local:
    return "local";
  case yy_enums::SourceKind::ImportedBundle:
    return "imported_bundle";
  case yy_enums::SourceKind::KungfuRuntime:
    return "kungfu_runtime";
  case yy_enums::SourceKind::Adapter:
    return "adapter";
  }
  return "unknown";
}

const char *payload_state_text(yy_enums::PayloadState state) {
  switch (state) {
  case yy_enums::PayloadState::Present:
    return PAYLOAD_STATE_PRESENT;
  case yy_enums::PayloadState::Redacted:
    return PAYLOAD_STATE_REDACTED;
  case yy_enums::PayloadState::Absent:
    return PAYLOAD_STATE_ABSENT;
  case yy_enums::PayloadState::Missing:
    return "missing";
  }
  return "missing";
}
inline constexpr const char *PROJECTION_SOURCE_REGISTRY = "source-registry-sqlite";
inline constexpr const char *PROJECTION_MANIFEST_CATALOG = "manifest-catalog-sqlite";
inline constexpr const char *PROVIDER_FILE = "content-addressed-file";
inline constexpr const char *PROVIDER_ROCKSDB = "rocksdb";
inline constexpr const char *ENV_STORAGE_PROVIDER = "KUNGFU_STORAGE_PROVIDER";

struct provider_selection {
  std::string name = {};
  std::string source = {};
};

struct stored_payload {
  std::string digest = {};
  std::string uri = {};
  uint64_t bytes = 0;
};

std::string text_or(const nlohmann::json &object, const std::string &field, const std::string &fallback = {}) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_null()) {
    return fallback;
  }
  return value.dump(-1, ' ', false);
}

bool bool_or(const nlohmann::json &object, const std::string &field, bool fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  return value.is_boolean() ? value.get<bool>() : fallback;
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_object()) {
    return nlohmann::json::object();
  }
  return object.at(field);
}

nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_array()) {
    return nlohmann::json::array();
  }
  return object.at(field);
}

std::string canonical_json(const nlohmann::json &value) { return value.dump(-1, ' ', false); }

uint64_t uint64_or(const nlohmann::json &object, const std::string &field, uint64_t fallback = 0) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_number_unsigned()) {
    return value.get<uint64_t>();
  }
  if (value.is_number_integer()) {
    return static_cast<uint64_t>(value.get<int64_t>());
  }
  if (value.is_string()) {
    const auto text = value.get<std::string>();
    uint64_t parsed = 0;
    const auto *begin = text.data();
    const auto *end = begin + text.size();
    const auto [ptr, error] = std::from_chars(begin, end, parsed);
    if (error == std::errc{} && ptr == end) {
      return parsed;
    }
  }
  return fallback;
}

int64_t int64_or(const nlohmann::json &object, const std::string &field, int64_t fallback = 0) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_number_integer()) {
    return value.get<int64_t>();
  }
  if (value.is_number_unsigned()) {
    return static_cast<int64_t>(value.get<uint64_t>());
  }
  return fallback;
}

uint32_t uint32_or(const nlohmann::json &object, const std::string &field, uint32_t fallback = 0) {
  return static_cast<uint32_t>(uint64_or(object, field, fallback));
}

int32_t int32_or(const nlohmann::json &object, const std::string &field, int32_t fallback = 0) {
  return static_cast<int32_t>(int64_or(object, field, fallback));
}

yy_enums::EpisodeStatus episode_status_or(const nlohmann::json &object, const std::string &field,
                                          yy_enums::EpisodeStatus fallback) {
  const auto value = text_or(object, field);
  if (value.empty() || value == "ended" || value == "end" || value == "Ended") {
    return fallback;
  }
  if (value == "aborted" || value == "abort" || value == "Aborted") {
    return yy_enums::EpisodeStatus::Aborted;
  }
  if (value == "tombstoned" || value == "tombstone" || value == "Tombstoned") {
    return yy_enums::EpisodeStatus::Tombstoned;
  }
  if (value == "open" || value == "Open") {
    return yy_enums::EpisodeStatus::Open;
  }
  return fallback;
}

yy_enums::EpisodeRefKind episode_ref_kind_or(const nlohmann::json &object, const std::string &field,
                                             yy_enums::EpisodeRefKind fallback) {
  const auto value = text_or(object, field);
  if (value.empty() || value == "input_frame" || value == "input" || value == "InputFrame") {
    return fallback;
  }
  if (value == "payload" || value == "Payload") {
    return yy_enums::EpisodeRefKind::Payload;
  }
  if (value == "schema" || value == "Schema") {
    return yy_enums::EpisodeRefKind::Schema;
  }
  if (value == "episode" || value == "Episode") {
    return yy_enums::EpisodeRefKind::Episode;
  }
  return fallback;
}

yy_storage::episode_manifest_store episode_store(const storage_service_options &options) {
  return yy_storage::episode_manifest_store(options.runtime_dir);
}

yy_storage::episode_begin_options parse_episode_begin_options(const nlohmann::json &value) {
  yy_storage::episode_begin_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.parent_episode_id = uint64_or(value, "parent_episode_id");
  parsed.root_trigger_frame_uid = uint64_or(value, "root_trigger_frame_uid");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.begin_time = int64_or(value, "begin_time");
  parsed.title = text_or(value, "title");
  parsed.actor = text_or(value, "actor");
  parsed.source = text_or(value, "source");
  return parsed;
}

yy_storage::episode_heartbeat_options parse_episode_heartbeat_options(const nlohmann::json &value) {
  yy_storage::episode_heartbeat_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.frame_count = uint64_or(value, "frame_count");
  parsed.note = text_or(value, "note");
  return parsed;
}

yy_storage::episode_close_options parse_episode_close_options(const nlohmann::json &value,
                                                              yy_enums::EpisodeStatus fallback_status) {
  yy_storage::episode_close_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.status = episode_status_or(value, "status", fallback_status);
  parsed.end_time = int64_or(value, "end_time");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.frame_count = uint64_or(value, "frame_count");
  parsed.reason = text_or(value, "reason");
  return parsed;
}

yy_storage::episode_frame_attach_options parse_episode_frame_attach_options(const nlohmann::json &value) {
  yy_storage::episode_frame_attach_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.frame_uid = uint64_or(value, "frame_uid");
  parsed.trigger_frame_uid = uint64_or(value, "trigger_frame_uid");
  parsed.stream_id = uint64_or(value, "stream_id");
  parsed.gen_time = int64_or(value, "gen_time");
  parsed.trigger_time = int64_or(value, "trigger_time");
  parsed.carrier_type = int32_or(value, "carrier_type");
  parsed.source = uint32_or(value, "source");
  parsed.dest = uint32_or(value, "dest");
  parsed.data_length = uint32_or(value, "data_length");
  parsed.integrity_version = uint32_or(value, "integrity_version");
  parsed.payload_checksum = uint64_or(value, "payload_checksum");
  parsed.frame_checksum = uint64_or(value, "frame_checksum");
  return parsed;
}

yy_storage::episode_ref_attach_options parse_episode_ref_attach_options(const nlohmann::json &value) {
  yy_storage::episode_ref_attach_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.ref_kind = episode_ref_kind_or(value, "ref_kind", yy_enums::EpisodeRefKind::InputFrame);
  parsed.ref_uid = uint64_or(value, "ref_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.ref_id = text_or(value, "ref_id");
  parsed.ref_hash = text_or(value, "ref_hash");
  return parsed;
}

yy_storage::episode_recover_options parse_episode_recover_options(const nlohmann::json &value) {
  yy_storage::episode_recover_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.end_time = int64_or(value, "end_time");
  parsed.reason = text_or(value, "reason");
  return parsed;
}

yy_enums::SourceKind source_kind_or(const nlohmann::json &object, const std::string &field,
                                    yy_enums::SourceKind fallback) {
  const auto value = text_or(object, field);
  if (value == "imported_bundle" || value == "ImportedBundle") {
    return yy_enums::SourceKind::ImportedBundle;
  }
  if (value == "kungfu_runtime" || value == "KungfuRuntime") {
    return yy_enums::SourceKind::KungfuRuntime;
  }
  if (value == "adapter" || value == "Adapter") {
    return yy_enums::SourceKind::Adapter;
  }
  if (value == "local" || value == "Local") {
    return yy_enums::SourceKind::Local;
  }
  return fallback;
}

yy_enums::SourceVerificationStatus source_verification_status_or(const nlohmann::json &object, const std::string &field,
                                                                 yy_enums::SourceVerificationStatus fallback) {
  const auto value = text_or(object, field);
  if (value == "degraded" || value == "Degraded") {
    return yy_enums::SourceVerificationStatus::Degraded;
  }
  if (value == "failed" || value == "Failed") {
    return yy_enums::SourceVerificationStatus::Failed;
  }
  if (value == "ok" || value == "Ok") {
    return yy_enums::SourceVerificationStatus::Ok;
  }
  return fallback;
}

yy_storage::source_registry_store source_registry_store(const storage_service_options &options) {
  return yy_storage::source_registry_store(options.runtime_dir);
}

yy_storage::source_register_options parse_source_register_options(const nlohmann::json &value) {
  yy_storage::source_register_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.kind = source_kind_or(value, "kind", yy_enums::SourceKind::Local);
  parsed.coordinate = text_or(value, "coordinate");
  parsed.head = text_or(value, "head");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.register_time = int64_or(value, "register_time");
  return parsed;
}

yy_storage::source_head_update_options parse_source_head_update_options(const nlohmann::json &value) {
  yy_storage::source_head_update_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.first_frame_uid = uint64_or(value, "first_frame_uid");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.since = int64_or(value, "since");
  parsed.until = int64_or(value, "until");
  parsed.head = text_or(value, "head");
  parsed.inventory_hash_algo = text_or(value, "inventory_hash_algo");
  parsed.inventory_hash = text_or(value, "inventory_hash");
  return parsed;
}

yy_storage::accepted_range_options parse_accepted_range_options(const nlohmann::json &value) {
  yy_storage::accepted_range_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.manifest_id = text_or(value, "manifest_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.accept_time = int64_or(value, "accept_time");
  parsed.first_frame_uid = uint64_or(value, "first_frame_uid");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.since = int64_or(value, "since");
  parsed.until = int64_or(value, "until");
  parsed.status = source_verification_status_or(value, "status", yy_enums::SourceVerificationStatus::Ok);
  return parsed;
}

fs::path root_dir(const std::string &runtime_dir) { return fs::path(runtime_dir) / "storage"; }

fs::path payload_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "payloads"; }

fs::path rocksdb_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "rocksdb"; }

fs::path projection_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "projections"; }

fs::path payload_path(const std::string &runtime_dir, const std::string &digest) {
  // ADR-0037: payload bodies are opaque content-addressed bytes. The file is
  // named by the content hash alone, with no format-implying extension — the
  // body format is orthogonal to the record schema, which commits to the body
  // by hash, length, and payload state (content_type is record metadata).
  return payload_root(runtime_dir) / digest.substr(0, std::min<size_t>(2, digest.size())) / digest;
}

fs::path absolute_normalized(fs::path path) { return fs::absolute(std::move(path)).lexically_normal(); }

fs::path runtime_home_path(const storage_service_options &options) {
  const auto explicit_runtime_home = text_or(options.operation_options, "runtime_home");
  if (!explicit_runtime_home.empty()) {
    return absolute_normalized(explicit_runtime_home);
  }
  const auto runtime = absolute_normalized(options.runtime_dir);
  return runtime.filename() == "runtime" ? runtime.parent_path() : runtime;
}

std::string runtime_home_source(const storage_service_options &options) {
  return text_or(options.operation_options, "runtime_home").empty() ? "inferred-from-runtime-dir" : "option";
}

std::string optional_absolute_path(const nlohmann::json &object, const std::string &field) {
  const auto value = text_or(object, field);
  return value.empty() ? std::string{} : absolute_normalized(value).string();
}

std::vector<fs::path> all_payload_paths(const std::string &runtime_dir);
std::string payload_digest_from_path(const fs::path &path);

void write_json_file(const fs::path &path, const nlohmann::json &data) {
  fs::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::trunc);
  if (!output) {
    throw std::runtime_error("failed to write JSON file: " + path.string());
  }
  output << data.dump(2, ' ', false) << '\n';
}

std::string read_bytes(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("failed to read payload: " + path.string());
  }
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

void write_bytes(const fs::path &path, const std::string &raw) {
  fs::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("failed to write payload: " + path.string());
  }
  output.write(raw.data(), static_cast<std::streamsize>(raw.size()));
}

std::string normalized_provider_name(const std::string &provider) {
  if (provider.empty() || provider == "file" || provider == PROVIDER_FILE) {
    return PROVIDER_FILE;
  }
  if (provider == "rocks" || provider == PROVIDER_ROCKSDB) {
    return PROVIDER_ROCKSDB;
  }
  throw std::invalid_argument("unsupported storage provider: " + provider);
}

provider_selection select_provider(std::string provider) {
  if (provider.empty()) {
    if (const char *env_provider = std::getenv(ENV_STORAGE_PROVIDER); env_provider != nullptr) {
      provider = env_provider;
      return {normalized_provider_name(provider), "env:" + std::string(ENV_STORAGE_PROVIDER)};
    }
    return {PROVIDER_FILE, "default"};
  }
  return {normalized_provider_name(provider), "option"};
}

std::string storage_uri(const std::string &provider, const std::string &runtime_dir, const std::string &key) {
  if (provider == PROVIDER_ROCKSDB) {
    return std::string("rocksdb://") + rocksdb_root(runtime_dir).string() + "#" + key;
  }
  return key;
}

class storage_provider {
public:
  virtual ~storage_provider() = default;

  [[nodiscard]] virtual std::string name() const = 0;
  [[nodiscard]] virtual nlohmann::json layout() const = 0;
  [[nodiscard]] virtual storage_provider_runtime_view runtime() const = 0;
  [[nodiscard]] virtual bool payload_exists(const std::string &digest) const = 0;
  [[nodiscard]] virtual std::string read_payload(const std::string &digest) const = 0;
  virtual void write_payload(const std::string &digest, const std::string &raw) const = 0;
  [[nodiscard]] virtual std::vector<stored_payload> all_payloads() const = 0;
  // ADR-0040: the immutable content store this provider publishes payload
  // bytes through. Injected into kernel fsck/inspect so payload-ref
  // resolution reads the same backend that owns the bytes.
  [[nodiscard]] virtual yy_storage::content_store &content_store() const = 0;
};

class file_storage_provider : public storage_provider {
public:
  explicit file_storage_provider(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

  [[nodiscard]] std::string name() const override { return PROVIDER_FILE; }

  [[nodiscard]] nlohmann::json layout() const override {
    return {
        {"manifest_catalog_journal", "journal/system/storage/manifest-catalog/live/*.journal"},
        {"manifest_entries", "storage/manifests/<hash-prefix>/<sha256>"},
        {"payloads", "storage/payloads/<hash-prefix>/<sha256>"},
    };
  }

  [[nodiscard]] storage_provider_runtime_view runtime() const override {
    return {"stateless-filesystem", "process-cached", "per filesystem operation", false, true};
  }

  [[nodiscard]] bool payload_exists(const std::string &digest) const override {
    return fs::exists(payload_path(runtime_dir_, digest));
  }

  [[nodiscard]] std::string read_payload(const std::string &digest) const override {
    return read_bytes(payload_path(runtime_dir_, digest));
  }

  void write_payload(const std::string &digest, const std::string &raw) const override {
    // ADR-0040: publish through the immutable content store (atomic
    // tmp+rename, digest checked against the bytes) instead of a bare file
    // write; the store's layout is byte-compatible with payload_path.
    const auto result = content_store_.put_if_absent("payloads", raw, yy_storage::make_content_hash(digest));
    if (!result.ok()) {
      throw std::runtime_error("failed to publish payload " + digest + ": " +
                               yy_storage::content_store_error_name(result.error) +
                               (result.message.empty() ? "" : " (" + result.message + ")"));
    }
  }

  [[nodiscard]] yy_storage::content_store &content_store() const override { return content_store_; }

  [[nodiscard]] std::vector<stored_payload> all_payloads() const override {
    std::vector<stored_payload> result;
    for (const auto &path : all_payload_paths(runtime_dir_)) {
      result.push_back({payload_digest_from_path(path), path.string(), fs::file_size(path)});
    }
    return result;
  }

private:
  std::string runtime_dir_;
  mutable yy_storage::file_content_store content_store_{root_dir(runtime_dir_).string()};
};

// ADR-0040: the RocksDB-backed content store lives in the runtime/provider
// layer and implements the yijinjing contract over the provider's single
// long-lived engine handle (decision 6). Keys are "<namespace>/<digest>",
// bare lowercase hex. The store never owns the handle: the provider does,
// and multi-process ownership of one database path is rejected by the
// engine's own lock. Values are written through the WAL in one atomic key
// write, so a torn object is never visible under a digest; identical-bytes
// races on the same key are benign under content identity.
class rocksdb_content_store : public yy_storage::content_store {
public:
  // Returns a shared handle so an in-flight operation keeps its engine alive
  // across a concurrent readonly-to-readwrite upgrade in the provider.
  using engine_opener = std::function<std::shared_ptr<rocksdb::DB>(bool write)>;

  explicit rocksdb_content_store(engine_opener open) : open_(std::move(open)) {}

  [[nodiscard]] yy_storage::content_store_capabilities capabilities() const override {
    yy_storage::content_store_capabilities caps{};
    caps.profile = "kungfu-rocksdb/v1";
    caps.hash_algorithm = yy_storage::CONTENT_HASH_ALGORITHM_SHA256;
    caps.max_object_size = 0;
    caps.atomic_put_if_absent = true;
    caps.verified_reads = true;
    caps.durability = write_options_.sync ? "fsync-per-write" : "wal-os-buffered";
    caps.visibility = "publish-then-visible";
    caps.concurrency = "multi-writer-single-process";
    return caps;
  }

  [[nodiscard]] yy_storage::content_store_result put_if_absent(const std::string &content_namespace, const void *data,
                                                               size_t size,
                                                               const yy_storage::content_hash &expected) override {
    yy_storage::content_store_result result{};
    if (!yy_storage::is_valid_content_namespace(content_namespace)) {
      result.error = yy_storage::content_store_error::InvalidArgument;
      result.message = "invalid content namespace: " + content_namespace;
      return result;
    }
    if (size > 0 && data == nullptr) {
      result.error = yy_storage::content_store_error::InvalidArgument;
      result.message = "null data with non-zero size";
      return result;
    }
    const auto digest = yy_storage::compute_content_hash(data, size, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    if (!expected.empty()) {
      result.error = yy_storage::validate_content_digest(expected, digest.algorithm, result.message);
      if (result.error != yy_storage::content_store_error::Ok) {
        return result;
      }
      if (expected.value != digest.value) {
        result.error = yy_storage::content_store_error::HashMismatch;
        result.message = "bytes hash to " + digest.value + ", caller declared " + expected.value;
        return result;
      }
    }
    result.hash = digest;
    result.byte_length = size;
    auto db = open_(true);
    if (!db) {
      result.error = yy_storage::content_store_error::IoError;
      result.message = "cannot open storage engine for write";
      return result;
    }
    const auto key = object_key(content_namespace, digest.value);
    std::string existing;
    auto status = db->Get(read_options_, key, &existing);
    if (status.ok()) {
      if (existing.size() != size) {
        result.error = yy_storage::content_store_error::CorruptObject;
        result.message = "existing object holds " + std::to_string(existing.size()) + " bytes, content is " +
                         std::to_string(size) + " bytes; run verify";
        return result;
      }
      result.existed = true;
      return result;
    }
    if (!status.IsNotFound()) {
      result.error = yy_storage::content_store_error::IoError;
      result.message = "engine read failed: " + status.ToString();
      return result;
    }
    status = db->Put(write_options_, key, rocksdb::Slice(static_cast<const char *>(data), size));
    if (!status.ok()) {
      result.error = yy_storage::content_store_error::IoError;
      result.message = "engine write failed: " + status.ToString();
      return result;
    }
    return result;
  }

  using yy_storage::content_store::put_if_absent;

  [[nodiscard]] bool has(const std::string &content_namespace, const yy_storage::content_hash &hash) const override {
    if (!yy_storage::is_valid_content_namespace(content_namespace)) {
      return false;
    }
    std::string message;
    if (yy_storage::validate_content_digest(hash, yy_storage::CONTENT_HASH_ALGORITHM_SHA256, message) !=
        yy_storage::content_store_error::Ok) {
      return false;
    }
    auto db = open_(false);
    if (!db) {
      return false;
    }
    std::string existing;
    return db->Get(read_options_, object_key(content_namespace, hash.value), &existing).ok();
  }

  [[nodiscard]] yy_storage::content_store_result verify(const std::string &content_namespace,
                                                        const yy_storage::content_hash &hash) const override {
    yy_storage::content_store_result result{};
    std::string bytes;
    result.error = load_object(content_namespace, hash, bytes, result.message);
    if (result.error != yy_storage::content_store_error::Ok) {
      return result;
    }
    result.hash = yy_storage::make_content_hash(hash.value, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    result.byte_length = bytes.size();
    if (!yy_storage::verify_content_hash(bytes, result.hash)) {
      result.error = yy_storage::content_store_error::CorruptObject;
      result.message = "stored bytes do not hash to " + result.hash.value;
    }
    return result;
  }

  [[nodiscard]] yy_storage::content_get_result get(const std::string &content_namespace,
                                                   const yy_storage::content_hash &hash) const override {
    yy_storage::content_get_result result{};
    std::string bytes;
    result.error = load_object(content_namespace, hash, bytes, result.message);
    if (result.error != yy_storage::content_store_error::Ok) {
      return result;
    }
    result.hash = yy_storage::make_content_hash(hash.value, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    if (!yy_storage::verify_content_hash(bytes, result.hash)) {
      result.error = yy_storage::content_store_error::CorruptObject;
      result.message = "stored bytes do not hash to " + result.hash.value;
      return result;
    }
    result.bytes = std::move(bytes);
    return result;
  }

private:
  [[nodiscard]] static std::string object_key(const std::string &content_namespace, const std::string &digest) {
    return content_namespace + "/" + digest;
  }

  [[nodiscard]] yy_storage::content_store_error load_object(const std::string &content_namespace,
                                                            const yy_storage::content_hash &hash, std::string &bytes,
                                                            std::string &message) const {
    if (!yy_storage::is_valid_content_namespace(content_namespace)) {
      message = "invalid content namespace: " + content_namespace;
      return yy_storage::content_store_error::InvalidArgument;
    }
    const auto digest_error =
        yy_storage::validate_content_digest(hash, yy_storage::CONTENT_HASH_ALGORITHM_SHA256, message);
    if (digest_error != yy_storage::content_store_error::Ok) {
      return digest_error;
    }
    auto db = open_(false);
    if (!db) {
      message = "no storage engine at this runtime dir";
      return yy_storage::content_store_error::NotFound;
    }
    const auto status = db->Get(read_options_, object_key(content_namespace, hash.value), &bytes);
    if (status.IsNotFound()) {
      message = "no object under " + object_key(content_namespace, hash.value);
      return yy_storage::content_store_error::NotFound;
    }
    if (!status.ok()) {
      message = "engine read failed: " + status.ToString();
      return yy_storage::content_store_error::IoError;
    }
    return yy_storage::content_store_error::Ok;
  }

  engine_opener open_;
  rocksdb::ReadOptions read_options_ = [] {
    rocksdb::ReadOptions options;
    options.fill_cache = false;
    return options;
  }();
  rocksdb::WriteOptions write_options_ = {};
};

class rocksdb_storage_provider : public storage_provider {
public:
  explicit rocksdb_storage_provider(std::string runtime_dir)
      : runtime_dir_(std::move(runtime_dir)), content_store_([this](bool write) { return open(write); }) {}

  [[nodiscard]] std::string name() const override { return PROVIDER_ROCKSDB; }

  [[nodiscard]] nlohmann::json layout() const override {
    return {
        {"database", "storage/rocksdb"},
        {"manifest_catalog_journal", "journal/system/storage/manifest-catalog/live/*.journal"},
        {"manifest_entries", "manifests/<sha256>"},
        {"payloads", "payloads/<sha256>"},
    };
  }

  [[nodiscard]] storage_provider_runtime_view runtime() const override {
    std::lock_guard<std::mutex> lock(db_mutex_);
    return {"provider-instance-owned",
            "process-cached",
            db_ ? (db_writable_ ? "open-readwrite" : "open-readonly") : "closed",
            false,
            true,
            read_options_.fill_cache,
            write_options_.sync};
  }

  [[nodiscard]] bool payload_exists(const std::string &digest) const override {
    return content_store_.has("payloads", yy_storage::make_content_hash(digest));
  }

  [[nodiscard]] std::string read_payload(const std::string &digest) const override {
    // verified read through the content store: corrupt bytes never come back
    auto result = content_store_.get("payloads", yy_storage::make_content_hash(digest));
    if (!result.ok()) {
      throw std::runtime_error("failed to read payload " + digest + ": " +
                               yy_storage::content_store_error_name(result.error) +
                               (result.message.empty() ? "" : " (" + result.message + ")"));
    }
    return std::move(result.bytes);
  }

  void write_payload(const std::string &digest, const std::string &raw) const override {
    const auto result = content_store_.put_if_absent("payloads", raw, yy_storage::make_content_hash(digest));
    if (!result.ok()) {
      throw std::runtime_error("failed to publish payload " + digest + ": " +
                               yy_storage::content_store_error_name(result.error) +
                               (result.message.empty() ? "" : " (" + result.message + ")"));
    }
  }

  [[nodiscard]] std::vector<stored_payload> all_payloads() const override {
    std::vector<stored_payload> result;
    for_each("payloads/", [&](const std::string &key, const std::string &raw) {
      result.push_back({key.substr(std::string("payloads/").size()), uri_for(key), raw.size()});
    });
    std::sort(result.begin(), result.end(),
              [](const stored_payload &lhs, const stored_payload &rhs) { return lhs.digest < rhs.digest; });
    return result;
  }

  [[nodiscard]] yy_storage::content_store &content_store() const override { return content_store_; }

private:
  [[nodiscard]] std::string uri_for(const std::string &key) const {
    return storage_uri(PROVIDER_ROCKSDB, runtime_dir_, key);
  }

  // Lazily opens the engine and hands back a shared handle. RocksDB is
  // thread-safe through one handle, so concurrent operations share it; the
  // readonly-to-readwrite upgrade swaps in a fresh handle while in-flight
  // readers finish on the old one (a readonly open holds no engine lock).
  // Readonly opens still never create the database; only writes do.
  [[nodiscard]] std::shared_ptr<rocksdb::DB> open(bool write) const {
    std::lock_guard<std::mutex> lock(db_mutex_);
    if (db_) {
      if (!write || db_writable_) {
        return db_;
      }
      db_.reset();
      db_writable_ = false;
    }
    rocksdb::DB *raw = nullptr;
    rocksdb::Options options;
    options.create_if_missing = write;
    options.error_if_exists = false;
    rocksdb::Status status;
    if (write) {
      fs::create_directories(rocksdb_root(runtime_dir_));
      status = rocksdb::DB::Open(options, rocksdb_root(runtime_dir_).string(), &raw);
    } else {
      if (!fs::exists(rocksdb_root(runtime_dir_))) {
        return {};
      }
      status = rocksdb::DB::OpenForReadOnly(options, rocksdb_root(runtime_dir_).string(), &raw);
    }
    if (!status.ok()) {
      throw std::runtime_error("rocksdb_open_failed: " + status.ToString());
    }
    db_ = std::shared_ptr<rocksdb::DB>(raw);
    db_writable_ = write;
    return db_;
  }

  [[nodiscard]] bool get(const std::string &key, std::string &value) const {
    auto db = open(false);
    if (!db) {
      return false;
    }
    const auto status = db->Get(read_options_, key, &value);
    if (status.IsNotFound()) {
      return false;
    }
    if (!status.ok()) {
      throw std::runtime_error("rocksdb_read_failed: " + key + ": " + status.ToString());
    }
    return true;
  }

  void put(const std::string &key, const std::string &value) const {
    auto db = open(true);
    const auto status = db->Put(write_options_, key, value);
    if (!status.ok()) {
      throw std::runtime_error("rocksdb_write_failed: " + key + ": " + status.ToString());
    }
  }

  template <typename Fn> void for_each(const std::string &prefix, Fn fn) const {
    auto db = open(false);
    if (!db) {
      return;
    }
    std::unique_ptr<rocksdb::Iterator> it(db->NewIterator(read_options_));
    for (it->Seek(prefix); it->Valid(); it->Next()) {
      const auto key = it->key().ToString();
      if (!key.starts_with(prefix)) {
        break;
      }
      fn(key, it->value().ToString());
    }
    if (!it->status().ok()) {
      throw std::runtime_error("rocksdb_iterate_failed: " + it->status().ToString());
    }
  }

  std::string runtime_dir_;
  mutable rocksdb_content_store content_store_;
  mutable std::mutex db_mutex_;
  mutable std::shared_ptr<rocksdb::DB> db_ = {};
  mutable bool db_writable_ = false;
  rocksdb::ReadOptions read_options_ = [] {
    rocksdb::ReadOptions options;
    options.fill_cache = false;
    return options;
  }();
  rocksdb::WriteOptions write_options_ = {};
};

std::unique_ptr<storage_provider> make_provider(const std::string &provider_name, const std::string &runtime_dir) {
  if (provider_name == PROVIDER_ROCKSDB) {
    return std::make_unique<rocksdb_storage_provider>(runtime_dir);
  }
  return std::make_unique<file_storage_provider>(runtime_dir);
}

// ADR-0040 decision 6: the per-operation provider open/close was a lifecycle
// artifact, not an engine limit. One long-lived provider per (canonical
// runtime dir, provider) is shared by every operation in this process, so
// concurrent facade/service calls share one engine handle instead of racing
// for the engine lock. Entries live until process exit: the touched
// (runtime dir, provider) set is small, an evicted-then-reused handle would
// reintroduce the open/close races this cache removes, and a background
// eviction thread is out of scope by design. The engine's own lock keeps
// rejecting a second process on the same database path — holding the write
// handle for the process lifetime is that decision made visible, and hero's
// location-metadata engine lives under layout::MAP, a disjoint path from
// this provider's storage/rocksdb, so no path ever has two in-process owners.
class provider_cache {
public:
  static provider_cache &instance() {
    // Intentionally leaked: cached engine handles must not run destructors
    // during static teardown (RocksDB aborts once its lock infrastructure is
    // torn down first). Never closing on exit loses nothing under the
    // declared contract — publication is WAL-ordered, so exit-without-close
    // is exactly the crash-safety case the backend already commits to.
    static auto *cache = new provider_cache();
    return *cache;
  }

  [[nodiscard]] std::shared_ptr<storage_provider> acquire(const std::string &runtime, const std::string &provider) {
    const auto selection = select_provider(provider);
    const auto runtime_dir = absolute_normalized(runtime).string();
    const auto key = selection.name + "|" + runtime_dir;
    std::lock_guard<std::mutex> lock(mutex_);
    if (const auto it = providers_.find(key); it != providers_.end()) {
      hits_.fetch_add(1, std::memory_order_relaxed);
      return it->second;
    }
    misses_.fetch_add(1, std::memory_order_relaxed);
    return providers_.emplace(key, make_provider(selection.name, runtime_dir)).first->second;
  }

  [[nodiscard]] storage_provider_cache_view stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return {"process", providers_.size(), hits_.load(std::memory_order_relaxed),
            misses_.load(std::memory_order_relaxed)};
  }

private:
  provider_cache() = default;

  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<storage_provider>> providers_;
  std::atomic<uint64_t> hits_{0};
  std::atomic<uint64_t> misses_{0};
};

nlohmann::json provider_runtime_json(const storage_provider_runtime_view &runtime) {
  nlohmann::json rendered = {{"lifecycle", runtime.lifecycle},
                             {"instance_lifecycle", runtime.instance_lifecycle},
                             {"handle", runtime.handle},
                             {"readonly_open_creates_backend", runtime.readonly_open_creates_backend},
                             {"write_open_creates_backend", runtime.write_open_creates_backend}};
  if (runtime.read_fill_cache.has_value()) {
    rendered["read_options"] = {{"fill_cache", *runtime.read_fill_cache}};
  }
  if (runtime.write_sync.has_value()) {
    rendered["write_options"] = {{"sync", *runtime.write_sync}};
  }
  return rendered;
}

nlohmann::json provider_cache_json(const storage_provider_cache_view &cache) {
  return {{"lifecycle", cache.lifecycle}, {"entries", cache.entries}, {"hits", cache.hits}, {"misses", cache.misses}};
}

std::shared_ptr<storage_provider> shared_provider(const storage_service_options &options) {
  return provider_cache::instance().acquire(options.runtime_dir, options.provider);
}

std::shared_ptr<storage_provider> shared_provider(const std::string &runtime_dir) {
  return provider_cache::instance().acquire(runtime_dir, {});
}

// Bundle a provider with an episode store wired to its content store, so
// payload-ref resolution reads the same backend that published the bytes
// (ADR-0040); the provider member keeps the injected store alive.
struct episode_store_with_provider {
  std::shared_ptr<storage_provider> provider;
  yy_storage::episode_manifest_store store;
};

episode_store_with_provider episode_ref_store(const storage_service_options &options) {
  auto provider = shared_provider(options);
  auto store = yy_storage::episode_manifest_store(options.runtime_dir);
  store.set_content_store(&provider->content_store());
  return {std::move(provider), std::move(store)};
}

nlohmann::json workspace_episode_layout(const storage_service_options &options, const storage_provider &provider) {
  const auto runtime = absolute_normalized(options.runtime_dir);
  const auto home = runtime_home_path(options);
  const auto journal_dir = runtime / "journal";
  const auto storage_dir = runtime / "storage";
  const auto episode_manifest_dir =
      journal_dir / "system" / yy_storage::EPISODE_MANIFEST_NAMESPACE / yy_storage::EPISODE_MANIFEST_NAME / "live";
  const auto manifest_catalog_journal_dir =
      journal_dir / "system" / yy_storage::MANIFEST_CATALOG_NAMESPACE / yy_storage::MANIFEST_CATALOG_NAME / "live";
  const auto source_registry_journal_dir =
      journal_dir / "system" / yy_storage::SOURCE_REGISTRY_NAMESPACE / yy_storage::SOURCE_REGISTRY_NAME / "live";
  const auto manifest_entries_pattern = storage_dir / "manifests" / "<hash-prefix>" / "<sha256>";
  const auto payload_pattern = storage_dir / "payloads" / "<hash-prefix>" / "<sha256>";

  return {
      {"schema", "kungfu.workspace.episode-layout/v1"},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"layout_version", 1},
      {"runtime_home", home.string()},
      {"workspace_data_home", home.string()},
      {"runtime_home_source", runtime_home_source(options)},
      {"runtime_dir", runtime.string()},
      {"runtime_dir_is_standard_child", runtime.filename() == "runtime"},
      {"config_home", optional_absolute_path(options.operation_options, "config_home")},
      {"provider", provider.name()},
      {"provider_layout", provider.layout()},
      {"provider_runtime", provider_runtime_json(provider.runtime())},
      {"provider_cache", provider_cache_json(provider_cache::instance().stats())},
      {"paths",
       {{"data_home", home.string()},
        {"runtime_dir", runtime.string()},
        {"archive_dir", (home / "archive").string()},
        {"dataset_dir", (home / "dataset").string()},
        {"inbox_dir", (home / "inbox").string()},
        {"journal_dir", journal_dir.string()},
        {"storage_dir", storage_dir.string()},
        {"source_registry_journal", (source_registry_journal_dir / "*.journal").string()},
        {"manifest_catalog_journal", (manifest_catalog_journal_dir / "*.journal").string()},
        {"manifest_entries", manifest_entries_pattern.string()},
        {"payloads", payload_pattern.string()},
        {"rocksdb", rocksdb_root(runtime.string()).string()},
        {"source_registry_projection", source_registry_projection(runtime.string()).sqlite_path()},
        {"manifest_catalog_projection", manifest_catalog_projection(runtime.string()).sqlite_path()},
        {"episode_manifest_journal_dir", episode_manifest_dir.string()},
        {"episode_manifest_journal", (episode_manifest_dir / "*.journal").string()},
        {"master_state", (runtime / "master").string()},
        {"remote_mirrors", (runtime / "remotes" / "<source-id>" / "runtime").string()},
        {"atlas_store", (runtime / "atlas" / "store").string()}}},
      {"episodes",
       {{"authority", "yijinjing-journal"},
        {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
        {"manifest_namespace", yy_storage::EPISODE_MANIFEST_NAMESPACE},
        {"manifest_name", yy_storage::EPISODE_MANIFEST_NAME},
        {"manifest_journal", (episode_manifest_dir / "*.journal").string()},
        {"query_tables", nlohmann::json::array({"episodes", "episode_records", "episode_frames", "episode_refs"})},
        {"export_schema", "kungfu.storage.episode-bundle/v1"}}},
      {"ownership",
       {{"journal_dir", "append-only yijinjing frames owned by the resolved runtime"},
        {"episode_manifest_journal", "append-only yijinjing manifest records; not loose JSON authority"},
        {"storage_dir", "runtime storage service area for content-addressed bodies, provider databases, and "
                        "projections"},
        {"source_registry_journal", "append-only yijinjing source-registry kernel records; the source catalog"},
        {"manifest_catalog_journal",
         "append-only yijinjing manifest-catalog kernel records; the import/export/cursor authority"},
        {"manifest_entries", "content-addressed accepted entries documents committed by the manifest records"},
        {"payloads", "provider-owned content-addressed payload bodies"},
        {"source_registry_projection", "derived rebuildable SQLite projection over the source-registry journal"},
        {"manifest_catalog_projection", "derived rebuildable SQLite projection over the manifest-catalog journal"},
        {"rocksdb", "optional provider-owned large-payload/key-value backend"},
        {"config_home", "user config home; intentionally outside workspace data"}}},
      {"notes", nlohmann::json::array({
                    "This layout describes the resolved local data root; it is an inspection contract, not a second "
                    "fact source.",
                    "Episode authority remains the yijinjing manifest journal under the runtime journal tree.",
                    "Provider-specific paths are implementation details behind the runtime storage service API.",
                })},
  };
}

nlohmann::json entries_for_manifest(const nlohmann::json &manifest, const nlohmann::json &range_filter = {}) {
  auto entries = array_or_empty(manifest, "entries");
  if (range_filter.is_object() && !range_filter.empty()) {
    entries = yy_storage::filter_storage_manifest_entries(entries, range_filter);
  }
  nlohmann::json result = nlohmann::json::array();
  for (const auto &entry : entries) {
    if (entry.is_object()) {
      result.push_back(entry);
    }
  }
  return result;
}

std::vector<fs::path> all_payload_paths(const std::string &runtime_dir) {
  std::vector<fs::path> paths;
  const auto root = payload_root(runtime_dir);
  if (!fs::exists(root)) {
    return paths;
  }
  for (const auto &prefix : fs::directory_iterator(root)) {
    if (!prefix.is_directory()) {
      continue;
    }
    for (const auto &entry : fs::directory_iterator(prefix.path())) {
      // Payload bodies are opaque content-addressed files named by hash, with no
      // extension (ADR-0037); every regular file under a prefix is a body.
      if (entry.is_regular_file()) {
        paths.emplace_back(entry.path());
      }
    }
  }
  std::sort(paths.begin(), paths.end());
  return paths;
}

std::string payload_digest_from_path(const fs::path &path) {
  // Bodies are named by the full content hash with no extension; the whole
  // filename is the digest.
  return path.filename().string();
}

yy_storage::manifest_catalog_store catalog_store(const std::string &runtime_dir) {
  return yy_storage::manifest_catalog_store(runtime_dir);
}

yy_storage::source_registry_store registry_store(const std::string &runtime_dir) {
  return yy_storage::source_registry_store(runtime_dir);
}

nlohmann::json load_latest_manifest_impl(const std::string &runtime_dir, const storage_provider &provider,
                                         const std::string &source_id) {
  return catalog_store(runtime_dir).latest_manifest(source_id, provider.content_store());
}

// The channel cursor is a journal record written at acceptance (ADR-0037);
// reading it back is a fold over ChannelCursorUpdated, not a derivation from
// the manifest edge.
nlohmann::json accepted_cursor(const std::string &runtime_dir, const std::string &source_id) {
  return catalog_store(runtime_dir).latest_cursor(source_id);
}

storage_projection_status_view source_registry_projection_status(const std::string &runtime_dir) {
  const auto projection = source_registry_projection(runtime_dir);
  return {PROJECTION_SOURCE_REGISTRY, projection.sqlite_path(), true, projection.verify_typed()};
}

storage_projection_status_view manifest_catalog_projection_status(const std::string &runtime_dir) {
  const auto projection = manifest_catalog_projection(runtime_dir);
  return {PROJECTION_MANIFEST_CATALOG, projection.sqlite_path(), true, projection.verify_typed()};
}

nlohmann::json projection_status_json(const storage_projection_status_view &status) {
  const auto &report = status.verification;
  nlohmann::json rendered = {{"ok", report.ok},
                             {"status", report.status},
                             {"schema", report.schema},
                             {"runtime_dir", report.runtime_dir},
                             {"authority", report.authority},
                             {"projection_present", report.projection_present},
                             {"name", status.name},
                             {"path", status.path},
                             {"rebuildable", status.rebuildable}};
  if (!report.note.empty()) {
    rendered["note"] = report.note;
  }
  if (report.projection_present) {
    rendered["degraded"] = report.degraded;
    rendered["drift"] = nlohmann::json::array();
    for (const auto &item : report.drift) {
      rendered["drift"].push_back({{"table", item.table},
                                   {"projection_rows", item.projection_rows},
                                   {"journal_distinct", item.journal_distinct}});
    }
    rendered["rows"] = nlohmann::json::object();
    for (const auto &item : report.rows) {
      rendered["rows"][item.table] = item.count;
    }
    rendered["journal_distinct"] = nlohmann::json::object();
    for (const auto &item : report.journal_distinct) {
      rendered["journal_distinct"][item.table] = item.count;
    }
  }
  return rendered;
}

nlohmann::json source_registry_projection_report(const std::string &runtime_dir) {
  return projection_status_json(source_registry_projection_status(runtime_dir));
}

nlohmann::json manifest_catalog_projection_report(const std::string &runtime_dir) {
  return projection_status_json(manifest_catalog_projection_status(runtime_dir));
}

nlohmann::json storage_projection_reports(const std::string &runtime_dir) {
  return nlohmann::json::array(
      {source_registry_projection_report(runtime_dir), manifest_catalog_projection_report(runtime_dir)});
}

const char *verification_status_text(yy_enums::SourceVerificationStatus status) {
  switch (status) {
  case yy_enums::SourceVerificationStatus::Ok:
    return "ok";
  case yy_enums::SourceVerificationStatus::Degraded:
    return "degraded";
  case yy_enums::SourceVerificationStatus::Failed:
    return "failed";
  }
  return "failed";
}

storage_query_result query_journal_projection(const storage_query_request &request) {
  storage_query_result result{};
  result.query = request.query;
  result.limit = request.limit;
  result.range = request.range;
  if (!request.entry_kind.empty()) {
    result.entry_kind = request.entry_kind;
  }

  const bool episode_query =
      request.query == storage_query_kind::Episodes || request.query == storage_query_kind::EpisodeRecords ||
      request.query == storage_query_kind::EpisodeFrames || request.query == storage_query_kind::EpisodeRefs;
  if (episode_query) {
    result.scope = "episode";
    if (request.episode_id != 0) {
      result.episode_id = request.episode_id;
    }
    result.projection_name = "episode-manifest";
    result.projection_schema = yy_storage::EPISODE_MANIFEST_SCHEMA_V1;
    result.rebuildable = false;

    const auto fold = yy_storage::episode_manifest_store(request.runtime_dir).fold_typed_records();
    if (request.query == storage_query_kind::Episodes) {
      std::vector<yy_storage::episode_current_view> rows;
      if (request.episode_id != 0) {
        const auto iter = fold.episodes.find(request.episode_id);
        if (iter != fold.episodes.end()) {
          rows.push_back(iter->second);
        }
      } else {
        for (auto iter = fold.episodes.rbegin(); iter != fold.episodes.rend(); ++iter) {
          rows.push_back(iter->second);
          if (request.limit != 0 && rows.size() >= request.limit) {
            break;
          }
        }
      }
      result.rows = std::move(rows);
      return result;
    }

    if (request.episode_id == 0) {
      throw std::invalid_argument("episode_id is required for " + storage_query_kind_name(request.query));
    }
    const auto iter = fold.episodes.find(request.episode_id);
    if (iter == fold.episodes.end()) {
      result.ok = false;
      result.errors.push_back({"episode_missing", request.episode_id});
      result.rows = std::vector<yy_storage::episode_manifest_record>{};
      return result;
    }
    const auto &view = iter->second;
    std::vector<yy_storage::episode_manifest_record> rows;
    if (request.query == storage_query_kind::EpisodeRecords) {
      rows = view.records;
    } else {
      const auto &indices = request.query == storage_query_kind::EpisodeFrames ? view.frame_indices : view.ref_indices;
      rows.reserve(indices.size());
      for (const auto index : indices) {
        rows.push_back(view.records.at(index));
      }
    }
    if (request.limit != 0 && rows.size() > request.limit) {
      rows.resize(request.limit);
    }
    result.rows = std::move(rows);
    return result;
  }

  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }
  result.projection_name = "manifest-catalog";
  result.projection_schema = yy_storage::MANIFEST_CATALOG_SCHEMA_V1;
  result.rebuildable = true;

  // Generic storage queries serve straight from the typed kernel journal
  // records. SQLite remains a derived projection used for parity/SQL access,
  // never the authority or an intermediate JSON query substrate.
  const auto records = catalog_store(request.runtime_dir).read_typed_records();
  const auto limit = request.limit == 0 ? uint64_t{1000} : std::min<uint64_t>(request.limit, 1000);
  std::map<uint64_t, std::vector<size_t>> manifests_by_source;
  for (size_t index = 0; index < records.manifests.size(); ++index) {
    manifests_by_source[records.manifests[index].source_uid].push_back(index);
  }

  if (request.query == storage_query_kind::Sources) {
    std::vector<storage_source_query_row> rows;
    for (const auto &[source_uid, indices] : manifests_by_source) {
      const auto &latest = records.manifests.at(indices.back());
      const auto source_id = std::string(latest.source_id.value);
      if (!request.source_id.empty() && source_id != request.source_id) {
        continue;
      }
      uint64_t export_count = 0;
      for (const auto &receipt : records.exports) {
        export_count += receipt.source_uid == source_uid ? 1 : 0;
      }
      rows.push_back({source_uid,
                      source_id,
                      std::string(latest.source_type.value),
                      std::string(latest.source_coordinate.value),
                      std::string(latest.manifest_id.value),
                      std::string(latest.source_head.value),
                      latest.accept_time,
                      latest.entry_count,
                      {std::string(latest.sync_root_algo.value), std::string(latest.sync_root_value.value)},
                      indices.size(),
                      export_count});
      if (rows.size() >= limit) {
        break;
      }
    }
    result.rows = std::move(rows);
    return result;
  }

  if (request.query == storage_query_kind::Manifests) {
    std::vector<storage_manifest_query_row> rows;
    for (const auto &[source_uid, indices] : manifests_by_source) {
      (void)source_uid;
      const auto source_id = std::string(records.manifests.at(indices.back()).source_id.value);
      if (!request.source_id.empty() && source_id != request.source_id) {
        continue;
      }
      for (const auto index : indices) {
        const auto &record = records.manifests.at(index);
        rows.push_back({source_id,
                        std::string(record.manifest_id.value),
                        record.accept_time,
                        record.entry_count,
                        std::string(record.entries_hash.value),
                        {std::string(record.sync_root_algo.value), std::string(record.sync_root_value.value)},
                        verification_status_text(record.status)});
        if (rows.size() >= limit) {
          break;
        }
      }
      if (rows.size() >= limit) {
        break;
      }
    }
    result.rows = std::move(rows);
    return result;
  }

  if (request.query != storage_query_kind::Entries) {
    throw std::invalid_argument("unsupported storage query: " + storage_query_kind_name(request.query));
  }
  std::unordered_map<uint64_t, size_t> latest_by_manifest_uid;
  for (size_t index = 0; index < records.manifests.size(); ++index) {
    latest_by_manifest_uid[records.manifests[index].manifest_uid] = index;
  }
  std::vector<storage_entry_query_row> rows;
  for (const auto &record : records.entries) {
    const auto header_iter = latest_by_manifest_uid.find(record.manifest_uid);
    if (header_iter == latest_by_manifest_uid.end()) {
      continue;
    }
    const auto &header = records.manifests.at(header_iter->second);
    if (record.accept_time != header.accept_time) {
      continue;
    }
    storage_entry_query_row row{std::string(record.kind.value),
                                std::string(record.entry_source_id.value),
                                std::string(record.source_path.value),
                                std::string(record.source_time.value),
                                record.entry_schema_version,
                                std::string(record.content_type.value),
                                std::string(record.payload_hash.value),
                                record.byte_len,
                                payload_state_text(record.payload_state),
                                record.entry_index,
                                record.accept_time,
                                std::string(header.source_id.value),
                                std::string(header.manifest_id.value)};
    if (!request.source_id.empty() && row.storage_source_id != request.source_id) {
      continue;
    }
    if (!request.entry_kind.empty() && row.kind != request.entry_kind) {
      continue;
    }
    if ((!request.range.since.empty() || !request.range.until.empty()) && row.source_time.empty()) {
      continue;
    }
    if (!request.range.since.empty() && row.source_time < request.range.since) {
      continue;
    }
    if (!request.range.until.empty() && row.source_time > request.range.until) {
      continue;
    }
    rows.push_back(std::move(row));
    if (rows.size() >= limit) {
      break;
    }
  }
  result.rows = std::move(rows);
  return result;
}

// Stage 3 deep verification (ADR-0041 point 4, ADR-0023/0028): re-open the
// event journals the manifest claims frames from and verify each attached
// frame receipt against the actual frame — presence, header fields, and the
// recomputed payload/frame checksums. Opt-in via the fsck "verify_frames"
// option because it reads every referenced journal. A sealed (Ended) Episode
// with a missing or mismatched frame is failed; an open/aborted Episode is
// degraded with the exact missing side reported.
struct episode_frame_verification {
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  size_t verified = 0;
  bool degraded = false;
};

episode_frame_verification verify_episode_frame_claims(const storage_service_options &options) {
  namespace yjj = kungfu::yijinjing;
  episode_frame_verification result;
  const auto fold = episode_store(options).fold_typed_records();

  auto locator = std::make_shared<yjj::data::locator>(options.runtime_dir, yy_enums::mode::LIVE);
  std::unordered_map<uint32_t, yjj::data::location_ptr> locations_by_uid;
  for (const auto &location : locator->list_locations("*", "*", "*", "*")) {
    locations_by_uid.emplace(location->uid, location);
  }

  struct claim_context {
    uint64_t episode_id = 0;
    bool sealed = false;
    yjj::types::EpisodeFrameAttached claim = {};
  };
  std::map<std::pair<uint32_t, uint32_t>, std::vector<claim_context>> journals;
  for (const auto &[episode_id, view] : fold.episodes) {
    if (options.episode_id != 0 && episode_id != options.episode_id) {
      continue;
    }
    const bool sealed = view.closed && view.close.status == yy_enums::EpisodeStatus::Ended;
    for (size_t position = 0; position < view.frame_indices.size(); ++position) {
      const auto &claim = view.frame_at(position);
      if (claim.frame_uid == 0) {
        continue;
      }
      journals[{claim.source, claim.dest}].push_back({episode_id, sealed, claim});
    }
  }

  auto report_presence_issue = [&result](bool sealed, nlohmann::json issue) {
    if (sealed) {
      result.errors.push_back(std::move(issue));
    } else {
      result.warnings.push_back(std::move(issue));
      result.degraded = true;
    }
  };

  for (auto &[journal_key, claims] : journals) {
    const auto source_uid = journal_key.first;
    const auto dest_uid = journal_key.second;
    const auto location_iter = locations_by_uid.find(source_uid);
    if (location_iter == locations_by_uid.end()) {
      for (const auto &context : claims) {
        report_presence_issue(context.sealed, {{"code", "episode_frame_location_unknown"},
                                               {"episode_id", context.episode_id},
                                               {"frame_uid", context.claim.frame_uid},
                                               {"location_uid", source_uid}});
      }
      continue;
    }
    const auto &location = location_iter->second;

    std::unordered_map<uint64_t, std::vector<const claim_context *>> wanted;
    for (const auto &context : claims) {
      wanted[context.claim.frame_uid].push_back(&context);
    }

    std::unordered_set<uint64_t> found;
    if (!location->locator->list_page_id(location, dest_uid).empty()) {
      auto reader = std::make_shared<yjj::journal::reader>(true, false, std::make_shared<yjj::journal::bus>(false));
      reader->join(location, dest_uid, 0);
      while (reader->data_available()) {
        const auto frame = reader->current_frame();
        const auto wanted_iter = wanted.find(frame->frame_uid());
        if (wanted_iter != wanted.end() && found.insert(frame->frame_uid()).second) {
          const auto &header = *reinterpret_cast<const yjj::types::frame_header *>(frame->address());
          const auto *payload = static_cast<const uint8_t *>(frame->data_address());
          for (const auto *context : wanted_iter->second) {
            const auto &claim = context->claim;
            nlohmann::json fields = nlohmann::json::array();
            if (header.carrier_type != claim.carrier_type) {
              fields.push_back(
                  {{"field", "carrier_type"}, {"claimed", claim.carrier_type}, {"actual", header.carrier_type}});
            }
            if (header.gen_time != claim.gen_time) {
              fields.push_back({{"field", "gen_time"}, {"claimed", claim.gen_time}, {"actual", header.gen_time}});
            }
            if (header.trigger_frame_uid != claim.trigger_frame_uid) {
              fields.push_back({{"field", "trigger_frame_uid"},
                                {"claimed", claim.trigger_frame_uid},
                                {"actual", header.trigger_frame_uid}});
            }
            if (frame->data_length() < claim.data_length) {
              fields.push_back(
                  {{"field", "data_length"}, {"claimed", claim.data_length}, {"actual", frame->data_length()}});
            }
            if (!fields.empty()) {
              result.errors.push_back({{"code", "episode_attached_frame_mismatch"},
                                       {"episode_id", context->episode_id},
                                       {"frame_uid", claim.frame_uid},
                                       {"fields", fields}});
              continue;
            }
            if (claim.integrity_version == 0) {
              ++result.verified;
              continue;
            }
            std::string algorithm;
            try {
              algorithm = action::frame_checksum_algorithm_for_integrity_version(claim.integrity_version);
            } catch (const std::exception &) {
              report_presence_issue(context->sealed, {{"code", "episode_frame_integrity_version_unknown"},
                                                      {"episode_id", context->episode_id},
                                                      {"frame_uid", claim.frame_uid},
                                                      {"integrity_version", claim.integrity_version}});
              continue;
            }
            const auto payload_checksum = action::checksum_payload(payload, claim.data_length, algorithm);
            const auto frame_checksum = action::checksum_frame(header, payload, claim.data_length, algorithm);
            if (payload_checksum != claim.payload_checksum || frame_checksum != claim.frame_checksum) {
              result.errors.push_back({{"code", "episode_attached_frame_checksum_mismatch"},
                                       {"episode_id", context->episode_id},
                                       {"frame_uid", claim.frame_uid},
                                       {"claimed_payload_checksum", claim.payload_checksum},
                                       {"actual_payload_checksum", payload_checksum},
                                       {"claimed_frame_checksum", claim.frame_checksum},
                                       {"actual_frame_checksum", frame_checksum}});
              continue;
            }
            ++result.verified;
          }
        }
        reader->next();
      }
    }
    for (const auto &context : claims) {
      if (found.count(context.claim.frame_uid) == 0) {
        report_presence_issue(context.sealed, {{"code", "episode_attached_frame_missing"},
                                               {"episode_id", context.episode_id},
                                               {"frame_uid", context.claim.frame_uid},
                                               {"location_uid", context.claim.source},
                                               {"dest", context.claim.dest}});
      }
    }
  }
  return result;
}

struct episode_repair_descriptor {
  std::string action = {};
  std::vector<std::string> required_inputs = {};
};

std::optional<episode_repair_descriptor> episode_repair_descriptor_for_issue(const nlohmann::json &issue) {
  const auto code = text_or(issue, "code");
  if (code == "episode_dependency_missing") {
    return episode_repair_descriptor{"fetch_episode", {"source_or_episode_bundle"}};
  }
  if (code == "episode_root_trigger_frame_missing" || code == "episode_trigger_frame_missing") {
    return episode_repair_descriptor{"fetch_frame_or_declare_external_input", {"source_or_episode_bundle"}};
  }
  if (code == "episode_payload_ref_missing" || code == "episode_payload_ref_hash_mismatch") {
    return episode_repair_descriptor{"fetch_payload_by_hash", {"payload_store_or_episode_bundle"}};
  }
  if (code == "episode_attached_frame_missing") {
    return episode_repair_descriptor{"fetch_frame", {"source_or_episode_bundle"}};
  }
  if (code == "episode_projection_absent" || code == "episode_projection_drift") {
    return episode_repair_descriptor{"rebuild_projection", {}};
  }
  if (code == "payload_not_present" && !bool_or(issue, "intentional", true)) {
    return episode_repair_descriptor{"fetch_payload_by_hash", {"source_or_bundle"}};
  }
  return std::nullopt;
}

std::string episode_issue_evidence(const std::string &code) {
  if (code.rfind("episode_payload_ref_", 0) == 0) {
    return "content";
  }
  if (code.rfind("episode_attached_frame_", 0) == 0 || code == "episode_frame_location_unknown" ||
      code == "episode_frame_integrity_version_unknown") {
    return "frames";
  }
  if (code == "episode_dependency_missing" || code == "episode_root_trigger_frame_missing" ||
      code == "episode_trigger_frame_missing") {
    return "causal_closure";
  }
  if (code.rfind("episode_projection_", 0) == 0) {
    return "projection";
  }
  return "manifest_integrity";
}

void append_unique(std::vector<std::string> &values, const std::string &value) {
  if (std::find(values.begin(), values.end(), value) == values.end()) {
    values.push_back(value);
  }
}

episode_qualification_evidence *find_episode_evidence(episode_qualification_result &result, const std::string &name) {
  const auto iter = std::find_if(result.evidence.begin(), result.evidence.end(),
                                 [&name](const auto &entry) { return entry.name == name; });
  return iter == result.evidence.end() ? nullptr : &*iter;
}

const episode_qualification_evidence *find_episode_evidence(const episode_qualification_result &result,
                                                            const std::string &name) {
  const auto iter = std::find_if(result.evidence.begin(), result.evidence.end(),
                                 [&name](const auto &entry) { return entry.name == name; });
  return iter == result.evidence.end() ? nullptr : &*iter;
}

episode_qualification_capability make_episode_capability(const std::string &name,
                                                         std::vector<std::pair<std::string, bool>> requirements) {
  episode_qualification_capability capability;
  capability.name = name;
  capability.safe = true;
  for (const auto &[requirement, satisfied] : requirements) {
    capability.required_evidence.push_back(requirement);
    if (!satisfied) {
      capability.safe = false;
      capability.blocked_by.push_back(requirement);
    }
  }
  return capability;
}

episode_qualification_result make_episode_qualification(const nlohmann::json &report, bool frames_checked) {
  episode_qualification_result result;
  result.episode_id = uint64_or(report, "episode_id");
  result.status = text_or(report, "status", "failed");
  const auto manifest_report = object_or_empty(report, "episode_manifest");
  const auto episode = object_or_empty(manifest_report, "episode");
  const bool exists = !episode.empty();
  result.lifecycle = exists ? text_or(episode, "status", "dangling") : "missing";
  const auto frame_count = uint64_or(episode, "frame_count");
  const auto payload_ref_count = uint64_or(episode, "payload_ref_count");
  const auto schema_ref_count = uint64_or(episode, "schema_ref_count");

  result.evidence = {
      {"manifest_records", exists ? "verified" : "failed", {}},
      {"manifest_integrity", exists ? "verified" : "failed", {}},
      {"causal_closure", exists ? "verified" : "failed", {}},
      {"content", payload_ref_count == 0 ? "not_applicable" : "verified", {}},
      {"frames", frame_count == 0 ? "not_applicable" : (frames_checked ? "verified" : "not_checked"), {}},
      {"schemas", schema_ref_count == 0 ? "not_applicable" : "not_checked", {}},
      {"projection", "not_checked", {}},
  };

  const auto add_issue = [&result](const nlohmann::json &detail, const std::string &severity) {
    episode_qualification_issue issue;
    issue.severity = severity;
    issue.code = text_or(detail, "code", "episode_issue_unknown");
    issue.evidence = episode_issue_evidence(issue.code);
    issue.detail = detail;
    result.issues.push_back(issue);
    if (auto *evidence = find_episode_evidence(result, issue.evidence); evidence != nullptr) {
      append_unique(evidence->issue_codes, issue.code);
      if (severity == "error") {
        evidence->state = "failed";
      } else if (severity == "warning" && evidence->state != "failed") {
        evidence->state = "degraded";
      }
    }
  };
  for (const auto &error : array_or_empty(report, "errors")) {
    add_issue(error, "error");
  }
  for (const auto &warning : array_or_empty(report, "warnings")) {
    add_issue(warning, "warning");
  }

  const auto projection = object_or_empty(report, "episode_projection");
  const auto projection_status = text_or(projection, "status", "not_checked");
  if (auto *evidence = find_episode_evidence(result, "projection"); evidence != nullptr) {
    if (!exists) {
      evidence->state = "not_applicable";
    } else if (projection_status == "ok") {
      evidence->state = "verified";
    } else if (projection_status == "absent") {
      evidence->state = "missing";
      add_issue({{"code", "episode_projection_absent"}, {"status", projection_status}}, "info");
    } else if (projection_status == "degraded") {
      evidence->state = "degraded";
      add_issue({{"code", "episode_projection_drift"},
                 {"status", projection_status},
                 {"drift", projection.value("drift", nlohmann::json::array())}},
                "warning");
    } else {
      evidence->state = "failed";
      add_issue({{"code", "episode_projection_unavailable"}, {"status", projection_status}}, "error");
    }
  }

  const auto state = [&result](const std::string &name) {
    const auto *evidence = find_episode_evidence(result, name);
    return evidence == nullptr ? std::string("missing") : evidence->state;
  };
  const auto verified = [&state](const std::string &name) { return state(name) == "verified"; };
  const auto verified_or_not_applicable = [&state](const std::string &name) {
    const auto value = state(name);
    return value == "verified" || value == "not_applicable";
  };
  const bool records_readable = verified("manifest_records");
  const bool manifest_valid = verified("manifest_integrity");
  result.capabilities = {
      make_episode_capability("inspect", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("fsck", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("export_evidence", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("plan_repair", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("rebuild_projection", {{"manifest_records=verified", records_readable},
                                                     {"manifest_integrity=verified", manifest_valid}}),
      make_episode_capability("append", {{"lifecycle=open", result.lifecycle == "open"},
                                         {"manifest_records=verified", records_readable},
                                         {"manifest_integrity=verified", manifest_valid}}),
      make_episode_capability("replay", {{"lifecycle=ended", result.lifecycle == "ended"},
                                         {"manifest_records=verified", records_readable},
                                         {"manifest_integrity=verified", manifest_valid},
                                         {"causal_closure=verified", verified("causal_closure")},
                                         {"content=verified|not_applicable", verified_or_not_applicable("content")},
                                         {"frames=verified|not_applicable", verified_or_not_applicable("frames")},
                                         {"schemas=verified|not_applicable", verified_or_not_applicable("schemas")}}),
      make_episode_capability("depend_on",
                              {{"lifecycle=ended", result.lifecycle == "ended"},
                               {"manifest_records=verified", records_readable},
                               {"manifest_integrity=verified", manifest_valid},
                               {"causal_closure=verified", verified("causal_closure")},
                               {"content=verified|not_applicable", verified_or_not_applicable("content")},
                               {"frames=verified|not_applicable", verified_or_not_applicable("frames")},
                               {"schemas=verified|not_applicable", verified_or_not_applicable("schemas")}}),
  };

  for (const auto &issue : result.issues) {
    const auto descriptor = episode_repair_descriptor_for_issue(issue.detail);
    if (!descriptor.has_value()) {
      continue;
    }
    nlohmann::json subject = nlohmann::json::object();
    for (const auto *field :
         {"episode_id", "dependency_episode_id", "frame_uid", "dependent_frame_uid", "ref_id", "ref_hash", "role"}) {
      if (issue.detail.contains(field) && !issue.detail.at(field).is_null()) {
        subject[field] = issue.detail.at(field);
      }
    }
    result.repair_prerequisites.push_back(
        {issue.code, descriptor->action, descriptor->required_inputs, std::move(subject)});
  }
  return result;
}

nlohmann::json episode_qualification_json(const episode_qualification_result &result) {
  nlohmann::json evidence = nlohmann::json::object();
  for (const auto &entry : result.evidence) {
    evidence[entry.name] = {{"state", entry.state}, {"issue_codes", entry.issue_codes}};
  }
  nlohmann::json issues = nlohmann::json::array();
  for (const auto &issue : result.issues) {
    issues.push_back(
        {{"severity", issue.severity}, {"code", issue.code}, {"evidence", issue.evidence}, {"detail", issue.detail}});
  }
  nlohmann::json capabilities = nlohmann::json::array();
  nlohmann::json safe_capabilities = nlohmann::json::array();
  nlohmann::json contractions = nlohmann::json::array();
  for (const auto &capability : result.capabilities) {
    capabilities.push_back({{"name", capability.name},
                            {"safe", capability.safe},
                            {"requires", capability.required_evidence},
                            {"blocked_by", capability.blocked_by}});
    if (capability.safe) {
      safe_capabilities.push_back(capability.name);
    } else {
      contractions.push_back({{"capability", capability.name}, {"blocked_by", capability.blocked_by}});
    }
  }
  nlohmann::json repair_prerequisites = nlohmann::json::array();
  for (const auto &prerequisite : result.repair_prerequisites) {
    repair_prerequisites.push_back({{"issue_code", prerequisite.issue_code},
                                    {"action", prerequisite.action},
                                    {"required_inputs", prerequisite.required_inputs},
                                    {"subject", prerequisite.subject}});
  }
  return {{"schema", EPISODE_QUALIFICATION_SCHEMA_V1},
          {"policy_source", "cpp-typed-fold-fsck"},
          {"episode_id", result.episode_id},
          {"lifecycle", result.lifecycle},
          {"status", result.status},
          {"evidence", evidence},
          {"issues", issues},
          {"capabilities", capabilities},
          {"safe_capabilities", safe_capabilities},
          {"contractions", contractions},
          {"repair_prerequisites", repair_prerequisites}};
}

nlohmann::json episode_fsck_impl(const storage_service_options &options) {
  const auto scoped = episode_ref_store(options);
  const auto episode_report = scoped.store.fsck(options.episode_id);
  const auto checked = object_or_empty(episode_report, "checked");
  nlohmann::json report = {
      {"ok", episode_report.value("ok", false)},
      {"status", episode_report.value("status", episode_report.value("ok", false) ? "ok" : "failed")},
      {"scope", "episode"},
      {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
      {"degraded", episode_report.value("degraded", false)},
      {"errors", episode_report.value("errors", nlohmann::json::array())},
      {"warnings", episode_report.value("warnings", nlohmann::json::array())},
      {"checked",
       {{"sources", 0},
        {"manifests", 0},
        {"payloads", 0},
        {"schemas", 0},
        {"accepted_ranges", 0},
        {"source_records", 0},
        {"projection_indexes", 1},
        {"sqlite_projection_rows", 0},
        {"orphan_payloads", 0},
        {"episode_manifest_records", checked.value("episode_manifest_records", 0)},
        {"episodes", checked.value("episodes", 0)}}},
      {"episode_manifest", episode_report},
      {"projections", nlohmann::json::array({{{"name", "episode-manifest"},
                                              {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                                              {"authority", "yijinjing-journal"},
                                              {"path", "journal/system/storage/episode-manifest/live/*.journal"},
                                              {"rebuildable", false}},
                                             {{"name", "episode-manifest-sqlite"},
                                              {"schema", EPISODE_MANIFEST_PROJECTION_SCHEMA_V1},
                                              {"authority", "yijinjing-journal"},
                                              {"path", "storage/projections/episode-manifest.sqlite"},
                                              {"rebuildable", true}}})}};
  // ADR-0041 point 5: the SQLite projection is a derived view verified
  // against the journal; drift degrades fsck, it never fails the journal.
  auto projection_report = episode_manifest_projection(options.runtime_dir).verify();
  report["episode_projection"] = projection_report;
  if (projection_report.value("status", std::string("ok")) == "degraded" &&
      report.value("status", std::string("ok")) == "ok") {
    report["status"] = "degraded";
    report["degraded"] = true;
  }
  if (bool_or(options.operation_options, "verify_frames", false)) {
    auto verification = verify_episode_frame_claims(options);
    for (auto &error : verification.errors) {
      report["errors"].push_back(std::move(error));
    }
    for (auto &warning : verification.warnings) {
      report["warnings"].push_back(std::move(warning));
    }
    report["checked"]["episode_frames_verified"] = verification.verified;
    const bool ok = report["errors"].empty();
    const bool degraded = report.value("degraded", false) || verification.degraded;
    report["ok"] = ok;
    report["degraded"] = degraded;
    report["status"] = ok ? (degraded ? "degraded" : "ok") : "failed";
  }
  if (options.episode_id != 0) {
    report["qualification"] = episode_qualification_json(
        make_episode_qualification(report, bool_or(options.operation_options, "verify_frames", false)));
  }
  return report;
}

nlohmann::json episode_export_bundle_impl(const storage_service_options &options) {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required for episode export");
  }
  const auto scoped = episode_ref_store(options);
  const auto inspected = scoped.store.inspect(options.episode_id);
  if (!inspected.value("ok", false)) {
    throw std::runtime_error("episode not found: " + std::to_string(options.episode_id));
  }
  const auto episode = object_or_empty(inspected, "episode");
  const auto records = inspected.value("records", nlohmann::json::array());
  const auto frames = inspected.value("frames", nlohmann::json::array());
  const auto refs = inspected.value("refs", nlohmann::json::array());
  const auto dependencies = inspected.value("dependencies", nlohmann::json::array());
  const auto causal_graph = inspected.value("causal_graph", nlohmann::json::object());
  return {{"schema", "kungfu.storage.episode-bundle/v1"},
          {"bundle_id", "episode:" + std::to_string(options.episode_id)},
          {"scope", "episode"},
          {"episode_id", options.episode_id},
          {"authority", "yijinjing-journal"},
          {"manifest", episode},
          {"causal_graph", causal_graph},
          {"records", records},
          {"frames", frames},
          {"refs", refs},
          {"dependencies", dependencies},
          {"degraded", causal_graph.value("degraded", false)},
          {"record_count", records.size()},
          {"frame_count", frames.size()},
          {"ref_count", refs.size()},
          {"dependency_count", dependencies.size()}};
}

nlohmann::json fsck_impl(const storage_service_options &options);
nlohmann::json episode_import_bundle_impl(const storage_service_options &options);
nlohmann::json accept_storage_manifest_impl(const std::string &runtime_dir, const nlohmann::json &input);
nlohmann::json export_bundle_generic_impl(const storage_service_options &options, bool record_receipt);

nlohmann::json repair_candidate_common(const nlohmann::json &warning, const std::string &code, const std::string &kind,
                                       const std::string &role, const std::string &action,
                                       nlohmann::json required_inputs) {
  nlohmann::json candidate = {
      {"code", code},           {"issue_code", text_or(warning, "code")},
      {"kind", kind},           {"role", role},
      {"action", action},       {"suggested_action", action},
      {"safe_to_apply", false}, {"requires", std::move(required_inputs)},
      {"warning", warning},
  };
  for (const auto *field : {"episode_id", "dependency_episode_id", "frame_uid", "dependent_frame_uid", "ref_id",
                            "ref_hash", "source_id", "subject", "state", "path", "payload_hash"}) {
    if (warning.contains(field) && !warning.at(field).is_null()) {
      candidate[field] = warning.at(field);
    }
  }
  return candidate;
}

nlohmann::json repair_candidate_from_warning(const nlohmann::json &warning) {
  const auto code = text_or(warning, "code");
  const auto descriptor = episode_repair_descriptor_for_issue(warning);
  if (!descriptor.has_value()) {
    return nullptr;
  }
  std::string candidate_code;
  std::string kind;
  std::string role;
  if (code == "episode_dependency_missing") {
    candidate_code = "repair_episode_dependency";
    kind = "episode";
    role = text_or(warning, "role", "ref");
  } else if (code == "episode_root_trigger_frame_missing") {
    candidate_code = "repair_episode_root_trigger_frame";
    kind = "frame";
    role = "root_trigger";
  } else if (code == "episode_trigger_frame_missing") {
    candidate_code = "repair_episode_trigger_frame";
    kind = "frame";
    role = "trigger";
  } else if (code == "episode_payload_ref_missing" || code == "episode_payload_ref_hash_mismatch") {
    candidate_code = "repair_episode_payload_ref";
    kind = "payload";
    role = "payload_ref";
  } else if (code == "payload_not_present") {
    candidate_code = "repair_source_payload";
    kind = "payload";
    role = "source_record";
  } else {
    // Projection repair is exposed by the qualification contract through the
    // dedicated rebuild operation, not as a storage repair-plan bundle row.
    return nullptr;
  }
  return repair_candidate_common(warning, candidate_code, kind, role, descriptor->action,
                                 nlohmann::json(descriptor->required_inputs));
}

nlohmann::json repair_plan_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_repair_requires_dry_run");
  }
  const auto report = fsck_impl(options);
  nlohmann::json candidates = nlohmann::json::array();
  nlohmann::json unsupported = nlohmann::json::array();
  for (const auto &warning : array_or_empty(report, "warnings")) {
    const auto candidate = repair_candidate_from_warning(warning);
    if (candidate.is_null()) {
      unsupported.push_back(warning);
    } else {
      candidates.push_back(candidate);
    }
  }
  // Sealed-Episode payload-ref issues are errors (the seal is falsified), and
  // they are exactly the issues repair material can satisfy; other error
  // codes are structural manifest defects, not fetchable facts.
  for (const auto &error : array_or_empty(report, "errors")) {
    const auto candidate = repair_candidate_from_warning(error);
    if (!candidate.is_null()) {
      candidates.push_back(candidate);
    }
  }
  return {{"ok", report.value("ok", false)},
          {"schema", "kungfu.storage.repair-plan/v1"},
          {"scope", report.value("scope", options.scope.empty() ? "all" : options.scope)},
          {"source_id", report.contains("source_id") ? report.at("source_id") : nlohmann::json(nullptr)},
          {"episode_id", report.contains("episode_id") ? report.at("episode_id") : nlohmann::json(nullptr)},
          {"dry_run", true},
          {"plan_only", true},
          {"status", report.value("status", report.value("ok", false) ? "ok" : "failed")},
          {"degraded", report.value("degraded", false)},
          {"candidate_count", candidates.size()},
          {"candidates", candidates},
          {"unsupported", unsupported},
          {"fsck", report},
          {"notes", nlohmann::json::array({
                        "Repair plan v1 is read-only and never fetches, deletes, compacts, or mutates storage.",
                        "Candidates describe missing facts that a future importer or remote sync source may provide.",
                    })}};
}

bool episode_record_kind_supported(const std::string &kind) {
  return kind == "episode_open" || kind == "episode_heartbeat" || kind == "episode_frame_attached" ||
         kind == "episode_ref_attached" || kind == "episode_closed" || kind == "episode_root_committed";
}

std::string episode_record_identity_key(const nlohmann::json &record) {
  const auto kind = text_or(record, "record_kind");
  const auto episode_id = std::to_string(uint64_or(record, "episode_id"));
  if (kind == "episode_open" || kind == "episode_closed" || kind == "episode_root_committed") {
    return kind + ":" + episode_id;
  }
  if (kind == "episode_frame_attached") {
    return kind + ":" + episode_id + ":" + std::to_string(uint64_or(record, "frame_uid"));
  }
  if (kind == "episode_ref_attached") {
    return kind + ":" + episode_id + ":" + text_or(record, "ref_kind") + ":" +
           std::to_string(uint64_or(record, "ref_uid")) + ":" + text_or(record, "ref_id") + ":" +
           text_or(record, "ref_hash");
  }
  return canonical_json(record);
}

nlohmann::json episode_apply_record(const storage_service_options &options, const nlohmann::json &record) {
  const auto kind = text_or(record, "record_kind");
  if (kind == "episode_open") {
    return episode_store(options).begin(parse_episode_begin_options(record));
  }
  if (kind == "episode_heartbeat") {
    return episode_store(options).heartbeat(parse_episode_heartbeat_options(record));
  }
  if (kind == "episode_frame_attached") {
    return episode_store(options).attach_frame(parse_episode_frame_attach_options(record));
  }
  if (kind == "episode_ref_attached") {
    return episode_store(options).attach_ref(parse_episode_ref_attach_options(record));
  }
  if (kind == "episode_closed") {
    return episode_store(options).end(parse_episode_close_options(record, yy_enums::EpisodeStatus::Ended));
  }
  if (kind == "episode_root_committed") {
    // ADR-0043: the destination's root is committed by its own seal path (the
    // episode_closed apply above); the bundle's root record is carried through
    // as the source's identity claim for comparison, never re-appended — a
    // root must commit to the sequence its own store recorded, and a second
    // root record would only be a duplicate-root diagnostic.
    auto row = record;
    row["applied"] = "source_identity_claim";
    return row;
  }
  return nullptr;
}

nlohmann::json apply_episode_bundle_material(const storage_service_options &options, const nlohmann::json &bundle,
                                             bool write) {
  auto validation_options = options;
  validation_options.scope = "episode";
  validation_options.dry_run = true;
  validation_options.bundle = bundle;
  const auto validated = episode_import_bundle_impl(validation_options);
  const auto bundle_episode_id =
      uint64_or(bundle, "episode_id", uint64_or(object_or_empty(bundle, "manifest"), "episode_id"));
  nlohmann::json existing_keys = nlohmann::json::array();
  std::vector<std::string> seen;
  if (bundle_episode_id != 0) {
    const auto scoped = episode_ref_store(options);
    const auto inspected = scoped.store.inspect(bundle_episode_id);
    for (const auto &existing : array_or_empty(inspected, "records")) {
      const auto key = episode_record_identity_key(existing);
      seen.push_back(key);
      existing_keys.push_back(key);
    }
  }
  nlohmann::json applied = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json rejected = nlohmann::json::array();
  if (write) {
    for (const auto &record : array_or_empty(bundle, "records")) {
      const auto kind = text_or(record, "record_kind");
      if (kind.empty()) {
        rejected.push_back({{"kind", "episode_record"}, {"reason", "record_kind_missing"}, {"record", record}});
      } else if (!episode_record_kind_supported(kind)) {
        rejected.push_back({{"kind", "episode_record"}, {"reason", "unsupported_record_kind"}, {"record_kind", kind}});
      }
    }
    if (!rejected.empty()) {
      return {{"kind", "episode_bundle"},
              {"schema", text_or(bundle, "schema")},
              {"episode_id", bundle_episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(bundle_episode_id)},
              {"validated", validated},
              {"existing_record_keys", existing_keys},
              {"applied", applied},
              {"skipped", skipped},
              {"rejected", rejected}};
    }
  }
  for (const auto &record : array_or_empty(bundle, "records")) {
    const auto key = episode_record_identity_key(record);
    if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
      skipped.push_back({{"kind", "episode_record"}, {"reason", "already_present"}, {"record", record}});
      continue;
    }
    const auto kind = text_or(record, "record_kind");
    if (kind.empty()) {
      rejected.push_back({{"kind", "episode_record"}, {"reason", "record_kind_missing"}, {"record", record}});
      continue;
    }
    if (write) {
      const auto written = episode_apply_record(options, record);
      if (written.is_null()) {
        rejected.push_back({{"kind", "episode_record"}, {"reason", "unsupported_record_kind"}, {"record_kind", kind}});
        continue;
      }
      applied.push_back({{"kind", "episode_record"}, {"record_kind", kind}, {"record", written}});
    } else {
      if (!episode_record_kind_supported(kind)) {
        rejected.push_back({{"kind", "episode_record"}, {"reason", "unsupported_record_kind"}, {"record_kind", kind}});
        continue;
      }
      applied.push_back({{"kind", "episode_record"}, {"record_kind", kind}, {"record", record}, {"dry_run", true}});
    }
  }
  return {{"kind", "episode_bundle"},
          {"schema", text_or(bundle, "schema")},
          {"episode_id", bundle_episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(bundle_episode_id)},
          {"validated", validated},
          {"existing_record_keys", existing_keys},
          {"applied", applied},
          {"skipped", skipped},
          {"rejected", rejected}};
}

nlohmann::json apply_source_bundle_material(const storage_service_options &options, const nlohmann::json &bundle,
                                            bool write) {
  auto source_id = options.source_id.empty() ? text_or(bundle, "source_id") : options.source_id;
  if (source_id.empty()) {
    source_id = text_or(object_or_empty(bundle, "manifest"), "source_id");
  }
  if (source_id.empty()) {
    throw std::invalid_argument("repair_apply_source_id_required");
  }
  const auto provider = shared_provider(options);
  auto manifest = load_latest_manifest_impl(options.runtime_dir, *provider, source_id);
  if (manifest.is_null()) {
    throw std::runtime_error("manifest not found: " + source_id);
  }
  auto entries = entries_for_manifest(manifest);
  nlohmann::json applied = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json rejected = nlohmann::json::array();
  bool manifest_changed = false;
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (!record.is_object() || !record.contains("payload")) {
      skipped.push_back({{"kind", "payload"}, {"reason", "payload_missing_in_material"}, {"record", record}});
      continue;
    }
    const auto raw = canonical_json(record.at("payload"));
    auto digest = text_or(record, "payload_hash");
    if (digest.empty()) {
      digest = yy_storage::compute_content_hash_value(raw, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    }
    const auto error =
        yy_storage::verify_payload_ref(raw, digest, raw.size(), yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    if (!error.empty()) {
      rejected.push_back({{"kind", "payload"}, {"reason", error}, {"payload_hash", digest}});
      continue;
    }
    bool matched = false;
    for (auto &entry : entries) {
      if (!entry.is_object() || text_or(entry, "payload_hash") != digest) {
        continue;
      }
      matched = true;
      if (text_or(entry, "payload_state") == PAYLOAD_STATE_PRESENT && provider->payload_exists(digest)) {
        skipped.push_back({{"kind", "payload"}, {"reason", "already_present"}, {"payload_hash", digest}});
        continue;
      }
      if (text_or(entry, "payload_state") == PAYLOAD_STATE_REDACTED ||
          text_or(entry, "payload_state") == PAYLOAD_STATE_ABSENT) {
        skipped.push_back({{"kind", "payload"}, {"reason", "intentional_non_present_state"}, {"payload_hash", digest}});
        continue;
      }
      if (write) {
        provider->write_payload(digest, raw);
      }
      entry["payload_state"] = PAYLOAD_STATE_PRESENT;
      entry["byte_len"] = raw.size();
      if (text_or(entry, "content_type").empty()) {
        entry["content_type"] = CONTENT_TYPE_JSON;
      }
      manifest_changed = true;
      applied.push_back({{"kind", "payload"},
                         {"payload_hash", digest},
                         {"subject", text_or(entry, "kind") + ":" + text_or(entry, "source_id")},
                         {"dry_run", !write}});
    }
    if (!matched) {
      rejected.push_back({{"kind", "payload"}, {"reason", "manifest_entry_missing"}, {"payload_hash", digest}});
    }
  }
  nlohmann::json accepted = nullptr;
  if (write && manifest_changed) {
    // A repair is a fresh acceptance: new manifest id, entries as repaired,
    // sync root recomputed at acceptance. History stays append-only.
    accepted = accept_storage_manifest_impl(
        options.runtime_dir, {
                                 {"manifest_id", text_or(manifest, "manifest_id") + ".repair"},
                                 {"storage_source_id", source_id},
                                 {"source_type", text_or(manifest, "source_type")},
                                 {"source_coordinate", text_or(object_or_empty(manifest, "source"), "coordinate")},
                                 {"source_head", text_or(manifest, "source_head")},
                                 {"scope", text_or(manifest, "scope")},
                                 {"range", object_or_empty(manifest, "range")},
                                 {"entries", entries},
                             });
  }
  return {{"kind", "source_bundle"},
          {"schema", text_or(bundle, "schema")},
          {"source_id", source_id},
          {"manifest_changed", manifest_changed},
          {"accepted_manifest", accepted},
          {"applied", applied},
          {"skipped", skipped},
          {"rejected", rejected}};
}

nlohmann::json repair_apply_impl(const storage_service_options &options) {
  const auto write = !options.dry_run;
  auto plan_options = options;
  plan_options.dry_run = true;
  const auto plan = repair_plan_impl(plan_options);
  auto material = options.bundle;
  if (material.empty()) {
    material = object_or_empty(options.operation_options, "repair_input");
  }
  if (material.empty()) {
    material = object_or_empty(options.operation_options, "material");
  }
  if (material.empty()) {
    throw std::invalid_argument("repair_apply_material_required");
  }
  nlohmann::json groups = nlohmann::json::array();
  const auto apply_one = [&](const nlohmann::json &item) {
    const auto schema = text_or(item, "schema");
    if (schema == "kungfu.storage.episode-bundle/v1") {
      return apply_episode_bundle_material(options, item, write);
    }
    if (schema == yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1) {
      return apply_source_bundle_material(options, item, write);
    }
    return nlohmann::json{{"kind", "unknown"},
                          {"schema", schema},
                          {"rejected", nlohmann::json::array({{{"reason", "unsupported_material_schema"}}})}};
  };
  if (material.contains("episode_bundles") || material.contains("source_bundles")) {
    for (const auto &bundle : array_or_empty(material, "episode_bundles")) {
      groups.push_back(apply_one(bundle));
    }
    for (const auto &bundle : array_or_empty(material, "source_bundles")) {
      groups.push_back(apply_one(bundle));
    }
  } else {
    groups.push_back(apply_one(material));
  }
  size_t applied_count = 0;
  size_t skipped_count = 0;
  size_t rejected_count = 0;
  for (const auto &group : groups) {
    applied_count += array_or_empty(group, "applied").size();
    skipped_count += array_or_empty(group, "skipped").size();
    rejected_count += array_or_empty(group, "rejected").size();
  }
  return {{"ok", rejected_count == 0},
          {"schema", "kungfu.storage.repair-apply/v1"},
          {"scope", options.scope.empty() ? "all" : options.scope},
          {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
          {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
          {"dry_run", options.dry_run},
          {"applied", write},
          {"status", rejected_count == 0 ? (write ? "applied" : "validated") : "rejected"},
          {"plan", plan},
          {"groups", groups},
          {"applied_count", applied_count},
          {"skipped_count", skipped_count},
          {"rejected_count", rejected_count},
          {"notes", nlohmann::json::array({
                        "Repair apply v1 only consumes locally supplied material.",
                        "It never fetches remote data, deletes, compacts, or garbage-collects storage.",
                    })}};
}

struct repair_evidence_runtime {
  std::string source = {};
  fs::path runtime_dir = {};
};

std::string normalized_runtime_key(const fs::path &path) {
  std::error_code ec;
  auto normalized = fs::weakly_canonical(path, ec);
  if (ec) {
    normalized = fs::absolute(path, ec);
  }
  return normalized.lexically_normal().string();
}

void push_evidence_runtime(std::vector<repair_evidence_runtime> &runtimes, const std::string &source,
                           const fs::path &runtime_dir) {
  if (runtime_dir.empty()) {
    return;
  }
  const auto key = normalized_runtime_key(runtime_dir);
  for (const auto &existing : runtimes) {
    if (normalized_runtime_key(existing.runtime_dir) == key) {
      return;
    }
  }
  runtimes.push_back({source, runtime_dir});
}

std::vector<repair_evidence_runtime> repair_evidence_runtimes(const storage_service_options &options) {
  std::vector<repair_evidence_runtime> runtimes;
  push_evidence_runtime(runtimes, "local-runtime", options.runtime_dir);
  const auto remotes_dir = fs::path(options.runtime_dir) / "remotes";
  std::error_code ec;
  if (fs::exists(remotes_dir, ec) && fs::is_directory(remotes_dir, ec)) {
    for (const auto &entry : fs::directory_iterator(remotes_dir, ec)) {
      if (ec) {
        break;
      }
      if (!entry.is_directory(ec)) {
        continue;
      }
      const auto runtime_dir = entry.path() / "runtime";
      if (fs::exists(runtime_dir, ec) && fs::is_directory(runtime_dir, ec)) {
        push_evidence_runtime(runtimes, "remote-mirror:" + entry.path().filename().string(), runtime_dir);
      }
    }
  }
  for (const auto &extra : array_or_empty(options.operation_options, "candidate_runtime_dirs")) {
    if (extra.is_string()) {
      push_evidence_runtime(runtimes, "explicit-runtime", extra.get<std::string>());
    }
  }
  return runtimes;
}

bool source_bundle_has_payload(const nlohmann::json &bundle, const std::string &payload_hash) {
  if (payload_hash.empty()) {
    return !array_or_empty(bundle, "records").empty();
  }
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (text_or(record, "payload_hash") == payload_hash && record.contains("payload")) {
      return true;
    }
  }
  return false;
}

bool episode_bundle_has_frame(const nlohmann::json &bundle, uint64_t frame_uid) {
  if (frame_uid == 0) {
    return !array_or_empty(bundle, "records").empty();
  }
  for (const auto &frame : array_or_empty(bundle, "frames")) {
    if (uint64_or(frame, "frame_uid") == frame_uid) {
      return true;
    }
  }
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (text_or(record, "record_kind") == "episode_frame_attached" && uint64_or(record, "frame_uid") == frame_uid) {
      return true;
    }
  }
  return false;
}

bool episode_bundle_has_ref_hash(const nlohmann::json &bundle, const std::string &ref_hash) {
  if (ref_hash.empty()) {
    return !array_or_empty(bundle, "records").empty();
  }
  for (const auto &ref : array_or_empty(bundle, "refs")) {
    if (text_or(ref, "ref_hash") == ref_hash) {
      return true;
    }
  }
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (text_or(record, "record_kind") == "episode_ref_attached" && text_or(record, "ref_hash") == ref_hash) {
      return true;
    }
  }
  return false;
}

bool episode_bundle_satisfies_candidate(const nlohmann::json &candidate, const nlohmann::json &bundle) {
  const auto code = text_or(candidate, "code");
  if (code == "repair_episode_root_trigger_frame" || code == "repair_episode_trigger_frame") {
    return episode_bundle_has_frame(bundle, uint64_or(candidate, "frame_uid"));
  }
  if (code == "repair_episode_payload_ref") {
    return episode_bundle_has_ref_hash(bundle, text_or(candidate, "ref_hash"));
  }
  if (code == "repair_episode_dependency") {
    const auto dependency_episode_id = uint64_or(candidate, "dependency_episode_id");
    return dependency_episode_id == 0 || uint64_or(bundle, "episode_id") == dependency_episode_id ||
           uint64_or(object_or_empty(bundle, "manifest"), "episode_id") == dependency_episode_id;
  }
  return false;
}

void push_unique_bundle(nlohmann::json &bundles, std::vector<std::string> &seen, const nlohmann::json &bundle) {
  const auto key = text_or(bundle, "schema") + ":" + text_or(bundle, "bundle_id", canonical_json(bundle));
  if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
    return;
  }
  seen.push_back(key);
  bundles.push_back(bundle);
}

nlohmann::json repair_fetch_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_repair_fetch_is_read_only");
  }
  auto plan_options = options;
  plan_options.dry_run = true;
  const auto plan = repair_plan_impl(plan_options);
  const auto runtimes = repair_evidence_runtimes(options);
  nlohmann::json material = {
      {"schema", "kungfu.storage.repair-material/v1"},
      {"generated_by", "kungfu.storage.repair-fetch/v1"},
      {"episode_bundles", nlohmann::json::array()},
      {"source_bundles", nlohmann::json::array()},
  };
  std::vector<std::string> seen_episode_bundles;
  std::vector<std::string> seen_source_bundles;
  nlohmann::json matched = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json missing = nlohmann::json::array();

  for (const auto &candidate : array_or_empty(plan, "candidates")) {
    const auto code = text_or(candidate, "code");
    bool found = false;
    if (code == "repair_source_payload") {
      const auto source_id = text_or(candidate, "source_id", options.source_id);
      const auto payload_hash = text_or(candidate, "payload_hash");
      for (const auto &runtime : runtimes) {
        try {
          auto candidate_options = options;
          candidate_options.runtime_dir = runtime.runtime_dir.string();
          candidate_options.scope = "source";
          candidate_options.source_id = source_id;
          const auto bundle = export_bundle_generic_impl(candidate_options, /*record_receipt=*/false);
          if (!source_bundle_has_payload(bundle, payload_hash)) {
            skipped.push_back({{"candidate", candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"reason", "payload_not_in_bundle"}});
            continue;
          }
          push_unique_bundle(material["source_bundles"], seen_source_bundles, bundle);
          matched.push_back({{"candidate", candidate},
                             {"evidence_source", runtime.source},
                             {"runtime_dir", runtime.runtime_dir.string()},
                             {"material", "source_bundle"}});
          found = true;
          break;
        } catch (const std::exception &e) {
          skipped.push_back({{"candidate", candidate},
                             {"evidence_source", runtime.source},
                             {"runtime_dir", runtime.runtime_dir.string()},
                             {"reason", e.what()}});
        }
      }
    } else if (text_or(candidate, "kind") == "episode" || text_or(candidate, "kind") == "frame" ||
               code == "repair_episode_payload_ref") {
      std::vector<uint64_t> episode_ids;
      const auto requested_episode_id = uint64_or(candidate, "episode_id", options.episode_id);
      if (requested_episode_id != 0) {
        episode_ids.push_back(requested_episode_id);
      }
      const auto dependency_episode_id = uint64_or(candidate, "dependency_episode_id");
      if (dependency_episode_id != 0 &&
          std::find(episode_ids.begin(), episode_ids.end(), dependency_episode_id) == episode_ids.end()) {
        episode_ids.push_back(dependency_episode_id);
      }
      for (const auto &runtime : runtimes) {
        for (const auto episode_id : episode_ids) {
          try {
            auto candidate_options = options;
            candidate_options.runtime_dir = runtime.runtime_dir.string();
            candidate_options.scope = "episode";
            candidate_options.episode_id = episode_id;
            const auto bundle = episode_export_bundle_impl(candidate_options);
            if (!episode_bundle_satisfies_candidate(candidate, bundle)) {
              skipped.push_back({{"candidate", candidate},
                                 {"evidence_source", runtime.source},
                                 {"runtime_dir", runtime.runtime_dir.string()},
                                 {"episode_id", episode_id},
                                 {"reason", "episode_evidence_not_in_bundle"}});
              continue;
            }
            push_unique_bundle(material["episode_bundles"], seen_episode_bundles, bundle);
            matched.push_back({{"candidate", candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"episode_id", episode_id},
                               {"material", "episode_bundle"}});
            found = true;
            break;
          } catch (const std::exception &e) {
            skipped.push_back({{"candidate", candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"episode_id", episode_id},
                               {"reason", e.what()}});
          }
        }
        if (found) {
          break;
        }
      }
    }
    if (!found) {
      missing.push_back(candidate);
    }
  }

  const auto written = !options.artifact_uri.empty();
  if (written) {
    write_json_file(options.artifact_uri, material);
  }
  return {
      {"ok", missing.empty()},
      {"schema", "kungfu.storage.repair-fetch/v1"},
      {"scope", options.scope.empty() ? "all" : options.scope},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
      {"dry_run", true},
      {"read_only", true},
      {"artifact_uri", options.artifact_uri.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.artifact_uri)},
      {"written", written},
      {"plan", plan},
      {"evidence_runtimes",
       [&] {
         nlohmann::json rows = nlohmann::json::array();
         for (const auto &runtime : runtimes) {
           rows.push_back({{"source", runtime.source}, {"runtime_dir", runtime.runtime_dir.string()}});
         }
         return rows;
       }()},
      {"material", material},
      {"matched", matched},
      {"matched_count", matched.size()},
      {"skipped", skipped},
      {"missing", missing},
      {"missing_count", missing.size()},
      {"notes", nlohmann::json::array({
                    "Repair fetch v1 only searches local runtime evidence and registered remote mirror runtimes.",
                    "It writes a local material artifact only when artifact_uri/--out is explicitly supplied.",
                    "It never applies material, deletes, compacts, garbage-collects, or performs network fetch.",
                })}};
}

nlohmann::json episode_import_bundle_impl(const storage_service_options &options) {
  if (!options.bundle.is_object() || text_or(options.bundle, "schema") != "kungfu.storage.episode-bundle/v1") {
    throw std::invalid_argument("episode_bundle_invalid");
  }
  const auto manifest = object_or_empty(options.bundle, "manifest");
  if (manifest.empty()) {
    throw std::invalid_argument("episode_bundle_manifest_missing");
  }
  const auto causal_graph = object_or_empty(options.bundle, "causal_graph");
  if (causal_graph.empty()) {
    throw std::invalid_argument("episode_bundle_causal_graph_missing");
  }
  const auto records = array_or_empty(options.bundle, "records");
  const auto frames = array_or_empty(options.bundle, "frames");
  const auto refs = array_or_empty(options.bundle, "refs");
  const auto dependencies = array_or_empty(options.bundle, "dependencies");
  return {{"ok", true},
          {"schema", "kungfu.storage.episode-import/v1"},
          {"scope", "episode"},
          {"episode_id", uint64_or(options.bundle, "episode_id", uint64_or(manifest, "episode_id"))},
          {"dry_run", true},
          {"accepted", false},
          {"status", "validated"},
          {"authority", "yijinjing-journal"},
          {"degraded", bool_or(options.bundle, "degraded", bool_or(causal_graph, "degraded", false))},
          {"manifest", manifest},
          {"causal_graph", causal_graph},
          {"dependencies", dependencies},
          {"records", records.size()},
          {"frames", frames.size()},
          {"refs", refs.size()},
          {"dependency_count", dependencies.size()},
          {"notes",
           nlohmann::json::array({
               "Episode bundle import v1 validates and preserves causal evidence without writing the local manifest.",
               "A later repair/import stage may materialize missing frames, payloads, or dependent Episodes.",
           })}};
}

nlohmann::json replace_string_subtree(nlohmann::json value, const std::string &needle, const std::string &replacement) {
  if (needle.empty()) {
    return value;
  }
  if (value.is_string()) {
    auto text = value.get<std::string>();
    size_t pos = 0;
    while ((pos = text.find(needle, pos)) != std::string::npos) {
      text.replace(pos, needle.size(), replacement);
      pos += replacement.size();
    }
    return text;
  }
  if (value.is_array()) {
    for (auto &item : value) {
      item = replace_string_subtree(item, needle, replacement);
    }
    return value;
  }
  if (value.is_object()) {
    for (auto &[_, item] : value.items()) {
      item = replace_string_subtree(item, needle, replacement);
    }
    return value;
  }
  return value;
}

storage_source_registry_view source_registry_status_view(const yy_storage::source_registry_current_view &source) {
  storage_source_registry_view result{};
  result.source_uid = source.source_uid;
  result.registered = source.registered;
  result.record_count = source.records.size();
  result.accepted_range_count = source.accepted_range_indices.size();
  if (source.registered) {
    result.source_id = fixed_string(source.registration.source_id);
    result.kind = source_kind_text(source.registration.kind);
    result.coordinate = fixed_string(source.registration.coordinate);
    result.head = source.current_head;
    result.location_uid = source.registration.location_uid;
    result.register_time = source.registration.register_time;
  }
  if (source.head_update_seen) {
    result.current_range =
        storage_frame_range_view{source.head_update.first_frame_uid, source.head_update.last_frame_uid,
                                 source.head_update.since, source.head_update.until};
    result.inventory_hash = storage_sync_root_view{fixed_string(source.head_update.inventory_hash_algo),
                                                   fixed_string(source.head_update.inventory_hash)};
    result.update_time = source.head_update.update_time;
  }
  return result;
}

storage_accepted_range_view accepted_range_status_view(const yijinjing::types::ImportManifestAccepted &manifest) {
  return {fixed_string(manifest.source_id),
          fixed_string(manifest.manifest_id),
          {fixed_string(manifest.range_since), fixed_string(manifest.range_until)},
          fixed_string(manifest.source_head),
          {fixed_string(manifest.sync_root_algo), fixed_string(manifest.sync_root_value)},
          manifest.entry_count,
          verification_status_text(manifest.status)};
}

storage_cursor_view cursor_status_view(const yijinjing::types::ChannelCursorUpdated &cursor) {
  return {fixed_string(cursor.source_id),
          fixed_string(cursor.manifest_id),
          fixed_string(cursor.source_head),
          {fixed_string(cursor.range_since), fixed_string(cursor.range_until)},
          {fixed_string(cursor.sync_root_algo), fixed_string(cursor.sync_root_value)},
          cursor.entry_count};
}

storage_status_result status_typed_impl(const storage_status_request &request) {
  const auto selection = select_provider(request.provider);
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, selection.name);
  storage_status_result result{};
  result.backend = provider->name();
  result.provider = provider->name();
  result.provider_config_source =
      request.provider_config_source.empty() ? selection.source : request.provider_config_source;
  result.provider_runtime = provider->runtime();
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }

  const auto source_fold = registry_store(request.runtime_dir).fold_typed_records();
  for (const auto &[source_uid, source] : source_fold.sources) {
    (void)source_uid;
    auto view = source_registry_status_view(source);
    if (request.source_id.empty() || view.source_id == request.source_id) {
      result.sources.push_back(std::move(view));
    }
  }
  result.ok = request.source_id.empty() || !result.sources.empty();

  const auto catalog = catalog_store(request.runtime_dir).read_typed_records();
  std::unordered_map<uint64_t, const yijinjing::types::ImportManifestAccepted *> latest_manifests;
  std::unordered_map<uint64_t, const yijinjing::types::ChannelCursorUpdated *> latest_cursors;
  for (const auto &manifest : catalog.manifests) {
    latest_manifests[manifest.source_uid] = &manifest;
  }
  for (const auto &cursor : catalog.cursors) {
    latest_cursors[cursor.source_uid] = &cursor;
  }

  for (const auto &source : result.sources) {
    storage_source_status_view status{};
    status.source_id = source.source_id;
    status.source = source;
    const auto manifest_iter = latest_manifests.find(source.source_uid);
    if (manifest_iter == latest_manifests.end()) {
      status.reason = "manifest_missing";
      result.source_status.push_back(std::move(status));
      continue;
    }

    const auto &manifest = *manifest_iter->second;
    status.ok = true;
    status.manifest_id = fixed_string(manifest.manifest_id);
    status.source_type = fixed_string(manifest.source_type);
    status.source_head = fixed_string(manifest.source_head);
    status.accepted_range = accepted_range_status_view(manifest);
    status.sync_root =
        storage_sync_root_view{fixed_string(manifest.sync_root_algo), fixed_string(manifest.sync_root_value)};
    status.entries = manifest.entry_count;
    status.payload_inventory = manifest.entry_count;

    std::unordered_set<std::string> schema_keys;
    for (const auto &entry : catalog.entries) {
      if (entry.manifest_uid != manifest.manifest_uid || entry.accept_time != manifest.accept_time ||
          entry.entry_schema_version == 0) {
        continue;
      }
      schema_keys.insert(fixed_string(entry.kind) + ":" + std::to_string(entry.entry_schema_version));
    }
    status.schema_inventory = schema_keys.size();

    if (const auto cursor_iter = latest_cursors.find(source.source_uid); cursor_iter != latest_cursors.end()) {
      status.accepted_cursor = cursor_status_view(*cursor_iter->second);
    }
    const auto source_type = *status.source_type;
    status.source_record =
        storage_manifest_source_view{status.source_id,
                                     source_type,
                                     source_type == "atlas" ? "adapter" : "local",
                                     fixed_string(manifest.source_coordinate),
                                     *status.source_head,
                                     {fixed_string(manifest.range_since), fixed_string(manifest.range_until)},
                                     fixed_string(manifest.sync_root_value),
                                     *status.accepted_range,
                                     *status.manifest_id};
    result.source_status.push_back(std::move(status));
  }

  result.projections = {source_registry_projection_status(request.runtime_dir),
                        manifest_catalog_projection_status(request.runtime_dir)};
  result.provider_cache = provider_cache::instance().stats();
  return result;
}

std::vector<std::string> referenced_payload_hashes(const std::string &runtime_dir, const std::string &source_id = {}) {
  return catalog_store(runtime_dir).referenced_payload_hashes(source_id);
}

std::pair<nlohmann::json, std::string> load_payload_impl(const storage_provider &provider,
                                                         const nlohmann::json &entry) {
  const auto digest = text_or(entry, "payload_hash");
  if (digest.empty() || !provider.payload_exists(digest)) {
    // An empty digest can never resolve to a body (and must not reach the
    // hash primitives, which reject empty values).
    return {nullptr, "payload_missing"};
  }
  const auto raw = provider.read_payload(digest);
  if (!entry.contains("byte_len") ||
      !entry.at("byte_len").is_number_unsigned() && !entry.at("byte_len").is_number_integer()) {
    return {nullptr, "byte_len_mismatch"};
  }
  const auto expected_len = entry.at("byte_len").get<uint64_t>();
  const auto error =
      yy_storage::verify_payload_ref(raw, digest, expected_len, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
  if (!error.empty()) {
    return {nullptr, error};
  }
  try {
    auto payload = nlohmann::json::parse(raw);
    return {payload, {}};
  } catch (const nlohmann::json::exception &) {
    return {nullptr, "payload_decode_error"};
  }
}

// Registered sources from the source-registry journal fold: the single source
// catalog (the JSON sources.json registry is retired, ADR-0037 final slice).
nlohmann::json list_sources_impl(const std::string &runtime_dir) {
  nlohmann::json sources = nlohmann::json::array();
  for (const auto &source : registry_store(runtime_dir).list().value("sources", nlohmann::json::array())) {
    if (source.is_object()) {
      sources.push_back(source);
    }
  }
  std::sort(sources.begin(), sources.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return text_or(lhs, "source_id") < text_or(rhs, "source_id");
  });
  return sources;
}

nlohmann::json issue_to_json(const yy_storage::storage_issue &issue) {
  nlohmann::json row = {{"severity", issue.severity}, {"code", issue.code}};
  if (!issue.path.empty()) {
    row["path"] = issue.path;
  }
  if (!issue.message.empty()) {
    row["message"] = issue.message;
  }
  if (!issue.expected.is_null()) {
    row["expected"] = issue.expected;
  }
  if (!issue.actual.is_null()) {
    row["actual"] = issue.actual;
  }
  return row;
}

nlohmann::json fsck_error_report(const storage_service_options &options, const std::string &code,
                                 const std::string &error) {
  return {
      {"ok", false},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"errors", nlohmann::json::array({{{"code", code}, {"error", error}}})},
      {"warnings", nlohmann::json::array()},
      {"checked",
       {
           {"sources", 0},
           {"manifests", 0},
           {"payloads", 0},
           {"schemas", 0},
           {"accepted_ranges", 0},
           {"source_records", 0},
           {"projection_indexes", 0},
           {"sqlite_projection_rows", 0},
           {"orphan_payloads", 0},
           {"episode_manifest_records", 0},
           {"episodes", 0},
       }},
  };
}

nlohmann::json fsck_impl(const storage_service_options &options) {
  if (options.scope == "episode") {
    return episode_fsck_impl(options);
  }
  const auto provider = shared_provider(options);

  nlohmann::json sources = nlohmann::json::array();
  for (const auto &source : list_sources_impl(options.runtime_dir)) {
    if (options.source_id.empty() || text_or(source, "source_id") == options.source_id) {
      sources.push_back(source);
    }
  }

  nlohmann::json report = {
      {"ok", true},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"authority", "yijinjing-journal"},
      {"errors", nlohmann::json::array()},
      {"warnings", nlohmann::json::array()},
      {"checked",
       {
           {"sources", sources.size()},
           {"manifests", 0},
           {"manifest_entries", 0},
           {"payloads", 0},
           {"entries_documents", 0},
           {"accepted_ranges", 0},
           {"source_records", 0},
           {"projection_indexes", 2},
           {"orphan_payloads", 0},
           {"episode_manifest_records", 0},
           {"episodes", 0},
       }},
  };
  bool degraded = false;
  if (!options.source_id.empty() && sources.empty()) {
    report["ok"] = false;
    report["errors"].push_back({{"code", "source_missing"}, {"source_id", options.source_id}});
    report["degraded"] = false;
    report["status"] = "failed";
    return report;
  }

  // Source-registry journal fold consistency (dangling heads, duplicate
  // registrations) — the registry journal is a first-class fact source too.
  const auto registry_report = registry_store(options.runtime_dir).fsck(options.source_id);
  for (auto error : array_or_empty(registry_report, "errors")) {
    if (text_or(error, "code") == "source_missing") {
      continue; // covered by the registered-set check above
    }
    error["projection"] = "source-registry";
    report["ok"] = false;
    report["errors"].push_back(error);
  }
  for (auto warning : array_or_empty(registry_report, "warnings")) {
    warning["projection"] = "source-registry";
    report["warnings"].push_back(warning);
  }

  // Catalog fold, sync-root chain, committed entries documents, and payload
  // references through the ADR-0040 content store (kernel-owned checks).
  std::map<std::string, nlohmann::json> catalog_sources;
  for (const auto &summary : catalog_store(options.runtime_dir).list().value("sources", nlohmann::json::array())) {
    catalog_sources.emplace(text_or(summary, "source_id"), summary);
  }
  size_t sources_with_manifests = 0;
  for (const auto &source : sources) {
    const auto current_source_id = text_or(source, "source_id");
    const auto iter = catalog_sources.find(current_source_id);
    if (iter == catalog_sources.end()) {
      report["ok"] = false;
      report["errors"].push_back({{"code", "manifest_missing"}, {"source_id", current_source_id}});
      continue;
    }
    ++sources_with_manifests;
    // The registry head and the catalog's latest accepted head must agree;
    // divergence means one journal missed an acceptance.
    const auto registry_head = text_or(source, "head");
    const auto catalog_head = text_or(iter->second, "source_head");
    if (!registry_head.empty() && registry_head != catalog_head) {
      report["ok"] = false;
      report["errors"].push_back({{"code", "source_registry_drift"},
                                  {"source_id", current_source_id},
                                  {"expected", catalog_head},
                                  {"actual", registry_head}});
    }
    report["checked"]["accepted_ranges"] =
        report["checked"]["accepted_ranges"].get<size_t>() + source.value("accepted_range_count", size_t{0});
  }
  report["checked"]["source_records"] = sources_with_manifests;

  if (sources_with_manifests > 0 || options.source_id.empty()) {
    const auto catalog_report = catalog_store(options.runtime_dir).fsck(options.source_id, provider->content_store());
    for (auto error : array_or_empty(catalog_report, "errors")) {
      if (text_or(error, "code") == "source_missing") {
        continue; // a registered source with no manifests is already reported
      }
      report["ok"] = false;
      report["errors"].push_back(error);
    }
    for (const auto &warning : array_or_empty(catalog_report, "warnings")) {
      report["warnings"].push_back(warning);
    }
    degraded = degraded || catalog_report.value("degraded", false);
    const auto catalog_checked = object_or_empty(catalog_report, "checked");
    report["checked"]["manifests"] = catalog_checked.value("manifests", 0);
    report["checked"]["manifest_entries"] = catalog_checked.value("manifest_entries", 0);
    report["checked"]["payloads"] = catalog_checked.value("payloads", 0);
    report["checked"]["entries_documents"] = catalog_checked.value("entries_documents", 0);
  }

  if (options.source_id.empty()) {
    const auto referenced = referenced_payload_hashes(options.runtime_dir);
    for (const auto &payload : provider->all_payloads()) {
      const auto digest = payload.digest;
      if (std::find(referenced.begin(), referenced.end(), digest) == referenced.end()) {
        report["checked"]["orphan_payloads"] = report["checked"]["orphan_payloads"].get<size_t>() + 1;
        report["warnings"].push_back({{"code", "orphan_payload"}, {"path", payload.uri}, {"payload_hash", digest}});
      }
    }
  }

  const auto scoped = episode_ref_store(options);
  const auto episode_report = scoped.store.fsck();
  const auto episode_checked = object_or_empty(episode_report, "checked");
  report["checked"]["episode_manifest_records"] = episode_checked.value("episode_manifest_records", 0);
  report["checked"]["episodes"] = episode_checked.value("episodes", 0);
  report["episode_manifest"] = episode_report;
  for (const auto &error : array_or_empty(episode_report, "errors")) {
    auto row = error;
    row["projection"] = "episode-manifest";
    report["ok"] = false;
    report["errors"].push_back(row);
  }
  for (const auto &warning : array_or_empty(episode_report, "warnings")) {
    auto row = warning;
    row["projection"] = "episode-manifest";
    report["warnings"].push_back(row);
  }
  degraded = degraded || episode_report.value("degraded", false);

  // Derived SQLite projections are verified against the journal folds.
  // Drift or absence degrades the verdict (the journal stays the authority
  // and a rebuild restores the view); it never fails the journal itself.
  const auto projections = storage_projection_reports(options.runtime_dir);
  report["projections"] = projections;
  for (const auto &projection : projections) {
    const auto status = text_or(projection, "status", "ok");
    if (status == "absent") {
      report["warnings"].push_back({{"code", "projection_absent"},
                                    {"projection", text_or(projection, "name")},
                                    {"path", text_or(projection, "path")},
                                    {"reason", "projection is derived and can be rebuilt"}});
    } else if (status == "degraded") {
      degraded = true;
      report["warnings"].push_back({{"code", "projection_drift"},
                                    {"projection", text_or(projection, "name")},
                                    {"path", text_or(projection, "path")},
                                    {"drift", projection.value("drift", nlohmann::json::array())}});
    }
  }

  // Tri-state verdict over the boolean ok: failed (corruption/drift/unreadable)
  // dominates, then degraded (incomplete but not corrupt), else ok.
  report["degraded"] = degraded;
  report["status"] = !report["ok"].get<bool>() ? "failed" : (degraded ? "degraded" : "ok");
  return report;
}

nlohmann::json rebuild_index_impl(const storage_service_options &options) {
  // ADR-0037 (final slice): rebuild the derived SQLite projections from the
  // kernel journals through the Hana closed-set -> SQLite path. The journals
  // are the authority; there is no JSON registry to regenerate any more.
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json projections = nlohmann::json::array();
  bool would_write = false;
  const auto plan_one = [&](const char *name, auto &&projection) {
    auto verify = projection.verify();
    const auto status = verify.value("status", std::string("ok"));
    const bool needs_write = status != "ok" || !verify.value("projection_present", false);
    would_write = would_write || needs_write;
    if (options.dry_run) {
      verify["name"] = name;
      verify["dry_run"] = true;
      verify["written"] = false;
      verify["would_write"] = needs_write;
      projections.push_back(verify);
      return;
    }
    auto rebuilt = projection.rebuild();
    rebuilt["name"] = name;
    rebuilt["dry_run"] = false;
    rebuilt["written"] = true;
    if (!rebuilt.value("ok", false)) {
      errors.push_back({{"code", "projection_rebuild_failed"}, {"projection", name}});
    }
    projections.push_back(rebuilt);
  };
  plan_one(PROJECTION_SOURCE_REGISTRY, source_registry_projection(options.runtime_dir));
  plan_one(PROJECTION_MANIFEST_CATALOG, manifest_catalog_projection(options.runtime_dir));
  const auto sources = list_sources_impl(options.runtime_dir);
  if (!options.source_id.empty()) {
    const auto found = std::any_of(sources.begin(), sources.end(), [&](const nlohmann::json &source) {
      return text_or(source, "source_id") == options.source_id;
    });
    if (!found) {
      errors.push_back({{"code", "source_missing"}, {"source_id", options.source_id}});
    }
  }
  return {
      {"ok", errors.empty()},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"authority", "yijinjing-journal"},
      {"rebuilt_from", "storage kernel journals"},
      {"projections", projections},
      {"dry_run", options.dry_run},
      {"would_write", options.dry_run ? would_write : true},
      {"written", !options.dry_run},
      {"sources_rebuilt", sources.size()},
      {"errors", errors},
  };
}

nlohmann::json gc_plan_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_gc_requires_dry_run");
  }
  const auto provider = shared_provider(options);
  const auto referenced = referenced_payload_hashes(options.runtime_dir, options.source_id);
  const auto payloads = provider->all_payloads();
  nlohmann::json candidates = nlohmann::json::array();
  uint64_t candidate_bytes = 0;
  for (const auto &payload : payloads) {
    const auto digest = payload.digest;
    if (std::find(referenced.begin(), referenced.end(), digest) != referenced.end()) {
      continue;
    }
    const auto bytes = payload.bytes;
    candidate_bytes += bytes;
    candidates.push_back({{"payload_hash", digest},
                          {"path", payload.uri},
                          {"bytes", bytes},
                          {"safe_to_delete", options.source_id.empty()}});
  }
  return {
      {"ok", true},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"dry_run", true},
      {"payloads_scanned", payloads.size()},
      {"referenced_payloads", referenced.size()},
      {"candidate_count", candidates.size()},
      {"candidate_bytes", candidate_bytes},
      {"candidates", candidates},
      {"notes", nlohmann::json::array({"No payloads were deleted.",
                                       options.source_id.empty()
                                           ? "All-scope candidates are unreferenced by retained storage manifests."
                                           : "Source scope candidates are not globally safe to delete because the "
                                             "interim payload store is shared."})},
  };
}

nlohmann::json compact_plan_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_compact_requires_dry_run");
  }
  auto rebuild_options = options;
  rebuild_options.dry_run = true;
  const auto rebuild = rebuild_index_impl(rebuild_options);
  const auto garbage = gc_plan_impl(rebuild_options);
  const auto provider = shared_provider(options);
  nlohmann::json manifests = nlohmann::json::array();
  const auto catalog = catalog_store(options.runtime_dir);
  for (const auto &summary : catalog.list().value("sources", nlohmann::json::array())) {
    const auto current_source_id = text_or(summary, "source_id");
    if (!options.source_id.empty() && current_source_id != options.source_id) {
      continue;
    }
    const auto inspected = catalog.inspect(current_source_id);
    for (const auto &manifest : inspected.value("manifests", nlohmann::json::array())) {
      manifests.push_back(
          {{"source_id", current_source_id},
           {"manifest_id", text_or(manifest, "manifest_id")},
           {"entries", manifest.value("entry_count", 0)},
           {"sync_root", manifest.contains("sync_root") ? manifest.at("sync_root") : nlohmann::json(nullptr)}});
    }
  }
  return {
      {"ok", rebuild.value("ok", false) && garbage.value("ok", false)},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"dry_run", true},
      {"retained_manifests", manifests},
      {"rebuild_index", rebuild},
      {"gc", garbage},
      {"projection_compact",
       {
           {"name", PROJECTION_MANIFEST_CATALOG},
           {"path", manifest_catalog_projection(options.runtime_dir).sqlite_path()},
           {"action", "rebuild-and-vacuum"},
           {"dry_run", true},
           {"rebuildable", true},
       }},
      {"unsupported",
       nlohmann::json::array(
           {{{"name", "history-archive"}, {"reason", "archive bundles are not implemented in this slice"}},
            {{"name", "backend-compact"},
             {"reason", provider->name() == PROVIDER_ROCKSDB ? "RocksDB compaction is not destructive-history compact"
                                                             : "the file backend has no backend compaction"}}})},
      {"notes", nlohmann::json::array({"No manifests, payloads, journal frames, or projections were rewritten.",
                                       "This is a reviewable compaction plan, not destructive compaction."})},
  };
}

// Accept one import manifest into the kernel journals: the manifest-catalog
// records (header + per-entry deltas + channel cursor, entries document
// committed into the content store) plus the source-registry alignment
// (register-once, head update, accepted range). Returns the accepted
// manifest JSON edge.
nlohmann::json accept_storage_manifest_impl(const std::string &runtime_dir, const nlohmann::json &input) {
  const auto provider = shared_provider(runtime_dir);
  const auto edge = catalog_store(runtime_dir).accept_manifest(input, provider->content_store());
  const auto source_id = text_or(edge, "source_id");
  const auto source = object_or_empty(edge, "source");
  const auto sync_root = object_or_empty(edge, "sync_root");
  const auto registry = registry_store(runtime_dir);
  if (!registry.inspect(source_id).value("ok", false)) {
    yy_storage::source_register_options reg{};
    reg.source_id = source_id;
    reg.kind = text_or(source, "kind") == "adapter" ? yy_enums::SourceKind::Adapter : yy_enums::SourceKind::Local;
    reg.coordinate = text_or(source, "coordinate");
    reg.head = text_or(edge, "source_head");
    (void)registry.register_source(reg);
  }
  yy_storage::source_head_update_options head{};
  head.source_id = source_id;
  head.head = text_or(edge, "source_head");
  head.inventory_hash_algo = text_or(sync_root, "algorithm");
  head.inventory_hash = text_or(sync_root, "value");
  (void)registry.update_head(head);
  yy_storage::accepted_range_options accepted{};
  accepted.source_id = source_id;
  accepted.manifest_id = text_or(edge, "manifest_id");
  (void)registry.record_accepted_range(accepted);
  return edge;
}

// Project a range-filtered manifest edge for export: filtered entries, a
// recomputed sync root over them, and rebuilt inventories. Same proof
// semantics; the range view is an edge document, never a stored record.
nlohmann::json range_filtered_manifest_edge(const nlohmann::json &manifest, const nlohmann::json &range_filter) {
  auto edge = manifest;
  const auto entries = entries_for_manifest(manifest, range_filter);
  const auto sync_root = yy_storage::compute_linear_sync_root(entries.get<std::vector<nlohmann::json>>());
  edge["entries"] = entries;
  edge["range"] = range_filter;
  edge["counts"] = {{"records", entries.size()}};
  edge["sync_root"] = sync_root;
  edge["payload_inventory"] = yy_storage::build_storage_payload_inventory(entries);
  edge["schema_inventory"] = yy_storage::build_storage_schema_inventory(entries);
  nlohmann::json accepted = {
      {"schema", yy_storage::STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
      {"source_id", text_or(manifest, "source_id")},
      {"manifest_id", text_or(manifest, "manifest_id")},
      {"range", range_filter},
      {"source_head", text_or(manifest, "source_head")},
      {"sync_root", sync_root},
      {"entry_count", entries.size()},
      {"status", "ok"},
  };
  edge["accepted_ranges"] = nlohmann::json::array({accepted});
  if (edge.contains("source") && edge.at("source").is_object()) {
    edge["source"]["current_head"]["range"] = range_filter;
    edge["source"]["current_head"]["inventory_hash"] = sync_root.value("value", "");
    edge["source"]["accepted_ranges"] = nlohmann::json::array({accepted});
  }
  return edge;
}

nlohmann::json export_bundle_generic_impl(const storage_service_options &options, bool record_receipt) {
  const auto provider = shared_provider(options);
  const auto manifest = load_latest_manifest_impl(options.runtime_dir, *provider, options.source_id);
  if (manifest.is_null()) {
    throw std::runtime_error("manifest not found: " + options.source_id);
  }
  auto export_manifest = manifest;
  if (!options.range.empty()) {
    export_manifest = range_filtered_manifest_edge(manifest, options.range);
  }
  nlohmann::json records = nlohmann::json::array();
  for (const auto &entry : entries_for_manifest(manifest, options.range)) {
    auto row = entry;
    row["scope"] = text_or(manifest, "scope");
    row["manifest_id"] = text_or(manifest, "manifest_id");
    row["storage_source_id"] = options.source_id;
    row["source_type"] = text_or(manifest, "source_type");
    row["source_head"] = text_or(manifest, "source_head");
    const auto state = text_or(entry, "payload_state", PAYLOAD_STATE_PRESENT);
    if (state == PAYLOAD_STATE_REDACTED || state == PAYLOAD_STATE_ABSENT) {
      // A deliberately withheld or source-confirmed nonexistent body is an
      // honest state, not an export failure: the entry travels with its
      // recorded state and no body, and the body is never read.
      row["payload"] = nullptr;
    } else if (state != PAYLOAD_STATE_PRESENT) {
      // A recorded-missing body is expected to exist: attempt it, so a
      // lost-and-found body becomes repair material; otherwise export the
      // honest gap.
      auto [payload, error] = load_payload_impl(*provider, entry);
      row["payload"] = error.empty() ? payload : nlohmann::json(nullptr);
    } else {
      auto [payload, error] = load_payload_impl(*provider, entry);
      if (!error.empty()) {
        throw std::runtime_error(error + ": " + text_or(entry, "kind") + ":" + text_or(entry, "source_id"));
      }
      row["payload"] = payload;
    }
    records.push_back(row);
  }
  std::sort(records.begin(), records.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return std::make_tuple(text_or(lhs, "kind"), text_or(lhs, "source_id"), text_or(lhs, "source_path")) <
           std::make_tuple(text_or(rhs, "kind"), text_or(rhs, "source_id"), text_or(rhs, "source_path"));
  });
  auto bundle = yy_storage::build_storage_export_bundle(export_manifest, records);
  if (record_receipt) {
    // The export receipt is a local journal fact (ADR-0037): what left this
    // store, when, over which range, committing to the exported sync root. It
    // is deliberately not embedded in the bundle -- the exchange document
    // stays deterministic for identical content.
    (void)catalog_store(options.runtime_dir).record_export(export_manifest, records.size(), options.range);
  }
  return bundle;
}

class file_storage_json_edge_service {
public:
  [[nodiscard]] nlohmann::json status(const storage_service_options &options) const {
    return render_storage_status_result(default_storage_service().status(parse_storage_status_request(options)));
  }

  [[nodiscard]] nlohmann::json fsck(const storage_service_options &options) const { return fsck_impl(options); }

  [[nodiscard]] nlohmann::json repair_plan(const storage_service_options &options) const {
    return repair_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_fetch(const storage_service_options &options) const {
    return repair_fetch_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_apply(const storage_service_options &options) const {
    return repair_apply_impl(options);
  }

  [[nodiscard]] nlohmann::json export_bundle(const storage_service_options &options) const {
    if (options.scope == "episode") {
      return episode_export_bundle_impl(options);
    }
    // The public export operation records the export-bundle receipt; internal
    // read-only exports (verify_sync round trips, repair-fetch evidence scans
    // over mirror runtimes) call the impl without the receipt.
    return export_bundle_generic_impl(options, /*record_receipt=*/true);
  }

  [[nodiscard]] nlohmann::json import_bundle(const storage_service_options &options) const {
    if (!options.bundle.is_object()) {
      throw std::invalid_argument("bundle_manifest_missing");
    }
    if (options.scope == "episode" || text_or(options.bundle, "schema") == "kungfu.storage.episode-bundle/v1") {
      return episode_import_bundle_impl(options);
    }
    const auto manifest = object_or_empty(options.bundle, "manifest");
    if (manifest.empty()) {
      throw std::invalid_argument("bundle_manifest_missing");
    }
    const auto records = array_or_empty(options.bundle, "records");
    if (options.verify) {
      for (const auto &issue : yy_storage::verify_storage_import_manifest(manifest)) {
        if (issue.severity != "warning") {
          throw std::invalid_argument("bundle_manifest_invalid: " + issue.code);
        }
      }
    }
    const auto provider = shared_provider(options);
    for (const auto &record : records) {
      if (!record.is_object() || !record.contains("payload") || record.at("payload").is_null()) {
        continue;
      }
      const auto record_state = text_or(record, "payload_state", PAYLOAD_STATE_PRESENT);
      if (record_state == PAYLOAD_STATE_REDACTED || record_state == PAYLOAD_STATE_ABSENT) {
        // A withheld or nonexistent body must never enter the store, even if
        // a malformed bundle carries one (ADR-0018 security boundary).
        continue;
      }
      const auto raw = canonical_json(record.at("payload"));
      auto digest = text_or(record, "payload_hash");
      if (digest.empty()) {
        digest = yy_storage::compute_content_hash_value(raw, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
      }
      const auto error =
          yy_storage::verify_payload_ref(raw, digest, raw.size(), yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
      if (!error.empty()) {
        throw std::invalid_argument("storage_payload_invalid: " + error);
      }
      provider->write_payload(digest, raw);
    }
    // Acceptance is a journal append: the bundle manifest is the adapter-edge
    // input, the accepted fact records are Hana-core kernel metadata.
    const auto accepted = accept_storage_manifest_impl(
        options.runtime_dir, {
                                 {"manifest_id", text_or(manifest, "manifest_id")},
                                 {"storage_source_id", text_or(manifest, "source_id")},
                                 {"source_type", text_or(manifest, "source_type")},
                                 {"source_coordinate", text_or(object_or_empty(manifest, "source"), "coordinate")},
                                 {"source_head", text_or(manifest, "source_head")},
                                 {"scope", text_or(manifest, "scope")},
                                 {"range", object_or_empty(manifest, "range")},
                                 {"entries", array_or_empty(manifest, "entries")},
                                 {"sync_root", object_or_empty(manifest, "sync_root")},
                             });
    return {{"ok", true},
            {"scope", "source"},
            {"source_id", text_or(accepted, "source_id")},
            {"manifest_id", text_or(accepted, "manifest_id")},
            {"records", records.size()}};
  }

  [[nodiscard]] nlohmann::json rebuild_index(const storage_service_options &options) const {
    return rebuild_index_impl(options);
  }

  [[nodiscard]] nlohmann::json gc_plan(const storage_service_options &options) const { return gc_plan_impl(options); }

  [[nodiscard]] nlohmann::json compact_plan(const storage_service_options &options) const {
    return compact_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json verify_sync(const storage_service_options &options) const {
    const auto source_report = fsck_impl(options);
    if (!source_report.value("ok", false)) {
      return {{"ok", false},
              {"scope", "source"},
              {"source_id", options.source_id},
              {"errors", nlohmann::json::array({{{"code", "source_fsck_failed"}, {"fsck", source_report}}})}};
    }
    auto export_options = options;
    const auto bundle = export_bundle_generic_impl(export_options, /*record_receipt=*/false);
    const auto temp_root =
        fs::temp_directory_path() / ("kungfu-storage-sync-" + std::to_string(std::random_device{}()) + "-" +
                                     std::to_string(std::random_device{}()));
    nlohmann::json import_result;
    nlohmann::json imported_report;
    nlohmann::json imported_manifest;
    try {
      auto import_options = options;
      import_options.runtime_dir = temp_root.string();
      import_options.bundle = bundle;
      import_result = import_bundle(import_options);
      imported_report = fsck_impl(import_options);
      imported_report = replace_string_subtree(imported_report, temp_root.string(), "<sync-runtime>");
      const auto import_provider = shared_provider(import_options);
      imported_manifest = load_latest_manifest_impl(import_options.runtime_dir, *import_provider, options.source_id);
      fs::remove_all(temp_root);
    } catch (...) {
      fs::remove_all(temp_root);
      throw;
    }
    const auto provider = shared_provider(options);
    const auto local_manifest = load_latest_manifest_impl(options.runtime_dir, *provider, options.source_id);
    const auto local_root = local_manifest.is_object() && local_manifest.contains("sync_root")
                                ? local_manifest.at("sync_root")
                                : nlohmann::json(nullptr);
    const auto imported_root = imported_manifest.is_object() && imported_manifest.contains("sync_root")
                                   ? imported_manifest.at("sync_root")
                                   : nlohmann::json(nullptr);
    const auto roots_match = local_root == imported_root;
    return {{"ok", imported_report.value("ok", false) && roots_match},
            {"scope", "source"},
            {"source_id", options.source_id},
            {"exported_records", bundle.value("records", nlohmann::json::array()).size()},
            {"import", import_result},
            {"local_sync_root", local_root},
            {"imported_sync_root", imported_root},
            {"sync_roots_match", roots_match},
            {"source_fsck", source_report},
            {"imported_fsck", imported_report}};
  }

  [[nodiscard]] nlohmann::json layout(const storage_service_options &options) const {
    const auto provider = shared_provider(options);
    return workspace_episode_layout(options, *provider);
  }

  [[nodiscard]] nlohmann::json episode_begin(const storage_service_options &options) const {
    return episode_store(options).begin(parse_episode_begin_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_heartbeat(const storage_service_options &options) const {
    return episode_store(options).heartbeat(parse_episode_heartbeat_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_end(const storage_service_options &options) const {
    return episode_store(options).end(
        parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Ended));
  }

  [[nodiscard]] nlohmann::json episode_abort(const storage_service_options &options) const {
    return episode_store(options).abort(
        parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Aborted));
  }

  [[nodiscard]] nlohmann::json episode_attach_frame(const storage_service_options &options) const {
    return episode_store(options).attach_frame(parse_episode_frame_attach_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_attach_ref(const storage_service_options &options) const {
    return episode_store(options).attach_ref(parse_episode_ref_attach_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_list(const storage_service_options &options) const {
    return episode_store(options).list(uint64_or(options.operation_options, "location_uid"), options.limit);
  }

  [[nodiscard]] nlohmann::json episode_inspect(const storage_service_options &options) const {
    auto inspected = episode_ref_store(options).store.inspect(options.episode_id);
    auto qualification_options = options;
    qualification_options.scope = "episode";
    const auto qualification_report = episode_fsck_impl(qualification_options);
    inspected["qualification"] = qualification_report.at("qualification");
    return inspected;
  }

  [[nodiscard]] nlohmann::json episode_recover(const storage_service_options &options) const {
    return episode_store(options).recover(parse_episode_recover_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_projection_rebuild(const storage_service_options &options) const {
    return episode_manifest_projection(options.runtime_dir).rebuild();
  }

  [[nodiscard]] nlohmann::json source_register(const storage_service_options &options) const {
    return source_registry_store(options).register_source(parse_source_register_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_update_head(const storage_service_options &options) const {
    return source_registry_store(options).update_head(parse_source_head_update_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_record_accepted_range(const storage_service_options &options) const {
    return source_registry_store(options).record_accepted_range(
        parse_accepted_range_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_list(const storage_service_options &options) const {
    return source_registry_store(options).list();
  }

  [[nodiscard]] nlohmann::json source_inspect(const storage_service_options &options) const {
    return source_registry_store(options).inspect(text_or(options.operation_options, "source_id", options.source_id));
  }

  [[nodiscard]] nlohmann::json source_registry_fsck(const storage_service_options &options) const {
    const auto source_id = text_or(options.operation_options, "source_id", options.source_id);
    auto report = source_registry_store(options).fsck(source_id);
    // ADR-0037: fsck verifies journal + projection. The journal is the
    // authority; a rebuildable projection that has drifted from it is degraded,
    // not failed.
    auto projection = source_registry_projection(options.runtime_dir).verify();
    report["projection"] = projection;
    const bool journal_ok = report.value("ok", false);
    const bool projection_degraded = projection.value("status", std::string("ok")) == "degraded";
    report["ok"] = journal_ok && !projection_degraded;
    if (!journal_ok) {
      report["status"] = "failed";
    } else if (projection_degraded) {
      report["status"] = "degraded";
    }
    return report;
  }

  [[nodiscard]] nlohmann::json source_registry_rebuild(const storage_service_options &options) const {
    return source_registry_projection(options.runtime_dir).rebuild();
  }
};

class file_storage_service : public storage_service {
public:
  [[nodiscard]] storage_status_result status(const storage_status_request &request) const override {
    return status_typed_impl(request);
  }

  [[nodiscard]] storage_query_result query(const storage_query_request &request) const override {
    return query_journal_projection(request);
  }
};

const file_storage_service &typed_storage_service_instance() {
  static const file_storage_service service;
  return service;
}

const file_storage_json_edge_service &storage_json_edge_service_instance() {
  static const file_storage_json_edge_service service;
  return service;
}

const char *episode_status_text(yy_enums::EpisodeStatus status) {
  switch (status) {
  case yy_enums::EpisodeStatus::Open:
    return "open";
  case yy_enums::EpisodeStatus::Ended:
    return "ended";
  case yy_enums::EpisodeStatus::Aborted:
    return "aborted";
  case yy_enums::EpisodeStatus::Tombstoned:
    return "tombstoned";
  }
  return "unknown";
}

const char *episode_ref_kind_text(yy_enums::EpisodeRefKind kind) {
  switch (kind) {
  case yy_enums::EpisodeRefKind::InputFrame:
    return "input_frame";
  case yy_enums::EpisodeRefKind::Payload:
    return "payload";
  case yy_enums::EpisodeRefKind::Schema:
    return "schema";
  case yy_enums::EpisodeRefKind::Episode:
    return "episode";
  }
  return "unknown";
}

template <typename T> nlohmann::json episode_base_record_json(const char *kind, const T &record) {
  return {{"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
          {"record_kind", kind},
          {"schema_version", record.schema_version},
          {"episode_id", record.episode_id},
          {"location_uid", record.location_uid}};
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeOpen &record) {
  auto row = episode_base_record_json("episode_open", record);
  row["status"] = episode_status_text(yy_enums::EpisodeStatus::Open);
  row["parent_episode_id"] = record.parent_episode_id;
  row["root_trigger_frame_uid"] = record.root_trigger_frame_uid;
  row["begin_time"] = record.begin_time;
  row["title"] = std::string(record.title.value);
  row["actor"] = std::string(record.actor.value);
  row["source"] = std::string(record.source.value);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeHeartbeat &record) {
  auto row = episode_base_record_json("episode_heartbeat", record);
  row["update_time"] = record.update_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["note"] = std::string(record.note.value);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeFrameAttached &record) {
  auto row = episode_base_record_json("episode_frame_attached", record);
  row["frame_uid"] = record.frame_uid;
  row["trigger_frame_uid"] = record.trigger_frame_uid;
  row["stream_id"] = record.stream_id;
  row["gen_time"] = record.gen_time;
  row["trigger_time"] = record.trigger_time;
  row["carrier_type"] = record.carrier_type;
  row["source"] = record.source;
  row["dest"] = record.dest;
  row["data_length"] = record.data_length;
  row["integrity_version"] = record.integrity_version;
  row["payload_checksum"] = record.payload_checksum;
  row["frame_checksum"] = record.frame_checksum;
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRefAttached &record) {
  auto row = episode_base_record_json("episode_ref_attached", record);
  row["ref_kind"] = episode_ref_kind_text(record.ref_kind);
  row["ref_uid"] = record.ref_uid;
  row["update_time"] = record.update_time;
  row["ref_id"] = std::string(record.ref_id.value);
  row["ref_hash"] = std::string(record.ref_hash.value);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeClosed &record) {
  auto row = episode_base_record_json("episode_closed", record);
  row["status"] = episode_status_text(record.status);
  row["end_time"] = record.end_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["reason"] = std::string(record.reason.value);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRootCommitted &record) {
  auto row = episode_base_record_json("episode_root_committed", record);
  row["commit_time"] = record.commit_time;
  row["covered_record_count"] = record.covered_record_count;
  row["algorithm"] = std::string(record.algorithm.value);
  row["root_value"] = std::string(record.root_value.value);
  return row;
}

nlohmann::json episode_record_row_json(const yy_storage::episode_manifest_record &record) {
  auto row = std::visit(
      [&record](const auto &body) -> nlohmann::json {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, yy_storage::episode_manifest_unknown_record>) {
          return {{"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                  {"record_kind", "unknown"},
                  {"carrier_type", body.carrier_type},
                  {"frame_uid", record.manifest_frame_uid},
                  {"gen_time", record.manifest_gen_time}};
        } else {
          return episode_record_body_json(body);
        }
      },
      record.body);
  row["manifest_frame_uid"] = record.manifest_frame_uid;
  row["manifest_gen_time"] = record.manifest_gen_time;
  return row;
}

nlohmann::json episode_summary_json(const yy_storage::episode_current_view &view) {
  nlohmann::json summary = nlohmann::json::object();
  if (view.opened) {
    summary = episode_record_body_json(view.open);
    summary["manifest_frame_uid"] = view.open_manifest_frame_uid;
    summary["manifest_gen_time"] = view.open_manifest_gen_time;
  }
  if (view.heartbeat_seen) {
    summary["update_time"] = view.update_time;
  }
  if (view.last_frame_uid_seen) {
    summary["last_frame_uid"] = view.last_frame_uid;
  }
  if (view.closed) {
    summary["status"] = episode_status_text(view.close.status);
    summary["end_time"] = view.close.end_time;
    summary["reason"] = std::string(view.close.reason.value);
  }
  summary["schema"] = yy_storage::EPISODE_MANIFEST_SCHEMA_V1;
  summary["episode_id"] = view.episode_id;
  summary["opened"] = view.opened;
  summary["closed"] = view.closed;
  summary["record_count"] = view.records.size();
  summary["frame_count"] = view.frame_indices.size();
  summary["ref_count"] = view.ref_indices.size();
  size_t payload_ref_count = 0;
  size_t schema_ref_count = 0;
  for (size_t position = 0; position < view.ref_indices.size(); ++position) {
    const auto kind = view.ref_at(position).ref_kind;
    payload_ref_count += kind == yy_enums::EpisodeRefKind::Payload ? 1 : 0;
    schema_ref_count += kind == yy_enums::EpisodeRefKind::Schema ? 1 : 0;
  }
  summary["payload_ref_count"] = payload_ref_count;
  summary["schema_ref_count"] = schema_ref_count;
  if (view.root_seen) {
    summary["content_root"] = std::string(view.root.root_value.value);
    summary["content_root_algorithm"] = std::string(view.root.algorithm.value);
  }
  if (!summary.contains("status")) {
    summary["status"] = view.opened ? "open" : "dangling";
  }
  return summary;
}

nlohmann::json storage_query_rows_json(const storage_query_rows &rows) {
  return std::visit(
      [](const auto &typed_rows) {
        using rows_t = std::decay_t<decltype(typed_rows)>;
        nlohmann::json rendered = nlohmann::json::array();
        for (const auto &row : typed_rows) {
          if constexpr (std::is_same_v<rows_t, std::vector<storage_source_query_row>>) {
            rendered.push_back({{"source_uid", row.source_uid},
                                {"source_id", row.source_id},
                                {"source_type", row.source_type},
                                {"coordinate", row.coordinate},
                                {"manifest_id", row.manifest_id},
                                {"source_head", row.source_head},
                                {"accept_time", row.accept_time},
                                {"entry_count", row.entry_count},
                                {"sync_root", {{"algorithm", row.sync_root.algorithm}, {"value", row.sync_root.value}}},
                                {"manifest_count", row.manifest_count},
                                {"export_count", row.export_count}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<storage_manifest_query_row>>) {
            rendered.push_back({{"manifest_id", row.manifest_id},
                                {"accept_time", row.accept_time},
                                {"entry_count", row.entry_count},
                                {"entries_hash", row.entries_hash},
                                {"sync_root", {{"algorithm", row.sync_root.algorithm}, {"value", row.sync_root.value}}},
                                {"status", row.status},
                                {"source_id", row.source_id}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<storage_entry_query_row>>) {
            rendered.push_back({{"kind", row.kind},
                                {"source_id", row.source_id},
                                {"source_path", row.source_path},
                                {"source_time", row.source_time},
                                {"schema_version", row.schema_version},
                                {"content_type", row.content_type},
                                {"payload_hash", row.payload_hash},
                                {"byte_len", row.byte_len},
                                {"payload_state", row.payload_state},
                                {"entry_index", row.entry_index},
                                {"accept_time", row.accept_time},
                                {"storage_source_id", row.storage_source_id},
                                {"manifest_id", row.manifest_id}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<yy_storage::episode_current_view>>) {
            rendered.push_back(episode_summary_json(row));
          } else {
            rendered.push_back(episode_record_row_json(row));
          }
        }
        return rendered;
      },
      rows);
}

nlohmann::json make_request(storage_operation operation, const storage_service_options &options) {
  return {
      {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"operation", storage_operation_name(operation)},
      {"runtime_dir", options.runtime_dir},
      {"provider", options.provider},
      {"provider_config_source", options.provider_config_source},
      {"scope", options.scope},
      {"source_id", options.source_id},
      {"dry_run", options.dry_run},
      {"verify", options.verify},
      {"range", options.range},
      {"artifact_uri", options.artifact_uri},
  };
}

} // namespace

size_t storage_query_result::row_count() const {
  return std::visit([](const auto &typed_rows) { return typed_rows.size(); }, rows);
}

std::string storage_query_kind_name(storage_query_kind kind) {
  switch (kind) {
  case storage_query_kind::Sources:
    return "sources";
  case storage_query_kind::Manifests:
    return "manifests";
  case storage_query_kind::Entries:
    return "entries";
  case storage_query_kind::Episodes:
    return "episodes";
  case storage_query_kind::EpisodeRecords:
    return "episode_records";
  case storage_query_kind::EpisodeFrames:
    return "episode_frames";
  case storage_query_kind::EpisodeRefs:
    return "episode_refs";
  }
  throw std::invalid_argument("unknown storage query kind");
}

storage_query_kind parse_storage_query_kind(const std::string &kind) {
  const auto normalized = kind.empty() ? std::string("entries") : kind;
  if (normalized == "sources") {
    return storage_query_kind::Sources;
  }
  if (normalized == "manifests") {
    return storage_query_kind::Manifests;
  }
  if (normalized == "entries") {
    return storage_query_kind::Entries;
  }
  if (normalized == "episodes") {
    return storage_query_kind::Episodes;
  }
  if (normalized == "episode_records") {
    return storage_query_kind::EpisodeRecords;
  }
  if (normalized == "episode_frames") {
    return storage_query_kind::EpisodeFrames;
  }
  if (normalized == "episode_refs") {
    return storage_query_kind::EpisodeRefs;
  }
  throw std::invalid_argument("unsupported storage query: " + normalized);
}

const storage_service &default_storage_service() { return typed_storage_service_instance(); }

storage_query_request parse_storage_query_request(const storage_service_options &options) {
  storage_query_request request{};
  request.runtime_dir = options.runtime_dir;
  request.provider = options.provider;
  request.provider_config_source = options.provider_config_source;
  request.source_id = options.source_id;
  request.entry_kind = options.kind;
  request.range.since = text_or(options.range, "since");
  request.range.until = text_or(options.range, "until");
  request.query = parse_storage_query_kind(options.query);
  request.episode_id = options.episode_id;
  request.limit = options.limit;
  return request;
}

storage_status_request parse_storage_status_request(const storage_service_options &options) {
  return {options.runtime_dir, options.provider, options.provider_config_source, options.source_id};
}

nlohmann::json render_storage_status_result(const storage_status_result &result) {
  const auto range_json = [](const storage_time_range &range) {
    nlohmann::json rendered = nlohmann::json::object();
    if (!range.since.empty()) {
      rendered["since"] = range.since;
    }
    if (!range.until.empty()) {
      rendered["until"] = range.until;
    }
    return rendered;
  };
  const auto sync_root_json = [](const storage_sync_root_view &root) {
    return nlohmann::json{{"algorithm", root.algorithm}, {"value", root.value}};
  };
  const auto proof_root_json = [&sync_root_json](const storage_sync_root_view &root, uint64_t entry_count) {
    auto rendered = sync_root_json(root);
    rendered["schema"] = yy_storage::SYNC_ROOT_SCHEMA_V1;
    rendered["scope"] = yy_storage::SYNC_ROOT_SCOPE_ATLAS_IMPORT_MANIFEST;
    rendered["proof"] = yy_storage::SYNC_ROOT_PROOF_LINEAR_CHAIN_V1;
    rendered["entry_count"] = entry_count;
    rendered["initial"] = yy_storage::SYNC_ROOT_INITIAL_SHA256;
    rendered["ordering"] = {{"policy", yy_storage::SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
                            {"fields", nlohmann::json::array({"kind", "source_id", "source_path"})}};
    return rendered;
  };
  const auto accepted_range_json = [&range_json, &proof_root_json](const storage_accepted_range_view &range) {
    return nlohmann::json{{"schema", yy_storage::STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
                          {"source_id", range.source_id},
                          {"manifest_id", range.manifest_id},
                          {"range", range_json(range.range)},
                          {"source_head", range.source_head},
                          {"sync_root", proof_root_json(range.sync_root, range.entry_count)},
                          {"entry_count", range.entry_count},
                          {"status", range.status}};
  };
  const auto source_json = [](const storage_source_registry_view &source) {
    nlohmann::json rendered = {{"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
                               {"source_uid", source.source_uid},
                               {"source_id", source.source_id},
                               {"registered", source.registered},
                               {"record_count", source.record_count},
                               {"accepted_range_count", source.accepted_range_count}};
    if (source.registered) {
      rendered["kind"] = *source.kind;
      rendered["coordinate"] = *source.coordinate;
      rendered["head"] = *source.head;
      rendered["location_uid"] = *source.location_uid;
      rendered["register_time"] = *source.register_time;
    }
    if (source.current_range.has_value()) {
      const auto &range = *source.current_range;
      rendered["current_range"] = {{"first_frame_uid", range.first_frame_uid},
                                   {"last_frame_uid", range.last_frame_uid},
                                   {"since", range.since},
                                   {"until", range.until}};
      rendered["inventory_hash"] = {{"algorithm", source.inventory_hash->algorithm},
                                    {"value", source.inventory_hash->value}};
      rendered["update_time"] = *source.update_time;
    }
    return rendered;
  };

  nlohmann::json sources = nlohmann::json::array();
  for (const auto &source : result.sources) {
    sources.push_back(source_json(source));
  }
  nlohmann::json projections = nlohmann::json::array();
  for (const auto &projection : result.projections) {
    projections.push_back(projection_status_json(projection));
  }
  nlohmann::json source_status = nlohmann::json::array();
  for (const auto &status : result.source_status) {
    nlohmann::json row = {{"source_id", status.source_id}, {"ok", status.ok}, {"authority", result.authority}};
    if (!status.ok) {
      row["reason"] = *status.reason;
      row["source"] = source_json(status.source);
      source_status.push_back(std::move(row));
      continue;
    }
    row["manifest_id"] = *status.manifest_id;
    row["source_type"] = *status.source_type;
    row["source_head"] = *status.source_head;
    row["accepted_ranges"] = nlohmann::json::array({accepted_range_json(*status.accepted_range)});
    if (status.accepted_cursor.has_value()) {
      const auto &cursor = *status.accepted_cursor;
      row["accepted_cursor"] = {{"schema", yy_storage::STORAGE_CHANNEL_CURSOR_SCHEMA_V1},
                                {"source_id", cursor.source_id},
                                {"manifest_id", cursor.manifest_id},
                                {"source_head", cursor.source_head},
                                {"range", range_json(cursor.range)},
                                {"sync_root", sync_root_json(cursor.sync_root)},
                                {"entry_count", cursor.entry_count}};
    } else {
      row["accepted_cursor"] = nullptr;
    }
    row["sync_root"] = proof_root_json(*status.sync_root, status.entries);
    row["entries"] = status.entries;
    row["payload_inventory"] = status.payload_inventory;
    row["schema_inventory"] = status.schema_inventory;
    const auto &record = *status.source_record;
    row["source_record"] = {{"schema", yy_storage::STORAGE_SOURCE_RECORD_SCHEMA_V1},
                            {"source_id", record.source_id},
                            {"type", record.source_type},
                            {"kind", record.kind},
                            {"coordinate", record.coordinate},
                            {"current_head",
                             {{"head", record.source_head},
                              {"range", range_json(record.range)},
                              {"inventory_hash", record.inventory_hash}}},
                            {"accepted_ranges", nlohmann::json::array({accepted_range_json(record.accepted_range)})},
                            {"last_manifest_id", record.manifest_id},
                            {"updated_at", ""}};
    source_status.push_back(std::move(row));
  }

  return {{"ok", result.ok},
          {"backend", result.backend},
          {"provider", result.provider},
          {"provider_config_source", result.provider_config_source},
          {"provider_runtime", provider_runtime_json(result.provider_runtime)},
          {"provider_cache", provider_cache_json(result.provider_cache)},
          {"scope", result.scope},
          {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
          {"authority", result.authority},
          {"sources", std::move(sources)},
          {"source_count", result.sources.size()},
          {"projections", std::move(projections)},
          {"source_status", std::move(source_status)}};
}

nlohmann::json render_storage_query_result(const storage_query_result &result) {
  auto rows = storage_query_rows_json(result.rows);
  nlohmann::json rendered = {{"ok", result.ok},
                             {"scope", result.scope},
                             {"projection",
                              {{"name", result.projection_name},
                               {"schema", result.projection_schema},
                               {"authority", result.authority},
                               {"rebuildable", result.rebuildable}}},
                             {"query", storage_query_kind_name(result.query)},
                             {"limit", result.limit},
                             {"rows", std::move(rows)},
                             {"row_count", result.row_count()}};
  const bool episode_query =
      result.query == storage_query_kind::Episodes || result.query == storage_query_kind::EpisodeRecords ||
      result.query == storage_query_kind::EpisodeFrames || result.query == storage_query_kind::EpisodeRefs;
  if (episode_query) {
    rendered["episode_id"] =
        result.episode_id.has_value() ? nlohmann::json(*result.episode_id) : nlohmann::json(nullptr);
  } else {
    rendered["source_id"] = result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr);
    rendered["kind"] = result.entry_kind.has_value() ? nlohmann::json(*result.entry_kind) : nlohmann::json(nullptr);
    nlohmann::json range = nlohmann::json::object();
    if (!result.range.since.empty()) {
      range["since"] = result.range.since;
    }
    if (!result.range.until.empty()) {
      range["until"] = result.range.until;
    }
    rendered["range"] = std::move(range);
  }
  if (!result.errors.empty()) {
    rendered["errors"] = nlohmann::json::array();
    for (const auto &error : result.errors) {
      nlohmann::json row = {{"code", error.code}};
      if (error.episode_id.has_value()) {
        row["episode_id"] = *error.episode_id;
      }
      rendered["errors"].push_back(std::move(row));
    }
  }
  return rendered;
}

std::vector<std::string> storage_operation_names() {
  return {
      storage_operation_name(storage_operation::Status),
      storage_operation_name(storage_operation::Fsck),
      storage_operation_name(storage_operation::RepairPlan),
      storage_operation_name(storage_operation::RepairFetch),
      storage_operation_name(storage_operation::RepairApply),
      storage_operation_name(storage_operation::ExportBundle),
      storage_operation_name(storage_operation::ImportBundle),
      storage_operation_name(storage_operation::RebuildIndex),
      storage_operation_name(storage_operation::GcPlan),
      storage_operation_name(storage_operation::CompactPlan),
      storage_operation_name(storage_operation::VerifySync),
      storage_operation_name(storage_operation::Query),
      storage_operation_name(storage_operation::Layout),
      storage_operation_name(storage_operation::EpisodeBegin),
      storage_operation_name(storage_operation::EpisodeHeartbeat),
      storage_operation_name(storage_operation::EpisodeEnd),
      storage_operation_name(storage_operation::EpisodeAbort),
      storage_operation_name(storage_operation::EpisodeAttachFrame),
      storage_operation_name(storage_operation::EpisodeAttachRef),
      storage_operation_name(storage_operation::EpisodeList),
      storage_operation_name(storage_operation::EpisodeInspect),
      storage_operation_name(storage_operation::SourceRegister),
      storage_operation_name(storage_operation::SourceUpdateHead),
      storage_operation_name(storage_operation::SourceRecordAcceptedRange),
      storage_operation_name(storage_operation::SourceList),
      storage_operation_name(storage_operation::SourceInspect),
      storage_operation_name(storage_operation::SourceRegistryFsck),
      storage_operation_name(storage_operation::SourceRegistryRebuild),
  };
}

std::string storage_operation_name(storage_operation operation) {
  switch (operation) {
  case storage_operation::Status:
    return "status";
  case storage_operation::Fsck:
    return "fsck";
  case storage_operation::RepairPlan:
    return "repair_plan";
  case storage_operation::RepairFetch:
    return "repair_fetch";
  case storage_operation::RepairApply:
    return "repair_apply";
  case storage_operation::ExportBundle:
    return "export_bundle";
  case storage_operation::ImportBundle:
    return "import_bundle";
  case storage_operation::RebuildIndex:
    return "rebuild_index";
  case storage_operation::GcPlan:
    return "gc_plan";
  case storage_operation::CompactPlan:
    return "compact_plan";
  case storage_operation::VerifySync:
    return "verify_sync";
  case storage_operation::Query:
    return "query";
  case storage_operation::Layout:
    return "layout";
  case storage_operation::EpisodeBegin:
    return "episode_begin";
  case storage_operation::EpisodeHeartbeat:
    return "episode_heartbeat";
  case storage_operation::EpisodeEnd:
    return "episode_end";
  case storage_operation::EpisodeAbort:
    return "episode_abort";
  case storage_operation::EpisodeAttachFrame:
    return "episode_attach_frame";
  case storage_operation::EpisodeAttachRef:
    return "episode_attach_ref";
  case storage_operation::EpisodeList:
    return "episode_list";
  case storage_operation::EpisodeInspect:
    return "episode_inspect";
  case storage_operation::EpisodeRecover:
    return "episode_recover";
  case storage_operation::EpisodeProjectionRebuild:
    return "episode_projection_rebuild";
  case storage_operation::SourceRegister:
    return "source_register";
  case storage_operation::SourceUpdateHead:
    return "source_update_head";
  case storage_operation::SourceRecordAcceptedRange:
    return "source_record_accepted_range";
  case storage_operation::SourceList:
    return "source_list";
  case storage_operation::SourceInspect:
    return "source_inspect";
  case storage_operation::SourceRegistryFsck:
    return "source_registry_fsck";
  case storage_operation::SourceRegistryRebuild:
    return "source_registry_rebuild";
  }
  throw std::invalid_argument("unknown storage operation");
}

storage_operation parse_storage_operation(const std::string &operation) {
  if (operation == "status") {
    return storage_operation::Status;
  }
  if (operation == "fsck") {
    return storage_operation::Fsck;
  }
  if (operation == "repair_plan") {
    return storage_operation::RepairPlan;
  }
  if (operation == "repair_fetch") {
    return storage_operation::RepairFetch;
  }
  if (operation == "repair_apply") {
    return storage_operation::RepairApply;
  }
  if (operation == "export_bundle") {
    return storage_operation::ExportBundle;
  }
  if (operation == "import_bundle") {
    return storage_operation::ImportBundle;
  }
  if (operation == "rebuild_index") {
    return storage_operation::RebuildIndex;
  }
  if (operation == "gc_plan") {
    return storage_operation::GcPlan;
  }
  if (operation == "compact_plan") {
    return storage_operation::CompactPlan;
  }
  if (operation == "verify_sync") {
    return storage_operation::VerifySync;
  }
  if (operation == "query") {
    return storage_operation::Query;
  }
  if (operation == "layout") {
    return storage_operation::Layout;
  }
  if (operation == "episode_begin") {
    return storage_operation::EpisodeBegin;
  }
  if (operation == "episode_heartbeat") {
    return storage_operation::EpisodeHeartbeat;
  }
  if (operation == "episode_end") {
    return storage_operation::EpisodeEnd;
  }
  if (operation == "episode_abort") {
    return storage_operation::EpisodeAbort;
  }
  if (operation == "episode_attach_frame") {
    return storage_operation::EpisodeAttachFrame;
  }
  if (operation == "episode_attach_ref") {
    return storage_operation::EpisodeAttachRef;
  }
  if (operation == "episode_list") {
    return storage_operation::EpisodeList;
  }
  if (operation == "episode_inspect") {
    return storage_operation::EpisodeInspect;
  }
  if (operation == "episode_recover") {
    return storage_operation::EpisodeRecover;
  }
  if (operation == "episode_projection_rebuild") {
    return storage_operation::EpisodeProjectionRebuild;
  }
  if (operation == "source_register") {
    return storage_operation::SourceRegister;
  }
  if (operation == "source_update_head") {
    return storage_operation::SourceUpdateHead;
  }
  if (operation == "source_record_accepted_range") {
    return storage_operation::SourceRecordAcceptedRange;
  }
  if (operation == "source_list") {
    return storage_operation::SourceList;
  }
  if (operation == "source_inspect") {
    return storage_operation::SourceInspect;
  }
  if (operation == "source_registry_fsck") {
    return storage_operation::SourceRegistryFsck;
  }
  if (operation == "source_registry_rebuild") {
    return storage_operation::SourceRegistryRebuild;
  }
  throw std::invalid_argument("unsupported storage operation: " + operation);
}

storage_service_options parse_storage_service_options(const std::string &runtime_dir, const nlohmann::json &options) {
  storage_service_options parsed;
  parsed.runtime_dir = runtime_dir;
  const auto selected_provider = select_provider(text_or(options, "provider"));
  parsed.provider = selected_provider.name;
  parsed.provider_config_source = selected_provider.source;
  parsed.scope = text_or(options, "scope", "all");
  parsed.source_id = text_or(options, "source_id");
  parsed.dry_run = bool_or(options, "dry_run", true);
  parsed.verify = bool_or(options, "verify", true);
  parsed.range = object_or_empty(options, "range");
  parsed.artifact_uri = text_or(options, "artifact_uri");
  parsed.bundle = object_or_empty(options, "bundle");
  parsed.manifest = object_or_empty(options, "manifest");
  parsed.operation_options = options;
  parsed.query = text_or(options, "query", "entries");
  parsed.kind = text_or(options, "kind");
  parsed.episode_id = uint64_or(options, "episode_id");
  parsed.limit = uint64_or(options, "limit", 100);
  return parsed;
}

nlohmann::json make_storage_service_request(const std::string &operation, const std::string &runtime_dir,
                                            const nlohmann::json &options) {
  const auto parsed_operation = parse_storage_operation(operation);
  const auto parsed_options = parse_storage_service_options(runtime_dir, options);
  auto request = make_request(parsed_operation, parsed_options);
  if (parsed_operation == storage_operation::Query) {
    request["query"] = parsed_options.query;
    request["kind"] = parsed_options.kind.empty() ? nlohmann::json(nullptr) : nlohmann::json(parsed_options.kind);
    request["limit"] = parsed_options.limit;
  } else if (parsed_operation == storage_operation::Layout) {
    request["runtime_home"] = runtime_home_path(parsed_options).string();
    request["runtime_home_source"] = runtime_home_source(parsed_options);
    request["config_home"] = optional_absolute_path(parsed_options.operation_options, "config_home");
  }
  if (parsed_options.episode_id != 0) {
    request["episode_id"] = parsed_options.episode_id;
  }
  if (parsed_operation == storage_operation::EpisodeList) {
    request["location_uid"] = uint64_or(options, "location_uid");
    request["limit"] = parsed_options.limit;
  } else if (parsed_operation == storage_operation::EpisodeInspect) {
    request["episode_id"] = uint64_or(options, "episode_id");
  } else if (storage_operation_name(parsed_operation).rfind("episode_", 0) == 0) {
    request["episode"] = parsed_options.operation_options;
  }
  return request;
}

nlohmann::json run_storage_service_operation(const std::string &operation, const std::string &runtime_dir,
                                             const nlohmann::json &options) {
  const auto parsed_operation = parse_storage_operation(operation);
  const auto parsed_options = parse_storage_service_options(runtime_dir, options);
  switch (parsed_operation) {
  case storage_operation::Status:
    return storage_json_edge_service_instance().status(parsed_options);
  case storage_operation::Fsck:
    return storage_json_edge_service_instance().fsck(parsed_options);
  case storage_operation::RepairPlan:
    return storage_json_edge_service_instance().repair_plan(parsed_options);
  case storage_operation::RepairFetch:
    return storage_json_edge_service_instance().repair_fetch(parsed_options);
  case storage_operation::RepairApply:
    return storage_json_edge_service_instance().repair_apply(parsed_options);
  case storage_operation::ExportBundle:
    return storage_json_edge_service_instance().export_bundle(parsed_options);
  case storage_operation::ImportBundle:
    return storage_json_edge_service_instance().import_bundle(parsed_options);
  case storage_operation::RebuildIndex:
    return storage_json_edge_service_instance().rebuild_index(parsed_options);
  case storage_operation::GcPlan:
    return storage_json_edge_service_instance().gc_plan(parsed_options);
  case storage_operation::CompactPlan:
    return storage_json_edge_service_instance().compact_plan(parsed_options);
  case storage_operation::VerifySync:
    return storage_json_edge_service_instance().verify_sync(parsed_options);
  case storage_operation::Query:
    return render_storage_query_result(default_storage_service().query(parse_storage_query_request(parsed_options)));
  case storage_operation::Layout:
    return storage_json_edge_service_instance().layout(parsed_options);
  case storage_operation::EpisodeBegin:
    return storage_json_edge_service_instance().episode_begin(parsed_options);
  case storage_operation::EpisodeHeartbeat:
    return storage_json_edge_service_instance().episode_heartbeat(parsed_options);
  case storage_operation::EpisodeEnd:
    return storage_json_edge_service_instance().episode_end(parsed_options);
  case storage_operation::EpisodeAbort:
    return storage_json_edge_service_instance().episode_abort(parsed_options);
  case storage_operation::EpisodeAttachFrame:
    return storage_json_edge_service_instance().episode_attach_frame(parsed_options);
  case storage_operation::EpisodeAttachRef:
    return storage_json_edge_service_instance().episode_attach_ref(parsed_options);
  case storage_operation::EpisodeList:
    return storage_json_edge_service_instance().episode_list(parsed_options);
  case storage_operation::EpisodeInspect:
    return storage_json_edge_service_instance().episode_inspect(parsed_options);
  case storage_operation::EpisodeRecover:
    return storage_json_edge_service_instance().episode_recover(parsed_options);
  case storage_operation::EpisodeProjectionRebuild:
    return storage_json_edge_service_instance().episode_projection_rebuild(parsed_options);
  case storage_operation::SourceRegister:
    return storage_json_edge_service_instance().source_register(parsed_options);
  case storage_operation::SourceUpdateHead:
    return storage_json_edge_service_instance().source_update_head(parsed_options);
  case storage_operation::SourceRecordAcceptedRange:
    return storage_json_edge_service_instance().source_record_accepted_range(parsed_options);
  case storage_operation::SourceList:
    return storage_json_edge_service_instance().source_list(parsed_options);
  case storage_operation::SourceInspect:
    return storage_json_edge_service_instance().source_inspect(parsed_options);
  case storage_operation::SourceRegistryFsck:
    return storage_json_edge_service_instance().source_registry_fsck(parsed_options);
  case storage_operation::SourceRegistryRebuild:
    return storage_json_edge_service_instance().source_registry_rebuild(parsed_options);
  }
  throw std::invalid_argument("unknown storage operation");
}

nlohmann::json accept_storage_manifest(const std::string &runtime_dir, const nlohmann::json &manifest) {
  return accept_storage_manifest_impl(runtime_dir, manifest);
}

nlohmann::json load_storage_latest_manifest(const std::string &runtime_dir, const std::string &source_id) {
  const auto provider = shared_provider(runtime_dir);
  return load_latest_manifest_impl(runtime_dir, *provider, source_id);
}

nlohmann::json export_storage_records(const std::string &runtime_dir, const std::string &source_id,
                                      const nlohmann::json &range) {
  const auto provider = shared_provider(runtime_dir);
  const auto manifest = load_latest_manifest_impl(runtime_dir, *provider, source_id);
  if (manifest.is_null()) {
    throw std::runtime_error("manifest not found: " + source_id);
  }
  nlohmann::json records = nlohmann::json::array();
  for (const auto &entry : entries_for_manifest(manifest, range)) {
    auto row = entry;
    row["scope"] = text_or(manifest, "scope");
    row["manifest_id"] = text_or(manifest, "manifest_id");
    row["storage_source_id"] = source_id;
    row["source_type"] = text_or(manifest, "source_type");
    row["source_head"] = text_or(manifest, "source_head");
    const auto state = text_or(entry, "payload_state", PAYLOAD_STATE_PRESENT);
    if (state == PAYLOAD_STATE_REDACTED || state == PAYLOAD_STATE_ABSENT) {
      row["payload"] = nullptr;
    } else if (state != PAYLOAD_STATE_PRESENT) {
      auto [payload, error] = load_payload_impl(*provider, entry);
      row["payload"] = error.empty() ? payload : nlohmann::json(nullptr);
    } else {
      auto [payload, error] = load_payload_impl(*provider, entry);
      if (!error.empty()) {
        throw std::runtime_error(error + ": " + text_or(entry, "kind") + ":" + text_or(entry, "source_id"));
      }
      row["payload"] = payload;
    }
    records.push_back(row);
  }
  std::sort(records.begin(), records.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return std::make_tuple(text_or(lhs, "kind"), text_or(lhs, "source_id"), text_or(lhs, "source_path")) <
           std::make_tuple(text_or(rhs, "kind"), text_or(rhs, "source_id"), text_or(rhs, "source_path"));
  });
  return records;
}

std::string write_storage_payload_bytes(const std::string &runtime_dir, const std::string &digest,
                                        const std::string &raw) {
  const auto error = yy_storage::verify_payload_ref(raw, digest, raw.size(), yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
  if (!error.empty()) {
    throw std::invalid_argument("storage_payload_invalid: " + error);
  }
  const auto provider = shared_provider(runtime_dir);
  provider->write_payload(digest, raw);
  return provider->name() == PROVIDER_ROCKSDB ? storage_uri(PROVIDER_ROCKSDB, runtime_dir, "payloads/" + digest)
                                              : payload_path(runtime_dir, digest).string();
}

namespace {

nlohmann::json content_result_json(const yy_storage::content_store_result &result) {
  return {{"ok", result.ok()},
          {"error", yy_storage::content_store_error_name(result.error)},
          {"hash", {{"algorithm", result.hash.algorithm}, {"value", result.hash.value}}},
          {"byte_length", result.byte_length},
          {"existed", result.existed},
          {"message", result.message}};
}

// Accept "<algo>:<hex>" or bare hex, mirroring the kernel's ref resolution.
bool parse_content_hash_text(const std::string &text, yy_storage::content_hash &hash, std::string &message) {
  try {
    hash = text.find(':') != std::string::npos ? yy_storage::parse_content_hash(text)
                                               : yy_storage::make_content_hash(text);
    return true;
  } catch (const std::exception &e) {
    message = e.what();
    return false;
  }
}

nlohmann::json invalid_content_hash_json(const std::string &message) {
  yy_storage::content_store_result result{};
  result.error = yy_storage::content_store_error::InvalidArgument;
  result.message = message;
  return content_result_json(result);
}

} // namespace

// ADR-0040 content-store facade: one immutable contract routed through the
// provider selected for this runtime dir, so file and engine-backed profiles
// serve Python/Node through the same vocabulary as C++.
nlohmann::json content_store_put_if_absent(const std::string &runtime_dir, const std::string &content_namespace,
                                           const std::string &raw, const std::string &expected_hash) {
  yy_storage::content_hash expected{};
  if (!expected_hash.empty()) {
    std::string message;
    if (!parse_content_hash_text(expected_hash, expected, message)) {
      return invalid_content_hash_json(message);
    }
  }
  const auto provider = shared_provider(runtime_dir);
  return content_result_json(provider->content_store().put_if_absent(content_namespace, raw, expected));
}

bool content_store_has(const std::string &runtime_dir, const std::string &content_namespace,
                       const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    return false;
  }
  const auto provider = shared_provider(runtime_dir);
  return provider->content_store().has(content_namespace, hash);
}

nlohmann::json content_store_verify(const std::string &runtime_dir, const std::string &content_namespace,
                                    const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    return invalid_content_hash_json(message);
  }
  const auto provider = shared_provider(runtime_dir);
  return content_result_json(provider->content_store().verify(content_namespace, hash));
}

std::string content_store_get(const std::string &runtime_dir, const std::string &content_namespace,
                              const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    throw std::invalid_argument("content_store_get: " + message);
  }
  const auto provider = shared_provider(runtime_dir);
  auto result = provider->content_store().get(content_namespace, hash);
  if (!result.ok()) {
    throw std::runtime_error(std::string("content_store_get_failed: ") +
                             yy_storage::content_store_error_name(result.error) +
                             (result.message.empty() ? "" : ": " + result.message));
  }
  return std::move(result.bytes);
}

nlohmann::json content_store_capabilities(const std::string &runtime_dir) {
  const auto provider = shared_provider(runtime_dir);
  const auto caps = provider->content_store().capabilities();
  return {{"provider", provider->name()},
          {"profile", caps.profile},
          {"hash_algorithm", caps.hash_algorithm},
          {"max_object_size", caps.max_object_size},
          {"atomic_put_if_absent", caps.atomic_put_if_absent},
          {"verified_reads", caps.verified_reads},
          {"durability", caps.durability},
          {"visibility", caps.visibility},
          {"concurrency", caps.concurrency}};
}

nlohmann::json storage_service_capabilities() {
  const auto provider = select_provider({});
  return {
      {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"operations", storage_operation_names()},
      {"backend", provider.name},
      {"provider", provider.name},
      {"provider_config_source", provider.source},
      {"providers", nlohmann::json::array({
                        {{"name", PROVIDER_FILE},
                         {"default", provider.name == PROVIDER_FILE},
                         {"selected", provider.name == PROVIDER_FILE},
                         {"layout", file_storage_provider("").layout()},
                         {"runtime", provider_runtime_json(file_storage_provider("").runtime())}},
                        {{"name", PROVIDER_ROCKSDB},
                         {"default", provider.name == PROVIDER_ROCKSDB},
                         {"selected", provider.name == PROVIDER_ROCKSDB},
                         {"layout", rocksdb_storage_provider("").layout()},
                         {"runtime", provider_runtime_json(rocksdb_storage_provider("").runtime())}},
                    })},
      {"projections",
       nlohmann::json::array(
           {{{"name", "source-registry"},
             {"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/source-registry/live/*.journal"},
             {"rebuildable", false}},
            {{"name", PROJECTION_SOURCE_REGISTRY},
             {"schema", SOURCE_REGISTRY_PROJECTION_SCHEMA_V1},
             {"authority", "derived"},
             {"path", "storage/projections/source-registry.sqlite"},
             {"rebuildable", true}},
            {{"name", "manifest-catalog"},
             {"schema", yy_storage::MANIFEST_CATALOG_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/manifest-catalog/live/*.journal"},
             {"export_schema", yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1},
             {"rebuildable", false}},
            {{"name", PROJECTION_MANIFEST_CATALOG},
             {"schema", MANIFEST_CATALOG_PROJECTION_SCHEMA_V1},
             {"authority", "derived"},
             {"path", "storage/projections/manifest-catalog.sqlite"},
             {"rebuildable", true}},
            {{"name", "episode-manifest"},
             {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/episode-manifest/live/*.journal"},
             {"query_tables", nlohmann::json::array({"episodes", "episode_records", "episode_frames", "episode_refs"})},
             {"export_schema", "kungfu.storage.episode-bundle/v1"},
             {"rebuildable", false}}})},
      {"notes",
       nlohmann::json::array({
           "The runtime storage service surface and providers are owned by libkungfu.",
           "Provider selection is an implementation option; product semantics remain storage-service operations.",
           "Python and Node should remain binding, CLI, or UI layers over this service.",
       })},
  };
}

} // namespace kungfu::runtime::storage_service_api
