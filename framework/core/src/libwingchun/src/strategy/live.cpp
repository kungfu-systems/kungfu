// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020-07-20.
//

#include <fmt/format.h>

#include <kungfu/wingchun/strategy/live.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::wingchun::factor;

namespace kungfu::wingchun::strategy {

std::shared_ptr<LiveStreamDataBatcher> LiveContext::live_stream_data_batcher_ = nullptr;

LiveContext::LiveContext(apprentice &app, const rx::connectable_observable<event_ptr> &events)
    : Context(app, events), broker_client_(app_), bookkeeper_(app_, broker_client_) {
  KUNGFU_SETUP_LOGGER(app_.get_home(), app_.get_home()->name);
}

void LiveContext::on_start() {
  broker_client_.on_start(events_);
  if (not is_bypass_accounting()) {
    bookkeeper_.on_start(events_);
  }
}

bool LiveContext::is_started() const { return started_; }

void LiveContext::prepare(const event_ptr &event) {
  if (event->msg_type() == Position::tag) {
    const Position &position = event->data<Position>();
    if (position.holder_uid == get_live_home_uid()) {
      get_broker_client().subscribe(position.exchange_id, position.instrument_id);
    }
  }

  auto ledger_uid = app_.get_ledger_home_location()->uid;
  if (not app_.has_writer(ledger_uid)) {
    return;
  }
  auto writer = app_.get_writer(ledger_uid);

  if (not broker_states_requested_ and broker_client_.enrolled_md_connected() and
      broker_client_.enrolled_operator_connected() and broker_client_.enrolled_td_connected()) {
    writer->mark(now(), BrokerStateRequest::tag);
    writer->mark(now(), OperatorStateRequest::tag);
    broker_states_requested_ = true;
  }

  if (not broker_client_.enrolled_td_ready() or not broker_client_.enrolled_md_ready() or
      not broker_client_.enrolled_operator_ready()) {
    return;
  }

  if (not broker_client_.has_enrolled_td_channel(get_live_home_uid())) {
    return;
  }

  if (not positions_requested_) {
    if (is_positions_held()) {
      // Start - Let ledger prepare book for strategy
      writer->mark(now(), KeepPositionsRequest::tag);
    }

    if (not is_book_held()) {
      writer->mark(now(), ResetBookRequest::tag);
    }

    for (const auto &td_pair : broker_client_.get_enrolled_td_locations()) {
      writer->write(now(), td_pair.second->to<OutputKey>());
    }

    for (const auto &pair : get_broker_client().get_instrument_keys()) {
      writer->write(now(), pair.second);
    }

    // in hold position situation, mirror position help to keep avg_open_price and position volume is reset by
    // RebuildPositionsRequest
    writer->mark(now(), MirrorPositionsRequest::tag);

    // End - Let ledger prepare book for strategy
    if (is_positions_held()) {
      writer->mark(now(), RebuildPositionsRequest::tag);
    }

    // Request ledger to recover book for strategy
    writer->mark(now(), AssetRequest::tag);
    writer->mark(now(), PositionRequest::tag);
    positions_requested_ = true;
    return;
  }

  if (event->msg_type() == PositionEnd::tag and event->source() == ledger_uid) {
    if (event->data<PositionEnd>().holder_uid == get_live_home_uid()) {
      positions_set_ = true;
    }
  }

  if (not positions_set_) {
    return;
  }

  get_bookkeeper().guard_positions();
  started_ = true;
}

std::string LiveContext::get_config() const {
  auto &config_map = app_.get_state_bank()[boost::hana::type_c<Config>];
  if (config_map.find(app_.get_live_home_uid()) == config_map.end()) {
    return "{}";
  }
  auto &config_obj = config_map.at(app_.get_live_home_uid());
  return config_obj.data.value;
}

int64_t LiveContext::now() const { return app_.now(); }

int32_t LiveContext::add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) {
  return app_.add_timer(nanotime, callback);
}

int32_t LiveContext::add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) {
  return app_.add_time_interval(duration, callback);
}

void LiveContext::clear_timer(int32_t timer_id) { app_.clear_timer(timer_id); }

void LiveContext::add_account(const std::string &source, const std::string &account) {
  auto home = app_.get_live_home();
  auto account_location = location::make_shared(mode::LIVE, category::TD, source, account, home->locator);
  if (not app_.has_location(account_location->uid)) {
    SPDLOG_ERROR("invalid account {}_{}", source, account);
    throw wingchun_error(fmt::format("invalid account {}_{}", source, account));
  }
  broker_client_.enroll_td(account_location);
}

void LiveContext::subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                            const std::string &exchange_ids) {
  auto md_location = broker_client_.find_md_location(source, app_.get_live_home());
  for (const auto &instrument_id : instrument_ids) {
    broker_client_.subscribe(md_location, exchange_ids, instrument_id);
  }
  ensure_connect();
  send_instrument_keys();
}

void LiveContext::subscribe_all(const std::string &source, uint8_t market_type, uint64_t instrument_type,
                                uint64_t data_type) {
  auto md_location = broker_client_.find_md_location(source, app_.get_live_home());
  broker_client_.subscribe_all(md_location, market_type, instrument_type, data_type);
  ensure_connect();
  send_instrument_keys();
}

void LiveContext::subscribe_operator(const std::string &group, const std::string &name) {
  auto home = app_.get_live_home();
  auto operator_location = location::make_shared(mode::LIVE, category::OPERATOR, group, name, home->locator);
  if (not app_.has_location(operator_location->uid)) {
    SPDLOG_ERROR("subscribe operator no location");
    throw wingchun_error(fmt::format("invalid operator {}_{}", group, name));
  }

  broker_client_.enroll_operator(operator_location);
}

uint64_t LiveContext::insert_block_message(const std::string &source, const std::string &account,
                                           const std::string &opponent_seat, uint64_t match_number, bool is_specific) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  BlockMessage &msg = writer->open_data<BlockMessage>(now());
  kungfu::copy_string(msg.opponent_seat, opponent_seat.c_str());
  msg.match_number = match_number;
  msg.is_specific = is_specific;
  msg.block_id = writer->current_frame_uid();
  writer->close_data();
  return msg.block_id;
}

uint64_t LiveContext::insert_order_trigger(const std::string &instrument_id, const std::string &exchange_id,
                                           const std::string &source, const std::string &account, double limit_price,
                                           double volume, longfist::enums::PriceType type, longfist::enums::Side side,
                                           longfist::enums::Offset offset,
                                           longfist::enums::OrderTriggerType trigger_type, double stop_price,
                                           longfist::enums::HedgeFlag hedge_flag, bool is_swap) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  auto instrument_type = get_instrument_type(exchange_id, instrument_id);
  if (instrument_type == InstrumentType::Unknown) {
    SPDLOG_ERROR("unsupported instrument type {} of {}.{}", str_from_instrument_type(instrument_type), instrument_id,
                 exchange_id);
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  OrderTriggerInput &input = writer->open_data<OrderTriggerInput>(now());
  input.trigger_id = writer->current_frame_uid();
  kungfu::copy_string(input.instrument_id, instrument_id.c_str());
  kungfu::copy_string(input.exchange_id, exchange_id.c_str());
  input.instrument_type = instrument_type;
  input.limit_price = limit_price;
  input.frozen_price = limit_price;
  input.volume = volume;
  input.stop_price = stop_price;
  input.price_type = type;
  input.side = side;
  input.offset = offset;
  input.hedge_flag = hedge_flag;
  input.is_swap = is_swap;
  input.insert_time = now();
  writer->close_data();
  return input.trigger_id;
}

uint64_t LiveContext::insert_order(const std::string &instrument_id, const std::string &exchange_id,
                                   const std::string &source, const std::string &account, double limit_price,
                                   double volume, PriceType type, Side side, Offset offset, HedgeFlag hedge_flag,
                                   bool is_swap, uint64_t block_id, uint64_t parent_id,
                                   const std::string &contract_id) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  auto instrument_type = get_instrument_type(exchange_id, instrument_id);
  if (instrument_type == InstrumentType::Unknown) {
    SPDLOG_ERROR("unsupported instrument type {} of {}.{}", str_from_instrument_type(instrument_type), instrument_id,
                 exchange_id);
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  OrderInput &input = writer->open_data<OrderInput>(now());
  input.order_id = writer->current_frame_uid();
  kungfu::copy_string(input.instrument_id, instrument_id.c_str());
  kungfu::copy_string(input.exchange_id, exchange_id.c_str());
  input.instrument_type = instrument_type;
  input.limit_price = limit_price;
  input.frozen_price = limit_price;
  input.volume = volume;
  input.price_type = type;
  input.side = side;
  input.offset = offset;
  input.hedge_flag = hedge_flag;
  input.block_id = block_id;
  input.parent_id = parent_id;
  input.is_swap = is_swap;
  input.contract_id = contract_id.c_str();
  input.insert_time = now();
  writer->close_data();
  if (not is_bypass_accounting()) {
    bookkeeper_.on_order_input(now(), get_live_home_uid(), account_location_uid, input);
  }
  return input.order_id;
}

uint64_t LiveContext::insert_order_input(const std::string &source, const std::string &account,
                                         longfist::types::OrderInput &order_input) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  order_input.instrument_type = get_instrument_type(order_input.exchange_id, order_input.instrument_id);
  if (order_input.instrument_type == InstrumentType::Unknown) {
    SPDLOG_ERROR("unsupported instrument type {} of {}.{}", str_from_instrument_type(order_input.instrument_type),
                 order_input.instrument_id, order_input.exchange_id);
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  OrderInput &input = writer->open_data<OrderInput>(now());
  order_input.order_id = order_input.order_id == 0 ? writer->current_frame_uid() : order_input.order_id;
  order_input.insert_time = now();
  memcpy(&input, &order_input, sizeof(input));
  writer->close_data();
  if (not is_bypass_accounting()) {
    bookkeeper_.on_order_input(now(), get_live_home_uid(), account_location_uid, order_input);
  }
  return order_input.order_id;
}

std::vector<uint64_t> LiveContext::insert_batch_orders(
    const std::string &source, const std::string &account, const std::vector<std::string> &instrument_ids,
    const std::vector<std::string> &exchange_ids, std::vector<double> limit_prices, std::vector<double> volumes,
    std::vector<longfist::enums::PriceType> types, std::vector<longfist::enums::Side> sides,
    std::vector<longfist::enums::Offset> offsets, std::vector<longfist::enums::HedgeFlag> hedge_flags,
    std::vector<bool> is_swaps, const std::vector<std::string> &contract_ids) {
  std::vector<uint64_t> order_ids{};
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return order_ids;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return order_ids;
  }

  bool flag = instrument_ids.size() == exchange_ids.size() and //
              instrument_ids.size() == limit_prices.size() and //
              instrument_ids.size() == volumes.size() and      //
              instrument_ids.size() == types.size() and        //
              instrument_ids.size() == sides.size() and        //
              instrument_ids.size() == offsets.size() and      //
              instrument_ids.size() == hedge_flags.size() and  //
              instrument_ids.size() == is_swaps.size() and     //
              instrument_ids.size() == contract_ids.size();
  if (not flag) {
    SPDLOG_ERROR("Batch size not equals!");
    return order_ids;
  }

  auto writer = app_.get_writer(account_location_uid);
  writer->mark(now(), BatchOrderBegin::tag);

  for (int i = 0; i < instrument_ids.size(); ++i) {
    uint64_t order_id = insert_order(instrument_ids.at(i), exchange_ids.at(i), source, account, limit_prices.at(i),
                                     volumes.at(i), types.at(i), sides.at(i), offsets.at(i), hedge_flags.at(i),
                                     is_swaps.at(i), 0, 0, contract_ids.at(i));
    order_ids.push_back(order_id);
  }

  writer->mark(now(), BatchOrderEnd::tag);
  return order_ids;
}

std::vector<uint64_t> LiveContext::insert_array_orders(const std::string &source, const std::string &account,
                                                       std::vector<longfist::types::OrderInput> &order_inputs) {
  std::vector<uint64_t> order_ids{};
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return order_ids;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return order_ids;
  }

  auto writer = app_.get_writer(account_location_uid);
  writer->mark(now(), BatchOrderBegin::tag);

  for (OrderInput &input : order_inputs) {
    uint64_t order_id = insert_order_input(source, account, input);
    order_ids.push_back(order_id);
  }

  writer->mark(now(), BatchOrderEnd::tag);
  return order_ids;
}

uint64_t LiveContext::insert_algo_order(const std::string &instrument_id, const std::string &exchange_id,
                                        const std::string &source, const std::string &account, int64_t begin_time,
                                        int64_t end_time, double volume, longfist::enums::PriceType type,
                                        longfist::enums::Side side, longfist::enums::Offset offset,
                                        const std::string &algo_type_id, const std::string &algo_id,
                                        const std::string &args, bool is_local, uint32_t basket_uid,
                                        longfist::enums::PriceLevel price_level, double price_offset) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }

  auto writer = app_.get_writer(account_location_uid);
  AlgoOrderInput input = {};
  input.order_id = writer->current_frame_uid();
  input.insert_time = now();
  input.begin_time = begin_time;
  input.end_time = end_time;
  kungfu::copy_string(input.instrument_id, instrument_id.c_str());
  kungfu::copy_string(input.exchange_id, exchange_id.c_str());
  input.instrument_type = get_instrument_type(exchange_id, instrument_id);
  input.basket_uid = basket_uid;
  input.side = side;
  input.offset = offset;
  input.price_type = type;
  input.price_level = price_level;
  input.price_offset = price_offset;
  input.volume = volume;
  kungfu::copy_string(input.algo_type_id, algo_type_id.c_str());
  kungfu::copy_string(input.algo_id, algo_id.c_str());
  input.args = args;
  input.is_local = is_local;
  writer->write(now(), input);

  if (not is_bypass_accounting()) {
    bookkeeper_.on_algo_order_input(now(), get_live_home_uid(), account_location_uid, input);
  }
  return input.order_id;
}

uint64_t LiveContext::update_algo_order_volume(uint64_t origin_order_id, const std::string &source,
                                               const std::string &account, double volume) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }

  auto writer = app_.get_writer(account_location_uid);
  AlgoOrderInput input = {};
  input.order_id = writer->current_frame_uid();
  input.origin_order_id = origin_order_id;
  input.volume = volume;
  input.is_local = true;
  input.insert_time = now();

  writer->write(now(), input);
  return input.order_id;
}

uint64_t LiveContext::cancel_order(uint64_t order_id, OrderActionFlag action_flag) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  uint32_t account_location_uid = (order_id >> 32u) xor (get_live_home_uid());
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  OrderAction &action = writer->open_data<OrderAction>(0);

  action.order_action_id = writer->current_frame_uid();
  action.order_id = order_id;
  action.action_flag = action_flag;
  action.insert_time = now();

  writer->close_data();
  return action.order_action_id;
}

uint64_t LiveContext::cancel_order_trigger(uint64_t trigger_id) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  uint32_t account_location_uid = (trigger_id >> 32u) xor (get_live_home_uid());
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  OrderTriggerAction &action = writer->open_data<OrderTriggerAction>(0);

  action.order_trigger_action_id = writer->current_frame_uid();
  action.trigger_id = trigger_id;
  action.action_flag = OrderActionFlag::Cancel;
  action.insert_time = now();

  writer->close_data();
  return action.order_trigger_action_id;
}

uint64_t LiveContext::cancel_algo_order(uint64_t algo_order_id, AlgoOrderActionFlag action_flag) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  uint32_t account_location_uid = (algo_order_id >> 32u) xor (get_live_home_uid());
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }

  auto account_location = app_.get_location(account_location_uid);
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page(); // prevent that page released after close_data
  AlgoOrderAction &action = writer->open_data<AlgoOrderAction>(0);
  action.order_action_id = writer->current_frame_uid();
  action.order_id = algo_order_id;
  action.action_flag = action_flag;
  action.insert_time = now();

  writer->close_data();
  return action.order_action_id;
}

uint64_t LiveContext::toggle_algo_order(uint64_t algo_order_id, longfist::enums::AlgoOrderActionFlag action_flag) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return 0;
  }

  uint32_t account_location_uid = (algo_order_id >> 32u) xor (get_live_home_uid());
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("toggle_algo_order account {} not ready", app_.get_location_uname(account_location_uid));
    return 0;
  }

  auto account_location = app_.get_location(account_location_uid);
  auto writer = app_.get_writer(account_location_uid);
  page_ptr page = writer->get_current_page();
  AlgoOrderAction &action = writer->open_data<AlgoOrderAction>(0);
  action.order_action_id = writer->current_frame_uid();
  action.order_id = algo_order_id;
  action.action_flag = action_flag;
  writer->close_data();
  return action.order_action_id;
}

broker::Client &LiveContext::get_broker_client() { return broker_client_; }

book::Bookkeeper &LiveContext::get_bookkeeper() { return bookkeeper_; }

void LiveContext::req_history_order(const std::string &source, const std::string &account, uint32_t query_num) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {}_{} not ready", source, account);
    return;
  }
  auto writer = app_.get_writer(account_location_uid);
  RequestHistoryOrder &request = writer->open_data<RequestHistoryOrder>();
  request.trigger_time = now();
  request.query_num = query_num;
  writer->close_data();
}

void LiveContext::req_history_trade(const std::string &source, const std::string &account, uint32_t query_num) {
  if (not is_started()) {
    SPDLOG_ERROR("context not ready");
    return;
  }

  auto account_location_uid = broker_client_.get_td_location_uid(source, account);
  if (not broker_client_.is_ready(account_location_uid)) {
    SPDLOG_ERROR("account {}_{} not ready", source, account);
    return;
  }
  auto writer = app_.get_writer(account_location_uid);
  RequestHistoryTrade &request = writer->open_data<RequestHistoryTrade>();
  request.trigger_time = now();
  request.query_num = query_num;
  writer->close_data();
}

void LiveContext::req_deregister() { app_.request_deregister(); }

void LiveContext::update_strategy_state(StrategyStateUpdate &state_update) {
  auto writer = app_.get_writer(location::PUBLIC);
  state_update.update_time = now();
  writer->write(state_update.update_time, state_update);
}

void LiveContext::ensure_connect() {
  if (not started_) {
    return;
  }

  const event_ptr &e = app_.get_reader()->current_frame();
  for (const auto &pair : app_.get_registry()) {
    SPDLOG_DEBUG("Register: {}", pair.second.to_string());
    broker_client_.connect(e, pair.second);
  }

  for (const auto &pair : app_.get_bands()) {
    SPDLOG_DEBUG("Band: {}", pair.second.to_string());
    broker_client_.connect(e, pair.second);
  }
}

void LiveContext::send_instrument_keys() {
  if (not is_started()) {
    return;
  }
  for (const auto &pair : app_.get_locations()) {
    SPDLOG_DEBUG("Location: {}", pair.second->to_string());
    broker_client_.try_renew(now(), pair.second);
  }
}

yijinjing::data::location_ptr LiveContext::get_location(uint32_t location_uid) {
  return app_.get_location(location_uid);
}

void LiveContext::set_resume_policy(longfist::enums::ResumePolicy resume_policy) {
  broker_client_.set_resume_policy(resume_policy);
}

longfist::enums::ResumePolicy LiveContext::get_resume_policy() { return broker_client_.get_resume_policy_value(); }

uint32_t LiveContext::get_home_uid() const { return app_.get_home_uid(); }

uint32_t LiveContext::get_live_home_uid() const { return app_.get_live_home_uid(); }

std::shared_ptr<StreamDataBatcher> LiveContext::batch_streaming() {
  if (!live_stream_data_batcher_) {
    live_stream_data_batcher_ = std::make_shared<LiveStreamDataBatcher>();
    live_stream_data_batcher_->on_start(events_);
  }
  return live_stream_data_batcher_;
}

} // namespace kungfu::wingchun::strategy
