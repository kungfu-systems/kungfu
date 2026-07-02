#include <kungfu/common.h>
#include <kungfu/wingchun/broker/trader.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::wingchun::broker {

static const bool get_low_memory_mode() {
  bool is_low_memory_mode = std::getenv("KF_LOW_MEMORY") != nullptr;
  return is_low_memory_mode;
}

constexpr uint32_t SYNC_ASSET_INTERVAL = 7;
constexpr uint32_t ORDER_CLEAN_INTERVAL = 10;

// ====================== BaseService start ======================

Trader &BaseService::get_service() { return dynamic_cast<Trader &>(*vendor_.get_service()); }

// ====================== BaseService end ======================

// ====================== TraderWriterHook start ======================

TraderWriterHook::TraderWriterHook(TraderVendor &vendor) : vendor_(vendor) {}

void TraderWriterHook::on_open_frame(int64_t trigger_time, frame_ptr frame) {}

void TraderWriterHook::on_close_frame(int64_t gen_time, frame_ptr frame) {
  auto now = yijinjing::time::now_in_nano();
  switch (frame->msg_type()) {
  case Order::tag: {
    auto &order = guard_update_time<Order>(frame->data<Order>());
    if (order.restore_time == 0) {
      order.restore_time = order.insert_time;
    }
    get_algo_order_service().on_order(now, frame->source(), frame->dest(), order);
    get_order_service().on_order(now, frame->source(), frame->dest(), order);
    break;
  }
  case Trade::tag: {
    auto &trade = const_cast<Trade &>(frame->data<Trade>());
    if (trade.restore_time == 0) {
      trade.restore_time = trade.trade_time;
    }
    get_algo_order_service().on_trade(now, frame->source(), frame->dest(), trade);
    break;
  }
  case OrderTrigger::tag: {
    auto &order_trigger = guard_update_time<OrderTrigger>(frame->data<OrderTrigger>());
    if (order_trigger.restore_time == 0) {
      order_trigger.restore_time = order_trigger.insert_time;
    }
    get_order_trigger_service().on_order_trigger(now, frame->source(), frame->dest(), order_trigger);
    break;
  }
  case AlgoOrder::tag: {
    auto &algo_order = guard_update_time<AlgoOrder>(frame->data<AlgoOrder>());
    get_algo_order_service().on_algo_order(now, frame->source(), frame->dest(), algo_order);
    break;
  }
  case Position::tag: {
    guard_position(frame->data<Position>());
    break;
  }
  case Asset::tag: {
    guard_asset(frame->data<Asset>());
    break;
  }
  }
}

BrokerService_ptr TraderWriterHook::get_service() { return vendor_.get_service(); }

OrderService &TraderWriterHook::get_order_service() { return vendor_.get_order_service(); }

OrderTriggerService &TraderWriterHook::get_order_trigger_service() { return vendor_.get_order_trigger_service(); }

AlgoOrderService &TraderWriterHook::get_algo_order_service() { return vendor_.get_algo_order_service(); }

void TraderWriterHook::guard_position(const Position &const_position) {
  auto &position = const_cast<Position &>(const_position);
  position.update_time = vendor_.now();
  position.source_id = vendor_.get_live_home_uid();
  position.holder_uid = vendor_.get_live_home_uid();
  position.source_op_id = get_source_op_id(position.holder_uid, position.source_id);
  position.instrument_type = get_instrument_type(position.exchange_id, position.instrument_id);
}

void TraderWriterHook::guard_asset(const Asset &const_asset) {
  auto &asset = const_cast<Asset &>(const_asset);
  asset.holder_uid = vendor_.get_live_home_uid();
}

// ====================== TraderWriterHook end ======================

// ====================== TraderVendor start ======================

TraderVendor::TraderVendor(locator_ptr locator, const std::string &group, const std::string &name, mode m,
                           bool low_latency, const std::string &arguments)
    : BrokerVendor(location::make_shared(m, category::TD, group, name, std::move(locator)), low_latency, arguments),
      algo_order_service_(*this), order_service_(*this), order_trigger_service_(*this),
      hook_(std::make_shared<TraderWriterHook>(*this)) {}

void TraderVendor::set_service(Trader_ptr service) { service_ = std::move(service); }

void TraderVendor::react() {
  events_ | skip_until(events_ | is(RequestStart::tag)) | is(OrderInput::tag) |
      $$(order_service_.on_order_input(event));
  apprentice::react();

  // have to be in this position, only in react, the ResetBookRequest can be listened
  events_ | is(ResetBookRequest::tag) |
      $([&](const event_ptr &event) { get_writer(location::PUBLIC)->mark(now(), ResetBookRequest::tag); });
}

void TraderVendor::on_start() {
  BrokerVendor::on_start();
  service_->pre_start();

  events_ | is(OrderAction::tag) | $$(order_service_.on_order_action(event));
  events_ | is(BlockMessage::tag) | $$(order_service_.on_block_message(event->data<BlockMessage>()));
  events_ | is(BatchOrderBegin::tag, BatchOrderEnd::tag) | $$(order_service_.on_batch_order_tag(event));

  events_ | is(OrderTriggerInput::tag) | $$(order_trigger_service_.on_order_trigger_input(event));
  events_ | is(OrderTriggerAction::tag) | $$(order_trigger_service_.on_order_trigger_action(event));

  events_ | is(AlgoOrderInput::tag) | $$(algo_order_service_.on_algo_order_input(event));
  events_ | is(AlgoOrderAction::tag) | $$(algo_order_service_.on_algo_order_action(event));

  events_ | is(AssetRequest::tag) | $$(service_->req_account());
  events_ | is(PositionRequest::tag) | $$(service_->req_position());
  events_ | is(OrderTriggerRequest::tag) | $$(service_->req_order_trigger());
  events_ | is(ContractRequest::tag) | $$(service_->req_contract());
  events_ | is(RequestHistoryOrder::tag) | $$(service_->req_history_order(event));
  events_ | is(RequestHistoryTrade::tag) | $$(service_->req_history_trade(event));
  events_ | is(AssetSync::tag) | $$(service_->on_asset_sync());
  events_ | is(PositionSync::tag) | $$(service_->on_position_sync());
  events_ | is(Band::tag) | $$(service_->on_band(event));
  events_ | is(TimeKeyValue::tag) | $$(service_->on_time_key_value(event));
  events_ | is(Deregister::tag) | $$(service_->on_strategy_exit(event));

  service_->on_risk_setting(service_->get_risk_setting());
  service_->recover();
  on_recover();
  service_->on_start();

  // after recover done, which take some time, then start to try req account
  add_time_interval(SYNC_ASSET_INTERVAL * yijinjing::time_unit::NANOSECONDS_PER_SECOND,
                    [&](auto e) { service_->try_req_account(); });

  if (get_low_memory_mode()) {
    SPDLOG_WARN("Low memory mode, clear finished order every {}s", ORDER_CLEAN_INTERVAL);
    add_time_interval(ORDER_CLEAN_INTERVAL * yijinjing::time_unit::NANOSECONDS_PER_SECOND,
                      [&](auto e) { service_->clean_finished_orders(); });
  }
}

void TraderVendor::on_write_to(const event_ptr &event) {
  const auto &request = event->data<RequestWriteTo>();
  uint32_t dest_id = request.dest_id;
  if (writers_.find(dest_id) == writers_.end()) {
    writers_.emplace(dest_id, get_io_device()->open_hookable_writer(dest_id, hook_, request.page_size));
    if (dest_id == get_master_command_uid()) {
      master_cmd_writer_for_thread_ = get_writer(dest_id);
    }
    if (dest_id == location::PUBLIC) {
      public_writer_ = get_writer(location::PUBLIC);
    }
  }
}

BrokerService_ptr TraderVendor::get_service() { return service_; }

AlgoOrderService &TraderVendor::get_algo_order_service() { return algo_order_service_; }

const AlgoOrderService &TraderVendor::get_algo_order_service() const { return algo_order_service_; }

OrderService &TraderVendor::get_order_service() { return order_service_; }

const OrderService &TraderVendor::get_order_service() const { return order_service_; }

OrderTriggerService &TraderVendor::get_order_trigger_service() { return order_trigger_service_; }

const OrderTriggerService &TraderVendor::get_order_trigger_service() const { return order_trigger_service_; }

void TraderVendor::on_active() {
  order_service_.on_active();
  algo_order_service_.on_active();
  order_trigger_service_.on_active();
}

void TraderVendor::on_frame() {
  apprentice::on_frame();
  order_service_.on_frame();
  algo_order_service_.on_frame();
  order_trigger_service_.on_frame();
}

void TraderVendor::on_recover() {
  algo_order_service_.on_recover();
  service_->on_recover();
}

// ====================== TraderVendor end ======================

} // namespace kungfu::wingchun::broker