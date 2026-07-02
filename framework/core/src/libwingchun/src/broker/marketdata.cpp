// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#include <kungfu/wingchun/broker/marketdata.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::broker {
MarketDataVendor::MarketDataVendor(locator_ptr locator, const std::string &group, const std::string &name, mode m,
                                   bool low_latency, const std::string &arguments)
    : BrokerVendor(location::make_shared(m, category::MD, group, name, std::move(locator)), low_latency, arguments) {}

void MarketDataVendor::set_service(MarketData_ptr service) {
  service_ = std::move(service);
  service_->on_arguments(get_arguments());
}

void MarketDataVendor::on_react() {
  BrokerVendor::on_react();
  events_ | is(Instrument::tag) | $$(service_->update_instrument(event->data<Instrument>()));
}

void MarketDataVendor::on_start() {
  BrokerVendor::on_start();
  service_->pre_start();
  events_ | is(CustomSubscribe::tag) | $$(service_->subscribe_custom(event->data<CustomSubscribe>()));
  events_ | is(InstrumentKey::tag) | $$(service_->add_instrument_key(event->data<InstrumentKey>()));
  events_ | is(Band::tag) | $$(service_->on_band(event));
  service_->on_start();

  add_time_interval(yijinjing::time_unit::NANOSECONDS_PER_SECOND, [&](auto e) { service_->try_subscribe(); });
}

BrokerService_ptr MarketDataVendor::get_service() { return service_; }

bool MarketData::has_instrument(const std::string &instrument_id) const {
  return instruments_.find(instrument_id) != instruments_.end();
}

const Instrument &MarketData::get_instrument(const std::string &instrument_id) const {
  return instruments_.at(instrument_id);
}

void MarketData::update_instrument(Instrument instrument) {
  instruments_.emplace(instrument.instrument_id, instrument);
}

void MarketData::try_subscribe() {
  if (not instruments_to_subscribe_.empty()) {
    subscribe(instruments_to_subscribe_);
  }
  instruments_to_subscribe_.clear();
}

void MarketData::add_instrument_key(const InstrumentKey &key) { instruments_to_subscribe_.push_back(key); }

} // namespace kungfu::wingchun::broker
