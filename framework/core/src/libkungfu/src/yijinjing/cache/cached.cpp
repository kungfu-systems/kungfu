// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/cache/cached.h>
#include <kungfu/yijinjing/cache/open_layer_projector.h>
#include <kungfu/yijinjing/practice/hero.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::practice;
using namespace kungfu::yijinjing::data;
using namespace kungfu::cache;

// https://sqlite.org/limits.html
// The maximum number of bytes in the text of an SQL statement is limited to SQLITE_MAX_SQL_LENGTH which defaults to
// 1,000,000,000.
#define DEFAULT_STORE_VOLUME_BY_INTERVAL 1000
#define STORE_INTERVAL 100
#define RESTORE_LIMIT 5000

namespace kungfu::cache {

cached::cached(const yijinjing::io_device_ptr &io_device)
    : session_builder_(io_device), profile_(io_device->get_locator()),
      ledger_home_location_(practice::make_system_location("service", "ledger", io_device->get_locator())) {
  bypass_cached_ = std::getenv("KF_BYPASS_CACHED") != nullptr;
  profile_.setup();
  profile_get_all(profile_, profile_restore_bank_);

  // for otc scenes
  char *is_otc = std::getenv("IS_OTC_ACCOUNTING_TYPE");
  std::string yes_str = "1";
  if (is_otc != nullptr && strcmp(is_otc, yes_str.c_str()) == 0) {
    is_otc_ = true;
  }

  // 开放层 FB 投影器（默认 OFF，与 hana 闭集并存）：仅当 KF_OPEN_LAYER_SCHEMAS 指向 schemas 目录时启用。
  if (const char *schemas_dir = std::getenv("KF_OPEN_LAYER_SCHEMAS"); schemas_dir != nullptr) {
    try {
      open_layer_ = std::make_unique<open_layer_projector>();
      auto n = open_layer_->setup(schemas_dir, std::string(schemas_dir) + "/open_layer.db");
      open_layer_->start_worker(); // 后台异步批量 flush，feed() 不在 reader 热路径同步写 sqlite
      SPDLOG_INFO("open-layer projector enabled: {} type(s) from {}", n, schemas_dir);
    } catch (const std::exception &e) {
      SPDLOG_ERROR("open-layer projector setup failed, disabled: {}", e.what());
      open_layer_.reset();
    }
  }
}

cached::~cached() {

  m_quit_ = true;

  if (store_states_worker_.joinable()) {
    store_states_worker_.join();
  }

  if (store_profile_worker_.joinable()) {
    store_profile_worker_.join();
  }
}

void cached::restore_profile(const yijinjing::data::location_ptr &location,
                             const yijinjing::journal::writer_ptr &writer) {
  profile_store_mutex_.lock();
  try {
    // for config, basket, instruemnts .etc. from user interface
    profile_restore_bank_.clear();
    profile_get_all(profile_, profile_restore_bank_);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to drain profile db into profile band {} {} {}", location->uid, location->uname, ex.what());
  }
  profile_store_mutex_.unlock();
  feed_mutex_.lock();
  profile_restore_bank_ >> writer;
  profile_feed_bank_ >> writer;
  feed_mutex_.unlock();
}

void cached::restore_states(const yijinjing::data::location_ptr &location,
                            const yijinjing::journal::writer_ptr &writer) {
  if (bypass_cached_) {
    return;
  }

  std::lock_guard<std::mutex> lock(states_store_mutex_);

  try {
    make_cache_shift(location);
    app_states_shift_.at(location->uid) >> writer;
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to write cache {} {} {}", location->uid, location->uname, ex.what());
  }

  const bool IS_NODE = location->category == category::SYSTEM and location->group == "node";
  const bool IS_LEDGER = location->uid == ledger_home_location_->uid;
  const bool IS_TD = location->category == category::TD;
  const bool IS_STRATEGY = location->category == category::STRATEGY;
  const bool IS_OPERATOR = location->category == category::OPERATOR;
  const bool IS_SYSTEM = location->category == category::SYSTEM;

  if (IS_TD or IS_STRATEGY) {
    for (const auto &other_location : location->locator->list_locations("*", "*", "*", "*")) {
      if (other_location->category == category::SYSTEM) {
        continue;
      }

      auto is_current_location = other_location->uid == location->uid;

      for (auto dest : location->locator->list_location_dest_by_db(other_location)) {
        if (dest == location->uid or (is_current_location && dest == location::PUBLIC)) {
          try {
            ensure_cached_storage(other_location, dest);
            app_states_shift_.at(other_location->uid).restore_to(writer, dest);
          } catch (const std::exception &ex) {
            SPDLOG_ERROR("failed to write cache {} {} {}", other_location->uname, dest, ex.what());
          }
        }
      }
    }
  }

  // static data in td
  if (IS_STRATEGY or IS_OPERATOR or IS_SYSTEM) {
    for (const auto &td_location : location->locator->list_locations("td", "*", "*", "live")) {
      auto dests = location->locator->list_location_dest_by_db(td_location);
      if (std::find(dests.begin(), dests.end(), location::PUBLIC) != dests.end()) {
        try {
          if (not check_cached_storage_exists(td_location, location::PUBLIC)) {
            continue;
          }
          ensure_cached_storage(td_location, location::PUBLIC);
          app_states_shift_.at(td_location->uid).restore_to(StaticDataTypes, writer, location::PUBLIC);

          // for trading task starting as quick as possible
          if (IS_STRATEGY and location->group != "default" and is_otc_) {
            break;
          }
        } catch (const std::exception &ex) {
          SPDLOG_ERROR("failed to write static data {} {} {} for target {}", td_location->uname, location::PUBLIC,
                       ex.what(), location->uname);
        }
      }
    }
  }

  // restore all trading data from tds, including static data in td
  if (IS_SYSTEM) {
    for (const auto &td_location : location->locator->list_locations("td", "*", "*", "live")) {
      for (auto dest : location->locator->list_location_dest_by_db(td_location)) {
        try {
          ensure_cached_storage(td_location, dest);
          // tracing-foundation Phase 1: Order/AlgoOrder(交易)拆出闭集 cache,移除其专属 restore;
          // 保留对非交易 StateDataTypes 的泛型 restore。
          app_states_shift_.at(td_location->uid).restore_to(writer, dest, RESTORE_LIMIT);
        } catch (const std::exception &ex) {
          SPDLOG_ERROR("failed to write cache {} {} {} for target {}", td_location->uname, dest, ex.what(),
                       location->uname);
        }
      }
    }
  }

  // for watcher reload ledger written data (statisticdata (orerstat) after crash
  if (IS_NODE) {
    for (const auto &ledger_location : location->locator->list_locations("system", "service", "ledger", "live")) {
      for (auto dest : location->locator->list_location_dest_by_db(ledger_location)) {
        try {
          ensure_cached_storage(ledger_location, dest);
          app_states_shift_.at(ledger_location->uid).restore_to(StatisticDataTypes, writer, dest, RESTORE_LIMIT);
        } catch (const std::exception &ex) {
          SPDLOG_ERROR("failed to write cache {} {} {} for target {}", ledger_location->uname, dest, ex.what(),
                       location->uname);
        }
      }
    }
  }
}

void cached::restore(const location_ptr &location, const yijinjing::journal::writer_ptr &writer) {
  restore_profile(location, writer);
  restore_states(location, writer);
}

void cached::reset_cache_shift(const location_ptr &location) {
  if (bypass_cached_) {
    return;
  }

  uint32_t location_uid = location->uid;
  if (app_states_shift_.find(location_uid) == app_states_shift_.end()) {
    SPDLOG_INFO("no location_uid {} in app_states_shift_, no need to clear cache", location->uname);
    return;
  }

  // clear storage_map_ memory, for ensure_storage working fine next time
  app_states_shift_.erase(location_uid);
}

void cached::make_cache_shift(const location_ptr &location) {
  if (bypass_cached_) {
    return;
  }

  locations_.emplace(location->uid, location);
  app_states_shift_.emplace(location->uid, location);
}

void cached::try_ensure_cached_storage(const location_ptr &location, uint32_t dest) {
  if (bypass_cached_) {
    return;
  }

  std::lock_guard<std::mutex> lock(states_store_mutex_);
  ensure_cached_storage(location, dest);
}

void cached::ensure_cached_storage(const location_ptr &location, uint32_t dest) {
  make_cache_shift(location);
  app_states_shift_.at(location->uid).ensure_storage(dest);
}

bool cached::check_cached_storage_exists(const location_ptr &location, uint32_t dest) {
  if (app_states_shift_.find(location->uid) == app_states_shift_.end()) {
    return false;
  }

  return app_states_shift_.at(location->uid).check_storage_exists(dest);
}

void cached::cache_reset(const event_ptr &event) {
  if (bypass_cached_) {
    return;
  }

  std::lock_guard<std::mutex> lock(states_store_mutex_);
  auto cache_reset = event->data<CacheReset>();
  auto msg_type = cache_reset.msg_type;
  boost::hana::for_each(StateDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (DataType::tag == msg_type) {
      if (app_states_shift_.find(event->source()) != app_states_shift_.end()) {
        app_states_shift_[event->source()] -= typed_event_ptr<DataType>(event);
      }
      if (app_states_shift_.find(event->dest()) != app_states_shift_.end()) {
        app_states_shift_[event->dest()] /= typed_event_ptr<DataType>(event);
      }
    }
  });
}

void cached::feed(const event_ptr &event) {
  std::lock_guard<std::mutex> lock(feed_mutex_);
  // only etf related data will be stored by cached, these data should be only store in td public.db, for CachedReset
  if (event->msg_type() != BasketInstrument::tag and event->msg_type() != Basket::tag) {
    feed_profile_data(event, profile_feed_bank_);
  }

  if (not bypass_cached_ and event->msg_type() != Instrument::tag) {
    feed_state_data(event, states_feed_bank_);
  }

  // 开放层 FB 帧（msg_type 不在 longfist 闭集）：路由到 FB 投影器；未启用或未注册类型时 no-op，不影响 hana 路径。
  if (open_layer_) {
    open_layer_->feed(event);
  }
}

void cached::run_store_workers() {
  store_profile_worker_ = std::thread(&cached::do_store_profile_feeds, this);

  if (not bypass_cached_) {
    store_states_worker_ = std::thread(&cached::do_store_states_feeds, this);
  }
}

void cached::do_store_states_feeds() {
  while (!m_quit_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(STORE_INTERVAL));
    if (storage_pause_) {
      return;
    }

    store_states_feeds();
  }
  SPDLOG_DEBUG("store state feed end");
}

void cached::do_store_profile_feeds() {
  while (!m_quit_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(STORE_INTERVAL));
    if (storage_pause_) {
      return;
    }

    store_profile_feeds();
  }
  SPDLOG_DEBUG("store profile feed end");
}

void cached::store_states_feeds() {
  cache::location_bank tmp_location_bank = {};
  auto store_state_data_start_time = yijinjing::time::now_in_nano();

  feed_mutex_.lock();
  // tracing-foundation Phase 1: 交易类型拆出闭集 cache,移除 TradingDataTypes transfer(states_feed_bank_
  // 现仅含非交易 StateDataTypes);仅搬运非交易状态。trading_data_count 置 0 仅供下方日志保留。
  auto trading_data_count = 0;
  auto others_data_count = transfer_from_bank<bank, location_bank>(
      StateDataTypes, states_feed_bank_, tmp_location_bank, DEFAULT_STORE_VOLUME_BY_INTERVAL);
  feed_mutex_.unlock();

  auto &location_bank_map = tmp_location_bank.get_map();
  std::for_each(location_bank_map.begin(), location_bank_map.end(), [&](auto &pair) {
    uint32_t source = pair.first >> 32u;
    uint32_t dest = pair.first & 0xFFFFFFFF;
    auto &state_bank = pair.second;

    boost::hana::for_each(StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      auto hana_type = boost::hana::type_c<DataType>;
      using StateMap = std::unordered_map<uint64_t, state<DataType>>;
      auto &state_map = const_cast<StateMap &>(state_bank[hana_type]);
      std::vector<DataType> tmp_state_vector = {};
      for (const auto &s : state_map) {
        tmp_state_vector.push_back(s.second.data);
      }

      if (tmp_state_vector.size() <= 0) {
        return;
      }

      if (app_states_shift_.find(source) == app_states_shift_.end()) {
        return;
      }

      states_store_mutex_.lock();
      try {
        app_states_shift_.at(source).replace_range(dest, tmp_state_vector);
        SPDLOG_TRACE("cache [state] {} size {}", DataType::type_name.c_str(), tmp_state_vector.size());
      } catch (const std::exception &e) {
        SPDLOG_ERROR("Unexpected exception by store_states_feeds {}", e.what());
      }
      states_store_mutex_.unlock();
    });
  });

  auto store_state_data_end_time = yijinjing::time::now_in_nano();
  if (trading_data_count + others_data_count > 0) {
    SPDLOG_DEBUG("store states data take {}ns, trading data count {}, others data count {}",
                 store_state_data_end_time - store_state_data_start_time, trading_data_count, others_data_count);
  }
}

void cached::store_profile_feeds() {
  ProfileStateBank tmp_profile_bank = ProfileStateBank(ProfileDataTypes);
  auto store_profile_data_start_time = yijinjing::time::now_in_nano();

  feed_mutex_.lock();
  auto count = transfer_from_bank<ProfileStateBank, ProfileStateBank>(
      ProfileDataTypes, profile_feed_bank_, tmp_profile_bank, DEFAULT_STORE_VOLUME_BY_INTERVAL);
  feed_mutex_.unlock();

  boost::hana::for_each(ProfileDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    auto hana_type = boost::hana::type_c<DataType>;
    using FeedMap = std::unordered_map<uint64_t, state<DataType>>;
    auto &feed_map = const_cast<FeedMap &>(tmp_profile_bank[hana_type]);
    std::vector<DataType> tmp_profile_vector = {};
    for (const auto &s : feed_map) {
      tmp_profile_vector.push_back(s.second.data);
    }

    if (tmp_profile_vector.size() <= 0) {
      return;
    }

    profile_store_mutex_.lock();
    try {
      profile_.replace_range(tmp_profile_vector);
      SPDLOG_TRACE("cache [profile] {} size {}", DataType::type_name.c_str(), tmp_profile_vector.size());
    } catch (const std::exception &e) {
      SPDLOG_ERROR("Unexpected exception by store_profile_feeds {}", e.what());
    }
    profile_store_mutex_.unlock();
  });

  auto store_profile_data_end_time = yijinjing::time::now_in_nano();
  if (count > 0) {
    SPDLOG_DEBUG("store profile data take {}ns, count {}", store_profile_data_end_time - store_profile_data_start_time,
                 count);
  }
}

void cached::open_session(const location_ptr &location, int64_t open_time) {
  session_builder_.open_session(location, open_time);
}

void cached::close_session(const location_ptr &location, int64_t close_time) {
  session_builder_.close_session(location, close_time);
}

void cached::close_all_sessions(int64_t close_time) { return session_builder_.close_all_sessions(close_time); }

index::SessionMap &cached::get_all_sessions() { return session_builder_.get_all_sessions(); }

int64_t cached::find_last_active_time(const location_ptr &location) {
  if (bypass_cached_) {
    return yijinjing::time::now_in_nano();
  }

  return session_builder_.find_last_active_time(location);
}

void cached::update_session(const yijinjing::journal::frame_ptr &frame) {
  if (bypass_cached_ or storage_pause_) {
    return;
  }
  session_builder_.update_session(frame);
}

void cached::switch_feed_storage(bool pause_storage) { storage_pause_ = pause_storage; }

} // namespace kungfu::cache