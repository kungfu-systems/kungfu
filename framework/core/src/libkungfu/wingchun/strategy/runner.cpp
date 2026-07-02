// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#include <kungfu/wingchun/strategy/runner.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun::broker;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::practice;

namespace kungfu::wingchun::strategy {

Runner::Runner(const locator_ptr &locator, const std::string &group, const std::string &name, mode m, bool low_latency,
               const std::string &arguments)
    : apprentice(location::make_shared(m, category::STRATEGY, group, name, locator), low_latency, arguments) {}

Context_ptr Runner::get_context() const { return context_; }

Context_ptr Runner::make_context() {
  if (get_home()->mode == mode::BACKTEST) {
    if (not from_indexer_) {
      from_indexer_ = std::make_shared<tool::SliceIndexer>(get_begin_time(), get_end_time());
      SPDLOG_WARN("Runner in backtest mode not specified from_indexer, Default NameHashingIndexer used.");
    }
    if (not to_indexer_) {
      to_indexer_ = std::make_shared<tool::SliceIndexer>(get_begin_time(), get_end_time());
      SPDLOG_INFO("Runner in backtest mode not specified to_indexer, Default NameHashingIndexer used.");
    }
    if (not matcher_) {
      matcher_ = std::make_shared<BasicMatcher>();
      SPDLOG_WARN("Runner in backtest mode not specified Matcher, Default Quote-based Matcher used.");
    }
    if (not report_) {
      report_ = std::make_shared<tool::Report>();
      SPDLOG_WARN("Runner in backtest mode not specified Report.");
    }
    nlohmann::json j_obj = nlohmann::json::parse(backtest_config_);
    std::string matcher_config = j_obj["Matcher"].dump();
    std::string report_config = j_obj["Report"].dump();
    set_runner(*matcher_, this);
    auto backtest_context =
        std::make_shared<BacktestContext>(*this, events_, matcher_, std::move(from_indexer_), std::move(to_indexer_),
                                          report_, time_interval_, std::move(backtest_config_));
    init_matcher(*matcher_, std::addressof(backtest_context->get_bookkeeper()), matcher_config);
    init_report(*report_, this, std::addressof(backtest_context->get_bookkeeper()), report_config);
    return backtest_context;
  }

  return std::make_shared<LiveContext>(*this, events_);
}

void Runner::add_strategy(const Strategy_ptr &strategy) { strategies_.push_back(strategy); }

void Runner::set_matcher(const Matcher_ptr &matcher) { matcher_ = matcher; }

void Runner::set_from_indexer(const tool::SliceIndexer_ptr &indexer) { from_indexer_ = indexer; }

void Runner::set_to_indexer(const tool::SliceIndexer_ptr &indexer) { to_indexer_ = indexer; }

void Runner::set_report(const tool::Report_ptr &report) { report_ = report; }

void Runner::set_time_interval(int64_t time_interval) {
  if (time_interval <= 0) {
    throw wingchun_error(fmt::format("time_interval should be positive other than {}", time_interval_));
  }
  if (time_interval <= 100 * yijinjing::time_unit::NANOSECONDS_PER_MILLISECOND) {
    SPDLOG_WARN("No need to make time_interval smaller than 100ms which will cause to much resource.");
  }
  time_interval_ = time_interval;
}

void Runner::set_backtest_config(const std::string &backtest_config) { backtest_config_ = backtest_config; }

tool::Report_ptr Runner::get_report() const { return report_; }

void Runner::on_exit() { post_stop(); }

void Runner::react() {
  context_ = make_context();
  make_strategy_dir(*context_, strategy_dir_);
  context_->get_bookkeeper().add_book_listener(std::make_shared<BookListener>(*this));
  apprentice::react();
}

void Runner::on_react() { events_ | is(Channel::tag) | $$(inspect_channel(event)); }

void Runner::inspect_channel(const event_ptr &event) {
  auto channel = event->data<Channel>();
  if (has_location(channel.source_id) and has_location(channel.dest_id)) {
    auto dest_location = get_location(channel.dest_id);
    if (ledger_home_location_->uid == channel.source_id and dest_location->category == category::TD and
        context_->get_broker_client().should_connect_td(dest_location)) {
      reader_join(channel.source_id, channel.dest_id, event->gen_time());
    }
  }
}

void Runner::on_start() {
  pre_start();
  enable(*context_);

  bool resume_policy_is_now = context_->get_resume_policy() == longfist::enums::ResumePolicy::Now;
  auto start_events =
      events_ | skip_until(events_ | filter([&, resume_policy_is_now](auto e) {
                             return resume_policy_is_now ? context_->is_started() and has_post_started_ : true;
                           }));
  start_events | is(Quote::tag) |
      $$(invoke(&Strategy::on_quote, event->data<Quote>(), get_location(event->source()), event->dest()));
  start_events | is(Tree::tag) |
      $$(invoke(&Strategy::on_tree, event->data<Tree>(), get_location(event->source()), event->dest()));
  start_events | is(Depth::tag) |
      $$(invoke(&Strategy::on_depth, event->data<Depth>(), get_location(event->source()), event->dest()));
  start_events | is(Tick::tag) |
      $$(invoke(&Strategy::on_tick, event->data<Tick>(), get_location(event->source()), event->dest()));
  start_events | is(Entrust::tag) |
      $$(invoke(&Strategy::on_entrust, event->data<Entrust>(), get_location(event->source()), event->dest()));
  start_events | is(Transaction::tag) |
      $$(invoke(&Strategy::on_transaction, event->data<Transaction>(), get_location(event->source()), event->dest()));
  start_events | is(SyntheticData::tag) |
      $$(invoke(&Strategy::on_synthetic_data, event->data<SyntheticData>(), get_location(event->source()),
                event->dest()));

  events_ | is(BrokerStateUpdate::tag) |
      $$(invoke(&Strategy::on_broker_state_change, event->data<BrokerStateUpdate>(), get_location(event->source())));
  events_ | is(OperatorStateUpdate::tag) |
      $$(invoke(&Strategy::on_operator_state_change, event->data<OperatorStateUpdate>(),
                get_location(event->source())));
  events_ | is(Deregister::tag) |
      $$(invoke(&Strategy::on_deregister, event->data<Deregister>(), get_location(event->source())));

  events_ | take_until(events_ | filter([&](auto e) { return context_->is_started(); })) |
      $$(prepare(event, *context_));

  if (context_->is_started()) {
    post_start();
  } else {
    events_ | filter([&](auto e) { return context_->is_started(); }) | first() | $$(post_start());
  }
}

void Runner::on_active() {
  if (not is_live()) {
    pre_stop();
  }
}

void Runner::pre_start() { invoke(&Strategy::pre_start); }

void Runner::post_start() {
  if (not context_->is_started()) {
    return; // safe guard for live mode, in that case we will run truly when prepare process is done.
  }

  invoke(&Strategy::post_start);
  has_post_started_ = true;

  events_ | is(Order::tag) |
      $$(invoke(&Strategy::on_order, event->data<Order>(), get_location(event->source()), event->dest()));
  events_ | is(OrderTrigger::tag) |
      $$(invoke(&Strategy::on_order_trigger, event->data<OrderTrigger>(), get_location(event->source()),
                event->dest()));
  events_ | is(AlgoOrder::tag) |
      $$(invoke(&Strategy::on_algo_order, event->data<AlgoOrder>(), get_location(event->source()), event->dest()));
  events_ | is(Trade::tag) |
      $$(invoke(&Strategy::on_trade, event->data<Trade>(), get_location(event->source()), event->dest()));
  events_ | is(HistoryOrder::tag) |
      $$(invoke(&Strategy::on_history_order, event->data<HistoryOrder>(), get_location(event->source()),
                event->dest()));
  events_ | is(HistoryTrade::tag) |
      $$(invoke(&Strategy::on_history_trade, event->data<HistoryTrade>(), get_location(event->source()),
                event->dest()));
  events_ | is(RequestHistoryOrderError::tag) |
      $$(invoke(&Strategy::on_req_history_order_error, event->data<RequestHistoryOrderError>(),
                get_location(event->source()), event->dest()));
  events_ | is(RequestHistoryTradeError::tag) |
      $$(invoke(&Strategy::on_req_history_trade_error, event->data<RequestHistoryTradeError>(),
                get_location(event->source()), event->dest()));
  events_ | is(OrderActionError::tag) |
      $$(invoke(&Strategy::on_order_action_error, event->data<OrderActionError>(), get_location(event->source()),
                event->dest()));
  events_ | is(OrderTriggerActionError::tag) |
      $$(invoke(&Strategy::on_order_trigger_action_error, event->data<OrderTriggerActionError>(),
                get_location(event->source()), event->dest()));
  events_ | is(AlgoOrderActionError::tag) |
      $$(invoke(&Strategy::on_algo_order_action_error, event->data<AlgoOrderActionError>(),
                get_location(event->source()), event->dest()));
}

void Runner::pre_stop() { invoke(&Strategy::pre_stop); }

void Runner::post_stop() {
  invoke(&Strategy::post_stop);
  stop(*context_);
}

bool Runner::is_reactable(const event_ptr &event) {
  if (is_custom_event(event)) {
    invoke(&Strategy::on_custom_data, event->msg_type(),
           {event->data_as_bytes(), event->data_as_bytes() + event->data_length()}, event->data_length(),
           get_location(event->source()), event->dest());
    return false;
  }

  auto iter = map_is_own_event.find(event->msg_type());
  if (iter != map_is_own_event.end()) {
    return iter->second(context_->get_broker_client(), event);
  }
  return true;
}

void Runner::set_strategy_dir(const std::string &strategy_dir) { strategy_dir_ = strategy_dir; }

Runner::BookListener::BookListener(Runner &runner) : runner_(runner) {}

void Runner::BookListener::on_position_sync_reset(const book::Book &old_book, const book::Book &new_book) {
  auto context = std::dynamic_pointer_cast<Context>(runner_.context_);
  for (const auto &strategy : runner_.strategies_) {
    strategy->on_position_sync_reset(context, old_book, new_book);
  }
}

void Runner::BookListener::on_asset_sync_reset(const longfist::types::Asset &old_asset,
                                               const longfist::types::Asset &new_asset) {
  auto context = std::dynamic_pointer_cast<Context>(runner_.context_);
  for (const auto &strategy : runner_.strategies_) {
    strategy->on_asset_sync_reset(context, old_asset, new_asset);
  }
}

} // namespace kungfu::wingchun::strategy
