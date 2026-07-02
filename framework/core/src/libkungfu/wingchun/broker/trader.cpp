// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#include <kungfu/common.h>
#include <kungfu/wingchun/broker/trader.h>
#include <kungfu/yijinjing/cache/cached.h>
#include <kungfu/yijinjing/journal/tracer.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::cache;

namespace kungfu::wingchun::broker {

bool Trader::insert_algo_order(const event_ptr &event) {
  auto writer = get_writer(event->source());
  auto &algo_order_input = event->data<longfist::types::AlgoOrderInput>();
  auto &algo_order = writer->open_data<AlgoOrder>();
  algo_order_from_input(algo_order_input, algo_order);
  algo_order.status = longfist::enums::OrderStatus::Error;
  std::string error_msg = "Algo not supported";
  kungfu::copy_string(algo_order.error_msg, error_msg.c_str());
  writer->close_data();
  return true;
}

const std::string &Trader::get_account_id() const { return get_live_home()->name; }

yijinjing::journal::writer_ptr Trader::get_asset_writer() const {
  return get_writer(sync_asset_ ? location::SYNC : location::PUBLIC);
}

yijinjing::journal::writer_ptr Trader::get_position_writer() const {
  return get_writer(sync_position_ ? location::SYNC : location::PUBLIC);
}

AlgoOrderService &Trader::get_algo_order_service() {
  return dynamic_cast<TraderVendor &>(get_vendor()).get_algo_order_service();
}

const AlgoOrderService &Trader::get_algo_order_service() const {
  return dynamic_cast<TraderVendor &>(get_vendor()).get_algo_order_service();
}

OrderService &Trader::get_order_service() { return dynamic_cast<TraderVendor &>(get_vendor()).get_order_service(); }

const OrderService &Trader::get_order_service() const {
  return dynamic_cast<TraderVendor &>(get_vendor()).get_order_service();
}

OrderTriggerService &Trader::get_order_trigger_service() {
  return dynamic_cast<TraderVendor &>(get_vendor()).get_order_trigger_service();
}

const OrderTriggerService &Trader::get_order_trigger_service() const {
  return dynamic_cast<TraderVendor &>(get_vendor()).get_order_trigger_service();
}

const OrderMap &Trader::get_orders() const { return get_order_service().get_orders(); }

bool Trader::has_order(uint64_t order_id) const { return get_order_service().has_order(order_id); }

state<Order> &Trader::get_order(uint64_t order_id) { return get_order_service().get_order(order_id); }

const OrderActionMap &Trader::get_order_actions() const { return get_order_service().get_order_actions(); }

bool Trader::has_order_action(uint64_t action_id) const { return get_order_service().has_order_action(action_id); }

kungfu::state<longfist::types::OrderAction> &Trader::get_order_action(uint64_t action_id) {
  return get_order_service().get_order_action(action_id);
}

const TradeMap &Trader::get_trades() const { return get_order_service().get_trades(); }

const OrderTriggerMap &Trader::get_order_triggers() const { return get_order_trigger_service().get_order_triggers(); }

bool Trader::has_order_trigger_action(uint64_t action_id) const {
  return get_order_trigger_service().has_order_trigger_action(action_id);
}

kungfu::state<longfist::types::OrderTriggerAction> &Trader::get_order_trigger_action(uint64_t action_id) {
  return get_order_trigger_service().get_order_trigger_action(action_id);
}

bool Trader::has_order_trigger(uint64_t trigger_id) const {
  return get_order_trigger_service().has_order_trigger(trigger_id);
}

state<OrderTrigger> &Trader::get_order_trigger(uint64_t trigger_id) {
  return get_order_trigger_service().get_order_trigger(trigger_id);
}

const OrderTriggerActionMap &Trader::get_order_trigger_actions() const {
  return get_order_trigger_service().get_order_trigger_actions();
}

const AlgoOrderMap &Trader::get_algo_orders() const { return get_algo_order_service().get_algo_orders(); }

bool Trader::has_algo_order(uint64_t order_id) const { return get_algo_order_service().has_algo_order(order_id); }

state<AlgoOrder> &Trader::get_algo_order(uint64_t order_id) {
  return get_algo_order_service().get_algo_order(order_id);
}

const AlgoOrderActionMap &Trader::get_algo_order_actions() const {
  return get_algo_order_service().get_algo_order_actions();
}

void Trader::enable_asset_sync() { sync_asset_ = true; }

void Trader::enable_positions_sync() { sync_position_ = true; }

void Trader::on_asset_sync() {
  if (state_ == BrokerState::Ready) {
    req_account();
    disable_sync_account();
  }
}

void Trader::on_position_sync() {
  if (state_ == BrokerState::Ready) {
    req_position();
  }
}

void Trader::recover() {
  recover_from_journal();
  deal_write_frame();
  deal_read_frame();
}

void Trader::recover_from_journal() {
  tracer trc(get_live_home(), false, true, yijinjing::time::restore_start(), yijinjing::time::now_in_nano());
  SPDLOG_DEBUG("before tracer read");
  int64_t count = 0;
  auto &state_bank = const_cast<cache::bank &>(get_vendor().get_state_bank());
  while (trc.data_available()) {
    const auto &frame = trc.current_frame();

    switch (frame->msg_type()) {
    case Order::tag:
    case Trade::tag:
    case OrderTrigger::tag:
    case AlgoOrder::tag:
      cached::feed_state_data(frame, state_bank);
      ++count;
      break;
    }

    trc.next();
  }
  SPDLOG_DEBUG("after tracer read, count: {}", count);
}

void Trader::deal_write_frame() {
  SPDLOG_DEBUG("before state_bank read");
  uint64_t count = 0;
  auto &state_bank = get_vendor().get_state_bank();

  auto &algo_order_state_map = state_bank[boost::hana::type_c<AlgoOrder>];
  count += algo_order_state_map.size();
  std::for_each(algo_order_state_map.begin(), algo_order_state_map.end(), [&](auto &pair) {
    auto &algo_order_state = pair.second;
    get_algo_order_service().on_algo_order(algo_order_state.update_time, algo_order_state.source, algo_order_state.dest,
                                           algo_order_state.data);
  });

  auto &order_state_map = state_bank[boost::hana::type_c<Order>];
  count += order_state_map.size();
  std::for_each(order_state_map.begin(), order_state_map.end(), [&](auto &pair) {
    auto &order_state = pair.second;
    get_order_service().on_order(order_state.update_time, order_state.source, order_state.dest, order_state.data);
    get_algo_order_service().on_order(order_state.update_time, order_state.source, order_state.dest, order_state.data);
  });

  auto &trade_state_map = state_bank[boost::hana::type_c<Trade>];
  count += trade_state_map.size();
  std::for_each(trade_state_map.begin(), trade_state_map.end(), [&](auto &pair) {
    auto &trade_state = pair.second;
    get_order_service().on_trade(trade_state.update_time, trade_state.source, trade_state.dest, trade_state.data);
  });

  auto &order_trigger_state_map = state_bank[boost::hana::type_c<OrderTrigger>];
  count += order_trigger_state_map.size();
  std::for_each(order_trigger_state_map.begin(), order_trigger_state_map.end(), [&](auto &pair) {
    auto &order_trigger_state = pair.second;
    get_order_trigger_service().on_order_trigger(order_trigger_state.update_time, order_trigger_state.source,
                                                 order_trigger_state.dest, order_trigger_state.data);
  });

  SPDLOG_DEBUG("after state_bank read, count: {}", count);

  get_order_service().lost_orders(disable_recover_);
  get_order_trigger_service().clean_order_triggers(disable_recover_);
  get_algo_order_service().clean_algo_orders(disable_recover_);
}

void Trader::deal_read_frame() {
  // write a Lost Order to journal when read an OrderInput whose order_id not in orders_
  SPDLOG_DEBUG("before state_bank read");
  uint64_t count = 0;
  auto &state_bank = get_vendor().get_state_bank();

  auto &order_input_state_map = state_bank[boost::hana::type_c<OrderInput>];
  count += order_input_state_map.size();
  std::for_each(order_input_state_map.begin(), order_input_state_map.end(), [&](auto &pair) {
    auto &order_input_state = pair.second;
    get_order_service().lost_orders(order_input_state.source, order_input_state.data, disable_recover_);
  });

  auto &order_trigger_input_state_map = state_bank[boost::hana::type_c<OrderTriggerInput>];
  count += order_trigger_input_state_map.size();
  std::for_each(order_trigger_input_state_map.begin(), order_trigger_input_state_map.end(), [&](auto &pair) {
    auto &order_trigger_input_state = pair.second;
    get_order_trigger_service().clean_order_triggers(order_trigger_input_state.source, order_trigger_input_state.data,
                                                     disable_recover_);
  });

  auto &algo_order_input_state_map = state_bank[boost::hana::type_c<AlgoOrderInput>];
  count += algo_order_input_state_map.size();
  std::for_each(algo_order_input_state_map.begin(), algo_order_input_state_map.end(), [&](auto &pair) {
    auto &algo_order_input_state = pair.second;
    get_algo_order_service().clean_algo_orders(algo_order_input_state.source, algo_order_input_state.data,
                                               disable_recover_);
  });

  SPDLOG_DEBUG("after state_bank read, count: {}", count);
}

void Trader::clean_finished_orders() {
  if (state_ == BrokerState::Ready) {
    get_order_service().clean_finished_orders(yijinjing::time::now_in_nano());
  }
}

uint32_t Trader::get_risk_uid() const { return risk_uid_; }

void Trader::disable_recover() { disable_recover_ = true; }

void Trader::try_req_account() {
  if (is_sync_account() and BrokerState::Ready == state_) {
    req_account();
    disable_sync_account();
  }
}

void Trader::on_risk_setting(const RiskSetting &risk_setting) {
  SPDLOG_DEBUG("RiskSetting: {}", risk_setting.to_string());
  if (risk_setting.risk_check and not risk_setting.name.empty()) {
    risk_uid_ = location(get_home()->mode, category::SYSTEM, "service", risk_setting.risk_name, get_home()->locator)
                    .location_uid;
  }
}
} // namespace kungfu::wingchun::broker
