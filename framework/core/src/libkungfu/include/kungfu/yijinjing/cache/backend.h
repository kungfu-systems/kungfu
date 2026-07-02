// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#ifndef KUNGFU_CACHE_BACKEND_H
#define KUNGFU_CACHE_BACKEND_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/cache/runtime.h>
#include <kungfu/yijinjing/cache/sqlite_orm_ext.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::cache {
template <typename ValueType> std::enable_if_t<std::is_arithmetic_v<ValueType>, ValueType> make_default() { return 0; }

template <typename ValueType> std::enable_if_t<std::is_enum_v<ValueType>, int> make_default() { return 0; }

template <typename ValueType> std::enable_if_t<is_array_v<ValueType>, std::string> make_default() {
  return std::string();
}

template <typename ValueType>
std::enable_if_t<not is_numeric_v<ValueType> and not is_array_v<ValueType>, ValueType> make_default() {
  return ValueType();
}

constexpr auto make_storage_ptr = [](const std::string &db_file, const auto &types) {
  constexpr auto make_tables = [](const auto &types) {
    return [&](auto key) {
      using DataType = typename decltype(+types[key])::type;
      auto data_accessors = boost::hana::accessors<DataType>();
      auto columns = boost::hana::transform(data_accessors, [&](auto it) {
        auto name = boost::hana::first(it);
        auto accessor = boost::hana::second(it);
        auto member_pointer = member_pointer_trait<decltype(accessor)>().pointer();
        using MemberType = std::decay_t<decltype(accessor(DataType{}))>;
        return sqlite_orm::make_column(name.c_str(), member_pointer,
                                       sqlite_orm::default_value(make_default<MemberType>()));
      });
      auto pk_members = boost::hana::transform(DataType::primary_keys, [&](auto pk) {
        auto pk_member =
            boost::hana::find_if(data_accessors, hana::on(boost::hana::equal_t::to(pk), boost::hana::first));
        auto accessor = boost::hana::second(*pk_member);
        return member_pointer_trait<decltype(accessor)>().pointer();
      });
      auto make_primary_keys = [](auto... keys) { return sqlite_orm::primary_key(keys...); };
      auto primary_keys = boost::hana::unpack(pk_members, make_primary_keys);
      constexpr auto table_maker = [](const std::string &table_name, const auto &primary_keys) {
        return [&](auto... columns) { return sqlite_orm::make_table(table_name, columns..., primary_keys); };
      };
      return boost::hana::unpack(columns, table_maker(key.c_str(), primary_keys));
    };
  };
  constexpr auto storage_ptr_maker = [](const std::string &db_file) {
    return [&](auto... tables) {
      using storage_type = decltype(sqlite_orm::make_storage(db_file, tables...));
      auto storage_ptr = std::make_shared<storage_type>(sqlite_orm::make_storage(db_file, tables...));
      // storage->busy_timeout() only arms the connection alive at call time,
      // and sqlite_orm reopens connections per operation — so later
      // operations ran with no timeout at all and any cross-process
      // contention surfaced as an SQLITE_BUSY throw (observed escaping
      // thread/napi boundaries and killing whole processes). Arm every fresh
      // connection through the on_open hook instead, which our vendored
      // sqlite_orm invokes before pragma replay.
      storage_ptr->on_open = [](sqlite3 *db) {
        sqlite3_busy_timeout(db, 5 * yijinjing::time_unit::MILLISECONDS_PER_SECOND);
      };
      return storage_ptr;
    };
  };
  auto tables = boost::hana::transform(boost::hana::keys(types), make_tables(types));
  return boost::hana::unpack(tables, storage_ptr_maker(db_file));
};

using ProfileStoragePtr = decltype(make_storage_ptr(std::string(), longfist::ProfileDataTypes));
using SessionStoragePtr = decltype(make_storage_ptr(std::string(), longfist::SessionDataTypes));
using StateStoragePtr = decltype(make_storage_ptr(std::string(), longfist::StateDataTypes));

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
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      for (auto &pair : storage_map_) {
        restore<DataType>(target, pair.first, pair.second);
      }
    });
  }

  template <typename TargetType> void restore_to(TargetType &target, uint32_t dest) {
    ensure_storage(dest);
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      restore<DataType>(target, dest, storage_map_.at(dest));
    });
  }

  template <typename TargetType> void restore_to(TargetType &target, uint32_t dest, int limit) {
    ensure_storage(dest);
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
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
    auto from = yijinjing::time::restore_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX)) {
      writer->write_as(0, data, location_->uid, dest);
    }
  }

  template <typename DataType>
  void restore(const yijinjing::journal::writer_ptr &writer, uint32_t dest, StateStoragePtr &storage, int limit) {
    auto from = yijinjing::time::restore_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX, limit)) {
      writer->write_as(0, data, location_->uid, dest);
    }
  }

  template <typename DataType> void restore(cache::bank &bank, uint32_t dest, StateStoragePtr &storage) {
    auto from = yijinjing::time::restore_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX)) {
      bank << state(location_->uid, dest, from, data);
    }
  }

  template <typename DataType>
  void restore(cache::bank &bank, uint32_t dest, StateStoragePtr &storage, int limit) {
    auto from = yijinjing::time::restore_start();
    for (auto &data : time_spec<DataType>::get_all(storage, from, INT64_MAX, limit)) {
      bank << state(location_->uid, dest, from, data);
    }
  }
};

DECLARE_PTR(shift)
} // namespace kungfu::cache

#endif // KUNGFU_CACHE_BACKEND_H
