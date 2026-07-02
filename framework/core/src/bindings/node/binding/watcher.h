// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/14.
//

#ifndef KUNGFU_NODE_WATCHER_H
#define KUNGFU_NODE_WATCHER_H

#include <napi.h>
#include <uv.h>

#include "common.h"
#include "io.h"
#include "journal.h"
#include "operators.h"
// tracing-foundation Phase 1(goal 2026-06-25):wingchun(book/broker)已脱出。
// 交易记账(bookkeeper/Book/SilentAutoClient/BookListener)随之移除,留 Phase 2「喂 agent 事件」新 Watcher 重建。
#include <kungfu/yijinjing/cache/runtime.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::node {
constexpr uint64_t ID_TRANC = 0x00000000FFFFFFFF;
constexpr uint32_t PAGE_ID_MASK = 0x80000000;
constexpr uint32_t TRANSFER_STATIC_DATA_LIMIT = 2000;
constexpr uint32_t TRANSFER_TRADING_DATA_LIMIT = 2000;

class Watcher : public Napi::ObjectWrap<Watcher>, public practice::apprentice {
  typedef std::unordered_map<uint32_t, longfist::types::InstrumentKey> InstrumentKeyMap;

public:
  explicit Watcher(const Napi::CallbackInfo &info);

  ~Watcher() override;

  void NoSet(const Napi::CallbackInfo &info, const Napi::Value &value);

  Napi::Value HasLocation(const Napi::CallbackInfo &info);

  Napi::Value GetLocation(const Napi::CallbackInfo &info);

  Napi::Value GetLocationUID(const Napi::CallbackInfo &info);

  Napi::Value GetInstrumentUID(const Napi::CallbackInfo &info);

  Napi::Value GetInstrumentType(const Napi::CallbackInfo &info);

  Napi::Value GetLedger(const Napi::CallbackInfo &info);

  Napi::Value GetAppStates(const Napi::CallbackInfo &info);

  Napi::Value GetStrategyStates(const Napi::CallbackInfo &info);

  Napi::Value Now(const Napi::CallbackInfo &info);

  Napi::Value IsUsable(const Napi::CallbackInfo &info);

  Napi::Value IsLive(const Napi::CallbackInfo &info);

  Napi::Value IsStarted(const Napi::CallbackInfo &info);

  Napi::Value RequestStop(const Napi::CallbackInfo &info);

  Napi::Value RequestPosition(const Napi::CallbackInfo &info);

  Napi::Value PublishState(const Napi::CallbackInfo &info);

  Napi::Value IsReadyToInteract(const Napi::CallbackInfo &info);

  Napi::Value IssueCustomData(const Napi::CallbackInfo &info);

  Napi::Value IssueBlockMessage(const Napi::CallbackInfo &info);

  Napi::Value IssueOrderTrigger(const Napi::CallbackInfo &info);

  Napi::Value IssueOrder(const Napi::CallbackInfo &info);

  Napi::Value IssueAlgoOrder(const Napi::CallbackInfo &info);

  Napi::Value IssueMark(const Napi::CallbackInfo &info);

  Napi::Value CancelOrder(const Napi::CallbackInfo &info);

  Napi::Value CancelAlgoOrder(const Napi::CallbackInfo &info);

  Napi::Value CancelOrderTrigger(const Napi::CallbackInfo &info);

  Napi::Value ToggleAlgoOrder(const Napi::CallbackInfo &info);

  Napi::Value RequestMarketData(const Napi::CallbackInfo &info);

  Napi::Value Start(const Napi::CallbackInfo &info);

  void Sync(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  void Quit(const Napi::CallbackInfo &info);

  void AfterMasterDown(const Napi::CallbackInfo &info);

  void RequestDeregister();

  bool has_writer(uint32_t dest_id) const override;

  yijinjing::journal::writer_ptr get_writer(uint32_t dest_id) const override;

  bool is_reactable(const event_ptr &event) override;

  void drain_from_trading_data_reader(uint32_t step_limit = 0);

  bool is_step_continually();

protected:
  const bool bypass_accounting_;
  const bool bypass_trading_data_;
  const bool refresh_trading_data_before_sync_;
  const bool bypass_refresh_book_;
  const int milliseconds_sleep_after_step_;
  std::mutex feed_mutex_;

  void on_react() override;

  void on_start() override;

private:
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Watcher reset");
    Watcher::constructor.Reset();
  }

  uv_work_t uv_work_ = {};
  bool uv_work_live_ = false;
  bool quit_ = false;

  Napi::ObjectReference ledger_ref_;
  Napi::ObjectReference app_states_ref_;
  Napi::ObjectReference strategy_states_ref_;
  Napi::ObjectReference config_ref_;
  serialize::JsUpdateState update_ledger;
  serialize::JsResetCache reset_cache;
  cache::bank data_bank_;
  cache::bank trading_data_bank_;
  cache::deque_bank trading_data_cached_bank_;
  std::vector<kungfu::state<longfist::types::CacheReset>> reset_cache_states_;
  InstrumentKeyMap subscribed_instruments_ = {};
  std::unordered_map<uint32_t, int> broker_states_map_ = {};
  std::unordered_map<uint32_t, longfist::types::StrategyStateUpdate> strategy_states_map_ = {};

  yijinjing::journal::reader_ptr trading_data_reader_; // order, trade, orderStat
  uint32_t trading_data_count_by_step_ = 0;

  typedef longfist::enums::mode mode;
  typedef longfist::enums::category category;

  static constexpr auto bypass = [](practice::apprentice *app, bool bypass_quotes) {
    return rx::filter([&](const event_ptr &event) {
      return not(app->get_location(event->source())->category == longfist::enums::category::MD and
                 event->msg_type() != longfist::types::Instrument::tag and bypass_quotes);
    });
  };

  static constexpr auto is_subscribed = [](const InstrumentKeyMap &subscribed_instruments) {
    return rx::filter([&](const event_ptr &event) {
      return subscribed_instruments.find(event->data<longfist::types::Quote>().uid()) != subscribed_instruments.end();
    });
  };

  static constexpr auto is_trading_data = []() {
    return rx::filter([&](const event_ptr &event) {
      return longfist::RefreshRequiredDataTags.find(event->msg_type()) != longfist::RefreshRequiredDataTags.end();
    });
  };

  static constexpr auto not_trading_data = []() {
    return rx::filter([&](const event_ptr &event) {
      return longfist::RefreshRequiredDataTags.find(event->msg_type()) == longfist::RefreshRequiredDataTags.end();
    });
  };

  static constexpr auto is_static_data = []() {
    return rx::filter([&](const event_ptr &event) {
      return longfist::StaticDataTags.find(event->msg_type()) != longfist::StaticDataTags.end();
    });
  };

  void RestoreState(const yijinjing::data::location_ptr &state_location, int64_t from, int64_t to, bool sync_schema);

  yijinjing::data::location_ptr FindLocation(const Napi::CallbackInfo &info);

  void InspectChannel(int64_t trigger_time, const longfist::types::Channel &channel);

  void MonitorMarketData(int64_t trigger_time, const yijinjing::data::location_ptr &md_location);

  void OnRegister(int64_t trigger_time, const longfist::types::Register &register_data);

  void OnDeregister(int64_t trigger_time, const longfist::types::Deregister &deregister_data);

  template <typename DataType>
  void UpdateBrokerOperatorState(uint32_t source_id, uint32_t dest_id, const DataType &state) {
    auto source_location = get_location(state.location_uid);
    if (source_location->category == category::TD or source_location->category == category::MD or
        source_location->category == category::OPERATOR) {
      broker_states_map_.insert_or_assign(source_location->uid, int(state.state));
    }
  };

  void UpdateStrategyState(uint32_t strategy_uid, const longfist::types::StrategyStateUpdate &state);

  void SyncLedger();

  void TryRefreshTradingData();

  void SyncTradingData();

  void SyncTradingDataFromCached();

  void SyncAppStates();

  void SyncStrategyStates();

  void UpdateEventCache(const event_ptr &event);

  void SyncEventCache();

  void StartWorker();

  void CancelWorker();

  void ResetTradingDataCount() { trading_data_count_by_step_ = 0; };

  uint64_t MakeInstructionUID(yijinjing::journal::writer_ptr &writer, uint32_t dest, uint32_t client_id = 0) {
    uint64_t id_left = (uint64_t)(client_id xor dest) << 32u;
    uint64_t id_right = (ID_TRANC & writer->current_frame_uid()) | PAGE_ID_MASK;
    return id_left | id_right;
  }

  template <typename DataType> void UpdateLedger(const boost::hana::basic_type<DataType> &type) {
    using DataTypeMap = std::unordered_map<uint64_t, state<DataType>>;
    auto &target_map = const_cast<DataTypeMap &>(data_bank_[type]);
    auto is_static_data_type = longfist::StaticDataTags.find(DataType::tag) != longfist::StaticDataTags.end();
    auto count = 0;
    auto iter = target_map.begin();
    while (iter != target_map.end()) {
      const auto &state = iter->second;
      update_ledger(state.update_time, state.source, state.dest, state.data);
      iter = target_map.erase(iter);

      if (is_static_data_type && count++ >= TRANSFER_STATIC_DATA_LIMIT) {
        break;
      }
    }
  }

  // tracing-foundation Phase 1:UpdateTradingData / UpdateTradingDataFromCacheD(交易 longfist 类型已移出
  // StateDataTypes 闭集,trading_data_bank_ 无法 at_key)已移除;交易数据 sync 留 Phase 2 新 Watcher。

  template <typename Instruction>
  Napi::Value InteractWithLocation(const Napi::CallbackInfo &info, const Napi::Object &instruction_object) {
    try {
      auto target_location = IODevice::ExtractLocation(info, 1, get_locator());

      if (target_location->category == longfist::enums::category::SYSTEM && target_location->group == "master") {
        target_location = master_cmd_location_;
      }

      if (not is_location_live(target_location->uid) or not has_writer(target_location->uid)) {
        return Napi::Boolean::New(info.Env(), false);
      }

      auto trigger_time = yijinjing::time::now_in_nano();
      auto target_writer = get_writer(target_location->uid);
      Instruction instruction = {};
      serialize::JsGet{}(instruction_object, instruction);

      if (info.Length() == 2) {
        target_writer->write(trigger_time, instruction);
        return Napi::Boolean::New(info.Env(), true);
      }

      throw Napi::Error::New(info.Env(), "Invalid instruction arguments length");
    } catch (const std::exception &ex) {
      throw Napi::Error::New(info.Env(), fmt::format("invalid instruction arguments: {}", ex.what()));
    } catch (...) {
      throw Napi::Error::New(info.Env(), "invalid instruction arguments");
    }
  }

};

} // namespace kungfu::node

#endif // KUNGFU_NODE_WATCHER_H
