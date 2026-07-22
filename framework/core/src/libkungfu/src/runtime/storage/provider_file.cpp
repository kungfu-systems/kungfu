// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <fstream>
#include <stdexcept>
#include <tuple>
#include <utility>

namespace kungfu::runtime::storage_service_api::detail {
namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

class guarded_file_content_store final : public yy_storage::content_store {
public:
  guarded_file_content_store(std::string runtime_dir, std::string root)
      : runtime_dir_(std::move(runtime_dir)), delegate_(std::move(root)) {}

  [[nodiscard]] yy_storage::content_store_capabilities capabilities() const override {
    return delegate_.capabilities();
  }

  [[nodiscard]] yy_storage::content_store_result put_if_absent(const std::string &content_namespace, const void *data,
                                                               size_t size,
                                                               const yy_storage::content_hash &expected) override {
    backend_authority_write_guard authority_guard(runtime_dir_, PROVIDER_FILE);
    return delegate_.put_if_absent(content_namespace, data, size, expected);
  }
  using yy_storage::content_store::put_if_absent;

  [[nodiscard]] bool has(const std::string &content_namespace, const yy_storage::content_hash &hash) const override {
    return delegate_.has(content_namespace, hash);
  }

  [[nodiscard]] yy_storage::content_store_result verify(const std::string &content_namespace,
                                                        const yy_storage::content_hash &hash) const override {
    return delegate_.verify(content_namespace, hash);
  }

  [[nodiscard]] yy_storage::content_get_result get(const std::string &content_namespace,
                                                   const yy_storage::content_hash &hash) const override {
    return delegate_.get(content_namespace, hash);
  }

private:
  std::string runtime_dir_;
  yy_storage::file_content_store delegate_;
};

class file_storage_provider final : public storage_provider {
public:
  explicit file_storage_provider(std::string runtime_dir)
      : runtime_dir_(std::move(runtime_dir)), content_store_(runtime_dir_, root_dir(runtime_dir_).string()) {}

  [[nodiscard]] std::string name() const override { return PROVIDER_FILE; }
  [[nodiscard]] storage_provider_layout_view layout() const override {
    return {{},
            "journal/system/storage/manifest-catalog/live/*.journal",
            "storage/manifests/<hash-prefix>/<sha256>",
            "storage/payloads/<hash-prefix>/<sha256>"};
  }
  [[nodiscard]] storage_provider_runtime_view runtime() const override {
    return {"stateless-filesystem", "process-cached", "per filesystem operation", false, true};
  }
  [[nodiscard]] bool payload_exists(const std::string &digest) const override {
    return fs::exists(payload_path(runtime_dir_, digest));
  }
  [[nodiscard]] std::string read_payload(const std::string &digest) const override {
    std::ifstream input(payload_path(runtime_dir_, digest), std::ios::binary);
    if (!input) {
      throw std::runtime_error("failed to read payload: " + payload_path(runtime_dir_, digest).string());
    }
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
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
    for (const auto &path : all_payload_paths(runtime_dir_)) {
      result.push_back({payload_digest_from_path(path), path.string(), fs::file_size(path)});
    }
    return result;
  }
  [[nodiscard]] std::vector<stored_content_object> all_content_objects() const override {
    std::vector<stored_content_object> result;
    const auto storage_root = root_dir(runtime_dir_);
    if (!fs::exists(storage_root)) {
      return result;
    }
    for (const auto &namespace_entry : fs::directory_iterator(storage_root)) {
      const auto content_namespace = namespace_entry.path().filename().string();
      if (!namespace_entry.is_directory() || !yy_storage::is_valid_content_namespace(content_namespace) ||
          content_namespace == "rocksdb" || content_namespace == "manifests" || content_namespace == "projections" ||
          content_namespace == "backend-switch-receipts") {
        continue;
      }
      for (const auto &entry : fs::recursive_directory_iterator(namespace_entry.path())) {
        if (!entry.is_regular_file() || entry.path().parent_path().filename() == "tmp") {
          continue;
        }
        const auto digest = entry.path().filename().string();
        try {
          const auto hash = yy_storage::make_content_hash(digest);
          const auto verified = content_store_.verify(content_namespace, hash);
          if (!verified.ok()) {
            throw std::runtime_error("content_object_corrupt: " + content_namespace + "/" + digest);
          }
          result.push_back({content_namespace, digest, entry.path().string(), verified.byte_length});
        } catch (const std::invalid_argument &) {
          continue;
        }
      }
    }
    std::sort(result.begin(), result.end(), [](const stored_content_object &lhs, const stored_content_object &rhs) {
      return std::tie(lhs.content_namespace, lhs.digest) < std::tie(rhs.content_namespace, rhs.digest);
    });
    return result;
  }
  [[nodiscard]] yy_storage::content_store &content_store() const override { return content_store_; }

private:
  std::string runtime_dir_;
  mutable guarded_file_content_store content_store_;
};

std::unique_ptr<storage_provider> make_file_storage_provider(std::string runtime_dir) {
  return std::make_unique<file_storage_provider>(std::move(runtime_dir));
}

} // namespace kungfu::runtime::storage_service_api::detail
