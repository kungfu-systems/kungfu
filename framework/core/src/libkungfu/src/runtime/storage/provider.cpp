// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <optional>
#include <stdexcept>
#include <tuple>
#include <utility>

#if KUNGFU_HAS_ROCKSDB
#include <rocksdb/db.h>
#include <rocksdb/iterator.h>
#endif

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

namespace kungfu::runtime::storage_service_api::detail {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

fs::path root_dir(const std::string &runtime_dir) { return fs::path(runtime_dir) / "storage"; }

fs::path payload_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "payloads"; }

fs::path rocksdb_root(const std::string &runtime_dir) { return root_dir(runtime_dir) / "rocksdb"; }

fs::path provider_database_path(const std::string &runtime_dir) { return rocksdb_root(runtime_dir); }

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

std::optional<std::string> environment_value(const char *name) {
#ifdef _WIN32
  const auto required = GetEnvironmentVariableA(name, nullptr, 0);
  if (required == 0) {
    return std::nullopt;
  }
  std::string value(required, '\0');
  const auto written = GetEnvironmentVariableA(name, value.data(), required);
  if (written == 0 || written >= required) {
    return std::nullopt;
  }
  value.resize(written);
  return value;
#else
  if (const char *value = std::getenv(name); value != nullptr) {
    return std::string(value);
  }
  return std::nullopt;
#endif
}

provider_selection select_provider(std::string provider) {
  if (provider.empty()) {
    if (const auto env_provider = environment_value(ENV_STORAGE_PROVIDER); env_provider.has_value()) {
      provider = *env_provider;
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

std::string payload_uri_for(const std::string &provider, const std::string &runtime_dir, const std::string &digest) {
  return provider == PROVIDER_ROCKSDB ? storage_uri(provider, runtime_dir, "payloads/" + digest)
                                      : payload_path(runtime_dir, digest).string();
}

#if KUNGFU_HAS_ROCKSDB
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

  explicit rocksdb_content_store(std::string runtime_dir, engine_opener open)
      : runtime_dir_(std::move(runtime_dir)), open_(std::move(open)) {}

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
    backend_authority_write_guard authority_guard(runtime_dir_, PROVIDER_ROCKSDB);
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

  std::string runtime_dir_;
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
      : runtime_dir_(std::move(runtime_dir)), content_store_(runtime_dir_, [this](bool write) { return open(write); }) {
  }

  [[nodiscard]] std::string name() const override { return PROVIDER_ROCKSDB; }

  [[nodiscard]] storage_provider_layout_view layout() const override {
    return {"storage/rocksdb", "journal/system/storage/manifest-catalog/live/*.journal", "manifests/<sha256>",
            "payloads/<sha256>"};
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

  [[nodiscard]] std::vector<stored_content_object> all_content_objects() const override {
    std::vector<stored_content_object> result;
    for_each("", [&](const std::string &key, const std::string &raw) {
      const auto separator = key.find('/');
      if (separator == std::string::npos) {
        return;
      }
      const auto content_namespace = key.substr(0, separator);
      const auto digest = key.substr(separator + 1);
      if (!yy_storage::is_valid_content_namespace(content_namespace)) {
        return;
      }
      try {
        const auto hash = yy_storage::make_content_hash(digest);
        const auto verified = content_store_.verify(content_namespace, hash);
        if (!verified.ok()) {
          throw std::runtime_error("content_object_corrupt: " + key);
        }
        result.push_back({content_namespace, digest, uri_for(key), raw.size()});
      } catch (const std::invalid_argument &) {
        return;
      }
    });
    std::sort(result.begin(), result.end(), [](const stored_content_object &lhs, const stored_content_object &rhs) {
      return std::tie(lhs.content_namespace, lhs.digest) < std::tie(rhs.content_namespace, rhs.digest);
    });
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
#endif

std::unique_ptr<storage_provider> make_provider(const std::string &provider_name, const std::string &runtime_dir) {
  if (provider_name == PROVIDER_ROCKSDB) {
#if KUNGFU_HAS_ROCKSDB
    return std::make_unique<rocksdb_storage_provider>(runtime_dir);
#else
    throw std::runtime_error("provider_unavailable: rocksdb");
#endif
  }
  return make_file_storage_provider(runtime_dir);
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
// handle for the process lifetime is that decision made visible, and reactor's
// location-metadata engine lives under layout::MAP, a disjoint path from
// this provider's storage/rocksdb, so no path ever has two in-process owners.
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

nlohmann::json provider_layout_json(const storage_provider_layout_view &layout) {
  nlohmann::json rendered = {{"manifest_catalog_journal", layout.manifest_catalog_journal},
                             {"manifest_entries", layout.manifest_entries},
                             {"payloads", layout.payloads}};
  if (layout.database.has_value()) {
    rendered["database"] = *layout.database;
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
episode_store_with_provider episode_ref_store(const storage_service_options &options) {
  auto provider = shared_provider(options);
  auto store = yy_storage::episode_manifest_store(options.runtime_dir);
  store.set_content_store(&provider->content_store());
  return {std::move(provider), std::move(store)};
}

episode_store_with_provider episode_ref_store(const storage_fsck_request &request) {
  auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  auto store = yy_storage::episode_manifest_store(request.runtime_dir);
  store.set_content_store(&provider->content_store());
  return {std::move(provider), std::move(store)};
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

provider_cache &provider_cache::instance() {
  // Cached engine handles intentionally outlive static teardown.
  static auto *cache = new provider_cache();
  return *cache;
}

std::shared_ptr<storage_provider> provider_cache::acquire(const std::string &runtime, const std::string &provider) {
  const auto selection = select_provider_for_runtime(runtime, provider);
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

std::shared_ptr<storage_provider> provider_cache::acquire_migration(const std::string &runtime,
                                                                    const std::string &provider) {
  if (provider.empty()) {
    throw std::invalid_argument("migration provider is required");
  }
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

bool provider_cache::release_temporary(const std::string &runtime, const std::string &provider) {
  const auto selection = select_provider(provider);
  const auto runtime_dir = absolute_normalized(runtime).string();
  const auto key = selection.name + "|" + runtime_dir;
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = providers_.find(key);
  if (it == providers_.end()) {
    return true;
  }
  // Normal runtime handles remain process-cached. One-shot verification
  // runtimes may be released only after every operation-local owner is gone,
  // which lets Windows close RocksDB's LOCK before deleting the temp tree.
  if (it->second.use_count() != 1) {
    return false;
  }
  providers_.erase(it);
  return true;
}

storage_provider_cache_view provider_cache::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return {"process", providers_.size(), hits_.load(std::memory_order_relaxed), misses_.load(std::memory_order_relaxed)};
}

storage_provider_layout_view provider_layout_for(const std::string &provider) {
  if (provider == PROVIDER_ROCKSDB) {
    return {"storage/rocksdb", "journal/system/storage/manifest-catalog/live/*.journal", "manifests/<sha256>",
            "payloads/<sha256>"};
  }
  return {{},
          "journal/system/storage/manifest-catalog/live/*.journal",
          "storage/manifests/<hash-prefix>/<sha256>",
          "storage/payloads/<hash-prefix>/<sha256>"};
}

storage_provider_runtime_view provider_runtime_for(const std::string &provider) {
  if (provider == PROVIDER_ROCKSDB) {
    return {"provider-instance-owned", "process-cached", "closed", false, true, false, false};
  }
  return {"stateless-filesystem", "process-cached", "per filesystem operation", false, true};
}

bool provider_available(const std::string &provider) {
  if (provider != PROVIDER_ROCKSDB) {
    return true;
  }
#if KUNGFU_HAS_ROCKSDB
  return true;
#else
  return false;
#endif
}

} // namespace kungfu::runtime::storage_service_api::detail
