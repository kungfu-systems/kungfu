// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/26.
//

#ifndef KUNGFU_YIJINJING_SCHEMA_REGISTRY_H
#define KUNGFU_YIJINJING_SCHEMA_REGISTRY_H

#include <deque>
#include <kungfu/yijinjing/schema/types.h>
#include <set>

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
    TYPE_PAIR(RequestWriteToBand),               // 10307
    TYPE_PAIR(Band),                             // 10308
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
    TYPE_PAIR(RequestWriteToBand),                          // 10307
    TYPE_PAIR(Band),                                        // 10308
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

constexpr auto StaticDataTypes = boost::hana::make_map();
constexpr auto StatisticDataTypes = boost::hana::make_map();

template <typename T> constexpr bool is_in_types(auto types) { return boost::hana::contains(types, T::type_name); }

template <typename DataType> constexpr bool is_profile_data() { return is_in_types<DataType>(ProfileDataTypes); };

const auto build_data_set = [](auto types) {
  std::set<int32_t> s;
  boost::hana::for_each(types, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    s.emplace(DataType::tag);
  });
  return s;
};

const auto AllTypesTags = build_data_set(AllTypes);
const auto ProfileDataTags = build_data_set(ProfileDataTypes);
const auto StaticDataTags = build_data_set(StaticDataTypes);

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
