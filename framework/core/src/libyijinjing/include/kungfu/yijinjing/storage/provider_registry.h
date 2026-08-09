// SPDX-License-Identifier: Apache-2.0
#ifndef KUNGFU_YIJINJING_STORAGE_PROVIDER_REGISTRY_H
#define KUNGFU_YIJINJING_STORAGE_PROVIDER_REGISTRY_H

#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <kungfu/yijinjing/storage/content_store.h>

namespace kungfu::yijinjing::storage {

// Public, engine-neutral composition surface for embedded hosts. Registration
// is explicit and registry-local: providers never rely on global static
// initializers, and two independent hosts cannot mutate each other's catalog.
struct content_store_provider_descriptor {
  std::string id;
  std::string capability_profile;
  bool readable = true;
  bool writable = true;
};

using content_store_provider_factory = std::function<std::unique_ptr<content_store>(const std::string &configuration)>;

class content_store_provider_registry {
public:
  void add(content_store_provider_descriptor descriptor, content_store_provider_factory factory) {
    if (descriptor.id.empty() || !factory) {
      throw std::invalid_argument("invalid_provider_registration");
    }
    const auto id = descriptor.id;
    if (!providers_.emplace(id, entry{std::move(descriptor), std::move(factory)}).second) {
      throw std::invalid_argument("duplicate_provider_id: " + id);
    }
  }

  [[nodiscard]] bool contains(const std::string &id) const { return providers_.contains(id); }

  [[nodiscard]] content_store_provider_descriptor describe(const std::string &id) const { return find(id).descriptor; }

  [[nodiscard]] std::vector<content_store_provider_descriptor> describe_all() const {
    std::vector<content_store_provider_descriptor> result;
    result.reserve(providers_.size());
    for (const auto &[id, provider] : providers_) {
      (void)id;
      result.push_back(provider.descriptor);
    }
    return result;
  }

  [[nodiscard]] std::unique_ptr<content_store> create(const std::string &id,
                                                      const std::string &configuration = {}) const {
    return find(id).factory(configuration);
  }

private:
  struct entry {
    content_store_provider_descriptor descriptor;
    content_store_provider_factory factory;
  };

  [[nodiscard]] const entry &find(const std::string &id) const {
    const auto found = providers_.find(id);
    if (found == providers_.end()) {
      throw std::invalid_argument("provider_unavailable: " + id);
    }
    return found->second;
  }

  std::unordered_map<std::string, entry> providers_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_PROVIDER_REGISTRY_H
