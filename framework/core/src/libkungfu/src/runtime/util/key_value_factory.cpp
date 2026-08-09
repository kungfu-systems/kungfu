// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/live/key_value_store.h>

#include <kungfu/runtime/live/identity.h>
#include <kungfu/yijinjing/common.h>

#include <stdexcept>
#include <utility>

namespace kungfu::runtime::live {
namespace {

class unavailable_key_value_store final : public key_value_store {
public:
  explicit unavailable_key_value_store(std::string provider) : provider_(std::move(provider)) {}
  [[nodiscard]] std::string get(const std::string &) const override { fail(); }
  [[nodiscard]] std::map<std::string, std::string> get_many(const std::set<std::string> &) const override { fail(); }
  void put(const std::string &, const std::string &) const override { fail(); }
  void put_many(const std::map<std::string, std::string> &) const override { fail(); }
  void reset() override {}

private:
  [[noreturn]] void fail() const { throw std::runtime_error("provider_unavailable: " + provider_); }
  std::string provider_;
};

} // namespace

#if KUNGFU_HAS_ROCKSDB
key_value_store_ptr make_rocksdb_key_value_store(std::string path, bool writable, bool reopen_on_read);
#endif

key_value_store_ptr make_live_key_value_store(std::string path, bool writable, bool reopen_on_read) {
#if KUNGFU_HAS_ROCKSDB
  return make_rocksdb_key_value_store(std::move(path), writable, reopen_on_read);
#else
  (void)path;
  (void)writable;
  (void)reopen_on_read;
  return std::make_shared<unavailable_key_value_store>("rocksdb-live-kv");
#endif
}

void install_coordinator_key_value_provider() {
  ::kungfu::yijinjing::data::location::coordinator_kv() = [](const ::kungfu::yijinjing::data::location &self,
                                                             const std::string &key) {
    namespace es = yijinjing::enums;
    const std::string store_path =
        self.locator->layout_directory(es::layout::MAP, es::location_role::SYSTEM, COORDINATOR_WIRE_NAMESPACE,
                                       COORDINATOR_WIRE_NAME, self.mode, false);
    return make_live_key_value_store(store_path, false, true)->get(key);
  };
}

} // namespace kungfu::runtime::live
