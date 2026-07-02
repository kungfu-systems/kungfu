// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/28.
//

#ifndef KUNGFU_LONGFIST_TYPES_H
#define KUNGFU_LONGFIST_TYPES_H

#include <kungfu/common.h>
#include <kungfu/longfist/enums.h>

namespace kungfu::longfist::types {
static constexpr int INSTRUMENT_ID_LEN = 32;
static constexpr int PRODUCT_ID_LEN = 128;
static constexpr int ALGO_TYPE_ID_LEN = 128;
static constexpr int ALGO_ID_LEN = 128;
static constexpr int DATE_LEN = 16;
static constexpr int EXCHANGE_ID_LEN = 16;
static constexpr int TRAIDNG_PHASE_CODE_LEN = 8;
static constexpr int ERROR_MSG_LEN = 256;
static constexpr int EXTERNAL_ID_LEN = 32;
static constexpr int OPPONENT_SEAT_LEN = 16;
static constexpr int CONTRACT_OPENINGDATE_LEN = 16;
static constexpr int CONTRACT_EXPIRATIONDATE_LEN = 16;
static constexpr int CONTRACT_ID_LEN = 64;

KF_DEFINE_MARK_TYPE(BatchOrderBegin, 251);
KF_DEFINE_MARK_TYPE(BatchOrderEnd, 252);
KF_DEFINE_MARK_TYPE(AssetRequest, 351);
KF_DEFINE_MARK_TYPE(PositionRequest, 352);
KF_DEFINE_MARK_TYPE(AssetSync, 353);
KF_DEFINE_MARK_TYPE(PositionSync, 354);
KF_DEFINE_MARK_TYPE(OrderTriggerRequest, 355);
KF_DEFINE_MARK_TYPE(ContractRequest, 356);
// PageEnd (tag 10051) moved to the schema leaf kungfu/longfist/core.h; it stays
// registered in AllTypes (longfist.h) with the same tag.
KF_DEFINE_MARK_TYPE(Time, 10052);
KF_DEFINE_MARK_TYPE(Ping, 10053);
KF_DEFINE_MARK_TYPE(Pong, 10054);
KF_DEFINE_MARK_TYPE(SessionStart, 10151);
KF_DEFINE_MARK_TYPE(SessionEnd, 10152);
KF_DEFINE_MARK_TYPE(RequestStart, 10153);
KF_DEFINE_MARK_TYPE(RequestStop, 10154);
KF_DEFINE_MARK_TYPE(RequestDeregister, 10155);
KF_DEFINE_MARK_TYPE(OperatorStateRequest, 10156);
KF_DEFINE_MARK_TYPE(BrokerStateRequest, 10157);
KF_DEFINE_MARK_TYPE(CachedReadyToRead, 10251);
KF_DEFINE_MARK_TYPE(RequestCached, 10252);
KF_DEFINE_MARK_TYPE(CachedPause, 10253);
KF_DEFINE_MARK_TYPE(CachedResume, 10254);
KF_DEFINE_MARK_TYPE(ResetBookRequest, 10451);
KF_DEFINE_MARK_TYPE(MirrorPositionsRequest, 10452);
KF_DEFINE_MARK_TYPE(KeepPositionsRequest, 10453);
KF_DEFINE_MARK_TYPE(RebuildPositionsRequest, 10454);
KF_DEFINE_MARK_TYPE(SocketData, 10751);

// frame_header(tag 0) 与 page_header(tag 1) 已移入 schema 叶子 kungfu/longfist/core.h
// （经 enums.h -> core.h 在此可见，type tag 与字段布局不变）。

KF_DEFINE_PACK_TYPE(                         //
    Asset, 101, PK(holder_uid), PERPETUAL(), //
    (int64_t, update_time),                  // 更新时间

    (uint32_t, holder_uid),                   //
    (enums::LedgerCategory, ledger_category), //

    (double, initial_equity), // 期初权益
    (double, static_equity),  // 静态权益
    (double, dynamic_equity), // 动态权益

    (double, realized_pnl),   // 实现盈亏
    (double, unrealized_pnl), // 未实现盈亏

    (double, market_value),       // 市值
    (double, long_market_value),  // 融资买入证券市值, 或otc业务市值(多)
    (double, short_market_value), // 融券卖出证券市值, 或otc业务市值(空)

    (double, margin),       // 保证金占用
    (double, long_margin),  // 融资占用保证金, 或otc业务保证金占用(多)
    (double, short_margin), // 融券占用保证金, 或otc业务保证金占用(空)

    (double, accumulated_fee), // 累计手续费
    (double, intraday_fee),    // 当日手续费

    (double, frozen_cash),   // 冻结资金(股票: 买入挂单资金), 期货: 冻结保证金+冻结手续费)
    (double, frozen_margin), // 冻结保证金(期货)
    (double, frozen_fee),    // 冻结手续费(期货)

    (double, position_pnl), // 持仓盈亏(期货)
    (double, close_pnl),    // 平仓盈亏(期货)

    (double, avail),       // 可用资金
    (double, long_avail),  // otc业务可用资金(多)
    (double, short_avail), // otc业务可用资金(空）

    (double, total_asset),  // 总资产
    (double, avail_margin), // 可用保证金

    (double, long_debt),  // 融资欠款金额（原融资负债字段 现更新定义）
    (double, short_cash), // 融券卖出金额

    (double, margin_interest), // 融资融券利息
    (double, settlement),      // 融资融券清算资金

    (double, credit),           // 信贷额度
    (double, collateral_ratio), // 担保比例

    (double, total_debt),                  // 总负债
    (double, net_assets),                  // 净资产
    (double, long_total_debt),             // 融资总负债（融资欠款+融资利息+融资费用）
    (double, short_total_debt),            // 融券总负债（融券市值+融券利息+融券费用）
    (double, gage_buy_fund_available),     // 担保品买入可用资金
    (double, credit_buy_fund_available),   // 融资融券可用资金
    (double, buyredeliver_fund_available), // 买券还券可用资金
    (double, directrepay_fund_available)   // 现金还款可用资金
);

KF_DEFINE_PACK_TYPE(                                         //
    Contract, 102, PK(holder_uid, contract_id), PERPETUAL(), //
    (int64_t, update_time),                                  // 更新时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id),             // 证券代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),                 // 交易所代码
    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id),                 // 合约id(合约唯一标识)
    (kungfu::array<char, CONTRACT_OPENINGDATE_LEN>, opening_date),       // 开仓日期
    (kungfu::array<char, CONTRACT_EXPIRATIONDATE_LEN>, expiration_date), // 归还截止日期

    (enums::ContractType, contract_type),     // 合约类型
    (enums::InstrumentType, instrument_type), // 证券类型
    (enums::CloseOutFlag, close_out_flag),    // 合约了结状态

    (double, repayment_amt),       // 已偿还金额(融资)
    (double, total_liability_amt), // 融资总金额
    (double, unsettled_interest),  // 未结利息罚息

    (double, repayment_qty),       // 已偿还数量(融券)
    (double, total_liability_qty), // 融券总数量
    (uint32_t, holder_uid));

KF_DEFINE_PACK_TYPE(                                                                                 //
    Position, 103, PK(holder_uid, instrument_id, exchange_id, source_op_id, direction), PERPETUAL(), //
    (int64_t, update_time),                                                                          // 更新时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (enums::InstrumentType, instrument_type),                // 合约类型
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID

    (uint32_t, holder_uid),                   //
    (enums::LedgerCategory, ledger_category), //

    (enums::Direction, direction), // 持仓方向

    (double, volume),           // 数量
    (double, yesterday_volume), // 昨仓数量
    (double, frozen_total),     // 冻结数量
    (double, frozen_yesterday), // 冻结昨仓
    (double, static_yesterday), // 固定昨仓数量
    (double, open_volume),      // 今开数量

    (double, last_price), // 最新价

    (double, avg_open_price),       // 开仓均价, 今昨一起
    (double, position_cost_price),  // 持仓成本价
    (double, avg_open_price_today), // 今开仓均价, 仅今仓

    (double, close_price),     // 收盘价(股票和债券)
    (double, pre_close_price), // 昨收价(股票和债券)

    (double, settlement_price),     // 结算价(期货)
    (double, pre_settlement_price), // 昨结算(期货)

    (double, margin),       // 保证金(期货)
    (double, position_pnl), // 持仓盈亏(期货), 最新价 - 昨结算, 表示今日的盈亏, 本地不计算改变
    (double, close_pnl), // 平仓盈亏(期货), 平仓价 - 昨结算, 表示今日的平仓盈亏, 本地不计算改变

    (double, realized_pnl), // 已实现盈亏, 平仓价 - 昨结算, 表示今日的平仓盈亏, 随着交易被本地计算改变
    (double, unrealized_pnl), // 未实现盈亏, 最新价 - 昨结算, 表示今日的盈亏, 随着交易被本地计算改变

    (uint32_t, source_id),   // 来源账户
    (uint64_t, source_op_id) // 来源账户 xor holder_uid
);

KF_DEFINE_PACK_TYPE(                               //
    PositionEnd, 104, PK(holder_uid), PERPETUAL(), //
    (uint32_t, holder_uid)                         //
);

KF_DEFINE_PACK_TYPE(                                                               //
    InstrumentFactor, 105, PK(instrument_id, exchange_id, source_id), PERPETUAL(), //
    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id),                       // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),                           // 交易所ID
    (enums::InstrumentType, instrument_type),                                      // 合约类型
    (kungfu::array<int8_t, PRODUCT_ID_LEN>, product_id),                           // 产品ID (品种)
    (uint32_t, source_id),                                                         // 持仓账户
    (bool, is_trading),                                                            // 当前是否交易
    (double, long_margin_ratio),                                                   // 多头保证金率
    (double, short_margin_ratio),                                                  // 空头保证金率
    (double, conversion_rate),                                                     // 担保品折扣率
    (double, exchange_rate)                                                        // 汇率
);

KF_DEFINE_PACK_TYPE(                                       //
    OrderInput, 201, PK(order_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                  // 订单ID
    (uint64_t, parent_id),                                 // 母单号

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id), // 两融合约唯一标识
    (enums::InstrumentType, instrument_type),            // 合约类型

    (double, limit_price),  // 价格
    (double, frozen_price), // 冻结价格

    (double, volume), // 数量

    (bool, is_swap),                            // 互换单
    (enums::Side, side),                        // 买卖方向
    (enums::Offset, offset),                    // 开平方向
    (enums::HedgeFlag, hedge_flag),             // 投机套保标识
    (enums::PriceType, price_type),             // 价格类型
    (enums::VolumeCondition, volume_condition), // 成交量类型
    (enums::TimeCondition, time_condition),     // 成交时间类型
    (uint64_t, block_id),                       // 大宗交易信息id, 非大宗交易则为0

    (int64_t, insert_time) // 写入时间
);

KF_DEFINE_PACK_TYPE(                                           //
    Order, 202, PK(order_id), TIMESTAMP(restore_time),         //
    (uint64_t, order_id),                                      // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 柜台订单id
    (uint64_t, parent_id),                                     // 母单号

    (int64_t, insert_time),  // 订单写入时间
    (int64_t, update_time),  // 订单更新时间
    (int64_t, restore_time), // 根据这个时间决定是否要恢复该数据, 主要针对期货夜盘
    (kungfu::array<char, DATE_LEN>, trading_day), // 针对模拟盘交易日与实际时间不对应

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id),     // 两融合约唯一标识

    (enums::InstrumentType, instrument_type), // 合约类型

    (double, limit_price),  // 价格
    (double, frozen_price), // 冻结价格, 市价单冻结价格为0

    (double, volume),      // 数量
    (double, volume_left), // 剩余数量

    (double, tax),        // 税
    (double, commission), // 手续费

    (enums::OrderStatus, status), // 订单状态

    (int32_t, error_id),                             // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg), // 错误信息

    (bool, is_swap),                            // 互换单
    (enums::Side, side),                        // 买卖方向
    (enums::Offset, offset),                    // 开平方向
    (enums::HedgeFlag, hedge_flag),             // 投机套保标识
    (enums::PriceType, price_type),             // 价格类型
    (enums::VolumeCondition, volume_condition), // 成交量类型
    (enums::TimeCondition, time_condition)      // 成交时间类型
);
KF_DEFINE_PACK_TYPE(                                   //
    Trade, 203, PK(trade_id), TIMESTAMP(restore_time), //
    (uint64_t, trade_id),                              // 成交ID

    (uint64_t, order_id),                                      // 订单ID
    (uint64_t, parent_order_id),                               // 母单号
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 柜台订单id
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_trade_id), // 柜台成交编号id

    (int64_t, trade_time),   // 成交时间
    (int64_t, restore_time), // 根据这个时间决定是否要恢复该数据, 主要针对期货夜盘
    (kungfu::array<char, DATE_LEN>, trading_day), // 针对模拟盘交易日与实际时间不对应

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id),     // 两融合约唯一标识

    (enums::InstrumentType, instrument_type), // 合约类型

    (enums::Side, side),            // 买卖方向
    (enums::Offset, offset),        // 开平方向
    (enums::HedgeFlag, hedge_flag), // 投机套保标识

    (double, price),  // 成交价格
    (double, volume), // 成交量

    (double, tax),       // 税
    (double, commission) // 手续费
);

KF_DEFINE_PACK_TYPE(                                               //
    OrderAction, 204, PK(order_action_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                          // 订单ID
    (uint64_t, order_action_id),                                   // 订单操作ID
    (enums::OrderActionFlag, action_flag),                         // 订单操作类型
    (int64_t, insert_time)                                         // 写入时间
);

KF_DEFINE_PACK_TYPE(                                                    //
    OrderActionError, 205, PK(order_action_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                               // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 撤单原委托柜台订单id, 新生成撤单委托编号不记录
    (uint64_t, order_action_id),                               // 订单操作ID
    (int32_t, error_id),                                       // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg), // 错误信息
    (int64_t, insert_time)                           // 写入时间
);

KF_DEFINE_PACK_TYPE(                                         //
    BlockMessage, 206, PK(block_id), TIMESTAMP(insert_time), //
    (uint64_t, block_id), // 大宗交易信息id, 用于TD从OrderInput找到此数据
    (kungfu::array<char, OPPONENT_SEAT_LEN>, opponent_seat), // 对手方席号
    (uint64_t, match_number),                                // 成交约定号
    (bool, is_specific),                                     // 是否受限(特定)股份
    (int64_t, insert_time)                                   // 写入时间
);

KF_DEFINE_PACK_TYPE(                                     //
    OrderStat, 207, PK(order_id), TIMESTAMP(input_time), //
    (uint64_t, order_id),                                //
    (int64_t, md_time),                                  //
    (int64_t, input_time),                               //
    (int64_t, insert_time),                              //
    (int64_t, ack_time),                                 //
    (int64_t, trade_time),                               //
    (double, total_price),                               //
    (double, total_volume),                              //
    (double, avg_price)                                  //
);

KF_DEFINE_PACK_TYPE(                                                //
    OrderTriggerInput, 209, PK(trigger_id), TIMESTAMP(insert_time), //
    (uint64_t, trigger_id),                                         // 触发器id

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码
    (enums::InstrumentType, instrument_type),                // 合约类型

    (double, limit_price),  // 价格
    (double, frozen_price), // 冻结价格
    (double, volume),       // 数量
    (double, stop_price),   // 条件触发价格

    (bool, is_swap),                            // 互换单
    (enums::Side, side),                        // 买卖方向
    (enums::Offset, offset),                    // 开平方向
    (enums::HedgeFlag, hedge_flag),             // 投机套保标识
    (enums::PriceType, price_type),             // 价格类型
    (enums::VolumeCondition, volume_condition), // 成交量类型
    (enums::TimeCondition, time_condition),     // 成交时间类型
    (enums::OrderTriggerType, trigger_type),    // 条件触发类型

    (int64_t, insert_time) // 写入时间
);

KF_DEFINE_PACK_TYPE(                                             //
    OrderTrigger, 210, PK(trigger_id), TIMESTAMP(restore_time),  //
    (uint64_t, trigger_id),                                      // 触发器id
    (uint64_t, order_id),                                        // 预埋撤单, 被撤单的order_id
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_trigger_id), // 柜台触发器id
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id),   // 柜台订单id
    (enums::OrderTriggerFlag, action_flag),                      // 预埋下单 or 预埋撤单

    (int64_t, insert_time),  // 触发器写入时间
    (int64_t, update_time),  // 触发器更新时间
    (int64_t, restore_time), // 根据这个时间决定是否要恢复该数据, 主要针对期货夜盘
    (kungfu::array<char, DATE_LEN>, trading_day), // 针对模拟盘交易日与实际时间不对应

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (enums::InstrumentType, instrument_type),                // 合约类型

    (double, limit_price),  // 价格
    (double, frozen_price), // 冻结价格, 市价单冻结价格为0
    (double, volume),       // 数量
    (double, stop_price),   // 条件触发价格

    (enums::OrderStatus, status), //  触发器状态

    (int32_t, error_id),                             // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg), // 错误信息

    (bool, is_swap),                            // 互换单
    (enums::Side, side),                        // 买卖方向
    (enums::Offset, offset),                    // 开平方向
    (enums::HedgeFlag, hedge_flag),             // 投机套保标识
    (enums::PriceType, price_type),             // 价格类型
    (enums::VolumeCondition, volume_condition), // 成交量类型
    (enums::TimeCondition, time_condition),     // 成交时间类型
    (enums::OrderTriggerType, trigger_type)     // 条件触发类型
);

KF_DEFINE_PACK_TYPE(                                                              //
    OrderTriggerAction, 211, PK(order_trigger_action_id), TIMESTAMP(insert_time), //
    (uint64_t, trigger_id),                                                       // 订单ID
    (uint64_t, order_trigger_action_id),                                          // 订单操作ID
    (enums::OrderActionFlag, action_flag),                                        // 订单操作类型
    (int64_t, insert_time)                                                        // 写入时间
);

KF_DEFINE_PACK_TYPE(                                                                   //
    OrderTriggerActionError, 212, PK(order_trigger_action_id), TIMESTAMP(insert_time), //
    (uint64_t, trigger_id),                                                            // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_trigger_id), // 要删除的预埋单的ParkedId
    (uint64_t, order_trigger_action_id),                         // 订单操作ID
    (int32_t, error_id),                                         // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg),             // 错误信息
    (int64_t, insert_time)                                       // 写入时间
);

KF_DEFINE_DATA_TYPE(                                           //
    AlgoOrderInput, 213, PK(order_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                      // 算法单ID
    (uint64_t, origin_order_id),                               // 原算法单ID
    (int64_t, insert_time),                                    // 下单时间
    (int64_t, begin_time),                                     // 开始时间
    (int64_t, end_time),                                       // 结束时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码
    (enums::InstrumentType, instrument_type),                // 合约类型

    (uint32_t, basket_uid), // basket订单的id

    (enums::Side, side),              // 买卖方向
    (enums::Offset, offset),          // 开平方向
    (enums::PriceType, price_type),   // 价格类型
    (enums::PriceLevel, price_level), // 价格级别
    (double, price_offset),           // 价格偏移量

    (double, volume), // 目标量

    (kungfu::array<char, ALGO_TYPE_ID_LEN>, algo_type_id), // 算法类型
    (kungfu::array<char, ALGO_ID_LEN>, algo_id),           // 算法id

    (std::string, args), // 自定义参数json的形式
    (bool, is_local)     // 是否为一个本地算法单
);

KF_DEFINE_PACK_TYPE(                                           //
    AlgoOrder, 214, PK(order_id), TIMESTAMP(restore_time),     //
    (uint64_t, order_id),                                      // 算法单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 柜台算法单id
    (int64_t, insert_time),                                    // 下单时间
    (int64_t, update_time),                                    // 更新时间
    (int64_t, begin_time),                                     // 开始时间
    (int64_t, end_time),                                       // 结束时间
    (int64_t, restore_time), // 根据这个时间决定是否要恢复该数据, 主要针对期货夜盘

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码
    (enums::InstrumentType, instrument_type),                // 合约类型

    (uint32_t, basket_uid), // basket订单的id

    (enums::Side, side),              // 买卖方向
    (enums::Offset, offset),          // 开平方向
    (enums::PriceType, price_type),   // 价格类型
    (enums::PriceLevel, price_level), // 价格级别
    (double, price_offset),           // 价格偏移量

    (double, volume),      // 目标量
    (double, volume_left), // 剩余数量

    (kungfu::array<char, ALGO_TYPE_ID_LEN>, algo_type_id), // 算法类型
    (kungfu::array<char, ALGO_ID_LEN>, algo_id),           // 算法id

    (enums::OrderStatus, status),                    // 订单状态
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg), // 错误信息
    (bool, is_local)                                 // 是否为一个本地算法单
);

KF_DEFINE_PACK_TYPE(                                                   //
    AlgoOrderAction, 215, PK(order_action_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                              // 订单ID
    (uint64_t, order_action_id),                                       // 订单操作ID

    (enums::AlgoOrderActionFlag, action_flag), // 订单操作类型
    (int64_t, insert_time)                     // 写入时间
);

KF_DEFINE_PACK_TYPE(                                                        //
    AlgoOrderActionError, 216, PK(order_action_id), TIMESTAMP(insert_time), //
    (uint64_t, order_id),                                                   // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id),              // 柜台算法单id
    (uint64_t, order_action_id),                                            // 订单操作ID
    (int32_t, error_id),                                                    // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg),                        // 错误信息
    (int64_t, insert_time)                                                  // 写入时间
);

KF_DEFINE_PACK_TYPE(                                                     //
    RequestHistoryOrder, 301, PK(trigger_time), TIMESTAMP(trigger_time), //
    (uint64_t, trigger_time),                                            // 触发时间
    (uint32_t, query_num)                                                // 请求查询的数量
);

KF_DEFINE_PACK_TYPE(                                                     //
    RequestHistoryTrade, 302, PK(trigger_time), TIMESTAMP(trigger_time), //
    (uint64_t, trigger_time),                                            // 触发时间
    (uint32_t, query_num)                                                // 请求查询的数量
);

KF_DEFINE_PACK_TYPE(                                           //
    HistoryOrder, 303, PK(order_id), TIMESTAMP(insert_time),   //
    (uint64_t, order_id),                                      // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 柜台订单id, 字符型则hash转换

    (int64_t, insert_time),                       // 订单写入时间
    (int64_t, update_time),                       // 订单更新时间
    (kungfu::array<char, DATE_LEN>, trading_day), // 针对模拟盘交易日与实际时间不对应

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id),     // 两融合约唯一标识

    (bool, is_last),                     // 是否为本次查询的最后一条记录
    (enums::HistoryDataType, data_type), // 标记本数据是正常数据, 本页最后一条数据, 全部数据的最后一条

    (enums::InstrumentType, instrument_type), // 合约类型

    (double, limit_price),  // 价格
    (double, frozen_price), // 冻结价格, 市价单冻结价格为0

    (double, volume),      // 数量
    (double, volume_left), // 剩余数量

    (double, tax),        // 税
    (double, commission), // 手续费

    (enums::OrderStatus, status), // 订单状态

    (int32_t, error_id),                             // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg), // 错误信息

    (bool, is_swap), // 互换单

    (enums::Side, side),                        // 买卖方向
    (enums::Offset, offset),                    // 开平方向
    (enums::HedgeFlag, hedge_flag),             // 投机套保标识
    (enums::PriceType, price_type),             // 价格类型
    (enums::VolumeCondition, volume_condition), // 成交量类型
    (enums::TimeCondition, time_condition)      // 成交时间类型
);

KF_DEFINE_PACK_TYPE(                                        //
    HistoryTrade, 304, PK(trade_id), TIMESTAMP(trade_time), //
    (uint64_t, trade_id),                                   // 成交ID

    (uint64_t, order_id),                                      // 订单ID
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_order_id), // 柜台订单id
    (kungfu::array<char, EXTERNAL_ID_LEN>, external_trade_id), // 柜台成交编号id

    (int64_t, trade_time),                        // 成交时间
    (kungfu::array<char, DATE_LEN>, trading_day), // 针对模拟盘交易日与实际时间不对应

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (kungfu::array<char, CONTRACT_ID_LEN>, contract_id),     // 两融合约唯一标识

    (bool, is_last),                     // 是否为本次查询的最后一条记录
    (enums::HistoryDataType, data_type), // 标记本数据是正常数据, 本页最后一条数据, 全部数据的最后一条
    (bool, is_withdraw),                 // 是否是撤单流水

    (enums::InstrumentType, instrument_type), // 合约类型

    (enums::Side, side),            // 买卖方向
    (enums::Offset, offset),        // 开平方向
    (enums::HedgeFlag, hedge_flag), // 投机套保标识

    (double, price),              // 成交价格
    (double, volume),             // 成交量
    (double, close_today_volume), // 平今日仓量(期货)

    (double, tax),                                  // 税
    (double, commission),                           // 手续费
    (int32_t, error_id),                            // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg) // 错误信息
);

KF_DEFINE_PACK_TYPE(                                                         //
    RequestHistoryOrderError, 305, PK(trigger_time), TIMESTAMP(insert_time), //
    (int32_t, error_id),                                                     // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg),                         // 错误信息
    (int64_t, trigger_time)                                                  // 写入时间
);

KF_DEFINE_PACK_TYPE(                                                         //
    RequestHistoryTradeError, 306, PK(trigger_time), TIMESTAMP(insert_time), //
    (int32_t, error_id),                                                     // 错误ID
    (kungfu::array<char, ERROR_MSG_LEN>, error_msg),                         // 错误信息
    (int64_t, trigger_time)                                                  // 写入时间
);

KF_DEFINE_PACK_TYPE(                                         //
    Quote, 401, PK(instrument_id, exchange_id), PERPETUAL(), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID

    (enums::InstrumentType, instrument_type), // 合约类型

    (double, pre_close_price),      // 昨收价
    (double, pre_settlement_price), // 昨日期权/期货结算结价

    (double, last_price), // 最新价
    (double, volume),     // 数量
    (double, turnover),   // 成交金额

    (double, pre_open_interest), // 昨持仓量
    (double, open_interest),     // 持仓量

    (double, open_price), // 今开盘
    (double, high_price), // 最高价
    (double, low_price),  // 最低价

    (double, upper_limit_price), // 涨停板价
    (double, lower_limit_price), // 跌停板价

    (double, close_price),      // 收盘价
    (double, settlement_price), // 期权/期货结算价
    (double, iopv),             // 基金实时参考净值

    (double, total_bid_volume), // 总委托买入量
    (double, total_ask_volume), // 总委托卖出量
    (int64_t, total_trade_num), // 总成交笔数

    (kungfu::array<double, 10>, bid_price),  // 申买价
    (kungfu::array<double, 10>, ask_price),  // 申卖价
    (kungfu::array<double, 10>, bid_volume), // 申买量
    (kungfu::array<double, 10>, ask_volume), // 申卖量
    (kungfu::array<char, TRAIDNG_PHASE_CODE_LEN>, trading_phase_code)
    // 标的状态, 上交所用四位, 深交所用两位
    //************************************上海现货行情交易状态***************************************************************
    // 该字段为8位字符数组,左起每位表示特定的含义,无定义则填空格。
    // 第0位:‘S’表示启动(开市前)时段,‘C’表示集合竞价时段,‘T’表示连续交易时段,
    // ‘E’表示闭市时段 ,‘P’表示临时停牌,
    // ‘M’表示可恢复交易的熔断(盘中集合竞价),‘N’表示不可恢复交易的熔断(暂停交易至闭市)
    // ‘U’表示收盘集合竞价
    // 第1位:‘0’表示此产品不可正常交易,‘1’表示此产品可正常交易。
    // 第2位:‘0’表示未上市,‘1’表示已上市
    // 第3位:‘0’表示此产品在当前时段不接受进行新订单申报,‘1’ 表示此产品在当前时段可接受进行新订单申报。

    //************************************深圳现货行情交易状态***************************************************************
    // 第 0位:‘S’= 启动(开市前)‘O’= 开盘集合竞价‘T’= 连续竞价‘B’= 休市‘C’= 收盘集合竞价‘E’= 已闭市‘H’= 临时停牌‘A’=
    // 盘后交易‘V’=波动性中断 第 1位:‘0’= 正常状态 ‘1’= 全天停牌
);

KF_DEFINE_PACK_TYPE(                                                    //
    Entrust, 402, PK(instrument_id, exchange_id), TIMESTAMP(data_time), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (enums::InstrumentType, instrument_type), // 合约类型

    (double, price),                // 委托价格
    (double, volume),               // 委托量
    (enums::Side, side),            // 委托方向
    (enums::PriceType, price_type), // 订单价格类型（市价、限价、本方最优）

    (int64_t, main_seq),      // 主序号,
    (int64_t, seq),           // 子序号,
    (int64_t, orig_order_no), // 原始订单号 上海为原始订单号, 深圳为索引号
    (int64_t, biz_index)      // 业务序号
);

KF_DEFINE_PACK_TYPE(                                                        //
    Transaction, 403, PK(instrument_id, exchange_id), TIMESTAMP(data_time), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (enums::InstrumentType, instrument_type), // 合约类型

    (double, price),  // 成交价
    (double, volume), // 成交量

    (int64_t, bid_no), // 买方订单号
    (int64_t, ask_no), // 卖方订单号

    (enums::ExecType, exec_type), // SZ: 成交标识
    (enums::Side, side),          // 买卖方向

    (int64_t, main_seq), // 主序号
    (int64_t, seq),      // 子序号
    (int64_t, biz_index) // 业务序号
);

KF_DEFINE_PACK_TYPE(                                        //
    Tree, 404, PK(instrument_id, exchange_id), PERPETUAL(), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (enums::InstrumentType, instrument_type), // 合约类型

    (int64_t, trade_num), // 总成交笔数
    (double, volume),     // 总成交量
    (double, turnover),   // 总成交金额

    (double, bid_weighted_avg_price), // 加权平均委托买入价格
    (double, total_bid_volume),       // 委托买入数量
    (double, ask_weighted_avg_price), // 加权平均委托卖出价格
    (double, total_ask_volume),       // 委托卖出数量

    (double, pre_close_price), // 昨收价

    (double, last_price), // 最新价
    (double, open_price), // 今开盘
    (double, high_price), // 最高价
    (double, low_price),  // 最低价

    (double, upper_limit_price), // 涨停板价
    (double, lower_limit_price), // 跌停板价

    (double, close_price), // 收盘价

    (int32_t, bid_depth), // 申买档位数
    (int32_t, ask_depth), // 申卖档位数

    (kungfu::array<double, 10>, bid_price),                           // 申买价
    (kungfu::array<double, 10>, ask_price),                           // 申卖价
    (kungfu::array<double, 10>, bid_volume),                          // 申买量
    (kungfu::array<double, 10>, ask_volume),                          // 申卖量
    (kungfu::array<char, TRAIDNG_PHASE_CODE_LEN>, trading_phase_code) // 标的状态, 上交所用四位, 深交所用两位,同quote

);

KF_DEFINE_PACK_TYPE(                                                  //
    Depth, 405, PK(instrument_id, exchange_id), TIMESTAMP(data_time), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (enums::InstrumentType, instrument_type), // 合约类型
    (double, price),                          // 委托价格
    (double, volume),                         // 委托量
    (enums::Side, side)                       // 买卖方向
);

KF_DEFINE_PACK_TYPE(                                                 //
    Tick, 406, PK(instrument_id, exchange_id), TIMESTAMP(data_time), //

    (int64_t, data_time), // 数据生成时间

    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所代码

    (enums::InstrumentType, instrument_type), // 合约类型
    (double, bid_price),                      // 申买价
    (double, bid_volume),                     // 申卖价
    (double, ask_price),                      // 申买量
    (double, ask_volume)                      // 申卖量
);

KF_DEFINE_PACK_TYPE(                                         //
    InstrumentKey, 501, PK(key), PERPETUAL(),                //
    (uint32_t, key),                                         //
    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // 交易所ID
    (enums::InstrumentType, instrument_type)                 // 合约类型
);

KF_DEFINE_PACK_TYPE(                                               //
    CustomSubscribe, 502, PK(update_time), TIMESTAMP(update_time), //
    (int64_t, update_time),                                        //
    (enums::MarketType, market_type),                              //
    (enums::SubscribeInstrumentType, instrument_type),             //
    (enums::SubscribeDataType, data_type)                          //
);

KF_DEFINE_DATA_TYPE(                                     //
    SyntheticData, 601, PK(key), TIMESTAMP(update_time), //
    (int64_t, update_time),                              //
    (std::string, key),                                  //
    (std::string, tag_a),                                //
    (std::string, tag_b),                                //
    (std::string, tag_c),                                //
    (std::string, value)                                 //
);

KF_DEFINE_DATA_TYPE(                                          //
    OutputKey, 701, PK(location_uid), TIMESTAMP(update_time), //
    (uint64_t, uid64),                                        //
    (uint32_t, location_uid),                                 //
    (enums::category, category),                              //
    (enums::mode, mode),                                      //
    (std::string, group),                                     //
    (std::string, name),                                      //
    (uint32_t, seed)                                          //
);

KF_DEFINE_DATA_TYPE(                                //
    Register, 10101, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                              //
    (uint32_t, location_uid),                       //
    (enums::category, category),                    //
    (enums::mode, mode),                            //
    (std::string, group),                           //
    (std::string, name),                            //
    (uint32_t, seed),                               //
    (int32_t, pid),                                 //
    (int64_t, last_active_time),                    //
    (int64_t, checkin_time)                         //
);

KF_DEFINE_DATA_TYPE(                                  //
    Deregister, 10102, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                                //
    (uint32_t, location_uid),                         //
    (enums::category, category),                      //
    (enums::mode, mode),                              //
    (std::string, group),                             //
    (std::string, name),                              //
    (uint32_t, seed)                                  //
);

KF_DEFINE_DATA_TYPE(                                                     //
    Session, 10103, PK(location_uid, begin_time), TIMESTAMP(begin_time), //
    (uint64_t, uid64),                                                   //
    (uint32_t, location_uid),                                            //
    (enums::category, category),                                         //
    (enums::mode, mode),                                                 //
    (std::string, group),                                                //
    (std::string, name),                                                 //
    (uint32_t, seed),                                                    //
    (int64_t, begin_time),                                               //
    (int64_t, update_time),                                              //
    (int64_t, end_time),                                                 //
    (uint32_t, frame_count),                                             //
    (uint64_t, data_size)                                                //
);

KF_DEFINE_DATA_TYPE(                                                     //
    StrategyStateUpdate, 10104, PK(update_time), TIMESTAMP(update_time), //
    (enums::StrategyState, state),                                       //
    (int64_t, update_time),                                              //
    (std::string, info_a),                                               //
    (std::string, info_b),                                               //
    (std::string, info_c),                                               //
    (std::string, value)                                                 //
);

KF_DEFINE_DATA_TYPE(                                                     //
    OperatorStateUpdate, 10105, PK(update_time), TIMESTAMP(update_time), //
    (enums::OperatorState, state),                                       //
    (int64_t, update_time),                                              //
    (uint32_t, location_uid),                                            //
    (std::string, info_a),                                               //
    (std::string, info_b),                                               //
    (std::string, value)                                                 //
);

KF_DEFINE_PACK_TYPE(                                  //
    BrokerStateUpdate, 10106, PK(state), PERPETUAL(), //
    (uint32_t, location_uid),                         //
    (enums::BrokerState, state)                       //
);

KF_DEFINE_DATA_TYPE(                              //
    Config, 10201, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                            //
    (uint32_t, location_uid),                     //
    (enums::category, category),                  //
    (std::string, group),                         //
    (std::string, name),                          //
    (uint32_t, seed),                             //
    (enums::mode, mode),                          //
    (std::string, value)                          //
);

KF_DEFINE_DATA_TYPE(                                   //
    RiskSetting, 10202, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                                 //
    (uint32_t, location_uid),                          //
    (enums::category, category),                       //
    (std::string, group),                              //
    (std::string, name),                               //
    (uint32_t, seed),                                  //
    (enums::mode, mode),                               //
    (std::string, risk_name),                          //
    (bool, risk_check),                                //
    (enums::SelfDealCheckType, self_deal_check_type),  //
    (std::string, value)                               //
);

KF_DEFINE_PACK_TYPE(                                             //
    Commission, 10203, PK(product_id, exchange_id), PERPETUAL(), //
    (kungfu::array<char, PRODUCT_ID_LEN>, product_id),           // 品种
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),         // 交易所

    (enums::InstrumentType, instrument_type), // 合约类型

    (enums::CommissionRateMode, mode), // 手续费模式(按照交易额或者交易量)

    (double, open_ratio),        // 开仓费率
    (double, close_ratio),       // 平仓费率
    (double, close_today_ratio), // 平今费率

    (double, min_commission) // 最小手续费
);

KF_DEFINE_PACK_TYPE(                                                //
    Instrument, 10204, PK(instrument_id, exchange_id), PERPETUAL(), //
    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id),        // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),            // 交易所ID
    (enums::InstrumentType, instrument_type),                       // 合约类型

    (kungfu::array<int8_t, PRODUCT_ID_LEN>, product_id), // 产品ID (品种)

    (int32_t, contract_multiplier), // 合约乘数
    (double, price_tick),           // 最小变动价位
    (double, quantity_unit),        // 最小数量单位

    (kungfu::array<char, DATE_LEN>, open_date),   // 上市日
    (kungfu::array<char, DATE_LEN>, create_date), // 创建日
    (kungfu::array<char, DATE_LEN>, expire_date), // 到期日

    (int, delivery_year),       // 交割年份
    (int, delivery_month),      // 交割月
    (enums::Currency, currency) // 币种
);

// Location (tag 10205) moved to the schema leaf kungfu/longfist/core.h; it stays
// registered in AllTypes below via TYPE_PAIR(Location) unchanged.

KF_DEFINE_DATA_TYPE(                                         //
    Basket, 10206, PK(id), PERPETUAL(),                      //
    (uint32_t, id),                                          // basket id
    (std::string, name),                                     // basket 名字
    (enums::BasketVolumeType, volume_type),                  // 比例/数量
    (double, total_amount),                                  // 总数量
    (enums::BasketType, basket_type),                        // 类型: Custom 或 ETF
    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id), // ETF基金代码
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),     // ETF基金的市场
    (double, net_unit_value),                                // 最小申赎单位净值
    (double, etf_value),                                     // 基金份额净值
    (double, cash_difference),                               // 现金差额
    (double, max_cash_ratio),                                // 现金替代比例上限
    (double, max_purchase_volume),                           // 申购上限
    (double, max_redemption_volume),                         // 赎回上限
    (double, min_volume),                                    // 最小申赎单位
    (enums::ETFType, etf_type),                              // etf种类
    (enums::ETFStatus, etf_status)                           // etf状态
);

KF_DEFINE_PACK_TYPE(                                                                  //
    BasketInstrument, 10207, PK(basket_uid, instrument_id, exchange_id), PERPETUAL(), //
    (uint32_t, basket_uid),                                                           //
    (kungfu::array<char, INSTRUMENT_ID_LEN>, instrument_id),                          // 合约ID
    (kungfu::array<char, EXCHANGE_ID_LEN>, exchange_id),                              // 交易所ID
    (enums::InstrumentType, instrument_type),                                         // 合约类型
    (enums::Direction, direction),                                                    // 方向
    (double, volume),                                                                 // 数量
    (double, rate),                                                                   // 比例, volume比例
    (enums::CashReplaceFlag, replace_flag),                                           // 是否可以由现金替代
    (double, cash_premium_ratio),                                                     // 现金替代溢价比率
    (double, replace_balance),                                                        // 替代金额
    (bool, keep_single_side),                                                         // 保留单边
    (bool, close_today_first)                                                         // 优先平今
);

KF_DEFINE_PACK_TYPE(                              //
    CacheReset, 10208, PK(msg_type), PERPETUAL(), //
    (int32_t, msg_type)                           //
);

KF_DEFINE_PACK_TYPE(                                    //
    RequestCachedDone, 10209, PK(dest_id), PERPETUAL(), //
    (uint32_t, dest_id)                                 //
);

KF_DEFINE_PACK_TYPE(                                    //
    RequestReadFrom, 10301, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                              //
    (int64_t, from_time),                               //
    (uint64_t, page_size)                               //
);

KF_DEFINE_PACK_TYPE(                                          //
    RequestReadFromPublic, 10302, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                                    //
    (int64_t, from_time),                                     //
    (uint64_t, page_size)                                     //
);

KF_DEFINE_PACK_TYPE(                                        //
    RequestReadFromSync, 10303, PK(source_id), PERPETUAL(), //
    (uint32_t, source_id),                                  //
    (int64_t, from_time),                                   //
    (uint64_t, page_size)                                   //
);

KF_DEFINE_PACK_TYPE(                                 //
    RequestWriteTo, 10304, PK(dest_id), PERPETUAL(), //
    (uint32_t, dest_id),                             //
    (uint64_t, page_size)                            //
);

KF_DEFINE_PACK_TYPE(                                     //
    Channel, 10305, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                               //
    (uint32_t, dest_id)                                  //
);

KF_DEFINE_PACK_TYPE(                                            //
    ChannelRequest, 10306, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                                      //
    (uint32_t, dest_id)                                         //
);

KF_DEFINE_DATA_TYPE(                                          //
    RequestWriteToBand, 10307, PK(location_uid), PERPETUAL(), //
    (uint64_t, uid64),                                        //
    (uint32_t, location_uid),                                 //
    (enums::category, category),                              //
    (enums::mode, mode),                                      //
    (std::string, group),                                     //
    (std::string, name),                                      //
    (uint32_t, seed),                                         //
    (uint64_t, page_size)                                     //
);

KF_DEFINE_PACK_TYPE(                                  //
    Band, 10308, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                            //
    (uint32_t, dest_id)                               //
);

KF_DEFINE_PACK_TYPE(                                                   //
    RequestReadFromOthers, 10309, PK(source_id, dest_id), PERPETUAL(), //
    (uint32_t, source_id),                                             //
    (uint32_t, dest_id),                                               //
    (int64_t, from_time),                                              //
    (uint64_t, page_size)                                              //
);

KF_DEFINE_PACK_TYPE(                         //
    TimeRequest, 10501, PK(id), PERPETUAL(), //
    (int32_t, id),                           //
    (int64_t, base_time),                    //
    (int64_t, duration),                     //
    (int64_t, repeat),                       //
    (uint32_t, location_uid)                 //
);

KF_DEFINE_PACK_TYPE(                                                           //
    TimeReset, 10502, PK(system_clock_count, steady_clock_count), PERPETUAL(), //
    (int64_t, system_clock_count),                                             //
    (int64_t, steady_clock_count)                                              //
);

KF_DEFINE_PACK_TYPE(                               //
    TradingDay, 10503, PK(timestamp), PERPETUAL(), //
    (int64_t, timestamp)                           //
);

KF_DEFINE_DATA_TYPE(                                           //
    TimeValue, 10601, PK(update_time), TIMESTAMP(update_time), //
    (int64_t, update_time),                                    //
    (std::string, tag_a),                                      //
    (std::string, tag_b),                                      //
    (std::string, tag_c),                                      //
    (std::string, value)                                       //
);

KF_DEFINE_DATA_TYPE(                                      //
    TimeKeyValue, 10602, PK(key), TIMESTAMP(update_time), //
    (int64_t, update_time),                               //
    (std::string, key),                                   //
    (std::string, tag_a),                                 //
    (std::string, tag_b),                                 //
    (std::string, tag_c),                                 //
    (std::string, value)                                  //
);

} // namespace kungfu::longfist::types

#endif // KUNGFU_LONGFIST_TYPES_H
