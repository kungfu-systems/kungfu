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
    TYPE_PAIR(Session),                          // 10103
    TYPE_PAIR(OperatorStateUpdate),              // 10105
    TYPE_PAIR(SessionStart),                     // 10151
    TYPE_PAIR(SessionEnd),                       // 10152
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
    TYPE_PAIR(AcceptedRangeRecorded)             // 10903
);

constexpr auto AllDataTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                         // 0
    TYPE_PAIR(page_header),                          // 1
    TYPE_PAIR(SyntheticData),                        // 601
    TYPE_PAIR(OutputKey),                            // 701
    TYPE_PAIR(Register),                             // 10101
    TYPE_PAIR(Deregister),                           // 10102
    TYPE_PAIR(Session),                              // 10103
    TYPE_PAIR(OperatorStateUpdate),                  // 10105
    TYPE_PAIR(Config),                               // 10201
    TYPE_PAIR(Location),                             // 10205
    TYPE_PAIR(CacheReset),                           // 10208
    TYPE_PAIR(RequestCachedDone),                    // 10209
    TYPE_PAIR(RequestReadFrom),                      // 10301
    TYPE_PAIR(RequestReadFromPublic),                // 10302
    TYPE_PAIR(RequestReadFromSync),                  // 10303
    TYPE_PAIR(RequestWriteTo),                       // 10304
    TYPE_PAIR(Channel),                              // 10305
    TYPE_PAIR(ChannelRequest),                       // 10306
    TYPE_PAIR(RequestWriteToBand),                   // 10307
    TYPE_PAIR(Band),                                 // 10308
    TYPE_PAIR(RequestReadFromOthers),                // 10309
    TYPE_PAIR(TimeRequest),                          // 10501
    TYPE_PAIR(TimeReset),                            // 10502
    TYPE_PAIR(TimeValue),                            // 10601
    TYPE_PAIR(TimeKeyValue),                         // 10602
    TYPE_PAIR(EpisodeOpen),                          // 10801
    TYPE_PAIR(EpisodeHeartbeat),                     // 10802
    TYPE_PAIR(EpisodeFrameAttached),                 // 10803
    TYPE_PAIR(EpisodeRefAttached),                   // 10804
    TYPE_PAIR(EpisodeClosed),                        // 10805
    TYPE_PAIR(SourceRegistered),                     // 10901
    TYPE_PAIR(SourceHeadUpdated),                    // 10902
    TYPE_PAIR(AcceptedRangeRecorded)                 // 10903
);

constexpr auto CorePublicDataTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                                // 0
    TYPE_PAIR(page_header),                                 // 1
    TYPE_PAIR(SyntheticData),                               // 601
    TYPE_PAIR(OutputKey),                                   // 701
    TYPE_PAIR(Register),                                    // 10101
    TYPE_PAIR(Deregister),                                  // 10102
    TYPE_PAIR(Session),                                     // 10103
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
    TYPE_PAIR(AcceptedRangeRecorded)                        // 10903
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

constexpr auto ProfileDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Config),                                   // 10201
    TYPE_PAIR(Location)                                  // 10205
);

constexpr auto SessionDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Session)                                   // 10103
);

constexpr auto StateDataTypes = boost::hana::make_map( //
    TYPE_PAIR(OperatorStateUpdate),                    // 10105
    TYPE_PAIR(Config),                                 // 10201
    TYPE_PAIR(TimeValue),                              // 10601
    TYPE_PAIR(TimeKeyValue)                            // 10602
);

// ADR-0037: the source-registry kernel records project to SQLite through the
// same compile-time Hana closed-set -> SQLite column path (make_storage_ptr)
// used by the profile / session / state caches, not the hand-written raw-SQL
// projection that serves the JSON manifest layer.
constexpr auto SourceRegistryDataTypes = boost::hana::make_map( //
    TYPE_PAIR(SourceRegistered),                                // 10901
    TYPE_PAIR(SourceHeadUpdated),                               // 10902
    TYPE_PAIR(AcceptedRangeRecorded)                            // 10903
);

// ADR-0041: the Episode manifest record family as a Hana closed set for the
// rebuildable SQLite projection (cache::make_storage_ptr), the same path the
// source-registry projection uses. The manifest journal stays the authority;
// this set only feeds derived, rebuildable views.
constexpr auto EpisodeManifestDataTypes = boost::hana::make_map( //
    TYPE_PAIR(EpisodeOpen),                                      // 10801
    TYPE_PAIR(EpisodeHeartbeat),                                 // 10802
    TYPE_PAIR(EpisodeFrameAttached),                             // 10803
    TYPE_PAIR(EpisodeRefAttached),                               // 10804
    TYPE_PAIR(EpisodeClosed),                                    // 10805
    TYPE_PAIR(EpisodeRootCommitted)                              // 10806 (ADR-0043)
);

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
