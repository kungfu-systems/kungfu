// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#ifndef WINGCHUN_MARKETDATA_H
#define WINGCHUN_MARKETDATA_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/broker/broker.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::broker {

FORWARD_DECLARE_CLASS_PTR(MarketData)

class MarketDataVendor : public BrokerVendor {
public:
  MarketDataVendor(locator_ptr locator, const std::string &group, const std::string &name, longfist::enums::mode m,
                   bool low_latency, const std::string &arguments = "{}");

  void set_service(MarketData_ptr service);

protected:
  void on_react() override;

  void on_start() override;

  BrokerService_ptr get_service() override;

private:
  MarketData_ptr service_ = {};
};

class MarketData : public BrokerService {
  friend class MarketDataVendor;

public:
  explicit MarketData(BrokerVendor &vendor) : BrokerService(vendor){};

  virtual bool subscribe(const std::vector<longfist::types::InstrumentKey> &instrument_keys) = 0;

  virtual bool subscribe_all() { return false; };

  virtual bool subscribe_custom(const longfist::types::CustomSubscribe &custom_sub) { return subscribe_all(); };

  virtual bool unsubscribe(const std::vector<longfist::types::InstrumentKey> &instrument_keys) = 0;

  virtual void on_band(const event_ptr &event) {}

protected:
  [[nodiscard]] bool has_instrument(const std::string &instrument_id) const;

  [[nodiscard]] const longfist::types::Instrument &get_instrument(const std::string &instrument_id) const;

  void update_instrument(longfist::types::Instrument instrument);

  void try_subscribe();

  void add_instrument_key(const longfist::types::InstrumentKey &key);

  std::unordered_map<std::string, longfist::types::Instrument> instruments_ = {};
  std::vector<longfist::types::InstrumentKey> instruments_to_subscribe_{};
};
} // namespace kungfu::wingchun::broker

#endif // WINGCHUN_MARKETDATA_H
