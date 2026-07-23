// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_PROJECTION_HANA_SQLITE_H
#define KUNGFU_RUNTIME_PROJECTION_HANA_SQLITE_H

#include <kungfu/runtime/common.h>
#include <kungfu/runtime/projection/sqlite_orm_ext.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::projection {

template <typename ValueType> std::enable_if_t<std::is_arithmetic_v<ValueType>, ValueType> make_default() { return 0; }

template <typename ValueType> std::enable_if_t<std::is_enum_v<ValueType>, int> make_default() { return 0; }

template <typename ValueType> std::enable_if_t<is_array_v<ValueType>, std::string> make_default() {
  return std::string();
}

template <typename ValueType>
std::enable_if_t<not is_numeric_v<ValueType> and not is_array_v<ValueType>, ValueType> make_default() {
  return ValueType();
}

// Compile a sqlite_orm schema directly from the selected Hana registry. This
// is the only closed-set POD -> SQLite projection compiler; state caches and
// storage projections both consume it without owning another schema map.
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
      storage_ptr->on_open = [](sqlite3 *db) {
        sqlite3_busy_timeout(db, 5 * yijinjing::time_unit::MILLISECONDS_PER_SECOND);
      };
      return storage_ptr;
    };
  };
  auto tables = boost::hana::transform(boost::hana::keys(types), make_tables(types));
  return boost::hana::unpack(tables, storage_ptr_maker(db_file));
};

using ProfileStoragePtr = decltype(make_storage_ptr(std::string(), yijinjing::ProfileDataTypes));
using StateStoragePtr = decltype(make_storage_ptr(std::string(), yijinjing::StateDataTypes));
using SourceRegistryStoragePtr = decltype(make_storage_ptr(std::string(), yijinjing::SourceRegistryDataTypes));

} // namespace kungfu::runtime::projection

#endif // KUNGFU_RUNTIME_PROJECTION_HANA_SQLITE_H
