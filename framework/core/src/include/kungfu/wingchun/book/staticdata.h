#ifndef WINGCHUN_STATIC_DATA_H
#define WINGCHUN_STATIC_DATA_H

#include <kungfu/common.h>
#include <kungfu/wingchun/common.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::book {

class StaticData {
public:
  explicit StaticData(practice::apprentice &app);

  virtual ~StaticData() = default;

  void on_start(const rx::connectable_observable<event_ptr> &events);

  void restore(const cache::bank &state_bank);

  const map::BasketMap &get_baskets() const { return baskets_; }

  const map::BasketInstrumentMap &get_basket_instruments() const { return basket_instruments_; }

  const map::CommissionMap &get_commissions() const { return commissions_; }

  const map::InstrumentMap &get_instruments() const { return instruments_; }

  const map::InstrumentFactorMap &get_instrument_factors() const { return instrument_factors_; }

private:
  practice::apprentice &app_;
  map::BasketMap baskets_ = {};
  map::BasketInstrumentMap basket_instruments_ = {};
  map::CommissionMap commissions_ = {};
  map::InstrumentMap instruments_ = {};
  map::InstrumentFactorMap instrument_factors_ = {};

  void replace(const longfist::types::Basket &basket);

  void replace(const longfist::types::BasketInstrument &basket_instrument);

  void replace(const longfist::types::Commission &commission);

  void replace(const longfist::types::Instrument &instrument);

  void replace(const longfist::types::InstrumentFactor &instrument_factor);
};
} // namespace kungfu::wingchun::book

#endif // WINGCHUN_STATIC_DATA_H