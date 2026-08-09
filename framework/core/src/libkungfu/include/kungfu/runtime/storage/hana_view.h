// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_HANA_VIEW_H
#define KUNGFU_RUNTIME_STORAGE_HANA_VIEW_H

#include <optional>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include <boost/hana/accessors.hpp>
#include <boost/hana/concept/struct.hpp>
#include <boost/hana/for_each.hpp>

#include <kungfu/common.h>

namespace kungfu::runtime::storage_binding {

template <typename T> struct is_optional : std::false_type {};
template <typename T> struct is_optional<std::optional<T>> : std::true_type {};
template <typename T> inline constexpr bool is_optional_v = is_optional<std::decay_t<T>>::value;

template <typename T> struct is_vector : std::false_type {};
template <typename T, typename Allocator> struct is_vector<std::vector<T, Allocator>> : std::true_type {};
template <typename T> inline constexpr bool is_vector_v = is_vector<std::decay_t<T>>::value;

template <typename T> struct is_variant : std::false_type {};
template <typename... T> struct is_variant<std::variant<T...>> : std::true_type {};
template <typename T> inline constexpr bool is_variant_v = is_variant<std::decay_t<T>>::value;

template <typename T> inline constexpr bool is_hana_view_v = boost::hana::Struct<std::decay_t<T>>::value;

template <typename T, typename Emit> void for_each_field(const T &value, Emit &&emit) {
  static_assert(is_hana_view_v<T>, "typed binding view must expose Hana accessors");
  boost::hana::for_each(boost::hana::accessors<std::decay_t<T>>(), [&](auto field) {
    const auto name = boost::hana::first(field);
    const auto public_name = kungfu::public_field_name(name.c_str());
    const auto accessor = boost::hana::second(field);
    emit(public_name, accessor(value));
  });
}

} // namespace kungfu::runtime::storage_binding

#endif // KUNGFU_RUNTIME_STORAGE_HANA_VIEW_H
