// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/26.
//

#ifndef KUNGFU_LONGFIST_H
#define KUNGFU_LONGFIST_H

#include <deque>
#include <kungfu/longfist/types.h>
#include <set>

#define TYPE_PAIR(DataType) boost::hana::make_pair(HANA_STR(#DataType), boost::hana::type_c<types::DataType>)

namespace kungfu::longfist {
constexpr auto AllTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                     // 0
    TYPE_PAIR(page_header),                      // 1
    TYPE_PAIR(Asset),                            // 101
    TYPE_PAIR(Contract),                         // 102
    TYPE_PAIR(Position),                         // 103
    TYPE_PAIR(PositionEnd),                      // 104
    TYPE_PAIR(InstrumentFactor),                 // 105
    TYPE_PAIR(OrderInput),                       // 201
    TYPE_PAIR(Order),                            // 202
    TYPE_PAIR(Trade),                            // 203
    TYPE_PAIR(OrderAction),                      // 204
    TYPE_PAIR(OrderActionError),                 // 205
    TYPE_PAIR(BlockMessage),                     // 206
    TYPE_PAIR(OrderStat),                        // 207
    TYPE_PAIR(OrderTriggerInput),                // 209
    TYPE_PAIR(OrderTrigger),                     // 210
    TYPE_PAIR(OrderTriggerAction),               // 211
    TYPE_PAIR(OrderTriggerActionError),          // 212
    TYPE_PAIR(AlgoOrderInput),                   // 213
    TYPE_PAIR(AlgoOrder),                        // 214
    TYPE_PAIR(AlgoOrderAction),                  // 215
    TYPE_PAIR(AlgoOrderActionError),             // 216
    TYPE_PAIR(BatchOrderBegin),                  // 251
    TYPE_PAIR(BatchOrderEnd),                    // 252
    TYPE_PAIR(RequestHistoryOrder),              // 301
    TYPE_PAIR(RequestHistoryTrade),              // 302
    TYPE_PAIR(HistoryOrder),                     // 303
    TYPE_PAIR(HistoryTrade),                     // 304
    TYPE_PAIR(RequestHistoryOrderError),         // 305
    TYPE_PAIR(RequestHistoryTradeError),         // 306
    TYPE_PAIR(AssetRequest),                     // 351
    TYPE_PAIR(PositionRequest),                  // 352
    TYPE_PAIR(AssetSync),                        // 353
    TYPE_PAIR(PositionSync),                     // 354
    TYPE_PAIR(OrderTriggerRequest),              // 355
    TYPE_PAIR(ContractRequest),                  // 356
    TYPE_PAIR(Quote),                            // 401
    TYPE_PAIR(Entrust),                          // 402
    TYPE_PAIR(Transaction),                      // 403
    TYPE_PAIR(Tree),                             // 404
    TYPE_PAIR(Depth),                            // 405
    TYPE_PAIR(Tick),                             // 406
    TYPE_PAIR(InstrumentKey),                    // 501
    TYPE_PAIR(CustomSubscribe),                  // 502
    TYPE_PAIR(SyntheticData),                    // 601
    TYPE_PAIR(OutputKey),                        // 701
    TYPE_PAIR(PageEnd),                          // 10051
    TYPE_PAIR(Time),                             // 10052
    TYPE_PAIR(Ping),                             // 10053
    TYPE_PAIR(Pong),                             // 10054
    TYPE_PAIR(Register),                         // 10101
    TYPE_PAIR(Deregister),                       // 10102
    TYPE_PAIR(Session),                          // 10103
    TYPE_PAIR(StrategyStateUpdate),              // 10104
    TYPE_PAIR(OperatorStateUpdate),              // 10105
    TYPE_PAIR(BrokerStateUpdate),                // 10106
    TYPE_PAIR(SessionStart),                     // 10151
    TYPE_PAIR(SessionEnd),                       // 10152
    TYPE_PAIR(RequestStart),                     // 10153
    TYPE_PAIR(RequestStop),                      // 10154
    TYPE_PAIR(RequestDeregister),                // 10155
    TYPE_PAIR(OperatorStateRequest),             // 10156
    TYPE_PAIR(BrokerStateRequest),               // 10157
    TYPE_PAIR(Config),                           // 10201
    TYPE_PAIR(RiskSetting),                      // 10202
    TYPE_PAIR(Commission),                       // 10203
    TYPE_PAIR(Instrument),                       // 10204
    TYPE_PAIR(Location),                         // 10205
    TYPE_PAIR(Basket),                           // 10206
    TYPE_PAIR(BasketInstrument),                 // 10207
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
    TYPE_PAIR(ResetBookRequest),                 // 10451
    TYPE_PAIR(MirrorPositionsRequest),           // 10452
    TYPE_PAIR(KeepPositionsRequest),             // 10453
    TYPE_PAIR(RebuildPositionsRequest),          // 10454
    TYPE_PAIR(TimeRequest),                      // 10501
    TYPE_PAIR(TimeReset),                        // 10502
    TYPE_PAIR(TradingDay),                       // 10503
    TYPE_PAIR(TimeValue),                        // 10601
    TYPE_PAIR(TimeKeyValue),                     // 10602
    TYPE_PAIR(SocketData)                        // 10751
);

constexpr auto AllDataTypes = boost::hana::make_map( //
    TYPE_PAIR(frame_header),                         // 0
    TYPE_PAIR(page_header),                          // 1
    TYPE_PAIR(Asset),                                // 101
    TYPE_PAIR(Contract),                             // 102
    TYPE_PAIR(Position),                             // 103
    TYPE_PAIR(PositionEnd),                          // 104
    TYPE_PAIR(InstrumentFactor),                     // 105
    TYPE_PAIR(OrderInput),                           // 201
    TYPE_PAIR(Order),                                // 202
    TYPE_PAIR(Trade),                                // 203
    TYPE_PAIR(OrderAction),                          // 204
    TYPE_PAIR(OrderActionError),                     // 205
    TYPE_PAIR(BlockMessage),                         // 206
    TYPE_PAIR(OrderStat),                            // 207
    TYPE_PAIR(OrderTriggerInput),                    // 209
    TYPE_PAIR(OrderTrigger),                         // 210
    TYPE_PAIR(OrderTriggerAction),                   // 211
    TYPE_PAIR(OrderTriggerActionError),              // 212
    TYPE_PAIR(AlgoOrderInput),                       // 213
    TYPE_PAIR(AlgoOrder),                            // 214
    TYPE_PAIR(AlgoOrderAction),                      // 215
    TYPE_PAIR(AlgoOrderActionError),                 // 216
    TYPE_PAIR(RequestHistoryOrder),                  // 301
    TYPE_PAIR(RequestHistoryTrade),                  // 302
    TYPE_PAIR(HistoryOrder),                         // 303
    TYPE_PAIR(HistoryTrade),                         // 304
    TYPE_PAIR(RequestHistoryOrderError),             // 305
    TYPE_PAIR(RequestHistoryTradeError),             // 306
    TYPE_PAIR(Quote),                                // 401
    TYPE_PAIR(Entrust),                              // 402
    TYPE_PAIR(Transaction),                          // 403
    TYPE_PAIR(Tree),                                 // 404
    TYPE_PAIR(InstrumentKey),                        // 501
    TYPE_PAIR(CustomSubscribe),                      // 502
    TYPE_PAIR(SyntheticData),                        // 601
    TYPE_PAIR(OutputKey),                            // 701
    TYPE_PAIR(Register),                             // 10101
    TYPE_PAIR(Deregister),                           // 10102
    TYPE_PAIR(StrategyStateUpdate),                  // 10104
    TYPE_PAIR(Session),                              // 10103
    TYPE_PAIR(OperatorStateUpdate),                  // 10105
    TYPE_PAIR(BrokerStateUpdate),                    // 10106
    TYPE_PAIR(Config),                               // 10201
    TYPE_PAIR(RiskSetting),                          // 10202
    TYPE_PAIR(Commission),                           // 10203
    TYPE_PAIR(Instrument),                           // 10204
    TYPE_PAIR(Location),                             // 10205
    TYPE_PAIR(Basket),                               // 10206
    TYPE_PAIR(BasketInstrument),                     // 10207
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
    TYPE_PAIR(TradingDay),                           // 10503
    TYPE_PAIR(TimeValue),                            // 10601
    TYPE_PAIR(TimeKeyValue)                          // 10602
);

constexpr auto ProfileDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Config),                                   // 10201
    TYPE_PAIR(RiskSetting),                              // 10202
    TYPE_PAIR(Commission),                               // 10203
    TYPE_PAIR(Instrument),                               // 10204
    TYPE_PAIR(Location),                                 // 10205
    TYPE_PAIR(Basket),                                   // 10206
    TYPE_PAIR(BasketInstrument)                          // 10207
);

constexpr auto SessionDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Session)                                   // 10103
);

// tracing-foundation Phase 1 (goal 2026-06-25-kungfu-v4-tracing-foundation):
// 交易类型拆出 StateDataTypes(sqlite_orm cache 实例化驱动)。只留非交易内核/运行时状态,
// 砍掉 sqlite_orm 在交易类型上的实例化(22% __text / ~3.47 万符号)。交易类型仍定义于
// types.h(死源,未进闭集 cache),AllTypes/AllDataTypes 暂保留(hana 序列化另议)。
constexpr auto StateDataTypes = boost::hana::make_map( //
    TYPE_PAIR(StrategyStateUpdate),                    // 10104
    TYPE_PAIR(OperatorStateUpdate),                    // 10105
    TYPE_PAIR(Config),                                 // 10201
    TYPE_PAIR(RiskSetting),                            // 10202
    TYPE_PAIR(Commission),                             // 10203
    TYPE_PAIR(Instrument),                             // 10204
    TYPE_PAIR(Basket),                                 // 10206
    TYPE_PAIR(BasketInstrument),                       // 10207
    TYPE_PAIR(TimeValue),                              // 10601
    TYPE_PAIR(TimeKeyValue)                            // 10602
);

constexpr auto TradingDataTypes = boost::hana::make_map( //
    TYPE_PAIR(OrderInput),                               // 201
    TYPE_PAIR(Order),                                    // 202
    TYPE_PAIR(Trade),                                    // 203
    TYPE_PAIR(BlockMessage),                             // 206
    TYPE_PAIR(OrderStat),                                // 207
    TYPE_PAIR(OrderTriggerInput),                        // 209
    TYPE_PAIR(OrderTrigger),                             // 210
    TYPE_PAIR(AlgoOrderInput),                           // 213
    TYPE_PAIR(AlgoOrder)                                 // 214
);

constexpr auto MarketDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Quote),                                   //
    TYPE_PAIR(Tree),                                    //
    TYPE_PAIR(Entrust),                                 //
    TYPE_PAIR(Transaction),                             //
    TYPE_PAIR(Tick),                                    //
    TYPE_PAIR(Depth)                                    //
);

// tracing-foundation Phase 1: 须 ⊆ StateDataTypes(同一 StateStoragePtr)。去交易型 InstrumentFactor。
constexpr auto StaticDataTypes = boost::hana::make_map( //
    TYPE_PAIR(Commission),                              // 10203
    TYPE_PAIR(Instrument),                              // 10204
    TYPE_PAIR(Basket),                                  // 10206
    TYPE_PAIR(BasketInstrument)                         // 10207
);

// tracing-foundation Phase 1: OrderStat(交易统计)拆死源,本闭集清空(restore_to 迭代 no-op)。
constexpr auto StatisticDataTypes = boost::hana::make_map();

constexpr auto RefreshRequiredDataTypes = boost::hana::make_map( //
    TYPE_PAIR(OrderInput),                                       // 201
    TYPE_PAIR(Order),                                            // 202
    TYPE_PAIR(Trade),                                            // 203
    TYPE_PAIR(OrderStat)                                         // 207
);

template <typename T> constexpr bool is_in_types(auto types) { return boost::hana::contains(types, T::type_name); }

template <typename DataType> constexpr bool is_profile_data() { return is_in_types<DataType>(ProfileDataTypes); };

template <typename DataType> constexpr bool is_market_data() { return is_in_types<DataType>(MarketDataTypes); };

const auto build_data_set = [](auto types) {
  std::set<int32_t> s;
  boost::hana::for_each(types, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    s.emplace(DataType::tag);
  });
  return s;
};

const auto AllTypesTags = build_data_set(AllTypes);
const auto TradingDataTags = build_data_set(TradingDataTypes);
const auto ProfileDataTags = build_data_set(ProfileDataTypes);
const auto StaticDataTags = build_data_set(StaticDataTypes);
const auto RefreshRequiredDataTags = build_data_set(RefreshRequiredDataTypes);

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

using ProfileMapType = decltype(build_data_map(longfist::ProfileDataTypes));
DECLARE_PTR(ProfileMapType)

using StateMapType = decltype(build_state_map(longfist::StateDataTypes));
DECLARE_PTR(StateMapType)

using StateDequeMapType = decltype(build_state_deque_map(longfist::StateDataTypes));
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
} // namespace kungfu::longfist

#endif // KUNGFU_LONGFIST_H
