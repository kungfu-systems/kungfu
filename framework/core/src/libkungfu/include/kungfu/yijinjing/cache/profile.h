// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#ifndef KUNGFU_CONFIG_STORE_H
#define KUNGFU_CONFIG_STORE_H

#include "backend.h"
#include "kungfu/longfist/longfist.h"
#include "kungfu/yijinjing/common.h"

namespace kungfu::cache {
class profile {
public:
  explicit profile(const yijinjing::data::locator_ptr &locator);

  void setup();

  template <typename DataType> void set(const DataType &data) { get_storage()->replace(data); }

  template <typename DataType> DataType get(const DataType &query) {
    auto pk_members = boost::hana::transform(DataType::primary_keys, [&](auto pk) {
      auto pk_member = boost::hana::find_if(boost::hana::accessors<DataType>(),
                                            [&](auto it) { return pk == boost::hana::first(it); });
      auto accessor = boost::hana::second(*pk_member);
      return accessor(query);
    });
    auto operation = [&](auto... ids) { return get_storage()->get<DataType>(ids...); };
    return boost::hana::unpack(pk_members, operation);
  }

  template <typename DataType> std::vector<DataType> get_all(const DataType &) {
    return get_storage()->get_all<DataType>();
  }

  template <typename DataType> void remove(const DataType &query) {
    auto pk_members = boost::hana::transform(DataType::primary_keys, [&](auto pk) {
      auto just = boost::hana::find_if(boost::hana::accessors<DataType>(),
                                       [&](auto it) { return pk == boost::hana::first(it); });
      auto accessor = boost::hana::second(*just);
      return accessor(query);
    });
    auto operation = [&](auto... ids) { get_storage()->remove<DataType>(ids...); };
    boost::hana::unpack(pk_members, operation);
  }

  template <typename DataType> void remove_all() { get_storage()->remove_all<DataType>(); }

  template <typename DataType, typename SqliteExpression> void remove_all(SqliteExpression se) {
    get_storage()->remove_all<DataType>(se);
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    get_storage()->replace(event->template data<DataType>());
  }

  template <typename DataType> void operator<<(const state<DataType> &s) { get_storage()->replace(s.data); }

  template <typename DataType> void replace_range(const std::vector<DataType> &v) {
    get_storage()->replace_range(v.begin(), v.end());
  }

private:
  const std::string profile_db_file_;

  cache::ProfileStoragePtr &get_storage();

  explicit profile(std::string profile_db_file);
};
} // namespace kungfu::cache

#endif // KUNGFU_CONFIG_STORE_H
