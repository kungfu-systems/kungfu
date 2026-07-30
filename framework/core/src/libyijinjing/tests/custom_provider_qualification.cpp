// SPDX-License-Identifier: Apache-2.0

#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/provider_registry.h>

using namespace kungfu::yijinjing::storage;

namespace {

class memory_content_store final : public content_store {
public:
  explicit memory_content_store(std::string identity) : identity_(std::move(identity)) {}

  content_store_capabilities capabilities() const override {
    return {.profile = identity_,
            .atomic_put_if_absent = true,
            .verified_reads = true,
            .durability = "process-lifetime",
            .visibility = "immediate",
            .concurrency = "single-host"};
  }

  content_store_result put_if_absent(const std::string &content_namespace, const void *data, size_t size,
                                     const content_hash &expected = {}) override {
    if (!is_valid_content_namespace(content_namespace)) {
      return {.error = content_store_error::InvalidArgument, .message = "invalid namespace"};
    }
    const std::string bytes(static_cast<const char *>(data), size);
    const auto hash = make_content_hash(compute_content_hash_value(bytes));
    if (!expected.value.empty() && expected.value != hash.value) {
      return {.error = content_store_error::HashMismatch, .message = "declared digest does not match bytes"};
    }
    const auto [it, inserted] = objects_.emplace(key(content_namespace, hash), bytes);
    return {.hash = hash, .byte_length = static_cast<uint64_t>(it->second.size()), .existed = !inserted};
  }

  bool has(const std::string &content_namespace, const content_hash &hash) const override {
    return objects_.contains(key(content_namespace, hash));
  }

  content_store_result verify(const std::string &content_namespace, const content_hash &hash) const override {
    const auto found = objects_.find(key(content_namespace, hash));
    if (found == objects_.end()) {
      return {.error = content_store_error::NotFound};
    }
    if (compute_content_hash_value(found->second) != hash.value) {
      return {.error = content_store_error::CorruptObject};
    }
    return {.hash = hash, .byte_length = static_cast<uint64_t>(found->second.size())};
  }

  content_get_result get(const std::string &content_namespace, const content_hash &hash) const override {
    const auto verified = verify(content_namespace, hash);
    if (!verified.ok()) {
      return {.error = verified.error, .message = verified.message};
    }
    return {.hash = hash, .bytes = objects_.at(key(content_namespace, hash))};
  }

private:
  static std::string key(const std::string &content_namespace, const content_hash &hash) {
    return content_namespace + ":" + hash.value;
  }

  std::string identity_;
  std::map<std::string, std::string> objects_;
};

void require(bool condition, const char *message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

} // namespace

int main() {
  content_store_provider_registry registry;
  registry.add({.id = "memory", .capability_profile = "custom-memory/v1"}, [](const std::string &configuration) {
    return std::make_unique<memory_content_store>(configuration.empty() ? "custom-memory/v1" : configuration);
  });

  require(registry.contains("memory"), "registered provider is discoverable");
  require(registry.describe("memory").writable, "capability descriptor is queryable");
  auto store = registry.create("memory", "fixture-memory/v1");
  require(store->capabilities().profile == "fixture-memory/v1", "configuration reaches factory");
  const auto put = store->put_if_absent("fixture", std::string("hello"));
  require(put.ok() && !put.existed, "custom provider writes");
  require(store->get("fixture", put.hash).bytes == "hello", "custom provider reads");
  require(store->get("fixture", make_content_hash(std::string(64, '0'))).error == content_store_error::NotFound,
          "custom provider maps errors");

  bool duplicate_failed = false;
  try {
    registry.add({.id = "memory", .capability_profile = "duplicate/v1"},
                 [](const std::string &) { return std::make_unique<memory_content_store>("duplicate/v1"); });
  } catch (const std::invalid_argument &error) {
    duplicate_failed = std::string(error.what()) == "duplicate_provider_id: memory";
  }
  require(duplicate_failed, "duplicate provider ids fail closed");

  bool unavailable_failed = false;
  try {
    (void)registry.create("missing");
  } catch (const std::invalid_argument &error) {
    unavailable_failed = std::string(error.what()) == "provider_unavailable: missing";
  }
  require(unavailable_failed, "missing providers have stable diagnostics");
  std::cout << "custom provider qualification passed\n";
}
