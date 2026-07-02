// SPDX-License-Identifier: Apache-2.0
#include <kungfu/wingchun/operator/backtest.h>

using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;
using namespace kungfu::wingchun::tool;
using kungfu::yijinjing::nanomsg::nanomsg_json;
using namespace kungfu::wingchun::factor;

namespace kungfu::wingchun::op {

std::shared_ptr<BackTestStreamDataBatcher> BacktestContext::backtest_stream_data_batcher_ = nullptr;

BacktestContext::BacktestContext(apprentice &app, const rx::connectable_observable<event_ptr> &events,
                                 SliceIndexer_ptr from_indexer, SliceIndexer_ptr to_indexer, Report_ptr report,
                                 int64_t time_interval, std::string backtest_config)
    : Context(app, events), broker_client_(app), bookkeeper_(app_, broker_client_),
      from_indexer_(std::move(from_indexer)),
      slice_tool_(std::make_shared<SliceTool>(category::OPERATOR, app.get_home()->group, app.get_home()->name,
                                              std::move(to_indexer))),
      report_(std::move(report)), time_interval_(time_interval), backtest_config_(std::move(backtest_config)) {
  KUNGFU_SETUP_LOGGER(app_.get_home(), app_.get_home()->name);
}

void BacktestContext::post_stop() {
  std::vector<location_ptr> unreleased_locations;
  // TODO use C++20 range
  // TODO deconstructor not called ?
  SPDLOG_TRACE("unreleased sliced location checking.");

  for (const auto &[slice_location_obj, reference_state] : slice_reference_states_) {
    if (reference_state.reference_count > 0 or reference_state.state != SliceState::Released) {
      auto slice_location = std::make_shared<location>(slice_location_obj);
      unreleased_locations.push_back(slice_location);
      if (reference_state.reference_count > 0)
        SPDLOG_DEBUG("sliced location locator={}, location={} reference count={} is not released, now releasing",
                     slice_location->locator->get_root(), slice_location->uname, reference_state.reference_count);
      from_indexer_->submit_release_location(slice_location);
    }
  }
  std::for_each(unreleased_locations.begin(), unreleased_locations.end(), [this](const auto &slice_location) {
    from_indexer_->wait_release_location(slice_location);
    SPDLOG_TRACE("sliced location locator={}, location={} released.", slice_location->locator->get_root(),
                 slice_location->uname);
  });
}

void BacktestContext::on_start() {
  bookkeeper_.on_start(events_);

  events_ | is(Quote::tag) | $$(report_->on_quote(event->data<Quote>()););
  events_ | is(Entrust::tag) | $$(report_->on_entrust(event->data<Entrust>()););
  events_ | is(Transaction::tag) | $$(report_->on_transaction(event->data<Transaction>()););
  events_ | is(Tree::tag) | $$(report_->on_tree(event->data<Tree>()););
  events_ | is(Depth::tag) | $$(report_->on_depth(event->data<Depth>()););
  events_ | is(Tick::tag) | $$(report_->on_tick(event->data<Tick>()););
  events_ | is(SyntheticData::tag) | $$(report_->on_read_synthetic_data(event->data<SyntheticData>()));
  events_ | $$(on_timer_check(););
  init_time_events();
  report_->init();
}

bool BacktestContext::is_started() const { return true; }

const std::string BacktestContext::get_config() const {
  // todo figure out how to deal with configure from sqlite.
  return "{}";
}

void BacktestContext::prepare(const event_ptr &event) {}

int64_t BacktestContext::now() const { return app_.now(); }

int32_t BacktestContext::add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) {
  return add_timer_helper(nanotime, timer_usage_count_++, callback);
}

int32_t BacktestContext::add_timer_helper(int64_t nanotime, int32_t timer_id,
                                          const std::function<void(event_ptr)> &callback) {
  if (timer_id < 0) {
    throw wingchun_error(fmt::format("timer_id={} is overflow", timer_id));
  }
  timer_tasks_.emplace_back(timer_id, nanotime, callback);
  std::push_heap(std::begin(timer_tasks_), std::end(timer_tasks_));
  return timer_id;
}

int32_t BacktestContext::add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) {
  const int32_t timer_id = timer_usage_count_++;
  return add_timer_interval_helper(duration, timer_id, callback);
}

int32_t BacktestContext::add_timer_interval_helper(int64_t duration, int32_t timer_id,
                                                   const std::function<void(event_ptr)> &callback) {
  auto timer_callback = [this, callback, duration, timer_id](event_ptr event) {
    callback(event);
    this->add_timer_interval_helper(duration, timer_id, callback);
  };
  timer_tasks_.emplace_back(timer_id, now() + duration, timer_callback);
  std::push_heap(std::begin(timer_tasks_), std::end(timer_tasks_));
  return timer_id;
}

void BacktestContext::clear_timer(int32_t timer_id) {
  if (timer_id <= protected_timer_id_) {
    SPDLOG_WARN("timer_id={} lower than {} is reserved which is not allowed to clear", timer_id, protected_timer_id_);
    return;
  }
  std::erase_if(timer_tasks_, [timer_id](const auto &timer_task) { return timer_task.timer_id == timer_id; });
  std::make_heap(std::begin(timer_tasks_), std::end(timer_tasks_));
}

void BacktestContext::on_timer_check() {
  auto now_time = now();
  if (!timer_tasks_.empty() && timer_tasks_.front().nanotime <= now_time) {
    nlohmann::json time_event;
    time_event["msg_type"] = Time::tag;
    time_event["gen_time"] = now_time;
    time_event["trigger_time"] = now_time;
    time_event["source"] = app_.get_live_home_uid();
    time_event["dest"] = app_.get_live_home_uid();
    time_event["data"] = "";
    auto nanomsg_event = std::make_shared<nanomsg_json>(time_event.dump());
    while (!timer_tasks_.empty() && timer_tasks_.front().nanotime <= now_time) {
      // TODO use app_.make_nano_msg instead
      // Time time_event{};
      std::pop_heap(timer_tasks_.begin(), timer_tasks_.end());
      auto task = timer_tasks_.back();
      timer_tasks_.pop_back();
      task.call_back(nanomsg_event);
    }
  }
}

void BacktestContext::init_time_events() {
  auto writer = app_.get_writer(app_.get_home_uid());
  nlohmann::json j_obj = nlohmann::json::parse(backtest_config_);
  parse_then_write_in_timer<Commission>(j_obj, writer);
  parse_then_write_in_timer<Instrument>(j_obj, writer);

  auto write_next_time_mark = [writer, this](auto e) {
    auto next_time = now() + time_interval_;
    writer->mark_at(next_time, next_time, Time::tag);
  };
  writer->mark_at(app_.now(), app_.now(), Time::tag);
  write_next_time_mark(nullptr);
  protected_timer_id_ = add_time_interval(time_interval_, write_next_time_mark);

  SPDLOG_DEBUG("init {} Time events done.", (app_.get_end_time() - app_.get_begin_time()) / time_interval_);
}

void BacktestContext::subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                                const std::string &exchange_id) {
  for (const auto &instrument_id : instrument_ids) {
    if (broker_client_.is_subscribed(exchange_id, instrument_id)) {
      SPDLOG_WARN("instrument_id={} in exchange={} already subscribed", instrument_id, exchange_id);
      continue;
    }
    boost::hana::for_each(longfist::MarketDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      int64_t slice_begin_time = app_.now();
      subscribe_helper(slice_begin_time, source, instrument_id, exchange_id, DataType::tag);
    });
  }
}

void BacktestContext::subscribe_helper(int64_t begin_time, const std::string &source, const std::string &instrument_id,
                                       const std::string &exchange_id, int32_t data_tag) {
  auto md_location =
      from_indexer_->find_md_slice_location(begin_time, source, source, instrument_id, exchange_id, data_tag);
  auto slice_end_time =
      from_indexer_->get_md_slice_end_time(begin_time, source, source, instrument_id, exchange_id, data_tag);
  int64_t nanotime = begin_time - 1;
  int64_t offset = slice_end_time - begin_time;
  if (md_location) {
    subscribe_slice(md_location, nanotime, offset);
    add_location(app_, md_location);
    // TODO
    broker_client_.subscribe(md_location, exchange_id, instrument_id);
  }
  if (slice_end_time < app_.get_end_time()) {
    add_timer_helper(nanotime, 0,
                     [this, slice_end_time, source, instrument_id, exchange_id, data_tag](event_ptr event) {
                       subscribe_helper(slice_end_time, source, instrument_id, exchange_id, data_tag);
                     });
  }
}

void BacktestContext::subscribe_slice(const location_ptr &slice_location, int64_t nanotime, int64_t offset) {
  auto confirm_callback = [=, this](event_ptr event) {
    auto &reference_count = slice_reference_states_[*slice_location];
    switch (reference_count.state) {
    case SliceState::Acquiring:
      from_indexer_->wait_acquire_location(slice_location);
      reference_count.state = SliceState::Acquired;
      assert(reference_count.reference_count == 0);

      if (slice_location->locator->list_page_id(slice_location, location::PUBLIC).empty()) {
        SPDLOG_WARN("failed to subscribe data between {} and {}, md public journal in locator={}, location={} "
                    "not exists",
                    yijinjing::time::strftime(nanotime + 1), yijinjing::time::strftime(nanotime + offset),
                    slice_location->locator->get_root(), slice_location->uname);
      }
      for (const auto dest_id : slice_location->locator->list_location_dest(slice_location)) {
        SPDLOG_TRACE("subscribed dest {}, locator={}, location={}", dest_id, slice_location->locator->get_root(),
                     slice_location->uname);
        app_.get_reader()->join(slice_location, dest_id, nanotime);
      }
    case SliceState::Acquired:
      reference_count.reference_count += 1;
      break;
    default:
      SPDLOG_ERROR(" probably failed to acquire data between {} and {}, public journal in locator={}, location={} "
                   "not exists",
                   yijinjing::time::strftime(nanotime + 1), yijinjing::time::strftime(nanotime + offset), slice_location->locator->get_root(),
                   slice_location->uname);
      SPDLOG_ERROR("invalid slice state={} with reference count={} at slice data confirm acquiring stage.",
                   static_cast<int>(reference_count.state), reference_count.reference_count);
      return;
    }
    unsubscribe_slice(slice_location, nanotime + offset, offset);
  };
  auto submit_callback = [=, this](event_ptr event) {
    auto &reference_count = slice_reference_states_[*slice_location];
    switch (reference_count.state) {
    case SliceState::Idle:
      from_indexer_->submit_acquire_location(slice_location);
      reference_count.state = SliceState::Acquiring;
    case SliceState::Acquiring:
      add_timer_helper(nanotime, 0, confirm_callback);
      break;
    case SliceState::Acquired:
      SPDLOG_WARN("slice data between {} and {} is already acquired with reference count={}, public journal in "
                  "locator={}, location={}",
                  yijinjing::time::strftime(nanotime + 1), yijinjing::time::strftime(nanotime + offset), reference_count.reference_count,
                  slice_location->locator->get_root(), slice_location->uname);
      break;
    default:
      SPDLOG_ERROR("invalid slice state={} with reference count={} at slice data submit acquiring stage.",
                   static_cast<int>(reference_count.state), reference_count.reference_count);
      return;
    }
  };
  int lead_ratio = from_indexer_->acquire_lead_ratio();
  if (lead_ratio < 0) {
    throw wingchun_error(fmt::format("lead_ratio={} is invalid", lead_ratio));
  }
  add_timer_helper(nanotime - lead_ratio * offset, 0, submit_callback);
}

void BacktestContext::unsubscribe_slice(const location_ptr &slice_location, int64_t nanotime, int64_t offset) {
  int delay_ratio = from_indexer_->release_delay_ratio();
  if (delay_ratio < 0) {
    throw wingchun_error(fmt::format("delay_ratio={} is invalid", delay_ratio));
  }
  auto confirm_callback = [=, this](event_ptr event) {
    auto &reference_count = slice_reference_states_[*slice_location];
    switch (reference_count.state) {
    case SliceState::Releasing:
      from_indexer_->wait_release_location(slice_location);
      reference_count.state = SliceState::Released;

    case SliceState::Released:
      assert(reference_count.reference_count == 0);
      break;
    default:
      SPDLOG_ERROR("invalid slice state={} with reference count={} at slice data confirm releasing stage.",
                   static_cast<int>(reference_count.state), reference_count.reference_count);
      return;
    }
  };
  auto submit_callback = [=, this](event_ptr event) {
    auto &reference_count = slice_reference_states_[*slice_location];
    switch (reference_count.state) {
    case SliceState::Acquired:
      reference_count.reference_count -= 1;
      if (reference_count.reference_count == 0) {
        SPDLOG_TRACE("disjoining sliced location expired, locator={}, location={} at {}",
                     slice_location->locator->get_root(), slice_location->uname, app_.now());
        for (const auto dest_id : slice_location->locator->list_location_dest(slice_location)) {
          SPDLOG_TRACE("disjoining subscribed dest {}, locator={}, location={}", dest_id,
                       slice_location->locator->get_root(), slice_location->uname);
          app_.disjoin_channel(slice_location, dest_id);
        }
        from_indexer_->submit_release_location(slice_location);
        reference_count.state = SliceState::Releasing;
      }
      assert(reference_count.reference_count >= 0);
    case SliceState::Releasing:
      add_timer_helper(nanotime + (1 + delay_ratio) * offset, 0, confirm_callback);
      break;
    default:
      SPDLOG_ERROR("invalid slice state={} with reference count={} at slice data submit releasing stage.",
                   static_cast<int>(reference_count.state), reference_count.reference_count);
      return;
    }
  };
  add_timer_helper(nanotime + delay_ratio * offset, 0, submit_callback);
}

void BacktestContext::unsubscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                                  const std::string &exchange_id) {
  std::for_each(instrument_ids.begin(), instrument_ids.end(), [&exchange_id, this](const auto &instrument_id) {
    broker_client_.unsubscribe(exchange_id, instrument_id);
  });
}

void BacktestContext::subscribe_all(const std::string &source, uint8_t market_type, uint64_t instrument_type,
                                    uint64_t data_type) {
  throw wingchun_error(fmt::format("not support subscribe_all in backtest mode"));
}

void BacktestContext::subscribe_operator(const std::string &group, const std::string &name) {
  int64_t slice_begin_time = app_.now();
  subscribe_operator_helper(slice_begin_time, group, name);
}

void BacktestContext::subscribe_operator_helper(int64_t begin_time, const std::string &group, const std::string &name) {
  auto op_location = from_indexer_->find_operator_slice_location(begin_time, group, name);
  auto slice_end_time = from_indexer_->get_operator_slice_end_time(begin_time, group, name);
  int64_t nanotime = begin_time - 1;
  int64_t offset = slice_end_time - begin_time;
  if (op_location) {
    subscribe_slice(op_location, nanotime, offset);
    add_location(app_, op_location);
    broker_client_.enroll_operator(op_location);
  }
  if (slice_end_time < app_.get_end_time()) {
    add_timer_helper(nanotime, 0, [this, slice_end_time, group, name](event_ptr event) {
      subscribe_operator_helper(slice_end_time, group, name);
    });
  }
}

void BacktestContext::publish_synthetic_data(const std::string &key, const std::string &value) {
  auto current_time = now();
  SyntheticData synthetic_data;
  synthetic_data.update_time = current_time;
  synthetic_data.key = key;
  synthetic_data.value = value;
  slice_tool_->write_at(current_time, current_time, location::PUBLIC, synthetic_data);
  slice_tool_->next();
  report_->on_write_synthetic_data(synthetic_data);
}

broker::Client &BacktestContext::get_broker_client() { return broker_client_; }

book::Bookkeeper &BacktestContext::get_bookkeeper() { return bookkeeper_; }

void BacktestContext::req_deregister() {}

void BacktestContext::update_operator_state(OperatorStateUpdate &state_update) {}

yijinjing::data::location_ptr BacktestContext::get_location(uint32_t location_uid) {
  return app_.get_location(location_uid);
}

uint32_t BacktestContext::get_home_uid() const { return app_.get_home_uid(); }

std::shared_ptr<wingchun::factor::StreamDataBatcher> BacktestContext::batch_streaming() {
  if (!backtest_stream_data_batcher_) {
    backtest_stream_data_batcher_ = std::make_shared<BackTestStreamDataBatcher>(app_, from_indexer_);
  }
  return backtest_stream_data_batcher_;
}

} // namespace kungfu::wingchun::op