#include <kungfu/wingchun/broker/trader.h>

using namespace kungfu::rx;
using namespace kungfu::wingchun;
using namespace kungfu::wingchun::broker;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;

namespace kungfu::wingchun::broker {

constexpr uint64_t ORDER_CLAEN_THROTTLE = 5 * yijinjing::time_unit::NANOSECONDS_PER_MINUTE;

void OrderService::on_order_input(const event_ptr &event) {
  auto &order_input = event->data<OrderInput>();
  auto risk_uid = get_service().get_risk_uid();
  if (risk_uid != 0 and event->initial_source() != risk_uid) {
    SPDLOG_DEBUG("risk_uid: {}, initial_source: {}", risk_uid, event->initial_source());
    return;
  }

  // try_emplace default insert false to map, means not batch mode
  if (batch_status_.try_emplace(event->source()).first->second) {
    batch_order_inputs_.try_emplace(event->source()).first->second.push_back(order_input);
    return;
  }

  if (block_messages_.find(order_input.block_id) != block_messages_.end()) {
    auto &block_message = block_messages_.at(order_input.block_id);
    get_service().insert_block_order(event, block_message);
    return;
  }

  get_service().insert_order(event);
}

void OrderService::on_order_action(const event_ptr &event) {
  const auto &order_action = event->data<OrderAction>();
  auto risk_uid = get_service().get_risk_uid();
  if (risk_uid != 0 and event->initial_source() != risk_uid) {
    SPDLOG_DEBUG("risk_uid: {}, initial_source: {}", risk_uid, event->initial_source());
    return;
  }
  get_service().cancel_order(event);
  // source is cancel strategy, dest is TD, so swap source and dest
  order_actions_.insert_or_assign(order_action.order_action_id,
                                  state<OrderAction>{event->dest(), event->source(), event->gen_time(), order_action});
}

void OrderService::on_order(int64_t gen_time, uint32_t source, uint32_t dest, const Order &order) {
  orders_.insert_or_assign(order.order_id, state<Order>{source, dest, gen_time, order});
}

void OrderService::on_trade(int64_t gen_time, uint32_t source, uint32_t dest, const Trade &trade) {
  trades_.insert_or_assign(trade.trade_id, state<Trade>{source, dest, gen_time, trade});
  get_service().enable_sync_account();
}

void OrderService::on_batch_order_tag(const event_ptr &event) {
  if (event->msg_type() == BatchOrderBegin::tag) {
    batch_status_.insert_or_assign(event->source(), true);
    return;
  }

  if (event->msg_type() == BatchOrderEnd::tag) {
    batch_status_.insert_or_assign(event->source(), false);
    get_service().insert_batch_orders(event, batch_order_inputs_.at(event->source()));
    clear_batch_order_inputs(event->source());
  }
}

void OrderService::on_block_message(const longfist::types::BlockMessage &block_message) {
  if (block_message.block_id == UINT64_ZERO) {
    return;
  }
  block_messages_.insert_or_assign(block_message.block_id, block_message);
}

void OrderService::clear_batch_order_inputs(uint32_t location_uid) { batch_order_inputs_.erase(location_uid); }

void OrderService::lost_orders(bool bypass_recover) {
  std::for_each(orders_.begin(), orders_.end(), [&](auto &pair) {
    Order &order = pair.second.data;
    if (not is_final_status(order.status) and (bypass_recover or order.external_order_id.to_string().empty())) {
      order.status = OrderStatus::Lost;
      order.update_time = yijinjing::time::now_in_nano();
      vendor_.try_write_to(vendor_.now(), order, pair.second.dest);
    }
  });
}

void OrderService::lost_orders(uint32_t source, const OrderInput &order_input, bool bypass_recover) {
  if (orders_.find(order_input.order_id) != orders_.end()) {
    return;
  }

  Order order{};
  order_from_input(order_input, order);
  order.status = OrderStatus::Lost;
  order.update_time = yijinjing::time::now_in_nano();
  vendor_.try_write_to(vendor_.now(), order, source);
}

void OrderService::clean_finished_orders(uint64_t now) {
  auto before_clean_order_size = orders_.size();
  auto start = yijinjing::time::now_in_nano();
  auto iter = orders_.begin();
  while (iter != orders_.end()) {
    auto &state = iter->second;
    if (is_final_status(state.data.status) && (now - state.data.update_time) >= ORDER_CLAEN_THROTTLE) {
      iter = orders_.erase(iter);
    } else {
      iter++;
    }
  }
  auto after_clean_order_size = orders_.size();
  auto end = yijinjing::time::now_in_nano();
  SPDLOG_DEBUG("clean_finished_orders clean size {}, takes {}ns", before_clean_order_size - after_clean_order_size,
               end - start);
}

void OrderService::clean_trades() { trades_.clear(); }

const OrderMap &OrderService::get_orders() const { return orders_; }

bool OrderService::has_order(uint64_t order_id) const { return orders_.find(order_id) != orders_.end(); }

kungfu::state<longfist::types::Order> &OrderService::get_order(uint64_t order_id) { return orders_.at(order_id); }

const OrderActionMap &OrderService::get_order_actions() const { return order_actions_; }

const TradeMap &OrderService::get_trades() const { return trades_; }

bool OrderService::has_order_action(uint64_t action_id) const {
  return order_actions_.find(action_id) != order_actions_.end();
}

kungfu::state<longfist::types::OrderAction> &OrderService::get_order_action(uint64_t action_id) {
  return order_actions_.at(action_id);
}

} // namespace kungfu::wingchun::broker