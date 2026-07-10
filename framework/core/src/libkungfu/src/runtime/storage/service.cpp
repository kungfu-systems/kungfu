// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/service.h>

#include <algorithm>
#include <charconv>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/storage/generic_service.h>
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
inline constexpr const char *PAYLOAD_STATE_MISSING = "missing";
inline constexpr const char *CONTENT_TYPE_JSON = "application/json";
inline constexpr const char *SOURCE_REGISTRY_SCHEMA = "kungfu.storage.source-registry/v1";
inline constexpr const char *PROJECTION_SOURCE_REGISTRY = "source-registry";
inline constexpr const char *PROJECTION_SQLITE = "sqlite";
inline constexpr const char *SQLITE_PROJECTION_SCHEMA = "kungfu.storage.sqlite-projection/v1";
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

struct stored_manifest {
  std::string source_id = {};
  std::string manifest_id = {};
  std::string uri = {};
  nlohmann::json value = nlohmann::json::object();
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

fs::path registry_path(const std::string &runtime_dir) { return root_dir(runtime_dir) / "sources.json"; }

fs::path payload_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "payloads"; }

fs::path rocksdb_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "rocksdb"; }

fs::path projection_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "projections"; }

fs::path sqlite_projection_path(const std::string &runtime_dir) {
  return projection_root(runtime_dir) / "storage.sqlite";
}

fs::path payload_path(const std::string &runtime_dir, const std::string &digest) {
  // ADR-0037: payload bodies are opaque content-addressed bytes. The file is
  // named by the content hash alone, with no format-implying extension — the
  // body format is orthogonal to the record schema, which commits to the body
  // by hash, length, and payload state (content_type is record metadata).
  return payload_root(runtime_dir) / digest.substr(0, std::min<size_t>(2, digest.size())) / digest;
}

fs::path source_manifest_dir(const std::string &runtime_dir, const std::string &source_id) {
  return root_dir(runtime_dir) / "sources" / source_id / "manifests";
}

fs::path latest_manifest_path(const std::string &runtime_dir, const std::string &source_id) {
  return source_manifest_dir(runtime_dir, source_id) / "latest.json";
}

fs::path manifest_path(const std::string &runtime_dir, const std::string &source_id, const std::string &manifest_id) {
  return source_manifest_dir(runtime_dir, source_id) / (manifest_id + ".json");
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

std::vector<fs::path> manifest_paths(const std::string &runtime_dir, const std::string &source_id = {});
std::vector<fs::path> latest_manifest_paths(const std::string &runtime_dir, const std::string &source_id = {});
std::vector<fs::path> all_payload_paths(const std::string &runtime_dir);
std::string payload_digest_from_path(const fs::path &path);

std::optional<nlohmann::json> read_json_file(const fs::path &path) {
  if (!fs::exists(path)) {
    return std::nullopt;
  }
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("failed to read JSON file: " + path.string());
  }
  auto data = nlohmann::json::parse(input);
  if (!data.is_object()) {
    return std::nullopt;
  }
  return data;
}

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
  [[nodiscard]] virtual nlohmann::json runtime() const = 0;
  [[nodiscard]] virtual std::string registry_uri() const = 0;
  [[nodiscard]] virtual nlohmann::json load_registry() const = 0;
  virtual void save_registry(const nlohmann::json &registry) const = 0;
  [[nodiscard]] virtual nlohmann::json load_latest_manifest(const std::string &source_id) const = 0;
  virtual void write_manifest(const std::string &source_id, const std::string &manifest_id,
                              const nlohmann::json &manifest) const = 0;
  virtual void write_latest_manifest(const std::string &source_id, const nlohmann::json &manifest) const = 0;
  [[nodiscard]] virtual std::vector<stored_manifest> manifest_records(const std::string &source_id = {}) const = 0;
  [[nodiscard]] virtual std::vector<stored_manifest>
  latest_manifest_records(const std::string &source_id = {}) const = 0;
  [[nodiscard]] virtual bool payload_exists(const std::string &digest) const = 0;
  [[nodiscard]] virtual std::string read_payload(const std::string &digest) const = 0;
  virtual void write_payload(const std::string &digest, const std::string &raw) const = 0;
  [[nodiscard]] virtual std::vector<stored_payload> all_payloads() const = 0;
};

class file_storage_provider : public storage_provider {
public:
  explicit file_storage_provider(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

  [[nodiscard]] std::string name() const override { return PROVIDER_FILE; }

  [[nodiscard]] nlohmann::json layout() const override {
    return {
        {"source_registry", "storage/sources.json"},
        {"source_manifests", "storage/sources/<source-id>/manifests/*.json"},
        {"payloads", "storage/payloads/<hash-prefix>/<sha256>"},
    };
  }

  [[nodiscard]] nlohmann::json runtime() const override {
    return {
        {"lifecycle", "stateless-filesystem"},
        {"handle", "per filesystem operation"},
        {"readonly_open_creates_backend", false},
        {"write_open_creates_backend", true},
    };
  }

  [[nodiscard]] std::string registry_uri() const override { return registry_path(runtime_dir_).string(); }

  [[nodiscard]] nlohmann::json load_registry() const override {
    const auto path = registry_path(runtime_dir_);
    if (!fs::exists(path)) {
      return {{"schema", SOURCE_REGISTRY_SCHEMA}, {"sources", nlohmann::json::object()}};
    }
    auto data = read_json_file(path);
    if (!data || !data->contains("sources") || !data->at("sources").is_object()) {
      throw std::runtime_error("invalid storage source registry: " + path.string());
    }
    (*data)["schema"] = data->value("schema", SOURCE_REGISTRY_SCHEMA);
    return *data;
  }

  void save_registry(const nlohmann::json &registry) const override {
    write_json_file(registry_path(runtime_dir_), registry);
  }

  [[nodiscard]] nlohmann::json load_latest_manifest(const std::string &source_id) const override {
    const auto path = latest_manifest_path(runtime_dir_, source_id);
    if (!fs::exists(path)) {
      return nullptr;
    }
    auto data = read_json_file(path);
    return data ? *data : nlohmann::json(nullptr);
  }

  void write_manifest(const std::string &source_id, const std::string &manifest_id,
                      const nlohmann::json &manifest) const override {
    write_json_file(manifest_path(runtime_dir_, source_id, manifest_id), manifest);
  }

  void write_latest_manifest(const std::string &source_id, const nlohmann::json &manifest) const override {
    write_json_file(latest_manifest_path(runtime_dir_, source_id), manifest);
  }

  [[nodiscard]] std::vector<stored_manifest> manifest_records(const std::string &source_id = {}) const override {
    std::vector<stored_manifest> records;
    for (const auto &path : manifest_paths(runtime_dir_, source_id)) {
      std::optional<nlohmann::json> manifest;
      try {
        manifest = read_json_file(path);
      } catch (const std::exception &) {
        records.push_back({{}, path.filename().string(), path.string(), nullptr});
        continue;
      }
      if (!manifest) {
        continue;
      }
      records.push_back({text_or(*manifest, "source_id"), text_or(*manifest, "manifest_id", path.filename().string()),
                         path.string(), *manifest});
    }
    return records;
  }

  [[nodiscard]] std::vector<stored_manifest> latest_manifest_records(const std::string &source_id = {}) const override {
    std::vector<stored_manifest> records;
    for (const auto &path : latest_manifest_paths(runtime_dir_, source_id)) {
      std::optional<nlohmann::json> manifest;
      try {
        manifest = read_json_file(path);
      } catch (const std::exception &) {
        records.push_back({{}, "latest", path.string(), nullptr});
        continue;
      }
      if (!manifest) {
        continue;
      }
      records.push_back({text_or(*manifest, "source_id"), text_or(*manifest, "manifest_id"), path.string(), *manifest});
    }
    return records;
  }

  [[nodiscard]] bool payload_exists(const std::string &digest) const override {
    return fs::exists(payload_path(runtime_dir_, digest));
  }

  [[nodiscard]] std::string read_payload(const std::string &digest) const override {
    return read_bytes(payload_path(runtime_dir_, digest));
  }

  void write_payload(const std::string &digest, const std::string &raw) const override {
    write_bytes(payload_path(runtime_dir_, digest), raw);
  }

  [[nodiscard]] std::vector<stored_payload> all_payloads() const override {
    std::vector<stored_payload> result;
    for (const auto &path : all_payload_paths(runtime_dir_)) {
      result.push_back({payload_digest_from_path(path), path.string(), fs::file_size(path)});
    }
    return result;
  }

private:
  std::string runtime_dir_;
};

class rocksdb_storage_provider : public storage_provider {
public:
  explicit rocksdb_storage_provider(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

  [[nodiscard]] std::string name() const override { return PROVIDER_ROCKSDB; }

  [[nodiscard]] nlohmann::json layout() const override {
    return {
        {"database", "storage/rocksdb"},
        {"source_registry", "registry"},
        {"source_manifests", "manifest/<source-id>/<manifest-id> and manifest/<source-id>/latest"},
        {"payloads", "payload/<sha256>"},
    };
  }

  [[nodiscard]] nlohmann::json runtime() const override {
    return {
        {"lifecycle", "provider-instance-owned"},
        {"handle", db_ ? (db_writable_ ? "open-readwrite" : "open-readonly") : "closed"},
        {"readonly_open_creates_backend", false},
        {"write_open_creates_backend", true},
        {"read_options", {{"fill_cache", read_options_.fill_cache}}},
        {"write_options", {{"sync", write_options_.sync}}},
    };
  }

  [[nodiscard]] std::string registry_uri() const override { return uri_for("registry"); }

  [[nodiscard]] nlohmann::json load_registry() const override {
    std::string raw;
    if (!get("registry", raw)) {
      return {{"schema", SOURCE_REGISTRY_SCHEMA}, {"sources", nlohmann::json::object()}};
    }
    auto data = nlohmann::json::parse(raw);
    if (!data.is_object() || !data.contains("sources") || !data.at("sources").is_object()) {
      throw std::runtime_error("invalid storage source registry: " + registry_uri());
    }
    data["schema"] = data.value("schema", SOURCE_REGISTRY_SCHEMA);
    return data;
  }

  void save_registry(const nlohmann::json &registry) const override { put("registry", canonical_json(registry)); }

  [[nodiscard]] nlohmann::json load_latest_manifest(const std::string &source_id) const override {
    std::string raw;
    if (!get(latest_manifest_key(source_id), raw)) {
      return nullptr;
    }
    auto data = nlohmann::json::parse(raw);
    return data.is_object() ? data : nlohmann::json(nullptr);
  }

  void write_manifest(const std::string &source_id, const std::string &manifest_id,
                      const nlohmann::json &manifest) const override {
    put(manifest_key(source_id, manifest_id), canonical_json(manifest));
  }

  void write_latest_manifest(const std::string &source_id, const nlohmann::json &manifest) const override {
    put(latest_manifest_key(source_id), canonical_json(manifest));
  }

  [[nodiscard]] std::vector<stored_manifest> manifest_records(const std::string &source_id = {}) const override {
    const auto prefix = source_id.empty() ? std::string("manifest/") : "manifest/" + source_id + "/";
    std::vector<stored_manifest> records;
    for_each(prefix, [&](const std::string &key, const std::string &raw) {
      if (key.ends_with("/latest")) {
        return;
      }
      auto data = nlohmann::json::parse(raw);
      if (!data.is_object()) {
        records.push_back({{}, key.substr(key.find_last_of('/') + 1), uri_for(key), nullptr});
        return;
      }
      records.push_back({text_or(data, "source_id"),
                         text_or(data, "manifest_id", key.substr(key.find_last_of('/') + 1)), uri_for(key), data});
    });
    std::sort(records.begin(), records.end(),
              [](const stored_manifest &lhs, const stored_manifest &rhs) { return lhs.uri < rhs.uri; });
    return records;
  }

  [[nodiscard]] std::vector<stored_manifest> latest_manifest_records(const std::string &source_id = {}) const override {
    std::vector<stored_manifest> records;
    if (!source_id.empty()) {
      auto manifest = load_latest_manifest(source_id);
      if (manifest.is_object()) {
        records.push_back({text_or(manifest, "source_id"), text_or(manifest, "manifest_id"),
                           uri_for(latest_manifest_key(source_id)), manifest});
      }
      return records;
    }
    for_each("manifest/", [&](const std::string &key, const std::string &raw) {
      if (!key.ends_with("/latest")) {
        return;
      }
      auto data = nlohmann::json::parse(raw);
      if (data.is_object()) {
        records.push_back({text_or(data, "source_id"), text_or(data, "manifest_id"), uri_for(key), data});
      }
    });
    std::sort(records.begin(), records.end(),
              [](const stored_manifest &lhs, const stored_manifest &rhs) { return lhs.source_id < rhs.source_id; });
    return records;
  }

  [[nodiscard]] bool payload_exists(const std::string &digest) const override {
    std::string raw;
    return get(payload_key(digest), raw);
  }

  [[nodiscard]] std::string read_payload(const std::string &digest) const override {
    std::string raw;
    if (!get(payload_key(digest), raw)) {
      throw std::runtime_error("failed to read payload: " + uri_for(payload_key(digest)));
    }
    return raw;
  }

  void write_payload(const std::string &digest, const std::string &raw) const override {
    put(payload_key(digest), raw);
  }

  [[nodiscard]] std::vector<stored_payload> all_payloads() const override {
    std::vector<stored_payload> result;
    for_each("payload/", [&](const std::string &key, const std::string &raw) {
      result.push_back({key.substr(std::string("payload/").size()), uri_for(key), raw.size()});
    });
    std::sort(result.begin(), result.end(),
              [](const stored_payload &lhs, const stored_payload &rhs) { return lhs.digest < rhs.digest; });
    return result;
  }

private:
  [[nodiscard]] std::string uri_for(const std::string &key) const {
    return storage_uri(PROVIDER_ROCKSDB, runtime_dir_, key);
  }
  [[nodiscard]] static std::string manifest_key(const std::string &source_id, const std::string &manifest_id) {
    return "manifest/" + source_id + "/" + manifest_id;
  }
  [[nodiscard]] static std::string latest_manifest_key(const std::string &source_id) {
    return "manifest/" + source_id + "/latest";
  }
  [[nodiscard]] static std::string payload_key(const std::string &digest) { return "payload/" + digest; }

  [[nodiscard]] rocksdb::DB *open(bool write) const {
    if (db_) {
      if (!write || db_writable_) {
        return db_.get();
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
    db_.reset(raw);
    db_writable_ = write;
    return db_.get();
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
  mutable std::unique_ptr<rocksdb::DB> db_ = {};
  mutable bool db_writable_ = false;
  rocksdb::ReadOptions read_options_ = [] {
    rocksdb::ReadOptions options;
    options.fill_cache = false;
    return options;
  }();
  rocksdb::WriteOptions write_options_ = {};
};

std::unique_ptr<storage_provider> make_provider(const storage_service_options &options) {
  const auto provider = select_provider(options.provider);
  if (provider.name == PROVIDER_ROCKSDB) {
    return std::make_unique<rocksdb_storage_provider>(options.runtime_dir);
  }
  return std::make_unique<file_storage_provider>(options.runtime_dir);
}

std::unique_ptr<storage_provider> make_provider(const std::string &runtime_dir) {
  storage_service_options options;
  options.runtime_dir = runtime_dir;
  return make_provider(options);
}

nlohmann::json workspace_episode_layout(const storage_service_options &options, const storage_provider &provider) {
  const auto runtime = absolute_normalized(options.runtime_dir);
  const auto home = runtime_home_path(options);
  const auto journal_dir = runtime / "journal";
  const auto storage_dir = runtime / "storage";
  const auto episode_manifest_dir =
      journal_dir / "system" / yy_storage::EPISODE_MANIFEST_NAMESPACE / yy_storage::EPISODE_MANIFEST_NAME / "live";
  const auto source_manifest_pattern = storage_dir / "sources" / "<source-id>" / "manifests" / "*.json";
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
      {"paths",
       {{"data_home", home.string()},
        {"runtime_dir", runtime.string()},
        {"archive_dir", (home / "archive").string()},
        {"dataset_dir", (home / "dataset").string()},
        {"inbox_dir", (home / "inbox").string()},
        {"journal_dir", journal_dir.string()},
        {"storage_dir", storage_dir.string()},
        {"source_registry", registry_path(runtime.string()).string()},
        {"source_manifests", source_manifest_pattern.string()},
        {"payloads", payload_pattern.string()},
        {"rocksdb", rocksdb_root(runtime.string()).string()},
        {"sqlite_projection", sqlite_projection_path(runtime.string()).string()},
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
        {"storage_dir", "runtime storage service area for manifests, payloads, provider databases, and projections"},
        {"source_registry", "derived source catalog that can be rebuilt from accepted manifests"},
        {"payloads", "provider-owned content-addressed payload bodies"},
        {"sqlite_projection", "derived rebuildable query projection"},
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

std::vector<fs::path> manifest_paths(const std::string &runtime_dir, const std::string &source_id) {
  std::vector<fs::path> paths;
  const auto sources_root = root_dir(runtime_dir) / "sources";
  std::vector<fs::path> roots;
  if (!source_id.empty()) {
    roots.emplace_back(sources_root / source_id / "manifests");
  } else if (fs::exists(sources_root)) {
    for (const auto &entry : fs::directory_iterator(sources_root)) {
      if (entry.is_directory()) {
        roots.emplace_back(entry.path() / "manifests");
      }
    }
  }
  std::sort(roots.begin(), roots.end());
  for (const auto &manifest_dir : roots) {
    if (!fs::exists(manifest_dir)) {
      continue;
    }
    for (const auto &entry : fs::directory_iterator(manifest_dir)) {
      if (entry.is_regular_file() && entry.path().extension() == ".json") {
        paths.emplace_back(entry.path());
      }
    }
  }
  std::sort(paths.begin(), paths.end());
  return paths;
}

std::vector<fs::path> latest_manifest_paths(const std::string &runtime_dir, const std::string &source_id) {
  std::vector<fs::path> paths;
  const auto sources_root = root_dir(runtime_dir) / "sources";
  if (!source_id.empty()) {
    const auto path = sources_root / source_id / "manifests" / "latest.json";
    if (fs::exists(path)) {
      paths.emplace_back(path);
    }
    return paths;
  }
  if (!fs::exists(sources_root)) {
    return paths;
  }
  for (const auto &entry : fs::directory_iterator(sources_root)) {
    const auto path = entry.path() / "manifests" / "latest.json";
    if (entry.is_directory() && fs::exists(path)) {
      paths.emplace_back(path);
    }
  }
  std::sort(paths.begin(), paths.end());
  return paths;
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

nlohmann::json source_projection_from_manifest(const nlohmann::json &manifest) {
  if (manifest.contains("source") && manifest.at("source").is_object()) {
    return manifest.at("source");
  }
  return yy_storage::build_storage_source_record({
      {"source_id", text_or(manifest, "source_id")},
      {"source_type", text_or(manifest, "source_type")},
      {"source_head", text_or(manifest, "source_head")},
      {"range", object_or_empty(manifest, "range")},
      {"manifest_id", text_or(manifest, "manifest_id")},
      {"sync_root", object_or_empty(manifest, "sync_root")},
      {"accepted_ranges", array_or_empty(manifest, "accepted_ranges")},
  });
}

nlohmann::json accepted_cursor(const nlohmann::json &manifest) {
  auto accepted_ranges = array_or_empty(manifest, "accepted_ranges");
  nlohmann::json last_range = nlohmann::json::object();
  if (!accepted_ranges.empty() && accepted_ranges.back().is_object()) {
    last_range = accepted_ranges.back();
  }
  return {
      {"schema", "kungfu.storage.channel-cursor/v1"},
      {"source_id", text_or(manifest, "source_id")},
      {"manifest_id", text_or(manifest, "manifest_id")},
      {"source_head", text_or(manifest, "source_head", text_or(last_range, "source_head"))},
      {"range", manifest.contains("range") && manifest.at("range").is_object() ? manifest.at("range")
                                                                               : object_or_empty(last_range, "range")},
      {"sync_root",
       manifest.contains("sync_root") ? manifest.at("sync_root") : object_or_empty(last_range, "sync_root")},
      {"entry_count", entries_for_manifest(manifest).size()},
  };
}

struct sqlite_projection_counts {
  size_t sources = 0;
  size_t manifests = 0;
  size_t entries = 0;
};

std::string limit_clause(uint64_t limit) {
  if (limit == 0) {
    return "";
  }
  return " LIMIT " + std::to_string(std::min<uint64_t>(limit, 1000));
}

class sqlite_projection {
public:
  explicit sqlite_projection(fs::path path, bool writable) : path_(std::move(path)) {
    if (writable) {
      fs::create_directories(path_.parent_path());
    }
    const auto flags = writable ? SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE : SQLITE_OPEN_READONLY;
    sqlite3 *raw = nullptr;
    const auto rc = sqlite3_open_v2(path_.string().c_str(), &raw, flags, nullptr);
    db_.reset(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_open_failed: " + last_error());
    }
    if (writable) {
      exec("PRAGMA journal_mode=WAL");
      exec("PRAGMA synchronous=NORMAL");
    }
  }

  [[nodiscard]] const fs::path &path() const { return path_; }

  void create_schema() {
    exec("CREATE TABLE IF NOT EXISTS storage_projection_meta ("
         "key TEXT PRIMARY KEY,"
         "value TEXT NOT NULL)");
    exec("CREATE TABLE IF NOT EXISTS storage_sources ("
         "source_id TEXT PRIMARY KEY,"
         "source_type TEXT,"
         "source_head TEXT,"
         "manifest_id TEXT,"
         "source_coordinate TEXT,"
         "scope TEXT,"
         "sync_root_json TEXT,"
         "source_json TEXT NOT NULL)");
    exec("CREATE TABLE IF NOT EXISTS storage_manifests ("
         "source_id TEXT NOT NULL,"
         "manifest_id TEXT NOT NULL,"
         "source_head TEXT,"
         "entry_count INTEGER NOT NULL,"
         "sync_root_json TEXT,"
         "manifest_json TEXT NOT NULL,"
         "PRIMARY KEY (source_id, manifest_id))");
    exec("CREATE TABLE IF NOT EXISTS storage_entries ("
         "source_id TEXT NOT NULL,"
         "manifest_id TEXT NOT NULL,"
         "kind TEXT,"
         "entry_source_id TEXT,"
         "source_path TEXT,"
         "source_time TEXT,"
         "payload_hash TEXT,"
         "byte_len INTEGER,"
         "content_type TEXT,"
         "payload_state TEXT,"
         "entry_json TEXT NOT NULL,"
         "PRIMARY KEY (source_id, manifest_id, kind, entry_source_id, source_path, payload_hash))");
    exec("CREATE INDEX IF NOT EXISTS idx_storage_entries_payload_hash ON storage_entries(payload_hash)");
    exec("CREATE INDEX IF NOT EXISTS idx_storage_entries_source_time ON storage_entries(source_time)");
  }

  void clear(const std::string &source_id) {
    if (source_id.empty()) {
      exec("DELETE FROM storage_entries");
      exec("DELETE FROM storage_manifests");
      exec("DELETE FROM storage_sources");
      return;
    }
    exec_bound("DELETE FROM storage_entries WHERE source_id = ?", {source_id});
    exec_bound("DELETE FROM storage_manifests WHERE source_id = ?", {source_id});
    exec_bound("DELETE FROM storage_sources WHERE source_id = ?", {source_id});
  }

  void write_meta(const std::string &key, const std::string &value) {
    exec_bound("INSERT OR REPLACE INTO storage_projection_meta(key, value) VALUES (?, ?)", {key, value});
  }

  void insert_source(const nlohmann::json &manifest, const nlohmann::json &source) {
    exec_bound(
        "INSERT OR REPLACE INTO storage_sources("
        "source_id, source_type, source_head, manifest_id, source_coordinate, scope, sync_root_json, source_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        {
            text_or(manifest, "source_id"),
            text_or(manifest, "source_type"),
            text_or(manifest, "source_head"),
            text_or(manifest, "manifest_id"),
            text_or(source, "coordinate"),
            text_or(manifest, "scope"),
            manifest.contains("sync_root") ? canonical_json(manifest.at("sync_root")) : std::string(),
            canonical_json(source),
        });
  }

  void insert_manifest(const nlohmann::json &manifest) {
    exec_bound("INSERT OR REPLACE INTO storage_manifests("
               "source_id, manifest_id, source_head, entry_count, sync_root_json, manifest_json) "
               "VALUES (?, ?, ?, ?, ?, ?)",
               {
                   text_or(manifest, "source_id"),
                   text_or(manifest, "manifest_id"),
                   text_or(manifest, "source_head"),
                   std::to_string(entries_for_manifest(manifest).size()),
                   manifest.contains("sync_root") ? canonical_json(manifest.at("sync_root")) : std::string(),
                   canonical_json(manifest),
               });
  }

  void insert_entry(const nlohmann::json &manifest, const nlohmann::json &entry) {
    exec_bound("INSERT OR REPLACE INTO storage_entries("
               "source_id, manifest_id, kind, entry_source_id, source_path, source_time, payload_hash, byte_len, "
               "content_type, payload_state, entry_json) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
               {
                   text_or(manifest, "source_id"),
                   text_or(manifest, "manifest_id"),
                   text_or(entry, "kind"),
                   text_or(entry, "source_id"),
                   text_or(entry, "source_path"),
                   text_or(entry, "source_time"),
                   text_or(entry, "payload_hash"),
                   std::to_string(uint64_or(entry, "byte_len")),
                   text_or(entry, "content_type"),
                   text_or(entry, "payload_state"),
                   canonical_json(entry),
               });
  }

  [[nodiscard]] bool table_exists(const std::string &name) const {
    sqlite3_stmt *raw = nullptr;
    const auto rc = sqlite3_prepare_v2(db_.get(), "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", -1,
                                       &raw, nullptr);
    statement stmt(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_prepare_failed: " + last_error());
    }
    bind_text(stmt.get(), 1, name);
    return sqlite3_step(stmt.get()) == SQLITE_ROW;
  }

  [[nodiscard]] size_t count_rows(const std::string &table, const std::string &source_id = {}) const {
    if (!table_exists(table)) {
      return 0;
    }
    sqlite3_stmt *raw = nullptr;
    const auto sql =
        source_id.empty() ? "SELECT COUNT(*) FROM " + table : "SELECT COUNT(*) FROM " + table + " WHERE source_id = ?";
    const auto rc = sqlite3_prepare_v2(db_.get(), sql.c_str(), -1, &raw, nullptr);
    statement stmt(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_prepare_failed: " + last_error());
    }
    if (!source_id.empty()) {
      bind_text(stmt.get(), 1, source_id);
    }
    if (sqlite3_step(stmt.get()) != SQLITE_ROW) {
      throw std::runtime_error("sqlite_projection_count_failed: " + table + ": " + last_error());
    }
    return static_cast<size_t>(sqlite3_column_int64(stmt.get(), 0));
  }

  [[nodiscard]] sqlite_projection_counts counts(const std::string &source_id = {}) const {
    return {count_rows("storage_sources", source_id), count_rows("storage_manifests", source_id),
            count_rows("storage_entries", source_id)};
  }

  [[nodiscard]] nlohmann::json query_sources(const std::string &source_id, uint64_t limit) const {
    std::vector<std::string> values;
    auto sql = std::string("SELECT source_json FROM storage_sources");
    if (!source_id.empty()) {
      sql += " WHERE source_id = ?";
      values.emplace_back(source_id);
    }
    sql += " ORDER BY source_id" + limit_clause(limit);
    return query_json_column(sql, values, 0);
  }

  [[nodiscard]] nlohmann::json query_manifests(const std::string &source_id, uint64_t limit) const {
    std::vector<std::string> values;
    auto sql = std::string("SELECT manifest_json FROM storage_manifests");
    if (!source_id.empty()) {
      sql += " WHERE source_id = ?";
      values.emplace_back(source_id);
    }
    sql += " ORDER BY source_id, manifest_id" + limit_clause(limit);
    return query_json_column(sql, values, 0);
  }

  [[nodiscard]] nlohmann::json query_entries(const storage_service_options &options) const {
    std::vector<std::string> values;
    std::vector<std::string> clauses;
    if (!options.source_id.empty()) {
      clauses.emplace_back("source_id = ?");
      values.emplace_back(options.source_id);
    }
    if (!options.kind.empty()) {
      clauses.emplace_back("kind = ?");
      values.emplace_back(options.kind);
    }
    const auto since = text_or(options.range, "since");
    if (!since.empty()) {
      clauses.emplace_back("source_time >= ?");
      values.emplace_back(since);
    }
    const auto until = text_or(options.range, "until");
    if (!until.empty()) {
      clauses.emplace_back("source_time <= ?");
      values.emplace_back(until);
    }
    auto sql = std::string("SELECT source_id, manifest_id, entry_json FROM storage_entries");
    if (!clauses.empty()) {
      sql += " WHERE ";
      for (size_t index = 0; index < clauses.size(); ++index) {
        if (index > 0) {
          sql += " AND ";
        }
        sql += clauses.at(index);
      }
    }
    sql += " ORDER BY source_time, kind, entry_source_id, source_path" + limit_clause(options.limit);
    sqlite3_stmt *raw = nullptr;
    const auto rc = sqlite3_prepare_v2(db_.get(), sql.c_str(), -1, &raw, nullptr);
    statement stmt(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_prepare_failed: " + last_error());
    }
    bind_values(stmt.get(), values);
    nlohmann::json rows = nlohmann::json::array();
    int step = SQLITE_ROW;
    while ((step = sqlite3_step(stmt.get())) == SQLITE_ROW) {
      auto row = parse_json_column(stmt.get(), 2);
      if (row.is_object()) {
        row["storage_source_id"] = column_text(stmt.get(), 0);
        row["manifest_id"] = column_text(stmt.get(), 1);
      }
      rows.push_back(row);
    }
    if (step != SQLITE_DONE) {
      throw std::runtime_error("sqlite_projection_query_failed: " + last_error());
    }
    return rows;
  }

  void exec(const std::string &sql) {
    char *error = nullptr;
    const auto rc = sqlite3_exec(db_.get(), sql.c_str(), nullptr, nullptr, &error);
    std::string message = error ? error : "";
    sqlite3_free(error);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_exec_failed: " + message);
    }
  }

private:
  struct sqlite3_deleter {
    void operator()(sqlite3 *db) const {
      if (db != nullptr) {
        sqlite3_close(db);
      }
    }
  };

  struct statement_deleter {
    void operator()(sqlite3_stmt *stmt) const {
      if (stmt != nullptr) {
        sqlite3_finalize(stmt);
      }
    }
  };

  using statement = std::unique_ptr<sqlite3_stmt, statement_deleter>;

  [[nodiscard]] std::string last_error() const { return db_ ? sqlite3_errmsg(db_.get()) : "sqlite handle unavailable"; }

  static void bind_text(sqlite3_stmt *stmt, int index, const std::string &value) {
    const auto rc = sqlite3_bind_text(stmt, index, value.c_str(), -1, SQLITE_TRANSIENT);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_bind_failed");
    }
  }

  static std::string column_text(sqlite3_stmt *stmt, int index) {
    const auto raw = sqlite3_column_text(stmt, index);
    return raw == nullptr ? std::string() : reinterpret_cast<const char *>(raw);
  }

  static nlohmann::json parse_json_column(sqlite3_stmt *stmt, int index) {
    const auto raw = column_text(stmt, index);
    if (raw.empty()) {
      return nullptr;
    }
    return nlohmann::json::parse(raw);
  }

  static void bind_values(sqlite3_stmt *stmt, const std::vector<std::string> &values) {
    for (size_t index = 0; index < values.size(); ++index) {
      bind_text(stmt, static_cast<int>(index + 1), values.at(index));
    }
  }

  [[nodiscard]] nlohmann::json query_json_column(const std::string &sql, const std::vector<std::string> &values,
                                                 int column) const {
    sqlite3_stmt *raw = nullptr;
    const auto rc = sqlite3_prepare_v2(db_.get(), sql.c_str(), -1, &raw, nullptr);
    statement stmt(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_prepare_failed: " + last_error());
    }
    bind_values(stmt.get(), values);
    nlohmann::json rows = nlohmann::json::array();
    int step = SQLITE_ROW;
    while ((step = sqlite3_step(stmt.get())) == SQLITE_ROW) {
      rows.push_back(parse_json_column(stmt.get(), column));
    }
    if (step != SQLITE_DONE) {
      throw std::runtime_error("sqlite_projection_query_failed: " + last_error());
    }
    return rows;
  }

  void exec_bound(const std::string &sql, const std::vector<std::string> &values) {
    sqlite3_stmt *raw = nullptr;
    const auto rc = sqlite3_prepare_v2(db_.get(), sql.c_str(), -1, &raw, nullptr);
    statement stmt(raw);
    if (rc != SQLITE_OK) {
      throw std::runtime_error("sqlite_projection_prepare_failed: " + last_error());
    }
    for (size_t index = 0; index < values.size(); ++index) {
      bind_text(stmt.get(), static_cast<int>(index + 1), values.at(index));
    }
    const auto step = sqlite3_step(stmt.get());
    if (step != SQLITE_DONE) {
      throw std::runtime_error("sqlite_projection_step_failed: " + last_error());
    }
  }

  fs::path path_;
  std::unique_ptr<sqlite3, sqlite3_deleter> db_ = {};
};

nlohmann::json sqlite_projection_json(const std::string &runtime_dir, const std::string &source_id = {}) {
  const auto path = sqlite_projection_path(runtime_dir);
  nlohmann::json result = {
      {"name", PROJECTION_SQLITE}, {"schema", SQLITE_PROJECTION_SCHEMA}, {"path", path.string()}, {"rebuildable", true},
      {"authority", "derived"},    {"exists", fs::exists(path)},
  };
  if (!fs::exists(path)) {
    result["counts"] = {{"sources", 0}, {"manifests", 0}, {"entries", 0}};
    return result;
  }
  try {
    const sqlite_projection projection(path, false);
    const auto counts = projection.counts(source_id);
    result["ok"] = true;
    result["counts"] = {{"sources", counts.sources}, {"manifests", counts.manifests}, {"entries", counts.entries}};
  } catch (const std::exception &e) {
    result["ok"] = false;
    result["error"] = e.what();
  }
  return result;
}

nlohmann::json query_sqlite_projection(const storage_service_options &options) {
  const auto query = options.query.empty() ? std::string("entries") : options.query;
  if (query == "episodes" || query == "episode_records" || query == "episode_frames" || query == "episode_refs") {
    nlohmann::json rows = nlohmann::json::array();
    if (query == "episodes") {
      if (options.episode_id == 0) {
        rows = episode_store(options).list(0, options.limit).value("episodes", nlohmann::json::array());
      } else {
        const auto inspected = episode_store(options).inspect(options.episode_id);
        if (inspected.value("ok", false)) {
          rows.push_back(inspected.at("episode"));
        }
      }
    } else {
      if (options.episode_id == 0) {
        throw std::invalid_argument("episode_id is required for " + query);
      }
      const auto inspected = episode_store(options).inspect(options.episode_id);
      if (!inspected.value("ok", false)) {
        return {{"ok", false},
                {"scope", "episode"},
                {"episode_id", options.episode_id},
                {"projection",
                 {{"name", "episode-manifest"},
                  {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                  {"authority", "yijinjing-journal"},
                  {"rebuildable", false}}},
                {"query", query},
                {"limit", options.limit},
                {"rows", nlohmann::json::array()},
                {"row_count", 0},
                {"errors", inspected.value("errors", nlohmann::json::array())}};
      }
      const auto field = query == "episode_records"
                             ? std::string("records")
                             : (query == "episode_frames" ? std::string("frames") : std::string("refs"));
      rows = inspected.value(field, nlohmann::json::array());
      if (options.limit != 0 && rows.is_array() && rows.size() > options.limit) {
        nlohmann::json limited = nlohmann::json::array();
        for (size_t index = 0; index < std::min<size_t>(rows.size(), options.limit); ++index) {
          limited.push_back(rows.at(index));
        }
        rows = limited;
      }
    }
    return {{"ok", true},
            {"scope", "episode"},
            {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
            {"projection",
             {{"name", "episode-manifest"},
              {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
              {"authority", "yijinjing-journal"},
              {"rebuildable", false}}},
            {"query", query},
            {"limit", options.limit},
            {"rows", rows},
            {"row_count", rows.size()}};
  }
  const auto path = sqlite_projection_path(options.runtime_dir);
  nlohmann::json result = {
      {"ok", true},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"projection",
       {{"name", PROJECTION_SQLITE},
        {"schema", SQLITE_PROJECTION_SCHEMA},
        {"path", path.string()},
        {"authority", "derived"},
        {"rebuildable", true}}},
      {"query", query},
      {"kind", options.kind.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.kind)},
      {"range", options.range},
      {"limit", options.limit},
      {"rows", nlohmann::json::array()},
  };
  if (!fs::exists(path)) {
    result["ok"] = false;
    result["errors"] = nlohmann::json::array(
        {{{"code", "sqlite_projection_missing"}, {"path", path.string()}, {"hint", "run storage rebuild-index"}}});
    return result;
  }
  const sqlite_projection projection(path, false);
  if (query == "sources") {
    result["rows"] = projection.query_sources(options.source_id, options.limit);
  } else if (query == "manifests") {
    result["rows"] = projection.query_manifests(options.source_id, options.limit);
  } else if (query == "entries") {
    result["rows"] = projection.query_entries(options);
  } else {
    throw std::invalid_argument("unsupported storage query: " + query);
  }
  result["row_count"] = result.at("rows").size();
  return result;
}

nlohmann::json episode_fsck_impl(const storage_service_options &options) {
  const auto episode_report = episode_store(options).fsck(options.episode_id);
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
                                              {"rebuildable", false}}})}};
  return report;
}

nlohmann::json episode_export_bundle_impl(const storage_service_options &options) {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required for episode export");
  }
  const auto inspected = episode_store(options).inspect(options.episode_id);
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
nlohmann::json load_latest_manifest_impl(const storage_provider &provider, const std::string &source_id);

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
  if (code == "episode_dependency_missing") {
    return repair_candidate_common(warning, "repair_episode_dependency", "episode", text_or(warning, "role", "ref"),
                                   "fetch_episode", nlohmann::json::array({"source_or_episode_bundle"}));
  }
  if (code == "episode_root_trigger_frame_missing") {
    return repair_candidate_common(warning, "repair_episode_root_trigger_frame", "frame", "root_trigger",
                                   "fetch_frame_or_declare_external_input",
                                   nlohmann::json::array({"source_or_episode_bundle"}));
  }
  if (code == "episode_trigger_frame_missing") {
    return repair_candidate_common(warning, "repair_episode_trigger_frame", "frame", "trigger",
                                   "fetch_frame_or_declare_external_input",
                                   nlohmann::json::array({"source_or_episode_bundle"}));
  }
  if (code == "episode_payload_ref_missing") {
    return repair_candidate_common(warning, "repair_episode_payload_ref", "payload", "payload_ref",
                                   "fetch_payload_by_hash", nlohmann::json::array({"payload_store_or_episode_bundle"}));
  }
  if (code == "payload_not_present") {
    if (bool_or(warning, "intentional", true)) {
      return nullptr;
    }
    return repair_candidate_common(warning, "repair_source_payload", "payload", "source_record",
                                   "fetch_payload_by_hash", nlohmann::json::array({"source_or_bundle"}));
  }
  return nullptr;
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
         kind == "episode_ref_attached" || kind == "episode_closed";
}

std::string episode_record_identity_key(const nlohmann::json &record) {
  const auto kind = text_or(record, "record_kind");
  const auto episode_id = std::to_string(uint64_or(record, "episode_id"));
  if (kind == "episode_open" || kind == "episode_closed") {
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
    const auto inspected = episode_store(options).inspect(bundle_episode_id);
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
  const auto provider = make_provider(options);
  auto manifest = load_latest_manifest_impl(*provider, source_id);
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
    auto repaired_input = manifest;
    repaired_input["entries"] = entries;
    repaired_input.erase("sync_root");
    repaired_input.erase("accepted_ranges");
    repaired_input.erase("payload_inventory");
    repaired_input["manifest_id"] = text_or(manifest, "manifest_id") + ".repair";
    accepted = yy_storage::build_storage_import_manifest(repaired_input);
    provider->write_manifest(source_id, text_or(accepted, "manifest_id"), accepted);
    provider->write_latest_manifest(source_id, accepted);
    auto registry = provider->load_registry();
    registry["sources"][source_id] = accepted.at("source");
    provider->save_registry(registry);
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

nlohmann::json repair_fetch_impl(const storage_service_options &options, const storage_service &service) {
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
          const auto bundle = service.export_bundle(candidate_options);
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
            const auto bundle = service.export_bundle(candidate_options);
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

nlohmann::json rebuild_sqlite_projection(const storage_provider &provider, const storage_service_options &options,
                                         bool write) {
  size_t sources = 0;
  size_t manifests = 0;
  size_t entries = 0;
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json changes = nlohmann::json::array();
  const auto path = sqlite_projection_path(options.runtime_dir);
  std::unique_ptr<sqlite_projection> projection;
  if (write) {
    projection = std::make_unique<sqlite_projection>(path, true);
    projection->create_schema();
    projection->exec("BEGIN IMMEDIATE");
    projection->clear(options.source_id);
    projection->write_meta("schema", SQLITE_PROJECTION_SCHEMA);
    projection->write_meta("authority", "derived");
  }
  try {
    for (const auto &record : provider.latest_manifest_records(options.source_id)) {
      if (!record.value.is_object()) {
        errors.push_back({{"code", "manifest_invalid"}, {"path", record.uri}});
        continue;
      }
      const auto current_source_id = text_or(record.value, "source_id");
      if (current_source_id.empty()) {
        errors.push_back({{"code", "source_id_missing"}, {"path", record.uri}});
        continue;
      }
      const auto source = source_projection_from_manifest(record.value);
      const auto source_entries = entries_for_manifest(record.value);
      if (write) {
        projection->insert_source(record.value, source);
        projection->insert_manifest(record.value);
        for (const auto &entry : source_entries) {
          projection->insert_entry(record.value, entry);
        }
      }
      changes.push_back({{"source_id", current_source_id},
                         {"manifest_id", text_or(record.value, "manifest_id")},
                         {"entries", source_entries.size()}});
      ++sources;
      ++manifests;
      entries += source_entries.size();
    }
    if (write) {
      projection->exec("COMMIT");
    }
  } catch (...) {
    if (write && projection) {
      try {
        projection->exec("ROLLBACK");
      } catch (const std::exception &) {
      }
    }
    throw;
  }
  return {
      {"name", PROJECTION_SQLITE},
      {"schema", SQLITE_PROJECTION_SCHEMA},
      {"path", path.string()},
      {"rebuilt_from", "accepted latest manifests"},
      {"dry_run", !write},
      {"written", write},
      {"rows", {{"sources", sources}, {"manifests", manifests}, {"entries", entries}}},
      {"changes", changes},
      {"errors", errors},
  };
}

nlohmann::json load_latest_manifest_impl(const storage_provider &provider, const std::string &source_id) {
  return provider.load_latest_manifest(source_id);
}

nlohmann::json source_manifest_status(const storage_provider &provider, const nlohmann::json &source) {
  const auto source_id = text_or(source, "source_id");
  auto manifest = load_latest_manifest_impl(provider, source_id);
  if (manifest.is_null()) {
    return {
        {"source_id", source_id},       {"ok", false},      {"projection", PROJECTION_SOURCE_REGISTRY},
        {"reason", "manifest_missing"}, {"source", source},
    };
  }
  const auto entries = entries_for_manifest(manifest);
  const auto payload_inventory = object_or_empty(manifest, "payload_inventory");
  const auto schema_inventory = object_or_empty(manifest, "schema_inventory");
  return {
      {"source_id", source_id},
      {"ok", true},
      {"projection", PROJECTION_SOURCE_REGISTRY},
      {"manifest_id", text_or(manifest, "manifest_id")},
      {"source_type", text_or(manifest, "source_type")},
      {"source_head", text_or(manifest, "source_head")},
      {"accepted_ranges", array_or_empty(manifest, "accepted_ranges")},
      {"accepted_cursor", accepted_cursor(manifest)},
      {"sync_root", manifest.contains("sync_root") ? manifest.at("sync_root") : nlohmann::json(nullptr)},
      {"entries", entries.size()},
      {"payload_inventory", array_or_empty(payload_inventory, "entries").size()},
      {"schema_inventory", array_or_empty(schema_inventory, "entries").size()},
      {"source_record", source},
  };
}

std::vector<std::string> referenced_payload_hashes(const storage_provider &provider,
                                                   const std::string &source_id = {}) {
  std::vector<std::string> hashes;
  std::vector<std::pair<std::string, std::string>> seen_manifests;
  for (const auto &record : provider.manifest_records(source_id)) {
    if (!record.value.is_object()) {
      continue;
    }
    const auto key =
        std::make_pair(text_or(record.value, "source_id"), text_or(record.value, "manifest_id", record.manifest_id));
    if (std::find(seen_manifests.begin(), seen_manifests.end(), key) != seen_manifests.end()) {
      continue;
    }
    seen_manifests.emplace_back(key);
    for (const auto &entry : entries_for_manifest(record.value)) {
      const auto digest = text_or(entry, "payload_hash");
      if (!digest.empty() && std::find(hashes.begin(), hashes.end(), digest) == hashes.end()) {
        hashes.emplace_back(digest);
      }
    }
  }
  return hashes;
}

std::pair<nlohmann::json, std::string> load_payload_impl(const storage_provider &provider,
                                                         const nlohmann::json &entry) {
  const auto digest = text_or(entry, "payload_hash");
  if (!provider.payload_exists(digest)) {
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

nlohmann::json list_sources_impl(const storage_provider &provider) {
  auto registry = provider.load_registry();
  nlohmann::json sources = nlohmann::json::array();
  for (const auto &[_, source] : registry.at("sources").items()) {
    if (source.is_object()) {
      sources.push_back(source);
    }
  }
  std::sort(sources.begin(), sources.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return text_or(lhs, "source_id") < text_or(rhs, "source_id");
  });
  return sources;
}

nlohmann::json status_impl(const storage_service_options &options) {
  const auto provider = make_provider(options);
  auto sources = nlohmann::json::array();
  for (const auto &source : list_sources_impl(*provider)) {
    if (options.source_id.empty() || text_or(source, "source_id") == options.source_id) {
      sources.push_back(source);
    }
  }
  nlohmann::json source_status = nlohmann::json::array();
  for (const auto &source : sources) {
    source_status.push_back(source_manifest_status(*provider, source));
  }
  return {
      {"ok", options.source_id.empty() ? true : !sources.empty()},
      {"backend", provider->name()},
      {"provider", provider->name()},
      {"provider_config_source", options.provider_config_source},
      {"provider_runtime", provider->runtime()},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"sources", sources},
      {"source_count", sources.size()},
      {"projection",
       {
           {"name", PROJECTION_SOURCE_REGISTRY},
           {"path", provider->registry_uri()},
           {"rebuildable", true},
       }},
      {"projections", nlohmann::json::array({{{"name", PROJECTION_SOURCE_REGISTRY},
                                              {"path", provider->registry_uri()},
                                              {"rebuildable", true},
                                              {"authority", "derived"}},
                                             sqlite_projection_json(options.runtime_dir, options.source_id)})},
      {"source_status", source_status},
  };
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
  const auto provider = make_provider(options);
  nlohmann::json registry;
  try {
    registry = provider->load_registry();
  } catch (const std::exception &e) {
    return fsck_error_report(options, "source_registry_invalid", e.what());
  }

  nlohmann::json sources = nlohmann::json::array();
  for (const auto &[_, source] : registry.at("sources").items()) {
    if (source.is_object() && (options.source_id.empty() || text_or(source, "source_id") == options.source_id)) {
      sources.push_back(source);
    }
  }
  std::sort(sources.begin(), sources.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return text_or(lhs, "source_id") < text_or(rhs, "source_id");
  });

  nlohmann::json report = {
      {"ok", true},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"errors", nlohmann::json::array()},
      {"warnings", nlohmann::json::array()},
      {"checked",
       {
           {"sources", sources.size()},
           {"manifests", 0},
           {"payloads", 0},
           {"schemas", 0},
           {"accepted_ranges", 0},
           {"source_records", 0},
           {"projection_indexes", fs::exists(sqlite_projection_path(options.runtime_dir)) ? 2 : 1},
           {"sqlite_projection_rows", 0},
           {"orphan_payloads", 0},
           {"episode_manifest_records", 0},
           {"episodes", 0},
       }},
  };
  // Degraded means facts are incomplete but not corrupt: a payload is recorded
  // missing (data loss), as opposed to intentionally redacted/absent. Corruption
  // and drift set ok=false (failed); degradation keeps ok=true but is surfaced
  // through the tri-state `status` field so a missing payload no longer hides
  // under ok=true.
  bool degraded = false;
  if (!options.source_id.empty() && sources.empty()) {
    report["ok"] = false;
    report["errors"].push_back({{"code", "source_missing"}, {"source_id", options.source_id}});
    return report;
  }

  for (const auto &source : sources) {
    const auto current_source_id = text_or(source, "source_id");
    auto manifest = load_latest_manifest_impl(*provider, current_source_id);
    if (manifest.is_null()) {
      report["ok"] = false;
      report["errors"].push_back({{"code", "manifest_missing"}, {"source_id", current_source_id}});
      continue;
    }
    report["checked"]["manifests"] = report["checked"]["manifests"].get<size_t>() + 1;
    report["checked"]["source_records"] = report["checked"]["source_records"].get<size_t>() + 1;
    const auto projected_source = source_projection_from_manifest(manifest);
    if (projected_source != source) {
      report["ok"] = false;
      report["errors"].push_back({{"code", "source_registry_drift"},
                                  {"source_id", current_source_id},
                                  {"expected", projected_source},
                                  {"actual", source}});
    }
    for (const auto &issue : yy_storage::verify_storage_import_manifest(manifest)) {
      auto row = issue_to_json(issue);
      row["source_id"] = current_source_id;
      if (issue.severity == "warning") {
        report["warnings"].push_back(row);
      } else {
        report["ok"] = false;
        report["errors"].push_back(row);
      }
    }
    report["checked"]["accepted_ranges"] =
        report["checked"]["accepted_ranges"].get<size_t>() + array_or_empty(manifest, "accepted_ranges").size();
    report["checked"]["schemas"] = report["checked"]["schemas"].get<size_t>() +
                                   array_or_empty(object_or_empty(manifest, "schema_inventory"), "entries").size();
    const auto payload_inventory = object_or_empty(manifest, "payload_inventory");
    if (!payload_inventory.empty()) {
      const auto inventory_count = array_or_empty(payload_inventory, "entries").size();
      const auto entry_count = entries_for_manifest(manifest).size();
      if (inventory_count != entry_count) {
        report["ok"] = false;
        report["errors"].push_back({{"code", "payload_inventory_mismatch"},
                                    {"source_id", current_source_id},
                                    {"expected", entry_count},
                                    {"actual", inventory_count}});
      }
    }
    for (const auto &entry : entries_for_manifest(manifest)) {
      report["checked"]["payloads"] = report["checked"]["payloads"].get<size_t>() + 1;
      const auto payload_state = text_or(entry, "payload_state");
      if (payload_state != PAYLOAD_STATE_PRESENT) {
        // Redacted/absent are intentional (a sensitive body deliberately withheld
        // or known not to exist) and stay ok; any other non-present state, such as
        // a recorded-missing body, is a real gap and degrades the verdict.
        const bool intentional = payload_state == PAYLOAD_STATE_REDACTED || payload_state == PAYLOAD_STATE_ABSENT;
        if (!intentional) {
          degraded = true;
        }
        report["warnings"].push_back({{"code", "payload_not_present"},
                                      {"source_id", current_source_id},
                                      {"subject", text_or(entry, "kind") + ":" + text_or(entry, "source_id")},
                                      {"payload_hash", text_or(entry, "payload_hash")},
                                      {"state", payload_state},
                                      {"intentional", intentional}});
        continue;
      }
      const auto [_, error] = load_payload_impl(*provider, entry);
      if (!error.empty()) {
        report["ok"] = false;
        report["errors"].push_back({{"code", error},
                                    {"source_id", current_source_id},
                                    {"kind", text_or(entry, "kind")},
                                    {"entry_source_id", text_or(entry, "source_id")},
                                    {"payload_hash", text_or(entry, "payload_hash")}});
      }
    }
  }

  if (options.source_id.empty()) {
    const auto referenced = referenced_payload_hashes(*provider);
    for (const auto &payload : provider->all_payloads()) {
      const auto digest = payload.digest;
      if (std::find(referenced.begin(), referenced.end(), digest) == referenced.end()) {
        report["checked"]["orphan_payloads"] = report["checked"]["orphan_payloads"].get<size_t>() + 1;
        report["warnings"].push_back({{"code", "orphan_payload"}, {"path", payload.uri}, {"payload_hash", digest}});
      }
    }
  }

  const auto episode_report = episode_store(options).fsck();
  const auto episode_checked = object_or_empty(episode_report, "checked");
  report["checked"]["episode_manifest_records"] = episode_checked.value("episode_manifest_records", 0);
  report["checked"]["episodes"] = episode_checked.value("episodes", 0);
  report["episode_manifest"] = episode_report;
  report["degraded"] = report.value("degraded", false) || episode_report.value("degraded", false);
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

  const auto sqlite_projection_status = sqlite_projection_json(options.runtime_dir, options.source_id);
  report["projections"] = nlohmann::json::array({{{"name", PROJECTION_SOURCE_REGISTRY},
                                                  {"path", provider->registry_uri()},
                                                  {"rebuildable", true},
                                                  {"authority", "derived"}},
                                                 sqlite_projection_status});
  if (!sqlite_projection_status.value("exists", false)) {
    report["warnings"].push_back({{"code", "sqlite_projection_missing"},
                                  {"path", sqlite_projection_path(options.runtime_dir).string()},
                                  {"reason", "projection is derived and can be rebuilt"}});
  } else if (!sqlite_projection_status.value("ok", true)) {
    report["ok"] = false;
    report["errors"].push_back({{"code", "sqlite_projection_unreadable"},
                                {"path", sqlite_projection_path(options.runtime_dir).string()},
                                {"error", sqlite_projection_status.value("error", "")}});
  } else {
    const auto expected_sources = sources.size();
    size_t expected_manifests = 0;
    size_t expected_entries = 0;
    for (const auto &source : sources) {
      const auto current_source_id = text_or(source, "source_id");
      auto manifest = load_latest_manifest_impl(*provider, current_source_id);
      if (manifest.is_object()) {
        ++expected_manifests;
        expected_entries += entries_for_manifest(manifest).size();
      }
    }
    const auto counts = object_or_empty(sqlite_projection_status, "counts");
    report["checked"]["sqlite_projection_rows"] =
        counts.value("sources", 0) + counts.value("manifests", 0) + counts.value("entries", 0);
    if (counts.value("sources", 0) != expected_sources || counts.value("manifests", 0) != expected_manifests ||
        counts.value("entries", 0) != expected_entries) {
      report["ok"] = false;
      report["errors"].push_back(
          {{"code", "sqlite_projection_drift"},
           {"path", sqlite_projection_path(options.runtime_dir).string()},
           {"expected",
            {{"sources", expected_sources}, {"manifests", expected_manifests}, {"entries", expected_entries}}},
           {"actual", counts}});
    }
  }
  // Tri-state verdict over the boolean ok: failed (corruption/drift/unreadable)
  // dominates, then degraded (incomplete but not corrupt), else ok.
  report["degraded"] = degraded;
  report["status"] = !report["ok"].get<bool>() ? "failed" : (degraded ? "degraded" : "ok");
  return report;
}

nlohmann::json rebuild_index_impl(const storage_service_options &options) {
  const auto provider = make_provider(options);
  nlohmann::json old_registry;
  try {
    old_registry = provider->load_registry();
  } catch (const std::exception &) {
    old_registry = {{"schema", SOURCE_REGISTRY_SCHEMA}, {"sources", nlohmann::json::object()}};
  }
  auto old_sources = object_or_empty(old_registry, "sources");
  auto new_sources = options.source_id.empty() ? nlohmann::json::object() : old_sources;
  nlohmann::json changes = nlohmann::json::array();
  nlohmann::json errors = nlohmann::json::array();
  size_t rebuilt = 0;

  for (const auto &record : provider->latest_manifest_records(options.source_id)) {
    if (!record.value.is_object()) {
      errors.push_back({{"code", "manifest_invalid"}, {"path", record.uri}});
      continue;
    }
    const auto current_source_id = text_or(record.value, "source_id");
    if (current_source_id.empty()) {
      errors.push_back({{"code", "source_id_missing"}, {"path", record.uri}});
      continue;
    }
    const auto projected = source_projection_from_manifest(record.value);
    const auto previous =
        old_sources.contains(current_source_id) ? old_sources.at(current_source_id) : nlohmann::json(nullptr);
    if (previous != projected) {
      changes.push_back({{"source_id", current_source_id},
                         {"action", previous.is_null() ? "add" : "update"},
                         {"manifest_id", text_or(record.value, "manifest_id")}});
    }
    new_sources[current_source_id] = projected;
    ++rebuilt;
  }
  if (!options.source_id.empty() && rebuilt == 0) {
    errors.push_back({{"code", "source_manifest_missing"}, {"source_id", options.source_id}});
  }
  const nlohmann::json new_registry = {{"schema", SOURCE_REGISTRY_SCHEMA}, {"sources", new_sources}};
  const auto would_write = old_registry != new_registry;
  const auto sqlite_projection = rebuild_sqlite_projection(*provider, options, !options.dry_run);
  if (!sqlite_projection.value("errors", nlohmann::json::array()).empty()) {
    for (const auto &error : sqlite_projection.at("errors")) {
      errors.push_back(error);
    }
  }
  if (would_write && !options.dry_run) {
    provider->save_registry(new_registry);
  }
  return {
      {"ok", errors.empty()},
      {"scope", options.source_id.empty() ? "all" : "source"},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"projection",
       {
           {"name", PROJECTION_SOURCE_REGISTRY},
           {"path", provider->registry_uri()},
           {"rebuilt_from", "accepted latest manifests"},
       }},
      {"projections", nlohmann::json::array({{{"name", PROJECTION_SOURCE_REGISTRY},
                                              {"path", provider->registry_uri()},
                                              {"rebuilt_from", "accepted latest manifests"},
                                              {"dry_run", options.dry_run},
                                              {"written", would_write && !options.dry_run}},
                                             sqlite_projection})},
      {"dry_run", options.dry_run},
      {"would_write", would_write},
      {"written", would_write && !options.dry_run},
      {"sources_rebuilt", rebuilt},
      {"changes", changes},
      {"errors", errors},
  };
}

nlohmann::json gc_plan_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_gc_requires_dry_run");
  }
  const auto provider = make_provider(options);
  const auto referenced = referenced_payload_hashes(*provider, options.source_id);
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
  const auto provider = make_provider(options);
  nlohmann::json manifests = nlohmann::json::array();
  for (const auto &record : provider->manifest_records(options.source_id)) {
    if (!record.value.is_object()) {
      continue;
    }
    manifests.push_back(
        {{"source_id", text_or(record.value, "source_id")},
         {"manifest_id", text_or(record.value, "manifest_id")},
         {"path", record.uri},
         {"entries", entries_for_manifest(record.value).size()},
         {"sync_root", record.value.contains("sync_root") ? record.value.at("sync_root") : nlohmann::json(nullptr)}});
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
           {"name", PROJECTION_SQLITE},
           {"path", sqlite_projection_path(options.runtime_dir).string()},
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

class file_storage_service : public storage_service {
public:
  [[nodiscard]] nlohmann::json status(const storage_service_options &options) const override {
    return status_impl(options);
  }

  [[nodiscard]] nlohmann::json fsck(const storage_service_options &options) const override {
    return fsck_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_plan(const storage_service_options &options) const override {
    return repair_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_fetch(const storage_service_options &options) const override {
    return repair_fetch_impl(options, *this);
  }

  [[nodiscard]] nlohmann::json repair_apply(const storage_service_options &options) const override {
    return repair_apply_impl(options);
  }

  [[nodiscard]] nlohmann::json export_bundle(const storage_service_options &options) const override {
    if (options.scope == "episode") {
      return episode_export_bundle_impl(options);
    }
    const auto provider = make_provider(options);
    const auto manifest = load_latest_manifest_impl(*provider, options.source_id);
    if (manifest.is_null()) {
      throw std::runtime_error("manifest not found: " + options.source_id);
    }
    auto export_manifest = manifest;
    if (!options.range.empty()) {
      export_manifest = yy_storage::build_storage_import_manifest(
          {{"manifest_id", text_or(manifest, "manifest_id")},
           {"storage_source_id", text_or(manifest, "source_id")},
           {"source_type", text_or(manifest, "source_type")},
           {"source_coordinate", text_or(object_or_empty(manifest, "source"), "coordinate")},
           {"source_head", text_or(manifest, "source_head")},
           {"scope", text_or(manifest, "scope")},
           {"range", options.range},
           {"counts", {{"records", entries_for_manifest(manifest, options.range).size()}}},
           {"entries", entries_for_manifest(manifest, options.range)}});
    }
    nlohmann::json records = nlohmann::json::array();
    for (const auto &entry : entries_for_manifest(manifest, options.range)) {
      auto [payload, error] = load_payload_impl(*provider, entry);
      if (!error.empty()) {
        throw std::runtime_error(error + ": " + text_or(entry, "kind") + ":" + text_or(entry, "source_id"));
      }
      auto row = entry;
      row["scope"] = text_or(manifest, "scope");
      row["manifest_id"] = text_or(manifest, "manifest_id");
      row["storage_source_id"] = options.source_id;
      row["source_type"] = text_or(manifest, "source_type");
      row["source_head"] = text_or(manifest, "source_head");
      row["payload"] = payload;
      records.push_back(row);
    }
    std::sort(records.begin(), records.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
      return std::make_tuple(text_or(lhs, "kind"), text_or(lhs, "source_id"), text_or(lhs, "source_path")) <
             std::make_tuple(text_or(rhs, "kind"), text_or(rhs, "source_id"), text_or(rhs, "source_path"));
    });
    return yy_storage::build_storage_export_bundle(export_manifest, records);
  }

  [[nodiscard]] nlohmann::json import_bundle(const storage_service_options &options) const override {
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
    const auto provider = make_provider(options);
    for (const auto &record : records) {
      if (!record.is_object() || !record.contains("payload")) {
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
    const auto generic = yy_storage::build_storage_import_manifest(manifest);
    provider->write_manifest(text_or(generic, "source_id"), text_or(generic, "manifest_id"), generic);
    provider->write_latest_manifest(text_or(generic, "source_id"), generic);
    auto registry = provider->load_registry();
    registry["sources"][text_or(generic, "source_id")] = generic.at("source");
    provider->save_registry(registry);
    const auto accepted = generic;
    return {{"ok", true},
            {"scope", "source"},
            {"source_id", text_or(accepted, "source_id")},
            {"manifest_id", text_or(accepted, "manifest_id")},
            {"records", records.size()}};
  }

  [[nodiscard]] nlohmann::json rebuild_index(const storage_service_options &options) const override {
    return rebuild_index_impl(options);
  }

  [[nodiscard]] nlohmann::json gc_plan(const storage_service_options &options) const override {
    return gc_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json compact_plan(const storage_service_options &options) const override {
    return compact_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json verify_sync(const storage_service_options &options) const override {
    const auto source_report = fsck_impl(options);
    if (!source_report.value("ok", false)) {
      return {{"ok", false},
              {"scope", "source"},
              {"source_id", options.source_id},
              {"errors", nlohmann::json::array({{{"code", "source_fsck_failed"}, {"fsck", source_report}}})}};
    }
    const auto bundle = export_bundle(options);
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
      const auto import_provider = make_provider(import_options);
      imported_manifest = load_latest_manifest_impl(*import_provider, options.source_id);
      fs::remove_all(temp_root);
    } catch (...) {
      fs::remove_all(temp_root);
      throw;
    }
    const auto provider = make_provider(options);
    const auto local_manifest = load_latest_manifest_impl(*provider, options.source_id);
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

  [[nodiscard]] nlohmann::json query(const storage_service_options &options) const override {
    return query_sqlite_projection(options);
  }

  [[nodiscard]] nlohmann::json layout(const storage_service_options &options) const override {
    const auto provider = make_provider(options);
    return workspace_episode_layout(options, *provider);
  }

  [[nodiscard]] nlohmann::json episode_begin(const storage_service_options &options) const override {
    return episode_store(options).begin(parse_episode_begin_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_heartbeat(const storage_service_options &options) const override {
    return episode_store(options).heartbeat(parse_episode_heartbeat_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_end(const storage_service_options &options) const override {
    return episode_store(options).end(
        parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Ended));
  }

  [[nodiscard]] nlohmann::json episode_abort(const storage_service_options &options) const override {
    return episode_store(options).abort(
        parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Aborted));
  }

  [[nodiscard]] nlohmann::json episode_attach_frame(const storage_service_options &options) const override {
    return episode_store(options).attach_frame(parse_episode_frame_attach_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_attach_ref(const storage_service_options &options) const override {
    return episode_store(options).attach_ref(parse_episode_ref_attach_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json episode_list(const storage_service_options &options) const override {
    return episode_store(options).list(uint64_or(options.operation_options, "location_uid"), options.limit);
  }

  [[nodiscard]] nlohmann::json episode_inspect(const storage_service_options &options) const override {
    return episode_store(options).inspect(uint64_or(options.operation_options, "episode_id"));
  }

  [[nodiscard]] nlohmann::json episode_recover(const storage_service_options &options) const override {
    return episode_store(options).recover(parse_episode_recover_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_register(const storage_service_options &options) const override {
    return source_registry_store(options).register_source(parse_source_register_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_update_head(const storage_service_options &options) const override {
    return source_registry_store(options).update_head(parse_source_head_update_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_record_accepted_range(const storage_service_options &options) const override {
    return source_registry_store(options).record_accepted_range(
        parse_accepted_range_options(options.operation_options));
  }

  [[nodiscard]] nlohmann::json source_list(const storage_service_options &options) const override {
    return source_registry_store(options).list();
  }

  [[nodiscard]] nlohmann::json source_inspect(const storage_service_options &options) const override {
    return source_registry_store(options).inspect(text_or(options.operation_options, "source_id", options.source_id));
  }

  [[nodiscard]] nlohmann::json source_registry_fsck(const storage_service_options &options) const override {
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

  [[nodiscard]] nlohmann::json source_registry_rebuild(const storage_service_options &options) const override {
    return source_registry_projection(options.runtime_dir).rebuild();
  }
};

const file_storage_service &storage_service_instance() {
  static const file_storage_service service;
  return service;
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
    return storage_service_instance().status(parsed_options);
  case storage_operation::Fsck:
    return storage_service_instance().fsck(parsed_options);
  case storage_operation::RepairPlan:
    return storage_service_instance().repair_plan(parsed_options);
  case storage_operation::RepairFetch:
    return storage_service_instance().repair_fetch(parsed_options);
  case storage_operation::RepairApply:
    return storage_service_instance().repair_apply(parsed_options);
  case storage_operation::ExportBundle:
    return storage_service_instance().export_bundle(parsed_options);
  case storage_operation::ImportBundle:
    return storage_service_instance().import_bundle(parsed_options);
  case storage_operation::RebuildIndex:
    return storage_service_instance().rebuild_index(parsed_options);
  case storage_operation::GcPlan:
    return storage_service_instance().gc_plan(parsed_options);
  case storage_operation::CompactPlan:
    return storage_service_instance().compact_plan(parsed_options);
  case storage_operation::VerifySync:
    return storage_service_instance().verify_sync(parsed_options);
  case storage_operation::Query:
    return storage_service_instance().query(parsed_options);
  case storage_operation::Layout:
    return storage_service_instance().layout(parsed_options);
  case storage_operation::EpisodeBegin:
    return storage_service_instance().episode_begin(parsed_options);
  case storage_operation::EpisodeHeartbeat:
    return storage_service_instance().episode_heartbeat(parsed_options);
  case storage_operation::EpisodeEnd:
    return storage_service_instance().episode_end(parsed_options);
  case storage_operation::EpisodeAbort:
    return storage_service_instance().episode_abort(parsed_options);
  case storage_operation::EpisodeAttachFrame:
    return storage_service_instance().episode_attach_frame(parsed_options);
  case storage_operation::EpisodeAttachRef:
    return storage_service_instance().episode_attach_ref(parsed_options);
  case storage_operation::EpisodeList:
    return storage_service_instance().episode_list(parsed_options);
  case storage_operation::EpisodeInspect:
    return storage_service_instance().episode_inspect(parsed_options);
  case storage_operation::EpisodeRecover:
    return storage_service_instance().episode_recover(parsed_options);
  case storage_operation::SourceRegister:
    return storage_service_instance().source_register(parsed_options);
  case storage_operation::SourceUpdateHead:
    return storage_service_instance().source_update_head(parsed_options);
  case storage_operation::SourceRecordAcceptedRange:
    return storage_service_instance().source_record_accepted_range(parsed_options);
  case storage_operation::SourceList:
    return storage_service_instance().source_list(parsed_options);
  case storage_operation::SourceInspect:
    return storage_service_instance().source_inspect(parsed_options);
  case storage_operation::SourceRegistryFsck:
    return storage_service_instance().source_registry_fsck(parsed_options);
  case storage_operation::SourceRegistryRebuild:
    return storage_service_instance().source_registry_rebuild(parsed_options);
  }
  throw std::invalid_argument("unknown storage operation");
}

nlohmann::json accept_storage_manifest(const std::string &runtime_dir, const nlohmann::json &manifest) {
  const auto provider = make_provider(runtime_dir);
  const auto generic = yy_storage::build_storage_import_manifest(manifest);
  for (const auto &issue : yy_storage::verify_storage_import_manifest(generic)) {
    if (issue.severity != "warning") {
      throw std::invalid_argument("storage_manifest_invalid: " + issue.code);
    }
  }
  const auto source_id = text_or(generic, "source_id");
  const auto manifest_id = text_or(generic, "manifest_id");
  provider->write_manifest(source_id, manifest_id, generic);
  provider->write_latest_manifest(source_id, generic);

  auto registry = provider->load_registry();
  registry["sources"][source_id] = generic.at("source");
  provider->save_registry(registry);
  return generic;
}

nlohmann::json load_storage_latest_manifest(const std::string &runtime_dir, const std::string &source_id) {
  const auto provider = make_provider(runtime_dir);
  return load_latest_manifest_impl(*provider, source_id);
}

nlohmann::json export_storage_records(const std::string &runtime_dir, const std::string &source_id,
                                      const nlohmann::json &range) {
  const auto provider = make_provider(runtime_dir);
  const auto manifest = load_latest_manifest_impl(*provider, source_id);
  if (manifest.is_null()) {
    throw std::runtime_error("manifest not found: " + source_id);
  }
  nlohmann::json records = nlohmann::json::array();
  for (const auto &entry : entries_for_manifest(manifest, range)) {
    auto [payload, error] = load_payload_impl(*provider, entry);
    if (!error.empty()) {
      throw std::runtime_error(error + ": " + text_or(entry, "kind") + ":" + text_or(entry, "source_id"));
    }
    auto row = entry;
    row["scope"] = text_or(manifest, "scope");
    row["manifest_id"] = text_or(manifest, "manifest_id");
    row["storage_source_id"] = source_id;
    row["source_type"] = text_or(manifest, "source_type");
    row["source_head"] = text_or(manifest, "source_head");
    row["payload"] = payload;
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
  const auto provider = make_provider(runtime_dir);
  provider->write_payload(digest, raw);
  return provider->name() == PROVIDER_ROCKSDB ? storage_uri(PROVIDER_ROCKSDB, runtime_dir, "payload/" + digest)
                                              : payload_path(runtime_dir, digest).string();
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
                         {"runtime", file_storage_provider("").runtime()}},
                        {{"name", PROVIDER_ROCKSDB},
                         {"default", provider.name == PROVIDER_ROCKSDB},
                         {"selected", provider.name == PROVIDER_ROCKSDB},
                         {"layout", rocksdb_storage_provider("").layout()},
                         {"runtime", rocksdb_storage_provider("").runtime()}},
                    })},
      {"projections",
       nlohmann::json::array(
           {{{"name", PROJECTION_SOURCE_REGISTRY},
             {"schema", SOURCE_REGISTRY_SCHEMA},
             {"authority", "derived"},
             {"rebuildable", true}},
            {{"name", PROJECTION_SQLITE},
             {"schema", SQLITE_PROJECTION_SCHEMA},
             {"authority", "derived"},
             {"path", "storage/projections/storage.sqlite"},
             {"tables", nlohmann::json::array({"storage_sources", "storage_manifests", "storage_entries"})},
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
