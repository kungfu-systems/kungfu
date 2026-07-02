// SPDX-License-Identifier: Apache-2.0
#include <kungfu/wingchun/operator/runner.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun::broker;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::practice;

namespace kungfu::wingchun::op {
Runner::Runner(locator_ptr locator, const std::string &group, const std::string &name, mode m, bool low_latency,
               const std::string &arguments)
    : apprentice(location::make_shared(m, category::OPERATOR, group, name, std::move(locator)), low_latency,
                 arguments) {}

Context_ptr Runner::get_context() const { return context_; }

Context_ptr Runner::make_context() {
  if (get_home()->mode == mode::BACKTEST) {
    if (not from_indexer_) {
      from_indexer_ = std::make_shared<tool::SliceIndexer>(get_begin_time(), get_end_time());
      SPDLOG_WARN("Runner in backtest mode not specified from_indexer, Default NameHashingIndexer used.");
    }
    if (not to_indexer_) {
      to_indexer_ = std::make_shared<tool::SliceIndexer>(get_begin_time(), get_end_time());
      SPDLOG_WARN("Runner in backtest mode not specified to_indexer, Default NameHashingIndexer used.");
    }
    if (not report_) {
      report_ = std::make_shared<tool::Report>();
      SPDLOG_WARN("Runner in backtest mode not specified.");
    }
    nlohmann::json j_obj = nlohmann::json::parse(backtest_config_);
    std::string report_config = j_obj["Report"].dump();
    init_report(*report_, this, nullptr, report_config);
    return std::make_shared<BacktestContext>(*this, events_, std::move(from_indexer_), std::move(to_indexer_), report_,
                                             time_interval_, std::move(backtest_config_));
  }

  return std::make_shared<LiveContext>(*this, events_);
}

void Runner::add_operator(const Operator_ptr &op) { operators_.push_back(op); }

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

void Runner::on_react() {
  context_ = make_context();
  make_operator_dir(*context_, operator_dir_);
}

void Runner::on_start() {
  pre_start();
  enable(*context_);

  auto resume_policy_is_now = context_->get_resume_policy() == longfist::enums::ResumePolicy::Now;
  auto start_events =
      events_ | skip_until(events_ | filter([&](auto e) {
                             return resume_policy_is_now ? context_->is_started() and has_post_started_ : true;
                           }));
  start_events | is(Quote::tag) |
      $$(invoke(&Operator::on_quote, event->data<Quote>(), get_location(event->source()), event->dest()));
  start_events | is(Tree::tag) |
      $$(invoke(&Operator::on_tree, event->data<Tree>(), get_location(event->source()), event->dest()));
  start_events | is(Depth::tag) |
      $$(invoke(&Operator::on_depth, event->data<Depth>(), get_location(event->source()), event->dest()));
  start_events | is(Tick::tag) |
      $$(invoke(&Operator::on_tick, event->data<Tick>(), get_location(event->source()), event->dest()));
  start_events | is(Entrust::tag) |
      $$(invoke(&Operator::on_entrust, event->data<Entrust>(), get_location(event->source()), event->dest()));
  start_events | is(Transaction::tag) |
      $$(invoke(&Operator::on_transaction, event->data<Transaction>(), get_location(event->source()), event->dest()));
  start_events | is(SyntheticData::tag) |
      $$(invoke(&Operator::on_synthetic_data, event->data<SyntheticData>(), get_location(event->source()),
                event->dest()));
  events_ | is(BrokerStateUpdate::tag) |
      $$(invoke(&Operator::on_broker_state_change, event->data<BrokerStateUpdate>(), get_location(event->source())));
  events_ | is(OperatorStateUpdate::tag) |
      $$(invoke(&Operator::on_operator_state_change, event->data<OperatorStateUpdate>(),
                get_location(event->source())));
  events_ | is(Deregister::tag) |
      $$(invoke(&Operator::on_deregister, event->data<Deregister>(), get_location(event->source())));

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

void Runner::pre_start() { invoke(&Operator::pre_start); }

void Runner::post_start() {
  if (not context_->is_started()) {
    return;
  }

  invoke(&Operator::post_start);
  has_post_started_ = true;
}

void Runner::pre_stop() { invoke(&Operator::pre_stop); }

void Runner::post_stop() {
  invoke(&Operator::post_stop);
  stop(*context_);
}

bool Runner::is_reactable(const event_ptr &event) {
  auto iter = map_is_own_event.find(event->msg_type());
  if (iter != map_is_own_event.end()) {
    return iter->second(context_->get_broker_client(), event);
  }
  return not is_custom_event(event);
}

void Runner::set_operator_dir(const std::string &operator_dir) { operator_dir_ = operator_dir; }
} // namespace kungfu::wingchun::op
