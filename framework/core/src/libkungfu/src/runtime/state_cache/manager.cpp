// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/runtime/live/reactor.h>
#include <kungfu/runtime/projection/flatbuffer.h>
#include <kungfu/runtime/state_cache/manager.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::runtime::live;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::state_cache;

// https://sqlite.org/limits.html
// The maximum number of bytes in the text of an SQL statement is limited to SQLITE_MAX_SQL_LENGTH which defaults to
// 1,000,000,000.
#define DEFAULT_STORE_VOLUME_BY_INTERVAL 1000
#define STORE_INTERVAL 100
#define RESTORE_LIMIT 5000

namespace kungfu::runtime::state_cache {

manager::manager(const kungfu::runtime::io_device_ptr &io_device)
    : profile_(io_device->get_locator()),
      ledger_home_location_(live::make_system_location("service", "ledger", io_device->get_locator())) {
  bypass_cached_ = std::getenv("KF_BYPASS_CACHED") != nullptr;
  profile_.setup();
  profile_get_all(profile_, profile_restore_bank_);

  // 开放层 FB 投影器（默认 OFF，与 hana 闭集并存）：仅当 KF_OPEN_LAYER_SCHEMAS 指向 schemas 目录时启用。
  if (const char *schemas_dir = std::getenv("KF_OPEN_LAYER_SCHEMAS"); schemas_dir != nullptr) {
    try {
      open_layer_ = std::make_unique<projection::open_layer_projector>();
      auto n = open_layer_->setup(schemas_dir, std::string(schemas_dir) + "/open_layer.db");
      SPDLOG_INFO("open-layer projector enabled: {} type(s) from {}", n, schemas_dir);
    } catch (const std::exception &e) {
      SPDLOG_ERROR("open-layer projector setup failed, disabled: {}", e.what());
      open_layer_.reset();
    }
  }
}

manager::~manager() { stop(); }

void manager::start() {
  if (worker_running_.exchange(true)) {
    return;
  }
  m_quit_ = false;
  storage_pause_ = false;
  if (open_layer_) {
    open_layer_->start_worker();
  }
  store_profile_worker_ = std::thread(&manager::do_store_profile_feeds, this);
  if (not bypass_cached_) {
    store_states_worker_ = std::thread(&manager::do_store_states_feeds, this);
  }
}

void manager::stop() {
  if (not worker_running_.exchange(false)) {
    return;
  }
  m_quit_ = true;

  if (store_states_worker_.joinable()) {
    store_states_worker_.join();
  }

  if (store_profile_worker_.joinable()) {
    store_profile_worker_.join();
  }
  if (open_layer_) {
    open_layer_->stop_worker();
  }
}

void manager::restore_profile(const yijinjing::data::location_ptr &location,
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

void manager::restore_states(const yijinjing::data::location_ptr &location,
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

  const bool IS_NODE = location->role == location_role::SYSTEM and location->namespace_ == "node";
  const bool IS_LEDGER = location->uid == ledger_home_location_->uid;
  const bool IS_SINK = location->role == location_role::SINK;
  const bool IS_ACTOR = location->role == location_role::ACTOR;
  const bool IS_SERVICE = location->role == location_role::SERVICE;
  const bool IS_SYSTEM = location->role == location_role::SYSTEM;

  if (IS_SINK or IS_ACTOR) {
    for (const auto &other_location : location->locator->list_locations("*", "*", "*", "*")) {
      if (other_location->role == location_role::SYSTEM) {
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

  // static data published by sinks
  if (IS_ACTOR or IS_SERVICE or IS_SYSTEM) {
    for (const auto &sink_location : location->locator->list_locations("sink", "*", "*", "live")) {
      auto dests = location->locator->list_location_dest_by_db(sink_location);
      if (std::find(dests.begin(), dests.end(), location::PUBLIC) != dests.end()) {
        try {
          if (not check_cached_storage_exists(sink_location, location::PUBLIC)) {
            continue;
          }
          ensure_cached_storage(sink_location, location::PUBLIC);
          app_states_shift_.at(sink_location->uid).restore_to(StaticDataTypes, writer, location::PUBLIC);

        } catch (const std::exception &ex) {
          SPDLOG_ERROR("failed to write static data {} {} {} for target {}", sink_location->uname, location::PUBLIC,
                       ex.what(), location->uname);
        }
      }
    }
  }

  // Restore cached runtime state from sinks.
  if (IS_SYSTEM) {
    for (const auto &sink_location : location->locator->list_locations("sink", "*", "*", "live")) {
      for (auto dest : location->locator->list_location_dest_by_db(sink_location)) {
        try {
          ensure_cached_storage(sink_location, dest);
          // tracing-foundation Phase 1: Order/AlgoOrder(交易)拆出闭集 cache,移除其专属 restore;
          // 保留对非交易 StateDataTypes 的泛型 restore。
          app_states_shift_.at(sink_location->uid).restore_to(writer, dest, RESTORE_LIMIT);
        } catch (const std::exception &ex) {
          SPDLOG_ERROR("failed to write cache {} {} {} for target {}", sink_location->uname, dest, ex.what(),
                       location->uname);
        }
      }
    }
  }

  // Restore ledger-written runtime statistics after crash.
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

void manager::restore(const location_ptr &location, const yijinjing::journal::writer_ptr &writer) {
  restore_profile(location, writer);
  restore_states(location, writer);
}

void manager::reset_cache_shift(const location_ptr &location) {
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

void manager::make_cache_shift(const location_ptr &location) {
  if (bypass_cached_) {
    return;
  }

  locations_.emplace(location->uid, location);
  app_states_shift_.emplace(location->uid, location);
}

void manager::try_ensure_cached_storage(const location_ptr &location, uint32_t dest) {
  if (bypass_cached_) {
    return;
  }

  std::lock_guard<std::mutex> lock(states_store_mutex_);
  ensure_cached_storage(location, dest);
}

void manager::ensure_cached_storage(const location_ptr &location, uint32_t dest) {
  make_cache_shift(location);
  app_states_shift_.at(location->uid).ensure_storage(dest);
}

bool manager::check_cached_storage_exists(const location_ptr &location, uint32_t dest) {
  if (app_states_shift_.find(location->uid) == app_states_shift_.end()) {
    return false;
  }

  return app_states_shift_.at(location->uid).check_storage_exists(dest);
}

void manager::cache_reset(const event_ptr &event) {
  if (bypass_cached_) {
    return;
  }

  std::lock_guard<std::mutex> lock(states_store_mutex_);
  auto cache_reset = event->data<CacheReset>();
  auto carrier_type = cache_reset.carrier_type;
  boost::hana::for_each(StateDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (DataType::tag == carrier_type) {
      if (app_states_shift_.find(event->source()) != app_states_shift_.end()) {
        app_states_shift_[event->source()] -= typed_event_ptr<DataType>(event);
      }
      if (app_states_shift_.find(event->dest()) != app_states_shift_.end()) {
        app_states_shift_[event->dest()] /= typed_event_ptr<DataType>(event);
      }
    }
  });
}

void manager::feed(const event_ptr &event) {
  std::lock_guard<std::mutex> lock(feed_mutex_);
  feed_profile_data(event, profile_feed_bank_);

  if (not bypass_cached_) {
    feed_state_data(event, states_feed_bank_);
  }

  // Open-layer FlatBuffers frames are projected only when explicitly registered.
  if (open_layer_) {
    open_layer_->feed(event);
  }
}

void manager::run_store_workers() { start(); }

void manager::do_store_states_feeds() {
  while (!m_quit_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(STORE_INTERVAL));
    if (storage_pause_) {
      continue;
    }

    store_states_feeds();
  }
  SPDLOG_DEBUG("store state feed end");
}

void manager::do_store_profile_feeds() {
  while (!m_quit_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(STORE_INTERVAL));
    if (storage_pause_) {
      continue;
    }

    store_profile_feeds();
  }
  SPDLOG_DEBUG("store profile feed end");
}

void manager::store_states_feeds() {
  location_bank tmp_location_bank = {};
  auto store_state_data_start_time = yijinjing::time::now_in_nano();

  feed_mutex_.lock();
  auto others_data_count = transfer_from_bank<bank, location_bank>(StateDataTypes, states_feed_bank_, tmp_location_bank,
                                                                   DEFAULT_STORE_VOLUME_BY_INTERVAL);
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
  if (others_data_count > 0) {
    SPDLOG_DEBUG("store states data take {}ns, count {}", store_state_data_end_time - store_state_data_start_time,
                 others_data_count);
  }
}

void manager::store_profile_feeds() {
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

void manager::switch_feed_storage(bool pause_storage) { storage_pause_ = pause_storage; }

} // namespace kungfu::runtime::state_cache
