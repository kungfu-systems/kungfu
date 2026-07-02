// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/28.
//

#ifndef KUNGFU_LONGFIST_ENUM_H
#define KUNGFU_LONGFIST_ENUM_H

#include <fmt/ostream.h>
#include <nlohmann/json.hpp>
#include <spdlog/fmt/ostr.h>

// KF_JSON_SERIALIZE_ENUM 宏、format_as、以及核心枚举 FrameDataType / PageStatus
// 均移入 schema 叶子 kungfu/longfist/core.h（供 libyijinjing 单独 include）。
#include <kungfu/longfist/core.h>

namespace kungfu::longfist::enums {

enum class mode : int8_t { LIVE, DATA, REPLAY, BACKTEST };

KF_JSON_SERIALIZE_ENUM(mode, {
                                 {mode::LIVE, "LIVE"},
                                 {mode::DATA, "DATA"},
                                 {mode::REPLAY, "REPLAY"},
                                 {mode::BACKTEST, "BACKTEST"},
                             })

inline std::ostream &operator<<(std::ostream &os, mode t) { return os << int32_t(t); }

inline std::string get_mode_name(mode m) {
  switch (m) {
  case mode::LIVE:
    return "live";
  case mode::DATA:
    return "data";
  case mode::REPLAY:
    return "replay";
  case mode::BACKTEST:
    return "backtest";
  default:
    return "live";
  }
}

inline mode get_mode_by_name(const std::string &name) {
  if (name == "live")
    return mode::LIVE;
  else if (name == "data")
    return mode::DATA;
  else if (name == "replay")
    return mode::REPLAY;
  else if (name == "backtest")
    return mode::BACKTEST;

  return mode::LIVE;
}

enum class category : int8_t { MD, TD, STRATEGY, SYSTEM, OPERATOR };

KF_JSON_SERIALIZE_ENUM(category, {
                                     {category::MD, "MD"},
                                     {category::TD, "TD"},
                                     {category::STRATEGY, "STRATEGY"},
                                     {category::SYSTEM, "SYSTEM"},
                                     {category::OPERATOR, "OPERATOR"},
                                 })

inline std::ostream &operator<<(std::ostream &os, category t) { return os << int32_t(t); }

inline std::string get_category_name(category c) {
  switch (c) {
  case category::MD:
    return "md";
  case category::TD:
    return "td";
  case category::STRATEGY:
    return "strategy";
  case category::OPERATOR:
    return "operator";
  case category::SYSTEM:
  default:
    return "system";
  }
}

inline category get_category_by_name(const std::string &name) {
  if (name == "md")
    return category::MD;
  else if (name == "td")
    return category::TD;
  else if (name == "strategy")
    return category::STRATEGY;
  else if (name == "operator")
    return category::OPERATOR;
  else
    return category::SYSTEM;
}

enum class layout : int8_t { JOURNAL, SQLITE, NANOMSG, LOG, MAP };

KF_JSON_SERIALIZE_ENUM(layout, {
                                   {layout::JOURNAL, "JOURNAL"},
                                   {layout::SQLITE, "SQLITE"},
                                   {layout::NANOMSG, "NANOMSG"},
                                   {layout::LOG, "LOG"},
                                   {layout::MAP, "MAP"},
                               })

inline std::string get_layout_name(layout l) {
  switch (l) {
  case layout::JOURNAL:
    return "journal";
  case layout::SQLITE:
    return "db";
  case layout::NANOMSG:
    return "nn";
  case layout::MAP:
    return "map";
  case layout::LOG:
  default:
    return "log";
  }
}

// 权限订阅数据类型
enum class MarketType : int8_t {
  All,   ///< 表示全市场
  BSE,   ///< 北交所
  SHFE,  ///< 上期所
  CFFEX, ///< 中金所
  DCE,   ///< 大商所
  CZCE,  ///< 郑商所
  INE,   ///< 上期能源
  SSE,   ///< 上交所
  SZE    ///< 深交所
};

KF_JSON_SERIALIZE_ENUM(MarketType, {
                                       {MarketType::All, "All"},
                                       {MarketType::BSE, "BSE"},
                                       {MarketType::SHFE, "SHFE"},
                                       {MarketType::CFFEX, "CFFEX"},
                                       {MarketType::DCE, "DCE"},
                                       {MarketType::CZCE, "CZCE"},
                                       {MarketType::INE, "INE"},
                                       {MarketType::SSE, "SSE"},
                                       {MarketType::SZE, "SZE"},
                                   })

// 证券数据类型
enum class SubscribeDataType : uint64_t {
  All = 0x000000000000,         ///< 订阅全部证券数据类别
  Snapshot = 0x000000000001,    ///< 订阅快照数据类别
  Entrust = 0x000000000002,     ///< 订阅逐笔委托数据
  Transaction = 0x000000000004, ///< 订阅逐笔成交数据
  Tree = 0x000000000008,        ///< 建树行情, 目前只有盛立有
  Tick = 0x000000000016,        ///< 盘口数据 海外交易所
  Depth = 0x000000000032,       ///< 深度增量 海外交易所
};

KF_JSON_SERIALIZE_ENUM(SubscribeDataType, {
                                              {SubscribeDataType::All, "All"},
                                              {SubscribeDataType::Snapshot, "Snapshot"},
                                              {SubscribeDataType::Entrust, "Entrust"},
                                              {SubscribeDataType::Transaction, "Transaction"},
                                              {SubscribeDataType::Tree, "Tree"},
                                              {SubscribeDataType::Depth, "Depth"},
                                              {SubscribeDataType::Tick, "Tick"},
                                          })

// for subscribe
enum class SubscribeInstrumentType : uint64_t {
  All = 0x000000000000,         ///< 订阅全部证券品种类别
  Stock = 0x000000000001,       ///< 订阅股票证券品种类别
  Future = 0x000000000002,      ///< 订阅期货证券品种类别
  Bond = 0x000000000004,        ///< 订阅债券证券品种类别
  StockOption = 0x00000000008,  ///< 订阅期权证券品种类别
  FutureOption = 0x00000000010, ///< 订阅期货期权品种类别
  Fund = 0x0000000000020,       ///< 订阅基金证券品种类别
  Index = 0x000000000040,       ///< 订阅指数证券品种类别
  HKT = 0x000000000080,         ///< 订阅港股通证券品种类别

  /// SubscribeInstrumentType(All | Stock), 虽然没有定义值为3的枚举值, 这个操作不会报错, 会得到一个值为3的枚举值
};

KF_JSON_SERIALIZE_ENUM(SubscribeInstrumentType, {
                                                    {SubscribeInstrumentType::All, "All"},
                                                    {SubscribeInstrumentType::Stock, "Stock"},
                                                    {SubscribeInstrumentType::Future, "Future"},
                                                    {SubscribeInstrumentType::Bond, "Bond"},
                                                    {SubscribeInstrumentType::StockOption, "StockOption"},
                                                    {SubscribeInstrumentType::FutureOption, "FutureOption"},
                                                    {SubscribeInstrumentType::Fund, "Fund"},
                                                    {SubscribeInstrumentType::Index, "Index"},
                                                    {SubscribeInstrumentType::HKT, "HKT"},
                                                })

// for trading, different type has different minimum volume, price, accounting rules for making order
enum class InstrumentType : int8_t {
  Unknown,       // 未知
  Stock,         // 股票
  StockOption,   // 股票期权
  TechStock,     // 科技股
  Future,        // 期货
  Bond,          // 债券
  Fund,          // 基金
  Index,         // 指数
  Repo,          // 回购
  Crypto,        // 数字货币
  CryptoFuture,  // 数字货币期货币本位
  CryptoUFuture, // 数字货币期货U本位
};

KF_JSON_SERIALIZE_ENUM(InstrumentType, {
                                           {InstrumentType::Unknown, "Unknown"},
                                           {InstrumentType::Stock, "Stock"},
                                           {InstrumentType::StockOption, "StockOption"},
                                           {InstrumentType::TechStock, "TechStock"},
                                           {InstrumentType::Future, "Future"},
                                           {InstrumentType::Bond, "Bond"},
                                           {InstrumentType::Fund, "Fund"},
                                           {InstrumentType::Index, "Index"},
                                           {InstrumentType::Repo, "Repo"},
                                           {InstrumentType::Crypto, "Crypto"},
                                           {InstrumentType::CryptoFuture, "CryptoFuture"},
                                           {InstrumentType::CryptoUFuture, "CryptoUFuture"},
                                       })

inline std::ostream &operator<<(std::ostream &os, InstrumentType t) { return os << int32_t(t); }

enum class ExecType : int8_t { Unknown, Cancel, Trade };

KF_JSON_SERIALIZE_ENUM(ExecType, {
                                     {ExecType::Unknown, "Unknown"},
                                     {ExecType::Cancel, "Cancel"},
                                     {ExecType::Trade, "Trade"},
                                 })

inline std::ostream &operator<<(std::ostream &os, ExecType t) { return os << int32_t(t); }

enum class BsFlag : int8_t { Unknown, Buy, Sell };

KF_JSON_SERIALIZE_ENUM(BsFlag, {
                                   {BsFlag::Unknown, "Unknown"},
                                   {BsFlag::Buy, "Buy"},
                                   {BsFlag::Sell, "Sell"},
                               })

inline std::ostream &operator<<(std::ostream &os, BsFlag t) { return os << int32_t(t); }

enum class Side : int8_t {
  Buy,                       // 买入
  Sell,                      // 卖出
  Lock,                      // 锁仓
  Unlock,                    // 解锁
  Exec,                      // 行权
  Drop,                      // 放弃行权
  Purchase,                  // 申购
  Redemption,                // 赎回
  Split,                     // 拆分
  Merge,                     // 合并
  MarginTrade,               // 融资买入
  ShortSell,                 // 融券卖出
  RepayMargin,               // 卖券还款
  RepayStock,                // 买券还券
  CashRepayMargin,           // 现金还款
  StockRepayStock,           // 现券还券
  SurplusStockTransfer,      // 余券划转
  GuaranteeStockTransferIn,  // 担保品转入
  GuaranteeStockTransferOut, // 担保品转出
  GuaranteeStockBuy,         // 担保品买入
  GuaranteeStockSell,        // 担保品卖出
  Unknown = 99
};

KF_JSON_SERIALIZE_ENUM(Side, {
                                 {Side::Buy, "Buy"},
                                 {Side::Sell, "Sell"},
                                 {Side::Lock, "Lock"},
                                 {Side::Unlock, "Unlock"},
                                 {Side::Exec, "Exec"},
                                 {Side::Drop, "Drop"},
                                 {Side::Purchase, "Purchase"},
                                 {Side::Redemption, "Redemption"},
                                 {Side::Split, "Split"},
                                 {Side::Merge, "Merge"},
                                 {Side::MarginTrade, "MarginTrade"},
                                 {Side::ShortSell, "ShortSell"},
                                 {Side::RepayMargin, "RepayMargin"},
                                 {Side::RepayStock, "RepayStock"},
                                 {Side::CashRepayMargin, "CashRepayMargin"},
                                 {Side::StockRepayStock, "StockRepayStock"},
                                 {Side::SurplusStockTransfer, "SurplusStockTransfer"},
                                 {Side::GuaranteeStockTransferIn, "GuaranteeStockTransferIn"},
                                 {Side::GuaranteeStockTransferOut, "GuaranteeStockTransferOut"},
                                 {Side::GuaranteeStockTransferIn, "GuaranteeStockBuy"},
                                 {Side::GuaranteeStockTransferOut, "GuaranteeStockSell"},
                                 {Side::Unknown, "Unknown"},
                             })

inline std::ostream &operator<<(std::ostream &os, Side t) { return os << int32_t(t); }

enum class Offset : int8_t { Open, Close, CloseToday, CloseYesterday };

KF_JSON_SERIALIZE_ENUM(Offset, {
                                   {Offset::Open, "Open"},
                                   {Offset::Close, "Close"},
                                   {Offset::CloseToday, "CloseToday"},
                                   {Offset::CloseYesterday, "CloseYesterday"},
                               })

inline std::ostream &operator<<(std::ostream &os, Offset t) { return os << int32_t(t); }

enum class HedgeFlag : int8_t { Speculation, Arbitrage, Hedge, Covered };

KF_JSON_SERIALIZE_ENUM(HedgeFlag, {
                                      {HedgeFlag::Speculation, "Speculation"},
                                      {HedgeFlag::Arbitrage, "Arbitrage"},
                                      {HedgeFlag::Hedge, "Hedge"},
                                      {HedgeFlag::Covered, "Covered"},
                                  })

inline std::ostream &operator<<(std::ostream &os, HedgeFlag t) { return os << int32_t(t); }

enum class OrderActionFlag : int8_t {
  Cancel,        /// 普通撤单
  TriggerCancel, /// 预埋撤单
};

KF_JSON_SERIALIZE_ENUM(OrderActionFlag, {
                                            {OrderActionFlag::Cancel, "Cancel"},
                                            {OrderActionFlag::TriggerCancel, "TriggerCancel"},
                                        })

inline std::ostream &operator<<(std::ostream &os, OrderActionFlag t) { return os << int32_t(t); }

enum class ContractType : int8_t {
  CrdBuyContract,            /// 融资合约
  CrdSellContract,           /// 融券合约
  CrdBuyInterest,            /// 融资利息
  CrdSellFee,                /// 融券费用
  CapitalRightsCompensation, /// 资金权益补偿
  ShareRightsCompensation,   /// 股份权益补偿
  OverdueInterest,           /// 逾期罚息
  BadDebtInterest,           /// 坏账罚息
  CapitalOccupationFee,      /// 资金占用费
  ManagementFee,             /// 管理费
};

KF_JSON_SERIALIZE_ENUM(ContractType, {
                                         {ContractType::CrdBuyContract, "CrdBuyContract"},
                                         {ContractType::CrdSellContract, "CrdSellContract"},
                                         {ContractType::CrdBuyInterest, "CrdBuyInterest"},
                                         {ContractType::CrdSellFee, "CrdSellFee"},
                                         {ContractType::CapitalRightsCompensation, "CapitalRightsCompensation"},
                                         {ContractType::ShareRightsCompensation, "ShareRightsCompensation"},
                                         {ContractType::OverdueInterest, "OverdueInterest"},
                                         {ContractType::BadDebtInterest, "BadDebtInterest"},
                                         {ContractType::CapitalOccupationFee, "CapitalOccupationFee"},
                                         {ContractType::ManagementFee, "ManagementFee"},
                                     })

inline std::ostream &operator<<(std::ostream &os, ContractType t) { return os << int32_t(t); }

enum class CloseOutFlag : int8_t {
  NotCloseOut,     /// 未了结
  CloseOut,        /// 了结
  InitNotCloseOut, /// 初始未了结
};

KF_JSON_SERIALIZE_ENUM(CloseOutFlag, {
                                         {CloseOutFlag::NotCloseOut, "NotCloseOut"},
                                         {CloseOutFlag::CloseOut, "CloseOut"},
                                         {CloseOutFlag::InitNotCloseOut, "InitNotCloseOut"},
                                     })

inline std::ostream &operator<<(std::ostream &os, CloseOutFlag t) { return os << int32_t(t); }

enum class OrderTriggerFlag : int8_t {
  TriggerInsert, /// 预埋下单
  TriggerCancel  /// 预埋撤单
};

KF_JSON_SERIALIZE_ENUM(OrderTriggerFlag, {
                                             {OrderTriggerFlag::TriggerInsert, "TriggerInsert"},
                                             {OrderTriggerFlag::TriggerCancel, "TriggerCancel"},
                                         })

inline std::ostream &operator<<(std::ostream &os, OrderTriggerFlag t) { return os << int32_t(t); }

enum class AlgoOrderActionFlag : int8_t {
  Cancel, /// 普通撤单
  Start,  /// 启动
  Stop,   /// 停止
};

KF_JSON_SERIALIZE_ENUM(AlgoOrderActionFlag, {
                                                {AlgoOrderActionFlag::Cancel, "Cancel"},
                                                {AlgoOrderActionFlag::Start, "Start"},
                                                {AlgoOrderActionFlag::Stop, "Stop"},
                                            })

inline std::ostream &operator<<(std::ostream &os, AlgoOrderActionFlag t) { return os << int32_t(t); }

enum class PriceType : int8_t {
  Limit, // 限价,证券通用
  Any, // 市价，证券通用，对于股票上海为最优五档剩余撤销，深圳为即时成交剩余撤销，建议客户采用
  FakBest5,       // 上海深圳最优五档即时成交剩余撤销，不需要报价
  ForwardBest,    // 深圳本方方最优价格申报, 不需要报价
  ReverseBest,    // 上海最优五档即时成交剩余转限价, 深圳对手方最优价格申报，不需要报价
  Fak,            // 深圳即时成交剩余撤销，不需要报价
  Fok,            // 深圳市价全额成交或者撤销，不需要报价
  EnhancedLimit,  // 增强限价盘-港股
  AtAuctionLimit, // 竞价限价盘-港股
  AtAuction,      // 竞价盘-港股| 期货(竞价盘的价格就是开市价格)
  Unknown
};

KF_JSON_SERIALIZE_ENUM(PriceType, {
                                      {PriceType::Limit, "Limit"},
                                      {PriceType::Any, "Any"},
                                      {PriceType::FakBest5, "FakBest5"},
                                      {PriceType::ForwardBest, "ForwardBest"},
                                      {PriceType::ReverseBest, "ReverseBest"},
                                      {PriceType::Fak, "Fak"},
                                      {PriceType::Fok, "Fok"},
                                      {PriceType::EnhancedLimit, "EnhancedLimit"},
                                      {PriceType::AtAuctionLimit, "AtAuctionLimit"},
                                      {PriceType::AtAuction, "AtAuction"},
                                      {PriceType::Unknown, "Unknown"},
                                  })

inline std::ostream &operator<<(std::ostream &os, PriceType t) { return os << int32_t(t); }

// ETF成分股信息,标志改成分股是否可以由现金替代
enum class CashReplaceFlag : int8_t {
  UnReplace,           // 不可替代
  EnReplace,           // 可以替代
  MustReplace,         // 必须替代
  UnSSEReplace,        // 非沪市退补现金替代
  UnSSEMustReplace,    // 非沪市必须现金替代
  UnSSESZEReplace,     // 非沪深退补现金替代
  UnSSESZEMustReplace, // 非沪深必须现金替代
  UnHKReplace,         // 港市退补现金替代
  UnHKMustReplace,     // 港市必须现金替代
  Unknown
};

KF_JSON_SERIALIZE_ENUM(CashReplaceFlag, {
                                            {CashReplaceFlag::UnReplace, "UnReplace"},
                                            {CashReplaceFlag::EnReplace, "EnReplace"},
                                            {CashReplaceFlag::MustReplace, "MustReplace"},
                                            {CashReplaceFlag::UnSSEReplace, "UnSSEReplace"},
                                            {CashReplaceFlag::UnSSEMustReplace, "UnSSEMustReplace"},
                                            {CashReplaceFlag::UnSSESZEReplace, "UnSSESZEReplace"},
                                            {CashReplaceFlag::UnSSESZEMustReplace, "UnSSESZEMustReplace"},
                                            {CashReplaceFlag::UnHKReplace, "UnHKReplace"},
                                            {CashReplaceFlag::UnHKMustReplace, "UnHKMustReplace"},
                                            {CashReplaceFlag::Unknown, "Unknown"},
                                        })

inline std::ostream &operator<<(std::ostream &os, CashReplaceFlag t) { return os << int32_t(t); }

enum class ETFType : int8_t {
  LocalETF,        // 本市ETF
  CrossCountryETF, // 跨境ETF
  CrossMarketETF,  // 跨市ETF
  CurrencyETF,     // 货币ETF
  PhysicalBondETF, // 实物债券ETF
  CommodityETF,    // 商品ETF
  CashBondETF,     // 现金债券ETF
  Unknown
};

KF_JSON_SERIALIZE_ENUM(ETFType, {
                                    {ETFType::LocalETF, "LocalETF"},
                                    {ETFType::CrossCountryETF, "CrossCountryETF"},
                                    {ETFType::CrossMarketETF, "CrossMarketETF"},
                                    {ETFType::CurrencyETF, "CurrencyETF"},
                                    {ETFType::PhysicalBondETF, "PhysicalBondETF"},
                                    {ETFType::CommodityETF, "CommodityETF"},
                                    {ETFType::CashBondETF, "CashBondETF"},
                                    {ETFType::Unknown, "Unknown"},
                                })

inline std::ostream &operator<<(std::ostream &os, ETFType t) { return os << int32_t(t); }

enum class ETFStatus : int8_t {
  Forbid,         // 不允许申购也不允许赎回
  Allow,          // 允许申购和赎回
  PurchaseOnly,   // 只允许申购
  RedemptionOnly, // 只允许赎回
  Unknown
};

KF_JSON_SERIALIZE_ENUM(ETFStatus, {
                                      {ETFStatus::Forbid, "Forbid"},
                                      {ETFStatus::Allow, "Allow"},
                                      {ETFStatus::PurchaseOnly, "PurchaseOnly"},
                                      {ETFStatus::RedemptionOnly, "RedemptionOnly"},
                                      {ETFStatus::Unknown, "Unknown"},
                                  })

inline std::ostream &operator<<(std::ostream &os, ETFStatus t) { return os << int32_t(t); }

enum class PriceLevel : int8_t {
  Last, // 最新价
  Opposing5,
  Opposing4,
  Opposing3,
  Opposing2,
  Opposing1,
  Own1,
  Own2,
  Own3,
  Own4,
  Own5,
  UpperLimitPrice, // 涨停价
  LowerLimitPrice, // 跌停价
  Unknown
};

KF_JSON_SERIALIZE_ENUM(PriceLevel, {
                                       {PriceLevel::Last, "Last"},
                                       {PriceLevel::Opposing5, "Opposing5"},
                                       {PriceLevel::Opposing4, "Opposing4"},
                                       {PriceLevel::Opposing3, "Opposing3"},
                                       {PriceLevel::Opposing2, "Opposing2"},
                                       {PriceLevel::Opposing1, "Opposing1"},
                                       {PriceLevel::Own1, "Own1"},
                                       {PriceLevel::Own2, "Own2"},
                                       {PriceLevel::Own3, "Own3"},
                                       {PriceLevel::Own4, "Own4"},
                                       {PriceLevel::Own5, "Own5"},
                                       {PriceLevel::UpperLimitPrice, "UpperLimitPrice"},
                                       {PriceLevel::LowerLimitPrice, "LowerLimitPrice"},
                                       {PriceLevel::Unknown, "Unknown"},
                                   })

inline std::ostream &operator<<(std::ostream &os, PriceLevel t) { return os << int32_t(t); }

enum class VolumeCondition : int8_t { Any, Min, All };

KF_JSON_SERIALIZE_ENUM(VolumeCondition, {
                                            {VolumeCondition::Any, "Any"},
                                            {VolumeCondition::Min, "Min"},
                                            {VolumeCondition::All, "All"},
                                        })

inline std::ostream &operator<<(std::ostream &os, VolumeCondition t) { return os << int32_t(t); }

enum class TimeCondition : int8_t { ///
  IOC,                              /// 立即完成，否则撤销
  GFD,                              /// 当日有效
  GTC,                              /// 撤销前有效
  GFS,                              /// 本节有效
  GTD,                              /// 指定日期前有效
  GFA,                              /// 集合竞价有效
  Unknown
};

KF_JSON_SERIALIZE_ENUM(TimeCondition, {
                                          {TimeCondition::IOC, "IOC"},
                                          {TimeCondition::GFD, "GFD"},
                                          {TimeCondition::GTC, "GTC"},
                                          {TimeCondition::GFS, "GFS"},
                                          {TimeCondition::GTD, "GTD"},
                                          {TimeCondition::GFA, "GFA"},
                                      })

inline std::ostream &operator<<(std::ostream &os, TimeCondition t) { return os << int32_t(t); }

enum class OrderStatus : int8_t {
  Unknown,
  Submitted,              // 已提交
  Pending,                // 等待中
  Cancelled,              // 已撤单
  Error,                  // 错误
  Filled,                 // 已成交
  PartialFilledNotActive, // 部成部撤
  PartialFilledActive,    // 部成交易中
  Lost,                   // 丢失
  Cancelling,             // 待撤
  Pause,                  // 暂停
  PendingSettlement       // 等待结算
};

static std::vector<int8_t> CONTINUING_STATUS = {
    (int8_t)OrderStatus::Submitted,           //
    (int8_t)OrderStatus::Pending,             //
    (int8_t)OrderStatus::PartialFilledActive, //
    (int8_t)OrderStatus::Unknown,             //
    (int8_t)OrderStatus::Cancelling,          //
    (int8_t)OrderStatus::Pause,               //
    (int8_t)OrderStatus::PendingSettlement,   //
};

KF_JSON_SERIALIZE_ENUM(OrderStatus, {
                                        {OrderStatus::Unknown, "Unknown"},
                                        {OrderStatus::Submitted, "Submitted"},
                                        {OrderStatus::Pending, "Pending"},
                                        {OrderStatus::Cancelled, "Cancelled"},
                                        {OrderStatus::Error, "Error"},
                                        {OrderStatus::Filled, "Filled"},
                                        {OrderStatus::PartialFilledNotActive, "PartialFilledNotActive"},
                                        {OrderStatus::PartialFilledActive, "PartialFilledActive"},
                                        {OrderStatus::Lost, "Lost"},
                                        {OrderStatus::Cancelling, "Cancelling"},
                                        {OrderStatus::Pause, "Pause"},
                                        {OrderStatus::PendingSettlement, "PendingSettlement"},
                                    })

inline std::ostream &operator<<(std::ostream &os, OrderStatus t) { return os << int32_t(t); }

// 币种枚举
enum class Currency : int8_t { Unknown = 0, CNY, HKD, USD, JPY, GBP, EUR, CNH, SGD, MYR, CEN };

KF_JSON_SERIALIZE_ENUM(Currency, {
                                     {Currency::Unknown, "Unknown"},
                                     {Currency::CNY, "CNY"},
                                     {Currency::HKD, "HKD"},
                                     {Currency::USD, "USD"},
                                     {Currency::JPY, "JPY"},
                                     {Currency::GBP, "GBP"},
                                     {Currency::EUR, "EUR"},
                                     {Currency::CNH, "CNH"},
                                     {Currency::SGD, "SGD"},
                                     {Currency::MYR, "MYR"},
                                     {Currency::CEN, "CEN"},
                                 })

inline std::ostream &operator<<(std::ostream &os, Currency t) { return os << int32_t(t); }

enum class BasketVolumeType : int8_t { Unknown, Quantity, Proportion };

KF_JSON_SERIALIZE_ENUM(BasketVolumeType, {
                                             {BasketVolumeType::Unknown, "Unknown"},
                                             {BasketVolumeType::Quantity, "Quantity"},
                                             {BasketVolumeType::Proportion, "Proportion"},
                                         })

inline std::ostream &operator<<(std::ostream &os, BasketVolumeType t) { return os << int32_t(t); }

enum class BasketType : int8_t { Custom, ETF };

KF_JSON_SERIALIZE_ENUM(BasketType, {
                                       {BasketType::Custom, "Custom"},
                                       {BasketType::ETF, "ETF"},
                                   })

inline std::ostream &operator<<(std::ostream &os, BasketType t) { return os << int32_t(t); }

enum class Direction : int8_t { Long, Short };

KF_JSON_SERIALIZE_ENUM(Direction, {
                                      {Direction::Long, "Long"},
                                      {Direction::Short, "Short"},
                                  })

inline std::ostream &operator<<(std::ostream &os, Direction t) { return os << int32_t(t); }

enum class AccountType : int8_t { Stock, Credit, Future };

KF_JSON_SERIALIZE_ENUM(AccountType, {
                                        {AccountType::Stock, "Stock"},
                                        {AccountType::Credit, "Credit"},
                                        {AccountType::Future, "Future"},
                                    })

inline std::ostream &operator<<(std::ostream &os, AccountType t) { return os << int32_t(t); }

enum class CommissionRateMode : int8_t { ByAmount, ByVolume };

KF_JSON_SERIALIZE_ENUM(CommissionRateMode, {
                                               {CommissionRateMode::ByAmount, "ByAmount"},
                                               {CommissionRateMode::ByVolume, "ByVolume"},
                                           })

inline std::ostream &operator<<(std::ostream &os, CommissionRateMode t) { return os << int32_t(t); }

enum class LedgerCategory : int8_t {
  Account,
  Strategy,
};

KF_JSON_SERIALIZE_ENUM(LedgerCategory, {
                                           {LedgerCategory::Account, "Account"},
                                           {LedgerCategory::Strategy, "Strategy"},
                                       })

inline std::ostream &operator<<(std::ostream &os, LedgerCategory t) { return os << int32_t(t); }

enum class BrokerState : int8_t {
  Pending = 0,
  Idle = 1,
  DisConnected = 2,
  Connected = 3,
  LoggedIn = 4,
  LoginFailed = 5,
  Ready = 100
};

inline std::ostream &operator<<(std::ostream &os, BrokerState t) { return os << int32_t(t); }

KF_JSON_SERIALIZE_ENUM(BrokerState, {
                                        {BrokerState::Pending, "Pending"},
                                        {BrokerState::Idle, "Idle"},
                                        {BrokerState::DisConnected, "DisConnected"},
                                        {BrokerState::Connected, "Connected"},
                                        {BrokerState::LoggedIn, "LoggedIn"},
                                        {BrokerState::LoginFailed, "LoginFailed"},
                                        {BrokerState::Ready, "Ready"},
                                    })

enum class HistoryDataType : int8_t { Normal = 0, PageEnd = 1, TotalEnd = 2 };

KF_JSON_SERIALIZE_ENUM(HistoryDataType, {
                                            {HistoryDataType::Normal, "Normal"},
                                            {HistoryDataType::PageEnd, "PageEnd"},
                                            {HistoryDataType::TotalEnd, "TotalEnd"},
                                        })

inline std::ostream &operator<<(std::ostream &os, HistoryDataType t) { return os << int32_t(t); }

enum class StrategyState : int8_t { Normal, Warn, Error };

KF_JSON_SERIALIZE_ENUM(StrategyState, {
                                          {StrategyState::Normal, "Normal"},
                                          {StrategyState::Warn, "Warn"},
                                          {StrategyState::Error, "Error"},
                                      })

inline std::ostream &operator<<(std::ostream &os, StrategyState t) { return os << int32_t(t); }

// enum value has to be same with BrokerState
enum class OperatorState : int8_t { Pending = 0, DisConnected = 2, Connected = 3, Ready = 100 };

KF_JSON_SERIALIZE_ENUM(OperatorState, {
                                          {OperatorState::Pending, "Pending"},
                                          {OperatorState::DisConnected, "DisConnected"},
                                          {OperatorState::Connected, "ErrConnectedor"},
                                          {OperatorState::Ready, "Ready"},
                                      })

inline std::ostream &operator<<(std::ostream &os, OperatorState t) { return os << int32_t(t); }

class AssembleMode {
public:
  inline static const uint32_t Channel = 0b00000001; // read only journal of location to dest_id
  inline static const uint32_t Write = 0b00000010;   // read all journal from this location
  inline static const uint32_t Read = 0b00000100;    // read all journal to this dest_id
  inline static const uint32_t Public = 0b00001000;  // read all journal to location::PUBLIC
  inline static const uint32_t Sync = 0b00010000;    // read all journal to location::PUBLIC
  inline static const uint32_t All = 0b00100000;     // read all journal
};

template <typename T, typename U> inline T sub_data_bitwise(const T &a, const T &b) {
  return static_cast<T>(static_cast<U>(a) | static_cast<U>(b));
}

// PageStatus 已移入 kungfu/longfist/core.h（schema 叶子）。

inline std::ostream &operator<<(std::ostream &os, PageStatus t) { return os << int32_t(t); }

enum class AccountingMethodType : int8_t { Default = 0, OTC = 1 };

KF_JSON_SERIALIZE_ENUM(AccountingMethodType, {
                                                 {AccountingMethodType::Default, "Default"},
                                                 {AccountingMethodType::OTC, "OTC"},
                                             })

inline std::ostream &operator<<(std::ostream &os, AccountingMethodType t) { return os << int32_t(t); }

// FrameDataType 已移入 kungfu/longfist/core.h（schema 叶子）。

enum class OrderTriggerType : int8_t { ///
  Immediately,                         /// 立即
  Touch,                               /// 止损
  TouchProfit,                         /// 止赢
  ParkedOrder,                         /// 预埋单
  LastPriceGreaterThanStopPrice,       /// 最新价大于条件价
  LastPriceGreaterEqualStopPrice,      /// 最新价大于等于条件价
  LastPriceLesserThanStopPrice,        /// 最新价小于条件价
  LastPriceLesserEqualStopPrice,       /// 最新价小于等于条件价
  AskPriceGreaterThanStopPrice,        /// 卖一价大于条件价
  AskPriceGreaterEqualStopPrice,       /// 卖一价大于等于条件价
  AskPriceLesserThanStopPrice,         /// 卖一价小于条件价
  AskPriceLesserEqualStopPrice,        /// 卖一价小于等于条件价
  BidPriceGreaterThanStopPrice,        /// 买一价大于条件价
  BidPriceGreaterEqualStopPrice,       /// 买一价大于等于条件价
  BidPriceLesserThanStopPrice,         /// 买一价小于条件价
  BidPriceLesserEqualStopPrice         /// 买一价小于等于条件价
};

KF_JSON_SERIALIZE_ENUM(OrderTriggerType,
                       {
                           {OrderTriggerType::Immediately, "Immediately"},
                           {OrderTriggerType::Touch, "Touch"},
                           {OrderTriggerType::TouchProfit, "TouchProfit"},
                           {OrderTriggerType::ParkedOrder, "ParkedOrder"},
                           {OrderTriggerType::LastPriceGreaterThanStopPrice, "LastPriceGreaterThanStopPrice"},
                           {OrderTriggerType::LastPriceGreaterEqualStopPrice, "LastPriceGreaterEqualStopPrice"},
                           {OrderTriggerType::LastPriceLesserThanStopPrice, "LastPriceLesserThanStopPrice"},
                           {OrderTriggerType::LastPriceLesserEqualStopPrice, "LastPriceLesserEqualStopPrice"},
                           {OrderTriggerType::AskPriceGreaterThanStopPrice, "AskPriceGreaterThanStopPrice"},
                           {OrderTriggerType::AskPriceGreaterEqualStopPrice, "AskPriceGreaterEqualStopPrice"},
                           {OrderTriggerType::AskPriceLesserThanStopPrice, "AskPriceLesserThanStopPrice"},
                           {OrderTriggerType::AskPriceLesserEqualStopPrice, "AskPriceLesserEqualStopPrice"},
                           {OrderTriggerType::BidPriceGreaterThanStopPrice, "BidPriceGreaterThanStopPrice"},
                           {OrderTriggerType::BidPriceGreaterEqualStopPrice, "BidPriceGreaterEqualStopPrice"},
                           {OrderTriggerType::BidPriceLesserThanStopPrice, "BidPriceLesserThanStopPrice"},
                           {OrderTriggerType::BidPriceLesserEqualStopPrice, "BidPriceLesserEqualStopPrice"},
                       })

inline std::ostream &operator<<(std::ostream &os, OrderTriggerType t) { return os << int32_t(t); }

enum class Priority : int8_t { Low, Medium, High };

KF_JSON_SERIALIZE_ENUM(Priority, {
                                     {Priority::Low, "Low"},
                                     {Priority::Medium, "Medium"},
                                     {Priority::High, "High"},
                                 })

inline std::ostream &operator<<(std::ostream &os, Priority t) { return os << int32_t(t); }

inline bool operator<(Priority l, Priority r) { return int8_t(l) < int8_t(r); }

inline bool operator==(Priority l, Priority r) { return int8_t(l) == int8_t(r); }

enum class SelfDealCheckType : int8_t { No, AccountInternal, AccountInteractive };

KF_JSON_SERIALIZE_ENUM(SelfDealCheckType, {
                                              {SelfDealCheckType::No, "No"},
                                              {SelfDealCheckType::AccountInternal, "AccountInternal"},
                                              {SelfDealCheckType::AccountInteractive, "AccountInteractive"},
                                          })

inline std::ostream &operator<<(std::ostream &os, SelfDealCheckType t) { return os << int8_t(t); }

enum class ResumePolicy : int8_t { Now, Intraday, Stateless, Continuous };

KF_JSON_SERIALIZE_ENUM(ResumePolicy, {
                                         {ResumePolicy::Now, "Now"},
                                         {ResumePolicy::Intraday, "Intraday"},
                                         {ResumePolicy::Stateless, "Stateless"},
                                         {ResumePolicy::Continuous, "Continuous"},
                                     })

inline std::ostream &operator<<(std::ostream &os, ResumePolicy t) { return os << int8_t(t); }

} // namespace kungfu::longfist::enums
#endif // KUNGFU_LONGFIST_ENUM_H
