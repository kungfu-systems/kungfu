// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/26.
//

#ifndef KUNGFU_YIJINJING_SCHEMA_REGISTRY_H
#define KUNGFU_YIJINJING_SCHEMA_REGISTRY_H

#include <algorithm>
#include <array>
#include <deque>
#include <kungfu/yijinjing/journal/layout_fingerprint.h>
#include <kungfu/yijinjing/schema/types.h>

#define TYPE_PAIR(DataType) boost::hana::make_pair(HANA_STR(#DataType), boost::hana::type_c<types::DataType>)

namespace kungfu::yijinjing {
constexpr auto AllTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                     // 0
    TYPE_PAIR(page_header),                      // 1
    TYPE_PAIR(SyntheticData),                    // 601
    TYPE_PAIR(OutputKey),                        // 701
    TYPE_PAIR(PageEnd),                          // 10051
    TYPE_PAIR(Time),                             // 10052
    TYPE_PAIR(Ping),                             // 10053
    TYPE_PAIR(Pong),                             // 10054
    TYPE_PAIR(Register),                         // 10101
    TYPE_PAIR(Deregister),                       // 10102
    TYPE_PAIR(OperatorStateUpdate),              // 10105
    TYPE_PAIR(RequestStart),                     // 10153
    TYPE_PAIR(RequestStop),                      // 10154
    TYPE_PAIR(RequestDeregister),                // 10155
    TYPE_PAIR(OperatorStateRequest),             // 10156
    TYPE_PAIR(Config),                           // 10201
    TYPE_PAIR(Location),                         // 10205
    TYPE_PAIR(CacheReset),                       // 10208
    TYPE_PAIR(RequestCachedDone),                // 10209
    TYPE_PAIR(CachedReadyToRead),                // 10251
    TYPE_PAIR(RequestCached),                    // 10252
    TYPE_PAIR(CachedPause),                      // 10253
    TYPE_PAIR(CachedResume),                     // 10254
    TYPE_PAIR(RequestReadFrom),                  // 10301
    TYPE_PAIR(RequestReadFromPublic),            // 10302
    TYPE_PAIR(RequestReadFromSync),              // 10303
    TYPE_PAIR(RequestWriteTo),                   // 10304
    TYPE_PAIR(Channel),                          // 10305
    TYPE_PAIR(ChannelRequest),                   // 10306
    TYPE_PAIR(RequestWriteToOutlet),             // 10307
    TYPE_PAIR(Outlet),                           // 10308
    TYPE_PAIR(RequestReadFromOthers),            // 10309
    TYPE_PAIR(TimeRequest),                      // 10501
    TYPE_PAIR(TimeReset),                        // 10502
    TYPE_PAIR(TimeValue),                        // 10601
    TYPE_PAIR(TimeKeyValue),                     // 10602
    TYPE_PAIR(SocketData),                       // 10751
    TYPE_PAIR(EpisodeOpen),                      // 10801
    TYPE_PAIR(EpisodeHeartbeat),                 // 10802
    TYPE_PAIR(EpisodeFrameAttached),             // 10803
    TYPE_PAIR(EpisodeRefAttached),               // 10804
    TYPE_PAIR(EpisodeClosed),                    // 10805
    TYPE_PAIR(SourceRegistered),                 // 10901
    TYPE_PAIR(SourceHeadUpdated),                // 10902
    TYPE_PAIR(AcceptedRangeRecorded),            // 10903
    TYPE_PAIR(ImportManifestAccepted),           // 10904
    TYPE_PAIR(ManifestEntryRecorded),            // 10905
    TYPE_PAIR(ExportBundleRecorded),             // 10906
    TYPE_PAIR(ChannelCursorUpdated)              // 10907
);

// ADR-0065: AllDataTypes is the data-carrying subset of the AllTypes roster,
// derived from the struct-level has_data trait rather than re-listed. Mark types
// (has_data == false: PageEnd, Ping, Pong, RequestStart, ...) drop out
// automatically. (This is an internal set; public bindings use CorePublic*.)
constexpr auto AllDataTypes =
    boost::hana::unpack(boost::hana::filter(boost::hana::to_tuple(AllTypes),
                                            [](auto pair) {
                                              using DataType = typename decltype(+boost::hana::second(pair))::type;
                                              return boost::hana::bool_c<DataType::has_data>;
                                            }),
                        boost::hana::make_map);
static_assert(decltype(boost::hana::length(AllDataTypes))::value == 36);

constexpr auto CorePublicDataTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                                // 0
    TYPE_PAIR(page_header),                                 // 1
    TYPE_PAIR(SyntheticData),                               // 601
    TYPE_PAIR(OutputKey),                                   // 701
    TYPE_PAIR(Register),                                    // 10101
    TYPE_PAIR(Deregister),                                  // 10102
    TYPE_PAIR(OperatorStateUpdate),                         // 10105
    TYPE_PAIR(Config),                                      // 10201
    TYPE_PAIR(Location),                                    // 10205
    TYPE_PAIR(CacheReset),                                  // 10208
    TYPE_PAIR(RequestCachedDone),                           // 10209
    TYPE_PAIR(RequestReadFrom),                             // 10301
    TYPE_PAIR(RequestReadFromPublic),                       // 10302
    TYPE_PAIR(RequestReadFromSync),                         // 10303
    TYPE_PAIR(RequestWriteTo),                              // 10304
    TYPE_PAIR(Channel),                                     // 10305
    TYPE_PAIR(ChannelRequest),                              // 10306
    TYPE_PAIR(RequestWriteToOutlet),                        // 10307
    TYPE_PAIR(Outlet),                                      // 10308
    TYPE_PAIR(RequestReadFromOthers),                       // 10309
    TYPE_PAIR(TimeRequest),                                 // 10501
    TYPE_PAIR(TimeReset),                                   // 10502
    TYPE_PAIR(TimeValue),                                   // 10601
    TYPE_PAIR(TimeKeyValue),                                // 10602
    TYPE_PAIR(EpisodeOpen),                                 // 10801
    TYPE_PAIR(EpisodeHeartbeat),                            // 10802
    TYPE_PAIR(EpisodeFrameAttached),                        // 10803
    TYPE_PAIR(EpisodeRefAttached),                          // 10804
    TYPE_PAIR(EpisodeClosed),                               // 10805
    TYPE_PAIR(SourceRegistered),                            // 10901
    TYPE_PAIR(SourceHeadUpdated),                           // 10902
    TYPE_PAIR(AcceptedRangeRecorded),                       // 10903
    TYPE_PAIR(ImportManifestAccepted),                      // 10904
    TYPE_PAIR(ManifestEntryRecorded),                       // 10905
    TYPE_PAIR(ExportBundleRecorded),                        // 10906
    TYPE_PAIR(ChannelCursorUpdated)                         // 10907
);

constexpr auto CorePublicProfileDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Config),                                             // 10201
    TYPE_PAIR(Location)                                            // 10205
);

constexpr auto CorePublicStateDataTypes = boost::hana::make_map( //
    TYPE_PAIR(OperatorStateUpdate),                              // 10105
    TYPE_PAIR(Config),                                           // 10201
    TYPE_PAIR(TimeValue),                                        // 10601
    TYPE_PAIR(TimeKeyValue)                                      // 10602
);

// ADR-0065: the pure-category subsets below are derived from one authoritative
// membership table, not hand-listed. Each type declares its category flags once
// and hana::filter produces each subset, so a type can no longer drift between a
// subset and its list. schema/core.h stays neutral -- membership is a registry
// concern, not a POD-layout one. (AllTypes / has_data / CorePublic* structural
// subsets are a separate follow-up.)
namespace membership {
constexpr int state = 1 << 0;
constexpr int profile = 1 << 1;
constexpr int source_registry = 1 << 2;
constexpr int manifest_catalog = 1 << 3;
constexpr int episode_manifest = 1 << 4;

template <typename T, int Flags>
constexpr auto entry = boost::hana::make_pair(boost::hana::type_c<T>, boost::hana::int_c<Flags>);

constexpr auto table = boost::hana::make_tuple(             //
    entry<types::OperatorStateUpdate, state>,               //
    entry<types::Config, state | profile>,                  //
    entry<types::TimeValue, state>,                         //
    entry<types::TimeKeyValue, state>,                      //
    entry<types::Location, profile>,                        //
    entry<types::SourceRegistered, source_registry>,        //
    entry<types::SourceHeadUpdated, source_registry>,       //
    entry<types::AcceptedRangeRecorded, source_registry>,   //
    entry<types::ImportManifestAccepted, manifest_catalog>, //
    entry<types::ManifestEntryRecorded, manifest_catalog>,  //
    entry<types::ExportBundleRecorded, manifest_catalog>,   //
    entry<types::ChannelCursorUpdated, manifest_catalog>,   //
    entry<types::EpisodeOpen, episode_manifest>,            //
    entry<types::EpisodeHeartbeat, episode_manifest>,       //
    entry<types::EpisodeFrameAttached, episode_manifest>,   //
    entry<types::EpisodeRefAttached, episode_manifest>,     //
    entry<types::EpisodeClosed, episode_manifest>,          //
    entry<types::EpisodeRootCommitted, episode_manifest>    //
);

// Produce a subset in the same shape as a TYPE_PAIR make_map: (type_name -> type).
template <int Flag> constexpr auto derive() {
  auto filtered = boost::hana::filter(
      table, [](auto e) { return (boost::hana::second(e) & boost::hana::int_c<Flag>) != boost::hana::int_c<0>; });
  auto pairs = boost::hana::transform(filtered, [](auto e) {
    using T = typename decltype(+boost::hana::first(e))::type;
    return boost::hana::make_pair(T::type_name, boost::hana::first(e));
  });
  return boost::hana::unpack(pairs, boost::hana::make_map);
}
} // namespace membership

constexpr auto ProfileDataTypes = membership::derive<membership::profile>();

constexpr auto StateDataTypes = membership::derive<membership::state>();

// ADR-0037: the source-registry kernel records project to SQLite through the
// same compile-time Hana closed-set -> SQLite column path (projection::make_storage_ptr)
// used by the profile/state caches, not a hand-written raw-SQL
// projection that serves the JSON manifest layer.
constexpr auto SourceRegistryDataTypes = membership::derive<membership::source_registry>();

// ADR-0037 (final slice): the manifest-catalog record family — import-manifest
// acceptance, per-entry deltas, export-bundle receipts, and channel cursors —
// as a Hana closed set for the rebuildable SQLite projection
// (projection::make_storage_ptr), the same path the source-registry projection
// uses. The manifest-catalog journal stays the authority.
constexpr auto ManifestCatalogDataTypes = membership::derive<membership::manifest_catalog>();

// ADR-0041: the Episode manifest record family as a Hana closed set for the
// rebuildable SQLite projection (projection::make_storage_ptr), the same path the
// source-registry projection uses. The manifest journal stays the authority;
// this set only feeds derived, rebuildable views.
constexpr auto EpisodeManifestDataTypes = membership::derive<membership::episode_manifest>();

// ADR-0065 regression guard: a category's membership must change deliberately.
// Adding or removing a member updates the table above and the expected count here.
static_assert(decltype(boost::hana::length(StateDataTypes))::value == 4);
static_assert(decltype(boost::hana::length(ProfileDataTypes))::value == 2);
static_assert(decltype(boost::hana::length(SourceRegistryDataTypes))::value == 3);
static_assert(decltype(boost::hana::length(ManifestCatalogDataTypes))::value == 4);
static_assert(decltype(boost::hana::length(EpisodeManifestDataTypes))::value == 6);

// ADR-0067: each versioned manifest POD record's payload layout is welded to its
// schema_version by a paired compile-time assert. The read path validates size
// and version (payload_size >= sizeof(T), schema_version <= known max) but not
// layout: a size-preserving, version-unchanged change -- reusing a field, an
// equal-width retype, a same-width reorder -- passes both checks and is silently
// misread. Binding layout_fingerprint<T>() (ADR-0062) to a checked-in expected
// value tied to the type's current schema_version turns any such change into a
// build failure, forcing a deliberate version-binding update.
//
// schema_version stays an explicit, legible, hand-chosen integer (option B): it
// is read-dispatched and cross-version meaningful, so -- unlike the machine-only
// container epoch (ADR-0062) -- it must not be derived from the fingerprint. The
// expected values below are per (type, current schema_version), all == 1 today;
// at the first stable release this graduates to the append-only
// {(type, version) -> fingerprint} ledger (ADR-0067 option ii) that forces a
// version bump mechanically rather than by convention.
namespace manifest_layout_welds {
// The primary template is intentionally undefined: a type that joins a derived
// manifest subset but is not registered below trips an incomplete-type error in
// the coverage guard, so a new versioned record cannot ship unwelded.
template <typename DataType> struct expected_fingerprint;

#define KF_MANIFEST_LAYOUT_WELD(DataType, Fingerprint)                                                                 \
  template <> struct expected_fingerprint<types::DataType> {                                                           \
    static constexpr uint64_t value = (Fingerprint);                                                                   \
  };                                                                                                                   \
  static_assert(journal::layout_fingerprint_detail::layout_fingerprint<types::DataType>() == (Fingerprint),            \
                #DataType " manifest layout changed without updating its schema_version fingerprint (ADR-0067)")

// Episode manifest family (EPISODE_MANIFEST_SCHEMA_VERSION == 1).
KF_MANIFEST_LAYOUT_WELD(EpisodeOpen, 0x7e2a06636f04f207ull);
KF_MANIFEST_LAYOUT_WELD(EpisodeHeartbeat, 0x3fd295814b8d2f1bull);
KF_MANIFEST_LAYOUT_WELD(EpisodeFrameAttached, 0xe0671485211028a3ull);
KF_MANIFEST_LAYOUT_WELD(EpisodeRefAttached, 0xa52acfa727a396d3ull);
KF_MANIFEST_LAYOUT_WELD(EpisodeClosed, 0x8029b5210399344cull);
KF_MANIFEST_LAYOUT_WELD(EpisodeRootCommitted, 0x4e546d6d936d8a3cull);

// Source-registry family (SOURCE_REGISTRY_SCHEMA_VERSION == 1).
KF_MANIFEST_LAYOUT_WELD(SourceRegistered, 0xd4fe79ed51e22f34ull);
KF_MANIFEST_LAYOUT_WELD(SourceHeadUpdated, 0x9d4927d86359738cull);
KF_MANIFEST_LAYOUT_WELD(AcceptedRangeRecorded, 0x53869eec80f897c2ull);

// Manifest-catalog family (MANIFEST_CATALOG_SCHEMA_VERSION == 1).
KF_MANIFEST_LAYOUT_WELD(ImportManifestAccepted, 0x8885754e0e5f3503ull);
KF_MANIFEST_LAYOUT_WELD(ManifestEntryRecorded, 0xb36c14f76998c279ull);
KF_MANIFEST_LAYOUT_WELD(ExportBundleRecorded, 0x309393e82b01644dull);
KF_MANIFEST_LAYOUT_WELD(ChannelCursorUpdated, 0x89a5446eeb0c8255ull);

#undef KF_MANIFEST_LAYOUT_WELD

// Coverage guard: every member of the three derived manifest subsets must be
// registered above. An unregistered member makes expected_fingerprint<DataType>
// an incomplete type here and fails the build, so the enumeration cannot drift
// out of sync with the welds.
template <typename Subset> constexpr bool all_layouts_welded(Subset subset) {
  bool welded = true;
  boost::hana::for_each(subset, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    welded = welded && (journal::layout_fingerprint_detail::layout_fingerprint<DataType>() ==
                        expected_fingerprint<DataType>::value);
  });
  return welded;
}
static_assert(all_layouts_welded(EpisodeManifestDataTypes), "episode-manifest layout weld incomplete (ADR-0067)");
static_assert(all_layouts_welded(SourceRegistryDataTypes), "source-registry layout weld incomplete (ADR-0067)");
static_assert(all_layouts_welded(ManifestCatalogDataTypes), "manifest-catalog layout weld incomplete (ADR-0067)");
} // namespace manifest_layout_welds

// ADR-0065: intentionally empty placeholders. No static/statistic data types are
// registered yet, but the state-cache restore paths (manager.cpp) consume these
// sets, so they must stay defined rather than be removed.
constexpr auto StaticDataTypes = boost::hana::make_map();
constexpr auto StatisticDataTypes = boost::hana::make_map();

template <typename T> constexpr bool is_in_types(auto types) { return boost::hana::contains(types, T::type_name); }

template <typename DataType> constexpr bool is_profile_data() { return is_in_types<DataType>(ProfileDataTypes); };

// ADR-0065: the tag sets are compile-time sorted arrays, not runtime std::set
// globals -- no static-init cost, and membership is a constexpr binary search.
template <typename Types> constexpr auto build_tag_set(Types types) {
  constexpr std::size_t n = decltype(boost::hana::length(types))::value;
  std::array<int32_t, n> tags{};
  std::size_t i = 0;
  boost::hana::for_each(types, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    tags[i++] = DataType::tag;
  });
  std::sort(tags.begin(), tags.end());
  return tags;
}

template <std::size_t N> constexpr bool contains_tag(const std::array<int32_t, N> &tags, int32_t tag) {
  return std::binary_search(tags.begin(), tags.end(), tag);
}

// ADR-0067: carrier_type tag uniqueness is a compile-time invariant. Each POD
// type declares an explicit, hand-allocated, stable tag -- the on-wire,
// cross-language, persisted type ID -- so it must never depend on declaration
// order and can never be auto-generated. But nothing guarded against two types
// sharing a tag: the registry map is keyed by type name and build_tag_set sorts
// without a distinctness check, so a duplicate compiled silently. build_tag_set
// returns the tags sorted, so an adjacent-equal scan proves global distinctness.
// The machine guards uniqueness; it does not assign the tag.
template <std::size_t N> constexpr bool all_tags_distinct(const std::array<int32_t, N> &sorted_tags) {
  for (std::size_t i = 1; i < N; ++i) {
    if (sorted_tags[i] == sorted_tags[i - 1]) {
      return false;
    }
  }
  return true;
}

inline constexpr auto AllTypesTags = build_tag_set(AllTypes);
inline constexpr auto StaticDataTags = build_tag_set(StaticDataTypes);

static_assert(all_tags_distinct(AllTypesTags), "duplicate carrier_type tag in AllTypes (ADR-0067)");

constexpr auto build_data_map = [](auto types) {
  auto maps = boost::hana::transform(boost::hana::values(types), [](auto value) {
    using DataType = typename decltype(+value)::type;
    return boost::hana::make_pair(value, std::unordered_map<uint64_t, DataType>());
  });
  return boost::hana::unpack(maps, boost::hana::make_map);
};

constexpr auto build_state_map = [](auto types) {
  auto maps = boost::hana::transform(boost::hana::values(types), [](auto value) {
    using DataType = typename decltype(+value)::type;
    return boost::hana::make_pair(value, std::unordered_map<uint64_t, state<DataType>>());
  });
  return boost::hana::unpack(maps, boost::hana::make_map);
};

constexpr auto build_state_deque_map = [](auto types) {
  auto vectors = boost::hana::transform(boost::hana::values(types), [](auto value) {
    using DataType = typename decltype(+value)::type;
    return boost::hana::make_pair(value, std::deque<state<DataType>>());
  });
  return boost::hana::unpack(vectors, boost::hana::make_map);
};

using ProfileMapType = decltype(build_data_map(ProfileDataTypes));
DECLARE_PTR(ProfileMapType)

using StateMapType = decltype(build_state_map(StateDataTypes));
DECLARE_PTR(StateMapType)

using StateDequeMapType = decltype(build_state_deque_map(StateDataTypes));
DECLARE_PTR(StateDequeMapType)

template <typename DataType> std::enable_if_t<size_fixed_v<DataType>> copy(DataType &to, const DataType &from) {
  memcpy(&to, &from, sizeof(DataType));
}

template <typename DataType> std::enable_if_t<not size_fixed_v<DataType>> copy(DataType &to, const DataType &from) {
  boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto it) {
    auto accessor = boost::hana::second(it);
    accessor(to) = accessor(from);
  });
}
} // namespace kungfu::yijinjing

#endif // KUNGFU_YIJINJING_SCHEMA_REGISTRY_H
