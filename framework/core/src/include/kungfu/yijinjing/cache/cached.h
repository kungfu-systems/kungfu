// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_CACHED_H
#define KUNGFU_CACHED_H

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/cache/runtime.h>
#include <kungfu/yijinjing/index/session.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/log.h>

#include <memory>

namespace kungfu::cache {

// 开放层运行时投影器（与 hana 闭集并存，默认 OFF）；完整定义见 open_layer_projector.h，仅在 cached.cpp include。
class open_layer_projector;

using ProfileDataTypesType = decltype(longfist::ProfileDataTypes);
using ProfileStateMapType = decltype(longfist::build_state_map(longfist::ProfileDataTypes));
typedef cache::typed_bank<ProfileDataTypesType, ProfileStateMapType> ProfileStateBank;

class cached {
public:
  explicit cached(const yijinjing::io_device_ptr &io_device);

  ~cached();

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
  std::enable_if_t<longfist::is_profile_data<DataType>()> feed_profile(const DataType &data) {
    std::lock_guard<std::mutex> lock(feed_mutex_);
    auto s = state(0, 0, 0, data);
    profile_feed_bank_ << s;
  }

  void run_store_workers();

  void do_store_states_feeds();

  void do_store_profile_feeds();

  void store_states_feeds();

  void store_profile_feeds();

  void open_session(const yijinjing::data::location_ptr &location, int64_t open_time);

  void close_session(const yijinjing::data::location_ptr &location, int64_t close_time);

  void close_all_sessions(int64_t close_time);

  int64_t find_last_active_time(const yijinjing::data::location_ptr &source_location);

  void update_session(const yijinjing::journal::frame_ptr &frame);

  index::SessionMap &get_all_sessions();

  void switch_feed_storage(bool pause_storage);

  template <typename DataType>
  void restore_continuing_data(const yijinjing::journal::writer_ptr &writer,
                               const yijinjing::data::location_ptr &location, uint32_t dest) {
    auto from = yijinjing::time::today_start();
    ensure_cached_storage(location, dest);
    auto &state_shift = app_states_shift_.at(location->uid);
    auto storage = state_shift.get_storage(dest);
    auto states = storage->get_all<DataType>(sqlite_orm::where(
        sqlite_orm::and_(sqlite_orm::and_(sqlite_orm::greater_or_equal(&DataType::insert_time, from),
                                          sqlite_orm::lesser_or_equal(&DataType::insert_time, INT64_MAX)),
                         sqlite_orm::in(&DataType::status, longfist::enums::CONTINUING_STATUS))

            ));
    for (auto &data : states) {
      writer->write_as(0, data, location->uid, dest);
    }
  }

  static constexpr auto feed_profile_data = [](const event_ptr &event, auto &receiver) {
    boost::hana::for_each(longfist::ProfileDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      if (DataType::tag == event->msg_type()) {
        receiver << typed_event_ptr<DataType>(event);
      }
    });
  };

  static constexpr auto feed_state_data = [](const event_ptr &event, auto &receiver) {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      if (DataType::tag == event->msg_type()) {
        receiver << typed_event_ptr<DataType>(event);
      }
    });
  };

  static constexpr auto feed_trading_data = [](const event_ptr &event, auto &receiver) {
    boost::hana::for_each(longfist::TradingDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      if (DataType::tag == event->msg_type()) {
        receiver << typed_event_ptr<DataType>(event);
      }
    });
  };

private:
  index::session_builder session_builder_;
  std::unordered_map<uint32_t, yijinjing::data::location_ptr> locations_ = {};
  cache::profile profile_;
  ProfileStateBank profile_feed_bank_ = ProfileStateBank(longfist::ProfileDataTypes);
  ProfileStateBank profile_restore_bank_ = ProfileStateBank(longfist::ProfileDataTypes);
  std::unordered_map<uint32_t, cache::shift> app_states_shift_ = {};
  cache::bank states_feed_bank_;
  bool bypass_cached_;
  std::thread store_states_worker_;
  std::thread store_profile_worker_;
  std::mutex feed_mutex_;
  std::mutex states_store_mutex_;
  std::mutex profile_store_mutex_;
  std::atomic<bool> m_quit_ = false;
  std::atomic_bool storage_pause_ = false;
  bool is_otc_ = false;

  yijinjing::data::location_ptr ledger_home_location_;

  // 开放层 FB 投影器：仅当环境变量 KF_OPEN_LAYER_SCHEMAS 设定时由 ctor 启用；为空表示未启用，feed() 不投影。
  std::unique_ptr<open_layer_projector> open_layer_;

  static constexpr auto profile_get_all = [](auto &profile, auto &receiver) {
    boost::hana::for_each(longfist::ProfileDataTypes, [&](auto it) {
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

} // namespace kungfu::cache

#endif // KUNGFU_CACHED_H
