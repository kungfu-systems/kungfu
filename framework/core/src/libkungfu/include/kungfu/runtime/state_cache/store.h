// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#ifndef KUNGFU_RUNTIME_STATE_CACHE_STORE_H
#define KUNGFU_RUNTIME_STATE_CACHE_STORE_H

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/projection/hana_sqlite.h>
#include <kungfu/runtime/state_cache/model.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::state_cache {

using StateStoragePtr = projection::StateStoragePtr;

template <typename, typename = void, bool = true> struct time_spec;

template <typename DataType> struct time_spec<DataType, std::enable_if_t<not DataType::has_timestamp>> {
  static std::vector<DataType> get_all(StateStoragePtr &storage, int64_t, int64_t) {
    return storage->get_all<DataType>();
  };

  static std::vector<DataType> get_all(StateStoragePtr &storage, int64_t, int64_t, int limit) {
    return storage->get_all<DataType>();
  };
};

template <typename DataType> struct time_spec<DataType, std::enable_if_t<DataType::has_timestamp>> {
  static std::vector<DataType> get_all(StateStoragePtr &storage, int64_t from, int64_t to) {
    auto comparator = [](auto it) { return DataType::timestamp_key.value() == boost::hana::first(it); };
    auto just = boost::hana::find_if(boost::hana::accessors<DataType>(), comparator);
    auto accessor = boost::hana::second(*just);
    auto ts = member_pointer_trait<decltype(accessor)>().pointer();
    return storage->get_all<DataType>(sqlite_orm::where(sqlite_orm::and_(sqlite_orm::greater_or_equal(ts, from),
                                                                         sqlite_orm::lesser_or_equal(ts, to))),
                                      sqlite_orm::order_by(ts).asc());
  };

  static std::vector<DataType> get_all(StateStoragePtr &storage, int64_t from, int64_t to, int limit) {
    auto comparator = [](auto it) { return DataType::timestamp_key.value() == boost::hana::first(it); };
    auto just = boost::hana::find_if(boost::hana::accessors<DataType>(), comparator);
    auto accessor = boost::hana::second(*just);
    auto ts = member_pointer_trait<decltype(accessor)>().pointer();

    auto store_data =
        storage->get_all<DataType>(sqlite_orm::where(sqlite_orm::and_(sqlite_orm::greater_or_equal(ts, from),
                                                                      sqlite_orm::lesser_or_equal(ts, to))),
                                   sqlite_orm::order_by(ts).desc(), sqlite_orm::limit(limit));
    std::reverse(store_data.begin(), store_data.end());
    return store_data;
  };
};

class shift {
public:
  shift() = default;

  explicit shift(yijinjing::data::location_ptr location);

  shift(const shift &copy);

  void ensure_storage(uint32_t dest);

  bool check_storage_exists(uint32_t dest);

  StateStoragePtr get_storage(uint32_t dest) {
    ensure_storage(dest);
    return storage_map_.at(dest);
  }

  template <typename TargetType> void operator>>(TargetType &target) {
    for (auto dest : location_->locator->list_location_dest_by_db(location_)) {
      ensure_storage(dest);
    }
    boost::hana::for_each(yijinjing::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      for (auto &pair : storage_map_) {
        restore<DataType>(target, pair.first, pair.second);
      }
    });
  }

  template <typename TargetType> void restore_to(TargetType &target, uint32_t dest) {
    ensure_storage(dest);
    boost::hana::for_each(yijinjing::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      restore<DataType>(target, dest, storage_map_.at(dest));
    });
  }

  template <typename TargetType> void restore_to(TargetType &target, uint32_t dest, int limit) {
    ensure_storage(dest);
    boost::hana::for_each(yijinjing::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      restore<DataType>(target, dest, storage_map_.at(dest), limit);
    });
  }

  template <typename TargetType, typename DataTypes>
  void restore_to(DataTypes datatypes, TargetType &target, uint32_t dest) {
    ensure_storage(dest);
    boost::hana::for_each(datatypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      restore<DataType>(target, dest, storage_map_.at(dest));
    });
  }

  template <typename TargetType, typename DataTypes>
  void restore_to(DataTypes datatypes, TargetType &target, uint32_t dest, int limit) {
    ensure_storage(dest);
    boost::hana::for_each(datatypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      restore<DataType>(target, dest, storage_map_.at(dest), limit);
    });
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    ensure_storage(event->dest());
    storage_map_.at(event->dest())->replace(event->template data<DataType>());
  }

  template <typename DataType> void operator<<(const state<DataType> &s) {
    ensure_storage(s.dest);
    storage_map_.at(s.dest)->replace(s.data);
  }

  template <typename DataType> void replace_range(uint32_t dest, const std::vector<DataType> &v) {
    ensure_storage(dest);
    storage_map_.at(dest)->replace_range(v.begin(), v.end());
  }

  template <typename DataType> void operator-=(const typed_event_ptr<DataType> &event) {
    ensure_storage(event->dest());
    storage_map_.at(event->dest())->template remove_all<DataType>();
  }

  template <typename DataType> void operator/=(const typed_event_ptr<DataType> &) {
    for (auto &pair : storage_map_) {
      pair.second->template remove_all<DataType>();
    }
  }

private:
  yijinjing::data::location_ptr location_;
  std::unordered_map<uint32_t, StateStoragePtr> storage_map_;

  template <typename DataType>
  void restore(const yijinjing::journal::writer_ptr &writer, uint32_t dest, StateStoragePtr &storage) {
    auto from = yijinjing::time::history_window_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX)) {
      writer->write_as(0, data, location_->uid, dest);
    }
  }

  template <typename DataType>
  void restore(const yijinjing::journal::writer_ptr &writer, uint32_t dest, StateStoragePtr &storage, int limit) {
    auto from = yijinjing::time::history_window_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX, limit)) {
      writer->write_as(0, data, location_->uid, dest);
    }
  }

  template <typename DataType> void restore(bank &bank, uint32_t dest, StateStoragePtr &storage) {
    auto from = yijinjing::time::history_window_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX)) {
      bank << state(location_->uid, dest, from, data);
    }
  }

  template <typename DataType> void restore(bank &bank, uint32_t dest, StateStoragePtr &storage, int limit) {
    auto from = yijinjing::time::history_window_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX, limit)) {
      bank << state(location_->uid, dest, from, data);
    }
  }
};

DECLARE_PTR(shift)
} // namespace kungfu::runtime::state_cache

#endif // KUNGFU_RUNTIME_STATE_CACHE_STORE_H
