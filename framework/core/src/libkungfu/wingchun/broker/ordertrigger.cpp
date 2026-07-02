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

void OrderTriggerService::on_order_trigger_input(const event_ptr &event) {
  auto risk_uid = get_service().get_risk_uid();
  if (risk_uid != 0 and event->initial_source() != risk_uid) {
    SPDLOG_DEBUG("risk_uid: {}, initial_source: {}", risk_uid, event->initial_source());
    return;
  }
  get_service().insert_order_trigger(event);
}

void OrderTriggerService::on_order_trigger_action(const event_ptr &event) {
  auto risk_uid = get_service().get_risk_uid();
  if (risk_uid != 0 and event->initial_source() != risk_uid) {
    SPDLOG_DEBUG("risk_uid: {}, initial_source: {}", risk_uid, event->initial_source());
    return;
  }
  get_service().cancel_order_trigger(event);
  const auto &order_trigger_action = event->data<OrderTriggerAction>();
  state<OrderTriggerAction> order_trigger_action_state(event->source(), event->dest(), event->gen_time(),
                                                       event->data<OrderTriggerAction>());
  order_trigger_actions_.insert_or_assign(order_trigger_action.trigger_id, order_trigger_action_state);
}

void OrderTriggerService::on_order_trigger(int64_t gen_time, uint32_t source, uint32_t dest,
                                           const longfist::types::OrderTrigger &order_trigger) {
  state<OrderTrigger> order_trigger_state(source, dest, gen_time, order_trigger);
  order_triggers_.insert_or_assign(order_trigger.trigger_id, order_trigger_state);
}

void OrderTriggerService::clean_order_triggers(bool bypass_recover) {
  std::for_each(order_triggers_.begin(), order_triggers_.end(), [&](auto &pair) {
    OrderTrigger &trigger = pair.second.data;
    if (not is_final_status(trigger.status) and (bypass_recover or trigger.external_trigger_id.to_string().empty())) {
      trigger.status = OrderStatus::Lost;
      trigger.update_time = yijinjing::time::now_in_nano();
      vendor_.try_write_to(vendor_.now(), trigger, pair.second.dest);
    }
  });
}

void OrderTriggerService::clean_order_triggers(uint32_t source,
                                               const longfist::types::OrderTriggerInput &order_trigger_input,
                                               bool bypass_recover) {
  if (order_triggers_.find(order_trigger_input.trigger_id) != order_triggers_.end()) {
    return;
  }

  OrderTrigger trigger{};
  order_trigger_from_input(order_trigger_input, trigger);
  trigger.status = OrderStatus::Lost;
  trigger.update_time = yijinjing::time::now_in_nano();
  vendor_.try_write_to(vendor_.now(), trigger, source);
}

const OrderTriggerMap &OrderTriggerService::get_order_triggers() const { return order_triggers_; }

bool OrderTriggerService::has_order_trigger(uint64_t trigger_id) const {
  return order_triggers_.find(trigger_id) != order_triggers_.end();
}

kungfu::state<longfist::types::OrderTrigger> &OrderTriggerService::get_order_trigger(uint64_t trigger_id) {
  return order_triggers_.at(trigger_id);
}

const OrderTriggerActionMap &OrderTriggerService::get_order_trigger_actions() const { return order_trigger_actions_; }

bool OrderTriggerService::has_order_trigger_action(uint64_t action_id) const {
  return order_trigger_actions_.find(action_id) != order_trigger_actions_.end();
}

kungfu::state<longfist::types::OrderTriggerAction> &OrderTriggerService::get_order_trigger_action(uint64_t action_id) {
  return order_trigger_actions_.at(action_id);
}

} // namespace kungfu::wingchun::broker