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

void AlgoOrderService::on_algo_order_input(const event_ptr &event) {

  auto &algo_order_input = event->data<AlgoOrderInput>();
  auto writer = vendor_.get_writer(event->source());

  if (algo_order_input.is_local) {
    state<AlgoOrderInput> algo_order_input_state(event->source(), event->dest(), event->gen_time(), algo_order_input);
    if (algo_order_input.origin_order_id == UINT64_ZERO) {
      auto &algo_order = writer->open_data<AlgoOrder>();
      algo_order_from_input(algo_order_input, algo_order);
      writer->close_data();
      return;
    }
  }

  if (algo_order_input.is_local and algo_order_input.origin_order_id != UINT64_ZERO) {
    if (local_algo_orders_.find(algo_order_input.origin_order_id) == local_algo_orders_.end()) {
      SPDLOG_ERROR("failed to find local algo order, origin_order_id: {}", algo_order_input.origin_order_id);
      return;
    }

    auto &target_algo_order_state = local_algo_orders_.at(algo_order_input.origin_order_id);
    auto &target_algo_order = target_algo_order_state.data;

    // algo_order_from_input(algo_order_input, target_algo_order);
    target_algo_order.volume_left =
        algo_order_input.volume - (target_algo_order.volume - target_algo_order.volume_left);
    target_algo_order.volume = algo_order_input.volume;

    // waiting_record_local_algo_orders_.insert_or_assign(target_algo_order.order_id, target_algo_order_state);
    writer->write(yijinjing::time::now_in_nano(), target_algo_order);

    return;
  }

  get_service().insert_algo_order(event);
}

void AlgoOrderService::on_algo_order_action(const event_ptr &event) {
  // no algo order action resolution for local algo order;
  auto &algo_order_action = event->data<AlgoOrderAction>();
  if (local_algo_orders_.find(algo_order_action.order_id) == local_algo_orders_.end()) {
    if (algo_order_action.action_flag == AlgoOrderActionFlag::Cancel) {
      get_service().cancel_algo_order(event);
    } else {
      get_service().toggle_algo_order(event);
    }
  } else {
    if (algo_order_action.action_flag != AlgoOrderActionFlag::Cancel) {
      return;
    }

    auto &algo_order_state = local_algo_orders_.at(algo_order_action.order_id);
    auto &algo_order = algo_order_state.data;
    auto dest = algo_order_state.dest;
    auto algo_order_is_final = is_final_status(algo_order.status);

    if (algo_order.volume == algo_order.volume_left) {
      algo_order.status = OrderStatus::Cancelled;
    } else if (not algo_order_is_final) {
      algo_order.status = OrderStatus::PartialFilledNotActive;
    }

    vendor_.get_writer(dest)->write(yijinjing::time::now_in_nano(), algo_order);
  }

  state<AlgoOrderAction> algo_order_action_state(event->source(), event->dest(), event->gen_time(), algo_order_action);
  algo_order_actions_.insert_or_assign(algo_order_action.order_id, algo_order_action_state);
}

void AlgoOrderService::on_order(int64_t gen_time, uint32_t source, uint32_t dest, const Order &order) {
  if (order.parent_id == UINT64_ZERO) {
    return;
  }

  // save <order id> to <parent id> pair;
  order_id_to_algo_order_id_.insert_or_assign(order.order_id, order.parent_id);

  if (local_algo_orders_.find(order.parent_id) == local_algo_orders_.end()) {
    return;
  }

  try_update_sub_orders(order);

  if (not recover_done_) {
    return;
  }

  auto &target_algo_order_state = local_algo_orders_.at(order.parent_id);
  auto &target_algo_order = target_algo_order_state.data;

  auto volume_traded = get_volume_traded(order.parent_id);
  target_algo_order.volume_left = target_algo_order.volume - volume_traded;
  target_algo_order.restore_time = std::max<int64_t>(target_algo_order.restore_time, order.restore_time);

  auto has_traded = target_algo_order.volume_left != target_algo_order.volume;

  if (volume_traded == 0) {
    target_algo_order.status = OrderStatus::Pending;
  } else {
    target_algo_order.status = OrderStatus::PartialFilledActive;
  }

  if (is_final_status(order.status)) {
    auto pair = get_all_order_status(order.parent_id);
    if (pair.first) {
      if (has_traded) {
        if (target_algo_order.volume_left <= 0) {
          target_algo_order.status = OrderStatus::Filled;
        } else {
          target_algo_order.status = OrderStatus::PartialFilledNotActive;
        }
      } else {
        if (pair.second) {
          target_algo_order.status = OrderStatus::Error;
        } else {
          target_algo_order.status = OrderStatus::Cancelled;
        }
      }
    }
  }
  target_algo_order.update_time = yijinjing::time::now_in_nano();
  waiting_record_local_algo_orders_.insert_or_assign(target_algo_order.order_id, target_algo_order_state);
}

void AlgoOrderService::on_trade(int64_t gen_time, uint32_t source, uint32_t dest, const Trade &trade) {
  auto &trade_ref = const_cast<Trade &>(trade);
  auto order_id = trade.order_id;
  if (order_id_to_algo_order_id_.find(order_id) == order_id_to_algo_order_id_.end()) {
    return;
  }

  trade_ref.parent_order_id = order_id_to_algo_order_id_.at(order_id);
}

void AlgoOrderService::on_algo_order(int64_t gen_time, uint32_t source, uint32_t dest, const AlgoOrder &algo_order) {

  // this function fullfill all inner write AlgoOrder demand
  state<AlgoOrder> algo_order_state(source, dest, gen_time, algo_order);
  algo_orders_.insert_or_assign(algo_order.order_id, algo_order_state);

  if (algo_order.is_local) {
    local_algo_orders_.insert_or_assign(algo_order.order_id, algo_order_state);
  }
};

void AlgoOrderService::try_update_sub_orders(const Order &order) {
  if (local_sub_orders_.find(order.parent_id) == local_sub_orders_.end()) {
    Orders orders;
    local_sub_orders_.emplace(order.parent_id, orders);
  }

  auto &orders = local_sub_orders_.at(order.parent_id);
  orders.insert_or_assign(order.order_id, order);
}

std::pair<bool, bool> AlgoOrderService::get_all_order_status(uint64_t algo_order_id) {
  if (local_sub_orders_.find(algo_order_id) == local_sub_orders_.end()) {
    SPDLOG_ERROR("get_all_order_status no {} in local_sub_orders_", algo_order_id);
    return std::make_pair(false, false);
  }
  auto &orders = local_sub_orders_.at(algo_order_id);
  return get_status(orders);
}

int64_t AlgoOrderService::get_volume_traded(uint64_t algo_order_id) {
  if (local_sub_orders_.find(algo_order_id) == local_sub_orders_.end()) {
    SPDLOG_ERROR("get_volume_traded no {} in local_sub_orders_", algo_order_id);
    return false;
  }

  if (local_algo_orders_.find(algo_order_id) == local_algo_orders_.end()) {
    SPDLOG_ERROR("get_volume_traded no {} in local_algo_orders_", algo_order_id);
    return false;
  }

  auto traded_volume = 0;
  auto &orders = local_sub_orders_.at(algo_order_id);
  std::for_each(orders.begin(), orders.end(), [&](auto &pair) {
    auto &order = pair.second;
    traded_volume += order.volume - order.volume_left;
  });

  return traded_volume;
}

void AlgoOrderService::clean_algo_orders(bool bypass_recover) {
  std::for_each(algo_orders_.begin(), algo_orders_.end(), [&](auto &pair) {
    AlgoOrder &algo_order = pair.second.data;

    if (not is_final_status(algo_order.status) and
        (bypass_recover or (not algo_order.is_local and algo_order.external_order_id.to_string().empty()))) {
      algo_order.status = OrderStatus::Lost;
      algo_order.update_time = yijinjing::time::now_in_nano();
      vendor_.try_write_to(vendor_.now(), algo_order, pair.second.dest);
    }
  });
}

void AlgoOrderService::clean_algo_orders(uint32_t source, const AlgoOrderInput &algo_order_input, bool bypass_recover) {
  if (algo_orders_.find(algo_order_input.order_id) != algo_orders_.end()) {
    return;
  }

  AlgoOrder algo_order{};
  algo_order_from_input(algo_order_input, algo_order);
  algo_order.status = OrderStatus::Lost;
  algo_order.update_time = yijinjing::time::now_in_nano();
  vendor_.try_write_to(vendor_.now(), algo_order, source);
}

const AlgoOrderMap &AlgoOrderService::get_algo_orders() const { return algo_orders_; }

bool AlgoOrderService::has_algo_order(uint64_t algo_order_id) const {
  return algo_orders_.find(algo_order_id) != algo_orders_.end();
}

kungfu::state<AlgoOrder> &AlgoOrderService::get_algo_order(uint64_t algo_order_id) {
  return algo_orders_.at(algo_order_id);
}

const AlgoOrderActionMap &AlgoOrderService::get_algo_order_actions() const { return algo_order_actions_; }

void AlgoOrderService::on_frame() {
  if (waiting_record_local_algo_orders_.empty()) {
    return;
  }

  auto iter = waiting_record_local_algo_orders_.begin();
  while (iter != waiting_record_local_algo_orders_.end()) {
    auto &algo_order_state = iter->second;
    vendor_.try_write_to(vendor_.now(), algo_order_state.data, algo_order_state.dest);
    iter = waiting_record_local_algo_orders_.erase(iter);
  }
}

} // namespace kungfu::wingchun::broker
