// SPDX-License-Identifier: Apache-2.0

#include "py-longfist.h"

#include <kungfu/longfist/longfist.h>

using namespace kungfu::longfist::enums;

namespace py = pybind11;

namespace kungfu::longfist::pybind {

void bind_enums(py::module &m) {
  auto m_enums = m.def_submodule("enums");

  py::enum_<mode>(m_enums, "mode", py::arithmetic(), "Kungfu Run Mode")
      .value("LIVE", mode::LIVE)
      .value("DATA", mode::DATA)
      .value("REPLAY", mode::REPLAY)
      .value("BACKTEST", mode::BACKTEST)
      .export_values();
  m_enums.def("get_mode_name", &get_mode_name);
  m_enums.def("get_mode_by_name", &get_mode_by_name);

  py::enum_<location_role>(m_enums, "location_role", py::arithmetic(), "Kungfu Location Role")
      .value("SOURCE", location_role::SOURCE)
      .value("SINK", location_role::SINK)
      .value("ACTOR", location_role::ACTOR)
      .value("SYSTEM", location_role::SYSTEM)
      .value("SERVICE", location_role::SERVICE)
      .export_values();
  m_enums.def("get_location_role_name", &get_location_role_name);
  m_enums.def("get_location_role_by_name", &get_location_role_by_name);

  py::enum_<layout>(m_enums, "layout", py::arithmetic(), "Kungfu Data Layout")
      .value("JOURNAL", layout::JOURNAL)
      .value("SQLITE", layout::SQLITE)
      .value("NANOMSG", layout::NANOMSG)
      .value("LOG", layout::LOG)
      .export_values();
  m_enums.def("get_layout_name", &get_layout_name);

  py::enum_<InstrumentType>(m_enums, "InstrumentType", py::arithmetic())
      .value("Unknown", InstrumentType::Unknown)
      .value("Stock", InstrumentType::Stock)
      .value("Future", InstrumentType::Future)
      .value("Bond", InstrumentType::Bond)
      .value("StockOption", InstrumentType::StockOption)
      .value("TechStock", InstrumentType::TechStock)
      .value("Fund", InstrumentType::Fund)
      .value("Index", InstrumentType::Index)
      .value("Repo", InstrumentType::Repo)
      .value("Crypto", InstrumentType::Crypto)
      .value("CryptoFuture", InstrumentType::CryptoFuture)
      .value("CryptoUFuture", InstrumentType::CryptoUFuture)
      .export_values()
      .def("__eq__", [](const InstrumentType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<AccountType>(m_enums, "AccountType", py::arithmetic())
      .value("Stock", AccountType::Stock)
      .value("Credit", AccountType::Credit)
      .value("Future", AccountType::Future)
      .export_values()
      .def("__eq__", [](const AccountType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<CommissionRateMode>(m_enums, "CommissionRateMode", py::arithmetic())
      .value("ByAmount", CommissionRateMode::ByAmount)
      .value("ByVolume", CommissionRateMode::ByVolume)
      .export_values()
      .def("__eq__", [](const CommissionRateMode &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<ExecType>(m_enums, "ExecType", py::arithmetic())
      .value("Unknown", ExecType::Unknown)
      .value("Cancel", ExecType::Cancel)
      .value("Trade", ExecType::Trade)
      .export_values()
      .def("__eq__", [](const ExecType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Side>(m_enums, "Side", py::arithmetic())
      .value("Buy", Side::Buy)
      .value("Sell", Side::Sell)
      .value("Lock", Side::Lock)
      .value("Unlock", Side::Unlock)
      .value("Exec", Side::Exec)
      .value("Drop", Side::Drop)
      .value("Purchase", Side::Purchase)
      .value("Redemption", Side::Redemption)
      .value("Split", Side::Split)
      .value("Merge", Side::Merge)
      .value("MarginTrade", Side::MarginTrade)
      .value("ShortSell", Side::ShortSell)
      .value("RepayMargin", Side::RepayMargin)
      .value("RepayStock", Side::RepayStock)
      .value("CashRepayMargin", Side::CashRepayMargin)
      .value("StockRepayStock", Side::StockRepayStock)
      .value("SurplusStockTransfer", Side::SurplusStockTransfer)
      .value("GuaranteeStockTransferIn", Side::GuaranteeStockTransferIn)
      .value("GuaranteeStockTransferOut", Side::GuaranteeStockTransferOut)
      .value("GuaranteeStockBuy", Side::GuaranteeStockBuy)
      .value("GuaranteeStockSell", Side::GuaranteeStockSell)
      .value("Unknown", Side::Unknown)
      .export_values()
      .def("__eq__", [](const Side &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Offset>(m_enums, "Offset", py::arithmetic())
      .value("Open", Offset::Open)
      .value("Close", Offset::Close)
      .value("CloseToday", Offset::CloseToday)
      .value("CloseYesterday", Offset::CloseYesterday)
      .export_values()
      .def("__eq__", [](const Offset &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<HedgeFlag>(m_enums, "HedgeFlag", py::arithmetic())
      .value("Speculation", HedgeFlag::Speculation)
      .value("Arbitrage", HedgeFlag::Arbitrage)
      .value("Hedge", HedgeFlag::Hedge)
      .value("Covered", HedgeFlag::Covered)
      .export_values()
      .def("__eq__", [](const HedgeFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<BsFlag>(m_enums, "BsFlag", py::arithmetic())
      .value("Unknown", BsFlag::Unknown)
      .value("Buy", BsFlag::Buy)
      .value("Sell", BsFlag::Sell)
      .export_values()
      .def("__eq__", [](const BsFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<OrderStatus>(m_enums, "OrderStatus", py::arithmetic())
      .value("Unknown", OrderStatus::Unknown)
      .value("Submitted", OrderStatus::Submitted)
      .value("Pending", OrderStatus::Pending)
      .value("Cancelled", OrderStatus::Cancelled)
      .value("Error", OrderStatus::Error)
      .value("Filled", OrderStatus::Filled)
      .value("PartialFilledNotActive", OrderStatus::PartialFilledNotActive)
      .value("PartialFilledActive", OrderStatus::PartialFilledActive)
      .value("Lost", OrderStatus::Lost)
      .value("Cancelling", OrderStatus::Cancelling)
      .value("PendingSettlement", OrderStatus::PendingSettlement)
      .export_values()
      .def("__eq__", [](const OrderStatus &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Direction>(m_enums, "Direction", py::arithmetic())
      .value("Long", Direction::Long)
      .value("Short", Direction::Short)
      .export_values()
      .def("__eq__", [](const Direction &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<PriceType>(m_enums, "PriceType", py::arithmetic())
      .value("Any", PriceType::Any)
      .value("FakBest5", PriceType::FakBest5)
      .value("Fak", PriceType::Fak)
      .value("Fok", PriceType::Fok)
      .value("Limit", PriceType::Limit)
      .value("ForwardBest", PriceType::ForwardBest)
      .value("ReverseBest", PriceType::ReverseBest)
      .value("EnhancedLimit", PriceType::EnhancedLimit)
      .value("AtAuctionLimit", PriceType::AtAuctionLimit)
      .value("AtAuction", PriceType::AtAuction)
      .value("Unknown", PriceType::Unknown)
      .export_values()
      .def("__eq__", [](const PriceType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<PriceLevel>(m_enums, "PriceLevel", py::arithmetic())
      .value("Last", PriceLevel::Last)
      .value("Opposing5", PriceLevel::Opposing5)
      .value("Opposing4", PriceLevel::Opposing4)
      .value("Opposing3", PriceLevel::Opposing3)
      .value("Opposing2", PriceLevel::Opposing2)
      .value("Opposing1", PriceLevel::Opposing1)
      .value("Own1", PriceLevel::Own1)
      .value("Own2", PriceLevel::Own2)
      .value("Own3", PriceLevel::Own3)
      .value("Own4", PriceLevel::Own4)
      .value("Own5", PriceLevel::Own5)
      .value("UpperLimitPrice", PriceLevel::UpperLimitPrice)
      .value("lowerLimitPrice", PriceLevel::LowerLimitPrice)
      .value("Unknown", PriceLevel::Unknown)
      .export_values()
      .def("__eq__", [](const Direction &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<BasketVolumeType>(m_enums, "BasketVolumeType", py::arithmetic())
      .value("Unknown", BasketVolumeType::Unknown)
      .value("Quantity", BasketVolumeType::Quantity)
      .value("Proportion", BasketVolumeType::Proportion)
      .export_values()
      .def("__eq__", [](const BasketVolumeType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<BasketType>(m_enums, "BasketType", py::arithmetic())
      .value("Custom", BasketType::Custom)
      .value("ETF", BasketType::ETF)
      .export_values()
      .def("__eq__", [](const BasketType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<VolumeCondition>(m_enums, "VolumeCondition", py::arithmetic())
      .value("Any", VolumeCondition::Any)
      .value("Min", VolumeCondition::Min)
      .value("All", VolumeCondition::All)
      .export_values()
      .def("__eq__", [](const VolumeCondition &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<TimeCondition>(m_enums, "TimeCondition", py::arithmetic())
      .value("IOC", TimeCondition::IOC)
      .value("GFD", TimeCondition::GFD)
      .value("GTC", TimeCondition::GTC)
      .value("GFS", TimeCondition::GFS)
      .value("GTD", TimeCondition::GTD)
      .value("GFA", TimeCondition::GFA)
      .value("Unknown", TimeCondition::Unknown)
      .export_values()
      .def("__eq__", [](const TimeCondition &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<ContractType>(m_enums, "ContractType", py::arithmetic())
      .value("CrdBuyContract", ContractType::CrdBuyContract)
      .value("CrdSellContract", ContractType::CrdSellContract)
      .value("CrdBuyInterest", ContractType::CrdBuyInterest)
      .value("CrdSellFee", ContractType::CrdSellFee)
      .value("CapitalRightsCompensation", ContractType::CapitalRightsCompensation)
      .value("ShareRightsCompensation", ContractType::ShareRightsCompensation)
      .value("OverdueInterest", ContractType::OverdueInterest)
      .value("BadDebtInterest", ContractType::BadDebtInterest)
      .value("CapitalOccupationFee", ContractType::CapitalOccupationFee)
      .value("ManagementFee", ContractType::ManagementFee)
      .export_values()
      .def("__eq__", [](const ContractType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<CloseOutFlag>(m_enums, "CloseOutFlag", py::arithmetic())
      .value("NotCloseOut", CloseOutFlag::NotCloseOut)
      .value("CloseOut", CloseOutFlag::CloseOut)
      .value("InitNotCloseOut", CloseOutFlag::InitNotCloseOut)
      .export_values()
      .def("__eq__", [](const CloseOutFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<OrderActionFlag>(m_enums, "OrderActionFlag", py::arithmetic())
      .value("Cancel", OrderActionFlag::Cancel)
      .value("TriggerCancel", OrderActionFlag::TriggerCancel)
      .export_values()
      .def("__eq__", [](const OrderActionFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<LedgerCategory>(m_enums, "LedgerCategory", py::arithmetic())
      .value("Account", LedgerCategory::Account)
      .value("Strategy", LedgerCategory::Strategy)
      .export_values()
      .def("__eq__", [](const LedgerCategory &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<BrokerState>(m_enums, "BrokerState", py::arithmetic())
      .value("Pending", BrokerState::Pending)
      .value("Idle", BrokerState::Idle)
      .value("DisConnected", BrokerState::DisConnected)
      .value("Connected", BrokerState::Connected)
      .value("LoggedIn", BrokerState::LoggedIn)
      .value("LoginFailed", BrokerState::LoginFailed)
      .value("Ready", BrokerState::Ready)
      .export_values()
      .def("__eq__", [](const BrokerState &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<OperatorState>(m_enums, "OperatorState", py::arithmetic())
      .value("Pending", OperatorState::Pending)
      .value("DisConnected", OperatorState::DisConnected)
      .value("Connected", OperatorState::Connected)
      .value("Ready", OperatorState::Ready)
      .export_values()
      .def("__eq__", [](const OperatorState &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<HistoryDataType>(m_enums, "HistoryDataType", py::arithmetic())
      .value("Normal", HistoryDataType::Normal)
      .value("PageEnd", HistoryDataType::PageEnd)
      .value("TotalEnd", HistoryDataType::TotalEnd)
      .export_values()
      .def("__eq__", [](const HistoryDataType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<StrategyState>(m_enums, "StrategyState", py::arithmetic())
      .value("Normal", StrategyState::Normal)
      .value("Warn", StrategyState::Warn)
      .value("Error", StrategyState::Error)
      .export_values()
      .def("__eq__", [](const StrategyState &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<MarketType>(m_enums, "MarketType", py::arithmetic())
      .value("All", MarketType::All)
      .value("BSE", MarketType::BSE)
      .value("SHFE", MarketType::SHFE)
      .value("CFFEX", MarketType::CFFEX)
      .value("DCE", MarketType::DCE)
      .value("CZCE", MarketType::CZCE)
      .value("INE", MarketType::INE)
      .value("SSE", MarketType::SSE)
      .value("SZE", MarketType::SZE)
      .export_values()
      .def("__eq__", [](const MarketType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<SubscribeDataType>(m_enums, "SubscribeDataType", py::arithmetic())
      .value("All", SubscribeDataType::All)
      .value("Snapshot", SubscribeDataType::Snapshot)
      .value("Transaction", SubscribeDataType::Transaction)
      .value("Entrust", SubscribeDataType::Entrust)
      .value("Tree", SubscribeDataType::Tree)
      .value("Depth", SubscribeDataType::Depth)
      .value("Tick", SubscribeDataType::Tick)
      .export_values()
      .def("__eq__", [](const SubscribeDataType &a, uint64_t b) { return static_cast<uint64_t>(a) == b; })
      .def("__or__", py::overload_cast<const SubscribeDataType &, const SubscribeDataType &>(
                         &sub_data_bitwise<SubscribeDataType, uint64_t>));

  py::enum_<SubscribeInstrumentType>(m_enums, "SubscribeInstrumentType", py::arithmetic())
      .value("All", SubscribeInstrumentType::All)
      .value("Stock", SubscribeInstrumentType::Stock)
      .value("Future", SubscribeInstrumentType::Future)
      .value("Bond", SubscribeInstrumentType::Bond)
      .value("StockOption", SubscribeInstrumentType::StockOption)
      .value("FutureOption", SubscribeInstrumentType::FutureOption)
      .value("Fund", SubscribeInstrumentType::Fund)
      .value("Index", SubscribeInstrumentType::Index)
      .value("HKT", SubscribeInstrumentType::HKT)
      .export_values()
      .def("__eq__", [](const SubscribeInstrumentType &a, int b) { return static_cast<int>(a) == b; })
      .def("__or__", py::overload_cast<const SubscribeInstrumentType &, const SubscribeInstrumentType &>(
                         &sub_data_bitwise<SubscribeInstrumentType, uint64_t>));

  py::class_<AssembleMode>(m_enums, "AssembleMode")
      .def(py::init<>())
      .def_readonly_static("Channel", &AssembleMode::Channel)
      .def_readonly_static("Write", &AssembleMode::Write)
      .def_readonly_static("Read", &AssembleMode::Read)
      .def_readonly_static("Public", &AssembleMode::Public)
      .def_readonly_static("Sync", &AssembleMode::Sync)
      .def_readonly_static("All", &AssembleMode::All);

  py::enum_<PageStatus>(m_enums, "PageStatus", py::arithmetic())
      .value("Normal", PageStatus::Normal)
      .value("PreOpen", PageStatus::PreOpen)
      .export_values()
      .def("__eq__", [](const PageStatus &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<AccountingMethodType>(m_enums, "AccountingMethodType", py::arithmetic())
      .value("Default", AccountingMethodType::Default)
      .value("OTC", AccountingMethodType::OTC)
      .export_values()
      .def("__eq__", [](const AccountingMethodType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<FrameDataType>(m_enums, "FrameDataType", py::arithmetic())
      .value("Raw", FrameDataType::Raw)
      .value("Json", FrameDataType::Json)
      .value("Unknown", FrameDataType::Unknown)
      .export_values()
      .def("__eq__", [](const FrameDataType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<OrderTriggerType>(m_enums, "OrderTriggerType", py::arithmetic())
      .value("Immediately", OrderTriggerType::Immediately)
      .value("Touch", OrderTriggerType::Touch)
      .value("TouchProfit", OrderTriggerType::TouchProfit)
      .value("ParkedOrder", OrderTriggerType::ParkedOrder)
      .value("LastPriceGreaterThanStopPrice", OrderTriggerType::LastPriceGreaterThanStopPrice)
      .value("LastPriceGreaterEqualStopPrice", OrderTriggerType::LastPriceGreaterEqualStopPrice)
      .value("LastPriceLesserThanStopPrice", OrderTriggerType::LastPriceLesserThanStopPrice)
      .value("LastPriceLesserEqualStopPrice", OrderTriggerType::LastPriceLesserEqualStopPrice)
      .value("AskPriceGreaterThanStopPrice", OrderTriggerType::AskPriceGreaterThanStopPrice)
      .value("AskPriceGreaterEqualStopPrice", OrderTriggerType::AskPriceGreaterEqualStopPrice)
      .value("AskPriceLesserThanStopPrice", OrderTriggerType::AskPriceLesserThanStopPrice)
      .value("AskPriceLesserEqualStopPrice", OrderTriggerType::AskPriceLesserEqualStopPrice)
      .value("BidPriceGreaterThanStopPrice", OrderTriggerType::BidPriceGreaterThanStopPrice)
      .value("BidPriceGreaterEqualStopPrice", OrderTriggerType::BidPriceGreaterEqualStopPrice)
      .value("BidPriceLesserThanStopPrice", OrderTriggerType::BidPriceLesserThanStopPrice)
      .value("BidPriceLesserEqualStopPrice", OrderTriggerType::BidPriceLesserEqualStopPrice)
      .export_values()
      .def("__eq__", [](const OrderTriggerType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<OrderTriggerFlag>(m_enums, "OrderTriggerFlag", py::arithmetic())
      .value("TriggerInsert", OrderTriggerFlag::TriggerInsert)
      .value("TriggerCancel", OrderTriggerFlag::TriggerCancel)
      .export_values()
      .def("__eq__", [](const OrderTriggerFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<AlgoOrderActionFlag>(m_enums, "AlgoOrderActionFlag", py::arithmetic())
      .value("Cancel", AlgoOrderActionFlag::Cancel)
      .value("Start", AlgoOrderActionFlag::Start)
      .value("Stop", AlgoOrderActionFlag::Stop)
      .export_values()
      .def("__eq__", [](const AlgoOrderActionFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<ResumePolicy>(m_enums, "ResumePolicy", py::arithmetic())
      .value("Now", ResumePolicy::Now)
      .value("Intraday", ResumePolicy::Intraday)
      .value("Stateless", ResumePolicy::Stateless)
      .value("Continuous", ResumePolicy::Continuous)
      .export_values()
      .def("__eq__", [](const AlgoOrderActionFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<CashReplaceFlag>(m_enums, "CashReplaceFlag", py::arithmetic())
      .value("UnReplace", CashReplaceFlag::UnReplace)
      .value("EnReplace", CashReplaceFlag::EnReplace)
      .value("MustReplace", CashReplaceFlag::MustReplace)
      .value("UnSSEReplace", CashReplaceFlag::UnSSEReplace)
      .value("UnSSEMustReplace", CashReplaceFlag::UnSSEMustReplace)
      .value("UnSSESZEReplace", CashReplaceFlag::UnSSESZEReplace)
      .value("UnSSESZEMustReplace", CashReplaceFlag::UnSSESZEMustReplace)
      .value("UnHKReplace", CashReplaceFlag::UnHKReplace)
      .value("UnHKMustReplace", CashReplaceFlag::UnHKMustReplace)
      .value("Unknown", CashReplaceFlag::Unknown)
      .export_values()
      .def("__eq__", [](const CashReplaceFlag &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<ETFType>(m_enums, "ETFType", py::arithmetic())
      .value("LocalETF", ETFType::LocalETF)
      .value("CrossCountryETF", ETFType::CrossCountryETF)
      .value("CrossMarketETF", ETFType::CrossMarketETF)
      .value("CurrencyETF", ETFType::CurrencyETF)
      .value("PhysicalBondETF", ETFType::PhysicalBondETF)
      .value("CommodityETF", ETFType::CommodityETF)
      .value("CashBondETF", ETFType::CashBondETF)
      .value("Unknown", ETFType::Unknown)
      .export_values()
      .def("__eq__", [](const ETFType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<ETFStatus>(m_enums, "ETFStatus", py::arithmetic())
      .value("Forbid", ETFStatus::Forbid)
      .value("Allow", ETFStatus::Allow)
      .value("PurchaseOnly", ETFStatus::PurchaseOnly)
      .value("RedemptionOnly", ETFStatus::RedemptionOnly)
      .value("Unknown", ETFStatus::Unknown)
      .export_values()
      .def("__eq__", [](const ETFStatus &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Currency>(m_enums, "Currency", py::arithmetic())
      .value("Unknown", Currency::Unknown)
      .value("CNY", Currency::CNY)
      .value("HKD", Currency::HKD)
      .value("USD", Currency::USD)
      .value("JPY", Currency::JPY)
      .value("GBP", Currency::GBP)
      .value("EUR", Currency::EUR)
      .value("CNH", Currency::CNH)
      .value("SGD", Currency::SGD)
      .value("MYR", Currency::MYR)
      .value("CEN", Currency::CEN)
      .export_values()
      .def("__eq__", [](const Currency &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Priority>(m_enums, "Priority", py::arithmetic())
      .value("Low", Priority::Low)
      .value("Medium", Priority::Medium)
      .value("High", Priority::High)
      .export_values()
      .def("__eq__", [](const Priority &a, int b) { return static_cast<int>(a) == b; });
}
} // namespace kungfu::longfist::pybind
