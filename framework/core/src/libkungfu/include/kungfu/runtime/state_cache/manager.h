// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STATE_CACHE_MANAGER_H
#define KUNGFU_RUNTIME_STATE_CACHE_MANAGER_H

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/state_cache/model.h>
#include <kungfu/runtime/state_cache/profile.h>
#include <kungfu/runtime/state_cache/store.h>
#include <kungfu/yijinjing/log.h>

#include <memory>

namespace kungfu::runtime::projection {
class open_layer_projector;
}

namespace kungfu::runtime::state_cache {

// FlatBuffers 投影器与 Hana 闭集并存且默认关闭；完整定义只在 manager.cpp 引入。
using ProfileDataTypesType = decltype(yijinjing::ProfileDataTypes);
using ProfileStateMapType = decltype(yijinjing::build_state_map(yijinjing::ProfileDataTypes));
using ProfileStateBank = typed_bank<ProfileDataTypesType, ProfileStateMapType>;

class manager {
public:
  explicit manager(const kungfu::runtime::io_device_ptr &io_device);

  ~manager();

  template <typename DataType> std::vector<DataType> get_all(const DataType &) { return profile_.get_all(DataType{}); }

  void restore_profile(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer);

  void restore_states(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer);

  void restore(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer);

  void reset_cache_shift(const yijinjing::data::location_ptr &location);

  void make_cache_shift(const yijinjing::data::location_ptr &location);

  void try_ensure_cached_storage(const yijinjing::data::location_ptr &location, uint32_t dest);

  void ensure_cached_storage(const yijinjing::data::location_ptr &location, uint32_t dest);

  bool check_cached_storage_exists(const yijinjing::data::location_ptr &location, uint32_t dest);

  void cache_reset(const event_ptr &event);

  void feed(const event_ptr &event);

  template <typename DataType>
  std::enable_if_t<yijinjing::is_profile_data<DataType>()> feed_profile(const DataType &data) {
    std::lock_guard<std::mutex> lock(feed_mutex_);
    auto s = state(0, 0, 0, data);
    profile_feed_bank_ << s;
  }

  void run_store_workers();

  void do_store_states_feeds();

  void do_store_profile_feeds();

  void store_states_feeds();

  void store_profile_feeds();

  void switch_feed_storage(bool pause_storage);

  static constexpr auto feed_profile_data = [](const event_ptr &event, auto &receiver) {
    boost::hana::for_each(yijinjing::ProfileDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      if (DataType::tag == event->carrier_type()) {
        receiver << typed_event_ptr<DataType>(event);
      }
    });
  };

  static constexpr auto feed_state_data = [](const event_ptr &event, auto &receiver) {
    boost::hana::for_each(yijinjing::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      if (DataType::tag == event->carrier_type()) {
        receiver << typed_event_ptr<DataType>(event);
      }
    });
  };

private:
  std::unordered_map<uint32_t, yijinjing::data::location_ptr> locations_ = {};
  profile profile_;
  ProfileStateBank profile_feed_bank_ = ProfileStateBank(yijinjing::ProfileDataTypes);
  ProfileStateBank profile_restore_bank_ = ProfileStateBank(yijinjing::ProfileDataTypes);
  std::unordered_map<uint32_t, shift> app_states_shift_ = {};
  bank states_feed_bank_;
  bool bypass_cached_;
  std::thread store_states_worker_;
  std::thread store_profile_worker_;
  std::mutex feed_mutex_;
  std::mutex states_store_mutex_;
  std::mutex profile_store_mutex_;
  std::atomic<bool> m_quit_ = false;
  std::atomic_bool storage_pause_ = false;

  yijinjing::data::location_ptr ledger_home_location_;

  // 开放层 FB 投影器：仅当环境变量 KF_OPEN_LAYER_SCHEMAS 设定时由 ctor 启用；为空表示未启用，feed() 不投影。
  std::unique_ptr<projection::open_layer_projector> open_layer_;

  static constexpr auto profile_get_all = [](auto &profile, auto &receiver) {
    boost::hana::for_each(yijinjing::ProfileDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      try {

        for (const auto &data : profile.get_all(DataType{})) {
          auto s = state(0, 0, 0, data);
          receiver << s;
        }
      } catch (const std::exception &e) {
        SPDLOG_ERROR("Unexpected exception by profile_get_all {}", e.what());
      }
    });
  };

  template <typename DataType>
  static constexpr auto profile_get_by_type = [](auto &profile, auto &receiver) {
    try {
      for (const auto &data : profile.get_all(DataType{})) {
        auto s = state(0, 0, 0, data);
        receiver << s;
      }
    } catch (const std::exception &e) {
      SPDLOG_ERROR("Unexpected exception by profile_get_all {}", e.what());
    }
  };

  template <typename SourceType, typename DestType>
  static constexpr auto transfer_from_bank =
      [](auto datatypes, SourceType &data_source, DestType &data_dest, int32_t limit) {
        auto count = 0;
        boost::hana::for_each(datatypes, [&](auto it) {
          using DataType = typename decltype(+boost::hana::second(it))::type;
          auto hana_type = boost::hana::type_c<DataType>;
          using FeedMap = std::unordered_map<uint64_t, state<DataType>>;
          auto &feed_map = const_cast<FeedMap &>(data_source[hana_type]);
          auto iter = feed_map.begin();
          while (iter != feed_map.end() and count < limit) {
            data_dest << iter->second;
            iter = feed_map.erase(iter);
            count++;
          }
        });
        return count;
      };
};

} // namespace kungfu::runtime::state_cache

#endif // KUNGFU_RUNTIME_STATE_CACHE_MANAGER_H
