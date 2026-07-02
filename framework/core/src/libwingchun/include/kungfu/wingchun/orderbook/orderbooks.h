// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_ORDERBOOK_H
#define WINGCHUN_ORDERBOOK_H

#include <kungfu/longfist/enums.h>
#include <kungfu/longfist/types.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::orderbook {
struct Level final {
  double price;
  double volume;
  int64_t data_time;

  Level() = default;

  Level(double p, double v, int64_t ut) : price(p), volume(v), data_time(ut) {}

  [[nodiscard]] std::string to_string() const {
    nlohmann::json j;
    j["price"] = price;
    j["volume"] = volume;
    j["data_time"] = data_time;
    return j.dump();
  }
};

class Orderbooks {
public:
  Orderbooks() = default;

  Orderbooks(const Orderbooks &) = delete;

  Orderbooks &operator=(const Orderbooks &) = delete;

  virtual ~Orderbooks() = default;

  void on_start(const rx::connectable_observable<event_ptr> &events);

protected:
  virtual void on_entrust(const longfist::types::Entrust &entrust) = 0;
  virtual void on_transaction(const longfist::types::Transaction &transaction) = 0;
  virtual void on_quote(const longfist::types::Quote &quote) = 0;
};

template <typename OB> class OrderbooksImpl : public Orderbooks {
public:
  const typename OB::BidSide &get_bids(const std::string &instrument_id, const std::string &exchange_id) {
    const auto instrument_exchange_id = get_key(instrument_id, exchange_id);
    return obs_[instrument_exchange_id].get_bid_side();
  }

  const typename OB::AskSide &get_asks(const std::string &instrument_id, const std::string &exchange_id) {
    const auto instrument_exchange_id = get_key(instrument_id, exchange_id);
    return obs_[instrument_exchange_id].get_ask_side();
  }

protected:
  [[nodiscard]] std::string get_key(const std::string &instrument_id, const std::string &exchange_id) const {
    return instrument_id + exchange_id;
  }

  void on_entrust(const longfist::types::Entrust &entrust) override {
    const auto instrument_exchange_id = get_key(entrust.instrument_id, entrust.exchange_id);
    obs_[instrument_exchange_id].on_entrust(entrust);
  }

  void on_transaction(const longfist::types::Transaction &transaction) override {
    const auto instrument_exchange_id = get_key(transaction.instrument_id, transaction.exchange_id);
    obs_[instrument_exchange_id].on_transaction(transaction);
  }

  void on_quote(const longfist::types::Quote &quote) override {
    const auto instrument_exchange_id = get_key(quote.instrument_id, quote.exchange_id);
    obs_[instrument_exchange_id].on_quote(quote);
  }

private:
  std::unordered_map<std::string, OB> obs_;
};

class OrderbookSide {
public:
  OrderbookSide() = delete;

  OrderbookSide(const OrderbookSide &) = delete;

  OrderbookSide &operator=(const OrderbookSide &) = delete;

  virtual ~OrderbookSide() = default;

  [[nodiscard]] longfist::enums::Side get_side() const { return side_; }

protected:
  explicit OrderbookSide(longfist::enums::Side side) : side_(side){};

private:
  longfist::enums::Side side_;
};

template <typename BS, typename AS> class Orderbook {
public:
  using BidSide = BS;
  using AskSide = AS;
  Orderbook() : bid_side_(longfist::enums::Side::Buy), ask_side_(longfist::enums::Side::Sell) {}

  Orderbook(const Orderbook &) = delete;

  Orderbook &operator=(const Orderbook &) = delete;

  const BS &get_bid_side() { return bid_side_; }

  const AS &get_ask_side() { return ask_side_; }

  virtual void on_entrust(const longfist::types::Entrust &entrust) {}

  virtual void on_transaction(const longfist::types::Transaction &transaction) {}

  virtual void on_quote(const longfist::types::Quote &quote) {}

protected:
  BS bid_side_;
  AS ask_side_;
};

} // namespace kungfu::wingchun::orderbook
#endif // WINGCHUN_ORDERBOOK_H