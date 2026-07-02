// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-28.
//

#include <kungfu/common.h>
#include <kungfu/longfist/fb/asset_fb_builder.h>
#include <kungfu/longfist/fb/position_fb_builder.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/common.h>
#include <kungfu/wingchun/service/ledger.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::practice;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun::map;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::cache;

#define DEFAULT_AVG_VALID_VALUE 10000.0

namespace kungfu::wingchun::service {

Ledger::Ledger(locator_ptr locator, const std::string &group, const std::string &name, mode m, bool low_latency,
               const std::string &arguments)
    : apprentice(location::make_shared(m, category::SYSTEM, "service", "ledger", std::move(locator)), low_latency,
                 arguments),
      broker_client_(*this), bookkeeper_(*this, broker_client_, true, true) {
  sync_asset_ = std::getenv("KF_BYPASS_SYNC_ASSET") == nullptr;
  sync_position_ = std::getenv("KF_BYPASS_SYNC_POSITION") == nullptr;
  // born-FB 写侧开关(默认 OFF);设定时 ledger 在 POD Position/Asset 写之外额外写 born-FB 帧并存,POD 路径零变化。
  position_born_fb_ = std::getenv("KF_POSITION_BORN_FB") != nullptr;
  asset_born_fb_ = std::getenv("KF_ASSET_BORN_FB") != nullptr;
  // 迁移 cutover 开关(默认 OFF):设定时 write_book 跳过 POD Position/Asset 写,只走 born-FB(终态形态)。
  // 与 born-FB flag 配合:POD-only=两 flag 全不设;dual-write=born-FB 设、skip 不设;FB-only=born-FB 设 + skip 设。
  skip_pod_write_ = std::getenv("KF_SKIP_POD_WRITE") != nullptr;
  SPDLOG_DEBUG("sync_asset_: {},  sync_position_: {}", sync_asset_, sync_position_);
}

void Ledger::write_position_born_fb(int64_t trigger_time, const Position &position, uint32_t dest) {
  if (not position_born_fb_ or not has_writer(dest)) {
    return;
  }
  auto fb = longfist::fb::build_fb_position(position);
  get_writer(dest)->write_raw(trigger_time, longfist::fb::POSITION_FB_TAG, reinterpret_cast<uintptr_t>(fb.data()),
                              static_cast<uint32_t>(fb.size()));
}

void Ledger::write_position_born_fb_as(int64_t trigger_time, const Position &position, uint32_t source, uint32_t dest) {
  if (not position_born_fb_ or not has_writer(dest)) {
    return;
  }
  auto fb = longfist::fb::build_fb_position(position);
  get_writer(dest)->write_raw_at_as(trigger_time, trigger_time, source, dest, longfist::fb::POSITION_FB_TAG,
                                    reinterpret_cast<uintptr_t>(fb.data()), static_cast<uint32_t>(fb.size()));
}

void Ledger::write_asset_born_fb(int64_t trigger_time, const Asset &asset, uint32_t dest) {
  if (not asset_born_fb_ or not has_writer(dest)) {
    return;
  }
  auto fb = longfist::fb::build_fb_asset(asset);
  get_writer(dest)->write_raw(trigger_time, longfist::fb::ASSET_FB_TAG, reinterpret_cast<uintptr_t>(fb.data()),
                              static_cast<uint32_t>(fb.size()));
}

void Ledger::on_exit() {}

book::Bookkeeper &Ledger::get_bookkeeper() { return bookkeeper_; }

void Ledger::on_start() {
  broker_client_.on_start(events_);
  bookkeeper_.on_start(events_);
  bookkeeper_.guard_positions();

  events_ | is(BrokerStateUpdate::tag) |
      $$(update_app_state_map(event->source(), event->data<BrokerStateUpdate>(), broker_states_));
  events_ | is(OperatorStateUpdate::tag) |
      $$(update_app_state_map(event->source(), event->data<OperatorStateUpdate>(), operator_states_));
  events_ | is(Deregister::tag) | $$(on_deregister(event->data<Deregister>()));
  events_ | is(OrderInput::tag) | $$(update_order_stat(event, event->data<OrderInput>()));
  events_ | is(Order::tag) | $$(update_order_stat(event, event->data<Order>()));
  events_ | is(Trade::tag) | $$(update_order_stat(event, event->data<Trade>()));
  events_ | is(Channel::tag) | $$(inspect_channel(event->gen_time(), event->data<Channel>()));
  events_ | is(KeepPositionsRequest::tag) | $$(keep_positions(event->gen_time(), event->source()));
  events_ | is(RebuildPositionsRequest::tag) | $$(rebuild_positions(event->gen_time(), event->source()));
  events_ | is(MirrorPositionsRequest::tag) | $$(bookkeeper_.mirror_positions(event->gen_time(), event->source()));
  events_ | is(BrokerStateRequest::tag) | $$(write_app_state(event->gen_time(), event->source(), broker_states_));
  events_ | is(OperatorStateRequest::tag) | $$(write_app_state(event->gen_time(), event->source(), operator_states_));
  events_ | is(AssetRequest::tag) | $$(write_book_reset(event->gen_time(), event->source()));
  events_ | is(PositionRequest::tag) | $$(write_strategy_data(event->gen_time(), event->source()));
  events_ | is(PositionEnd::tag) | $$(update_account_book(event->gen_time(), event->data<PositionEnd>().holder_uid));

  if (sync_asset_) {
    add_time_interval(yijinjing::time_unit::NANOSECONDS_PER_MINUTE,
                      [&](const event_ptr &e) { request_asset_sync(e->gen_time()); });
  }
  if (sync_position_) {
    add_time_interval(yijinjing::time_unit::NANOSECONDS_PER_MINUTE,
                      [&](const event_ptr &e) { request_position_sync(e->gen_time()); });
  }

  SPDLOG_DEBUG("bypass_refresh_book {}", bypass_refresh_book());
  refresh_books();
}

bool Ledger::bypass_refresh_book() {
  static bool bypass_refresh_book = std::getenv("KF_BYPASS_REFRESH_BOOK") != nullptr;
  return bypass_refresh_book;
}

void Ledger::on_deregister(const Deregister &deregister) {
  uint32_t location_uid = deregister.location_uid;
  broker_states_.erase(location_uid);
  SPDLOG_INFO("deregister location [{:08x}] {}, from broker_states_", location_uid, get_location_uname(location_uid));
  operator_states_.erase(location_uid);
  SPDLOG_INFO("deregister location [{:08x}] {}, from operatoor_states_", location_uid,
              get_location_uname(location_uid));
  write_app_state_to_public(broker_states_);
  write_app_state_to_public(operator_states_);
}

void Ledger::refresh_books() {
  for (const auto &pair : bookkeeper_.get_books()) {
    if (pair.second->asset.ledger_category == LedgerCategory::Account) {
      refresh_account_book(now(), pair.first);
    }
    request_write_to(now(), pair.first);
  }
}

void Ledger::refresh_account_book(int64_t trigger_time, uint32_t account_uid) {
  if (bypass_refresh_book()) {
    return;
  }
  auto account_location = get_location(account_uid);
  auto group = account_location->group;
  auto md_location = location::make_shared(account_location->mode, category::MD, group, group, get_locator());
  auto book = bookkeeper_.get_book(account_uid);
  auto subscribe_positions = [&](auto positions) {
    for (const auto &pair : positions) {
      auto &position = pair.second;
      broker_client_.subscribe(md_location, position.exchange_id, position.instrument_id);
    }
  };
  subscribe_positions(book->long_positions);
  subscribe_positions(book->short_positions);
  broker_client_.try_renew(trigger_time, md_location);
  book->update(trigger_time);
}

OrderStat &Ledger::ensure_order_stat(uint64_t order_id, const event_ptr &event) {
  if (order_stats_.find(order_id) == order_stats_.end()) {
    OrderStat order_stat{};
    order_stat.order_id = order_id;
    order_stat.md_time = event->trigger_time();
    order_stat.input_time = event->gen_time();
    order_stats_.try_emplace(order_id, get_live_home_uid(), event->source(), event->gen_time(), order_stat);
  }
  return order_stats_.at(order_id).data;
}

void Ledger::update_order_stat(const event_ptr &event, const OrderInput &data) {
  write_book(event->gen_time(), event->dest(), event->source(), data);
  ensure_order_stat(data.order_id, event);
}

void Ledger::update_order_stat(const event_ptr &event, const Order &data) {
  write_book(event->gen_time(), event->source(), event->dest(), data);
  auto &stat = ensure_order_stat(data.order_id, event);
  auto inserted = stat.insert_time != 0;
  auto acked = stat.ack_time != 0;
  if (not inserted) {
    stat.insert_time = data.insert_time; // have to be insert_time, for ui rendering logic
    try_write_to(event->gen_time(), stat, event->source());
  }
  if (inserted and not acked) {
    stat.ack_time = event->gen_time();
    try_write_to(event->gen_time(), stat, event->source());
  }
}

void Ledger::update_order_stat(const event_ptr &event, const Trade &data) {
  write_book(event->gen_time(), event->source(), event->dest(), data);
  auto &stat = ensure_order_stat(data.order_id, event);
  if (stat.trade_time < event->gen_time()) {
    stat.trade_time = event->gen_time();
    stat.total_price += data.price * double(data.volume);
    stat.total_volume += double(data.volume);
    if (stat.total_volume > 0) {
      stat.avg_price = stat.total_price / stat.total_volume;
    }
    try_write_to(event->gen_time(), stat, event->source());
  }
}

// 获取有效位长度
int Ledger::get_decimal_places(double num) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(16) << num; // 设置足够的精度
  std::string str = out.str();
  size_t dotPos = str.find('.');
  if (dotPos == std::string::npos)
    return 0; // 没有小数点
  size_t precision = str.size() - dotPos - 1;
  // 去除末尾的0
  while (precision > 0 && str[dotPos + precision] == '0') {
    precision--;
  }

  return precision;
}

double Ledger::translate_by_price_tick(const char *exchange_id, const char *instrument_id, double price) {
  auto hashed_instrument_key = hash_instrument(exchange_id, instrument_id);
  auto instruments = bookkeeper_.get_static_data().get_instruments();
  if (instruments.find(hashed_instrument_key) != instruments.end()) {
    double price_tick = instruments[hashed_instrument_key].price_tick;
    if (is_valid_price(price_tick)) {
      if (price_tick >= 1) {
        price_tick = 1;
      }

      int digits = get_decimal_places(price_tick);
      double new_price_tick = 1.0 / pow(10, digits);
      uint64_t tick = 1 / new_price_tick;
      uint64_t uPrice = (uint64_t)((std::abs(price) + new_price_tick * 0.5) * tick);
      return (double)uPrice / tick;
    }
  }

  return int64_t(price * DEFAULT_AVG_VALID_VALUE) / DEFAULT_AVG_VALID_VALUE;
}

void Ledger::update_account_book(int64_t trigger_time, uint32_t account_uid) {
  refresh_account_book(trigger_time, account_uid);
  auto book = bookkeeper_.get_book(account_uid);
  write_positions(trigger_time, account_uid, book->long_positions);
  write_positions(trigger_time, account_uid, book->short_positions);
  try_write_to(trigger_time, book->asset, account_uid);
  write_asset_born_fb(trigger_time, book->asset, account_uid); // born-FB twin(flag-gated)
  PositionEnd end{};
  end.holder_uid = account_uid;
  try_write_to(trigger_time, end, account_uid);
}

void Ledger::inspect_channel(int64_t trigger_time, const Channel &channel) {
  auto source_location = get_location(channel.source_id);
  auto is_from_account = source_location->category == category::TD;

  if (channel.source_id != get_live_home_uid() and channel.dest_id != get_live_home_uid()) {
    if (not(source_location->category == category::SYSTEM and source_location->group == "service" and
            get_location(channel.dest_id)->category == category::TD)) {
      SPDLOG_INFO("join source: {} , dest: {}", source_location->uname, get_location(channel.dest_id)->uname);
      reader_join(channel.source_id, channel.dest_id, trigger_time);
    }
  }
  if (channel.dest_id == get_live_home_uid() and has_writer(channel.source_id) and is_from_account) {
    write_book_reset(trigger_time, channel.source_id);
  }
}

void Ledger::keep_positions(int64_t trigger_time, uint32_t strategy_uid) {
  if (bookkeeper_.has_book(strategy_uid)) {
    auto strategy_book = bookkeeper_.get_book(strategy_uid);
    tmp_books_.insert_or_assign(strategy_uid, *strategy_book);
  } else {
    SPDLOG_WARN("no book when keep positions {} {}", strategy_uid, get_location_uname(strategy_uid));
  }
}

void Ledger::rebuild_positions(int64_t trigger_time, uint32_t strategy_uid) {
  auto strategy_book = bookkeeper_.get_book(strategy_uid);
  SPDLOG_DEBUG("rebuild_positions {} {}", strategy_uid, get_location_uname(strategy_uid));

  auto rebuild_book = [&](auto &tmp_position) {
    if (not strategy_book->has_position_for(tmp_position)) {
      return;
    }
    auto &strategy_position = strategy_book->get_position_for(tmp_position);
    auto avg_open_price = strategy_position.avg_open_price;
    auto position_cost_price = strategy_position.position_cost_price;
    longfist::copy(strategy_position, tmp_position);
    if (is_equal(tmp_position.avg_open_price, 0.0)) {
      strategy_position.avg_open_price = avg_open_price;
    }
    if (is_equal(tmp_position.position_cost_price, 0.0)) {
      strategy_position.position_cost_price = position_cost_price;
    }
    strategy_position.update_time = trigger_time;
  };

  if (tmp_books_.find(strategy_uid) != tmp_books_.end()) {
    auto &tmp_book = tmp_books_.at(strategy_uid);

    auto reset_positions = [&](auto &position) {
      // pos in tmp_book is influenced by instrumentKey event of subscribe, which trigger update_book method and build a
      // target pos with 0 volume;
      if (tmp_book.has_position_for(position) && tmp_book.get_position_for(position).volume != 0) {
        return;
      }
      position.volume = 0;
      position.yesterday_volume = 0;
      position.frozen_total = 0;
      position.frozen_yesterday = 0;
      position.open_volume = 0;
      position.static_yesterday = 0;
      // should keep avg_open_price and position_cost_price
      // position.avg_open_price = 0;
      // position.position_cost_price = 0;
      position.update_time = trigger_time;
    };

    tmp_book.apply_long_positions(rebuild_book);
    tmp_book.apply_short_positions(rebuild_book);
    strategy_book->apply_long_positions(reset_positions);
    strategy_book->apply_short_positions(reset_positions);
    tmp_books_.erase(strategy_uid);
  }

  strategy_book->update(trigger_time);
}

void Ledger::write_book_reset(int64_t trigger_time, uint32_t book_uid) {
  CacheReset cache_reset{};
  cache_reset.msg_type = Position::tag;
  try_write_to(trigger_time, cache_reset, book_uid);
  cache_reset.msg_type = Asset::tag;
  try_write_to(trigger_time, cache_reset, book_uid);
  cache_reset.msg_type = InstrumentFactor::tag;
  try_write_to(trigger_time, cache_reset, book_uid,
               [&, trigger_time]() { get_writer(book_uid)->mark(trigger_time, ResetBookRequest::tag); });
}

void Ledger::write_strategy_data(int64_t trigger_time, uint32_t strategy_uid) {
  if (not has_writer(strategy_uid) or not has_location(strategy_uid)) {
    SPDLOG_WARN("write_strategy_data not found writer or location for target {}", strategy_uid);
    return;
  }

  auto location = get_location(strategy_uid);
  for (const auto &pair : bookkeeper_.get_books()) {
    auto &book = pair.second;
    auto &asset = book->asset;
    auto book_uid = asset.holder_uid;
    bool has_account = asset.ledger_category == LedgerCategory::Account and has_channel(book_uid, strategy_uid);
    bool is_strategy = location->category == category::STRATEGY and book_uid == strategy_uid;
    bool is_node = location->category == category::SYSTEM and location->group == "node";
    if (has_account or is_strategy or is_node) {
      write_positions(trigger_time, strategy_uid, book->long_positions);
      write_positions(trigger_time, strategy_uid, book->short_positions);
      try_write_to(trigger_time, asset, strategy_uid);
      write_asset_born_fb(trigger_time, asset, strategy_uid); // born-FB twin(flag-gated)
    }
  }
  PositionEnd end{};
  end.holder_uid = strategy_uid;
  try_write_to(trigger_time, end, strategy_uid);
}

void Ledger::write_positions(int64_t trigger_time, uint32_t dest, PositionMap &positions) {
  for (const auto &pair : positions) {
    try_write_as(trigger_time, pair.second, get_live_home_uid(), pair.second.holder_uid);
    // born-FB twin(flag-gated):与 POD 同 source(live_home)/dest(holder_uid) 路由。
    write_position_born_fb_as(trigger_time, pair.second, get_live_home_uid(), pair.second.holder_uid);
  }
}

void Ledger::request_asset_sync(int64_t trigger_time) {
  for (const auto &pair : bookkeeper_.get_books()) {
    auto &book = pair.second;
    auto &asset = book->asset;
    if (asset.ledger_category == LedgerCategory::Account and has_writer(asset.holder_uid)) {
      get_writer(asset.holder_uid)->mark(trigger_time, AssetSync::tag);
    }
  }
}

void Ledger::request_position_sync(int64_t trigger_time) {
  for (const auto &pair : bookkeeper_.get_books()) {
    auto &book = pair.second;
    auto &asset = book->asset;
    if (asset.ledger_category == LedgerCategory::Account and has_writer(asset.holder_uid)) {
      get_writer(asset.holder_uid)->mark(trigger_time, PositionSync::tag);
    }
  }
}

} // namespace kungfu::wingchun::service
