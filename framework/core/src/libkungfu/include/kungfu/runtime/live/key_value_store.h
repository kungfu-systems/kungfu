// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_LIVE_KEY_VALUE_STORE_H
#define KUNGFU_RUNTIME_LIVE_KEY_VALUE_STORE_H

#include <map>
#include <memory>
#include <set>
#include <string>

namespace kungfu::runtime::live {

class key_value_store {
public:
  virtual ~key_value_store() = default;
  [[nodiscard]] virtual std::string get(const std::string &key) const = 0;
  [[nodiscard]] virtual std::map<std::string, std::string> get_many(const std::set<std::string> &keys) const = 0;
  virtual void put(const std::string &key, const std::string &value) const = 0;
  virtual void put_many(const std::map<std::string, std::string> &values) const = 0;
  virtual void reset() = 0;
};

using key_value_store_ptr = std::shared_ptr<key_value_store>;

// Adapter-owned factory. The public port deliberately exposes no engine types.
[[nodiscard]] key_value_store_ptr make_live_key_value_store(std::string path, bool writable,
                                                            bool reopen_on_read = false);
void install_coordinator_key_value_provider();

} // namespace kungfu::runtime::live

#endif // KUNGFU_RUNTIME_LIVE_KEY_VALUE_STORE_H
