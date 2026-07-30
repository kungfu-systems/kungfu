// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_JOURNAL_LAYOUT_FINGERPRINT_H
#define KUNGFU_YIJINJING_JOURNAL_LAYOUT_FINGERPRINT_H

#include <kungfu/yijinjing/schema/core.h>

#include <cstdint>
#include <type_traits>

// KF-ADR-019f86da-4f90-741b-8f16-b27fcd99d0df: the journal container format epoch is derived from the page_header
// and frame_header binary layout, not from a hand-maintained integer. Any change
// to either layout -- add, remove, reorder, retype, or rename, including
// size-preserving ones the *_length checks cannot see -- changes the epoch, so an
// unversioned layout change cannot ship and old-epoch pages are refused by
// page::load automatically. Cross-epoch replay is offline conversion (deferred).
//
// A pure semantic reinterpretation that keeps a field's name and type is out of
// scope for any layout hash: change the field's name or type to version it.
namespace kungfu::yijinjing::journal {

namespace layout_fingerprint_detail {

constexpr uint64_t kFnvOffset = 1469598103934665603ull;
constexpr uint64_t kFnvPrime = 1099511628211ull;
constexpr uint64_t mix(uint64_t h, uint64_t v) { return (h ^ v) * kFnvPrime; }

// A platform-stable token for one field type: width, alignment, and the
// signed / enum / floating discriminators. Fixed-width fields keep this equal
// across macOS, Linux, and Windows.
template <typename A> constexpr uint64_t field_token() {
  using T = std::decay_t<A>;
  uint64_t t = kFnvOffset;
  t = mix(t, sizeof(T));
  t = mix(t, alignof(T));
  t = mix(t, static_cast<uint64_t>(std::is_signed_v<T> ? 1u : 0u));
  t = mix(t, static_cast<uint64_t>(std::is_enum_v<T> ? 2u : 0u));
  t = mix(t, static_cast<uint64_t>(std::is_floating_point_v<T> ? 4u : 0u));
  return t;
}

// Fold the Hana-reflected field set (field name chars in order + each field's
// type token) together with the struct's own size and alignment.
template <typename DataType> constexpr uint64_t layout_fingerprint() {
  uint64_t base = mix(mix(kFnvOffset, sizeof(DataType)), alignof(DataType));
  return boost::hana::fold_left(boost::hana::accessors<DataType>(), base, [](uint64_t acc, auto it) {
    acc = boost::hana::fold_left(boost::hana::first(it), acc, [](uint64_t a, auto ch) {
      return mix(a, static_cast<uint64_t>(static_cast<unsigned char>(decltype(ch)::value)));
    });
    using FieldT = std::decay_t<decltype(boost::hana::second(it)(std::declval<DataType &>()))>;
    return mix(acc, field_token<FieldT>());
  });
}

} // namespace layout_fingerprint_detail

// The container epoch covers both header layouts. The derived value proves that
// the declaration still matches the structs; the explicit v1 declaration makes
// every binary-format change a reviewable compatibility decision. Updating a
// header without deliberately advancing this declaration fails the build.
inline constexpr uint32_t derived_journal_format_epoch =
    (static_cast<uint32_t>(
         layout_fingerprint_detail::mix(
             layout_fingerprint_detail::layout_fingerprint<::kungfu::yijinjing::types::page_header>(),
             layout_fingerprint_detail::layout_fingerprint<::kungfu::yijinjing::types::frame_header>()) >>
         32) |
     1u);
inline constexpr uint32_t declared_journal_format_epoch_v1 = 0xe3b24c8du;
static_assert(derived_journal_format_epoch == declared_journal_format_epoch_v1,
              "journal wire layout changed: declare a new epoch and provide the required migration path");
inline constexpr uint32_t journal_format_epoch = declared_journal_format_epoch_v1;

} // namespace kungfu::yijinjing::journal

#endif // KUNGFU_YIJINJING_JOURNAL_LAYOUT_FINGERPRINT_H
