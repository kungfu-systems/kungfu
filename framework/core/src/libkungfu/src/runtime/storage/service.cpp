// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/service.h>

#include <algorithm>
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

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/generic_service.h>
#include <kungfu/yijinjing/storage/sync_root.h>
#include <rocksdb/db.h>
#include <rocksdb/iterator.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

inline constexpr const char *PAYLOAD_STATE_PRESENT = "present";
inline constexpr const char *CONTENT_TYPE_JSON = "application/json";
inline constexpr const char *SOURCE_REGISTRY_SCHEMA = "kungfu.storage.source-registry/v1";
inline constexpr const char *PROJECTION_SOURCE_REGISTRY = "source-registry";
inline constexpr const char *PROJECTION_SQLITE = "sqlite";
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

fs::path root_dir(const std::string &runtime_dir) { return fs::path(runtime_dir) / "storage"; }

fs::path registry_path(const std::string &runtime_dir) { return root_dir(runtime_dir) / "sources.json"; }

fs::path payload_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "payloads"; }

fs::path rocksdb_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "rocksdb"; }

fs::path payload_path(const std::string &runtime_dir, const std::string &digest) {
  return payload_root(runtime_dir) / digest.substr(0, std::min<size_t>(2, digest.size())) / (digest + ".json");
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
        {"payloads", "storage/payloads/<hash-prefix>/<sha256>.json"},
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
      if (entry.is_regular_file() && entry.path().extension() == ".json") {
        paths.emplace_back(entry.path());
      }
    }
  }
  std::sort(paths.begin(), paths.end());
  return paths;
}

std::string payload_digest_from_path(const fs::path &path) { return path.stem().string(); }

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
           {"orphan_payloads", 0},
       }},
  };
}

nlohmann::json fsck_impl(const storage_service_options &options) {
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
           {"projection_indexes", 1},
           {"orphan_payloads", 0},
       }},
  };
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
      if (text_or(entry, "payload_state") != PAYLOAD_STATE_PRESENT) {
        report["warnings"].push_back({{"code", "payload_not_present"},
                                      {"source_id", current_source_id},
                                      {"subject", text_or(entry, "kind") + ":" + text_or(entry, "source_id")},
                                      {"state", text_or(entry, "payload_state")}});
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
      {"dry_run", options.dry_run},
      {"would_write", would_write},
      {"written", would_write && !options.dry_run},
      {"sources_rebuilt", rebuilt},
      {"changes", changes},
      {"errors", errors},
      {"unsupported",
       nlohmann::json::array(
           {{{"name", PROJECTION_SQLITE}, {"reason", "no generic SQLite projection exists in this storage slice"}}})},
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
      {"unsupported",
       nlohmann::json::array(
           {{{"name", "history-archive"}, {"reason", "archive bundles are not implemented in this slice"}},
            {{"name", PROJECTION_SQLITE}, {"reason", "no generic SQLite projection exists in this storage slice"}},
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

  [[nodiscard]] nlohmann::json export_bundle(const storage_service_options &options) const override {
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
      storage_operation_name(storage_operation::Status),       storage_operation_name(storage_operation::Fsck),
      storage_operation_name(storage_operation::ExportBundle), storage_operation_name(storage_operation::ImportBundle),
      storage_operation_name(storage_operation::RebuildIndex), storage_operation_name(storage_operation::GcPlan),
      storage_operation_name(storage_operation::CompactPlan),  storage_operation_name(storage_operation::VerifySync),
  };
}

std::string storage_operation_name(storage_operation operation) {
  switch (operation) {
  case storage_operation::Status:
    return "status";
  case storage_operation::Fsck:
    return "fsck";
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
  return parsed;
}

nlohmann::json make_storage_service_request(const std::string &operation, const std::string &runtime_dir,
                                            const nlohmann::json &options) {
  return make_request(parse_storage_operation(operation), parse_storage_service_options(runtime_dir, options));
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
      {"notes",
       nlohmann::json::array({
           "The runtime storage service surface and providers are owned by libkungfu.",
           "Provider selection is an implementation option; product semantics remain storage-service operations.",
           "Python and Node should remain binding, CLI, or UI layers over this service.",
       })},
  };
}

} // namespace kungfu::runtime::storage_service_api
