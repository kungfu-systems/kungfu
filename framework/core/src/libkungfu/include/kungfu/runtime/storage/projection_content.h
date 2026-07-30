// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_PROJECTION_CONTENT_H
#define KUNGFU_RUNTIME_STORAGE_PROJECTION_CONTENT_H

#include <bit>
#include <cstdint>
#include <map>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include <boost/hana.hpp>

#include <kungfu/common.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::storage_service_api {

struct projection_content_snapshot {
  uint64_t rows = 0;
  std::string digest = {};
};

namespace projection_content_detail {

template <typename Value>
struct is_fixed_projection_value : std::bool_constant<std::is_arithmetic_v<Value> || std::is_enum_v<Value>> {};

template <typename Value, size_t Size>
struct is_fixed_projection_value<kungfu::array<Value, Size>> : is_fixed_projection_value<Value> {};

template <typename DataType> constexpr bool has_only_fixed_projection_fields() {
  constexpr auto fixed = boost::hana::all_of(boost::hana::accessors<DataType>(), [](auto member) {
    using member_type = std::decay_t<decltype(boost::hana::second(member)(std::declval<DataType &>()))>;
    return boost::hana::bool_c<is_fixed_projection_value<member_type>::value>;
  });
  return decltype(fixed)::value;
}

template <typename Value> void append_integral(std::string &bytes, Value value) {
  using value_type = std::remove_cv_t<Value>;
  using unsigned_type = std::make_unsigned_t<value_type>;
  auto encoded = static_cast<unsigned_type>(value);
  for (size_t index = 0; index < sizeof(unsigned_type); ++index) {
    const auto shift = 8U * (sizeof(unsigned_type) - index - 1U);
    bytes.push_back(static_cast<char>((encoded >> shift) & 0xffU));
  }
}

inline void append_value(std::string &bytes, bool value) { bytes.push_back(value ? '\1' : '\0'); }

template <typename Value>
std::enable_if_t<std::is_integral_v<Value> && !std::is_same_v<std::remove_cv_t<Value>, bool>>
append_value(std::string &bytes, Value value) {
  append_integral(bytes, value);
}

template <typename Value> std::enable_if_t<std::is_enum_v<Value>> append_value(std::string &bytes, Value value) {
  append_integral(bytes, static_cast<std::underlying_type_t<Value>>(value));
}

template <typename Value>
std::enable_if_t<std::is_floating_point_v<Value>> append_value(std::string &bytes, Value value) {
  if constexpr (sizeof(Value) == sizeof(uint32_t)) {
    append_integral(bytes, std::bit_cast<uint32_t>(value));
  } else if constexpr (sizeof(Value) == sizeof(uint64_t)) {
    append_integral(bytes, std::bit_cast<uint64_t>(value));
  } else {
    static_assert(sizeof(Value) == sizeof(uint32_t) || sizeof(Value) == sizeof(uint64_t),
                  "unsupported floating-point width in Hana projection digest");
  }
}

template <typename Value> std::enable_if_t<is_array_v<Value>> append_value(std::string &bytes, const Value &value) {
  for (size_t index = 0; index < Value::length; ++index) {
    append_value(bytes, value.value[index]);
  }
}

template <typename DataType> std::string primary_key_bytes(const DataType &record) {
  std::string bytes;
  const auto accessors = boost::hana::accessors<DataType>();
  boost::hana::for_each(DataType::primary_keys, [&](auto key) {
    const auto member =
        boost::hana::find_if(accessors, boost::hana::on(boost::hana::equal_t::to(key), boost::hana::first));
    append_value(bytes, boost::hana::second(*member)(record));
  });
  return bytes;
}

template <typename DataType> void append_record(std::string &bytes, const DataType &record) {
  boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto member) {
    const std::string name = boost::hana::first(member).c_str();
    append_integral(bytes, static_cast<uint64_t>(name.size()));
    bytes.append(name);
    append_value(bytes, boost::hana::second(member)(record));
  });
}

template <typename DataType>
std::map<std::string, DataType> normalize_records(const std::vector<DataType> &records, bool first_primary_key_wins) {
  std::map<std::string, DataType> normalized;
  for (const auto &record : records) {
    auto key = primary_key_bytes(record);
    if (first_primary_key_wins) {
      normalized.try_emplace(std::move(key), record);
    } else {
      normalized.insert_or_assign(std::move(key), record);
    }
  }
  return normalized;
}

} // namespace projection_content_detail

// SQLite replace semantics are last-primary-key-wins. EpisodeOpen is the one
// immutable-identity exception and asks for first-primary-key-wins explicitly.
// Both key extraction and record encoding come from the Hana schema, so adding
// or changing a field cannot silently leave this parity proof unchanged.
template <typename DataType>
projection_content_snapshot snapshot_projection_content(const std::vector<DataType> &records,
                                                        bool first_primary_key_wins = false) {
  static_assert(projection_content_detail::has_only_fixed_projection_fields<DataType>(),
                "Hana SQLite authority records may contain only fixed-layout scalar, enum, and array fields");
  static_assert(decltype(boost::hana::length(DataType::primary_keys))::value > 0,
                "Hana SQLite authority records require schema-declared primary keys");
  const auto normalized = projection_content_detail::normalize_records(records, first_primary_key_wins);

  std::string bytes = "kungfu.hana-sqlite-projection-content/v1";
  bytes.push_back('\0');
  bytes.append(DataType::type_name.c_str());
  bytes.push_back('\0');
  projection_content_detail::append_integral(bytes, static_cast<uint64_t>(normalized.size()));
  for (const auto &[key, record] : normalized) {
    projection_content_detail::append_integral(bytes, static_cast<uint64_t>(key.size()));
    bytes.append(key);
    projection_content_detail::append_record(bytes, record);
  }
  return {static_cast<uint64_t>(normalized.size()), yijinjing::storage::compute_content_hash_value(bytes)};
}

// Append-only audit families may legitimately lag the authority journal. They
// still must not contain a row whose primary key or Hana field content differs
// from the captured authority snapshot.
template <typename DataType>
bool projection_content_is_subset(const std::vector<DataType> &projected, const std::vector<DataType> &authority) {
  const auto projected_records = projection_content_detail::normalize_records(projected, false);
  const auto authority_records = projection_content_detail::normalize_records(authority, false);
  for (const auto &[key, projected_record] : projected_records) {
    const auto found = authority_records.find(key);
    if (found == authority_records.end()) {
      return false;
    }
    std::string projected_bytes;
    std::string authority_bytes;
    projection_content_detail::append_record(projected_bytes, projected_record);
    projection_content_detail::append_record(authority_bytes, found->second);
    if (projected_bytes != authority_bytes) {
      return false;
    }
  }
  return true;
}

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_PROJECTION_CONTENT_H
