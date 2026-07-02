#include <kungfu/wingchun/book/staticdata.h>

using namespace kungfu::rx;
using namespace kungfu::wingchun;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;

namespace kungfu::wingchun::book {

StaticData::StaticData(apprentice &app) : app_(app) {}

void StaticData::on_start(const rx::connectable_observable<event_ptr> &events) {
  restore(app_.get_state_bank());

  events | is(Basket::tag) | $$(replace(event->data<Basket>()));
  events | is(BasketInstrument::tag) | $$(replace(event->data<BasketInstrument>()));
  events | is(Commission::tag) | $$(replace(event->data<Commission>()));
  events | is(Instrument::tag) | $$(replace(event->data<Instrument>()));
  events | is(InstrumentFactor::tag) | $$(replace(event->data<InstrumentFactor>()));
}

void StaticData::restore(const cache::bank &state_bank) {
  hana::for_each(longfist::StaticDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    for (auto &pair : state_bank[boost::hana::type_c<DataType>]) {
      replace(pair.second.data);
    }
  });
}

void StaticData::replace(const Basket &basket) { baskets_.insert_or_assign(basket.id, basket); }

void StaticData::replace(const BasketInstrument &basket_instrument) {
  auto basket_instrument_hashed = hash_basket_instrument(basket_instrument.basket_uid, basket_instrument.exchange_id,
                                                         basket_instrument.instrument_id);
  basket_instruments_.insert_or_assign(basket_instrument_hashed, basket_instrument);
}

void StaticData::replace(const Commission &commission) {
  auto commission_hashed = hash_product(commission.exchange_id, commission.product_id);
  commissions_.insert_or_assign(commission_hashed, commission);
}

void StaticData::replace(const Instrument &instrument) {
  auto instrument_hashed = hash_instrument(instrument.exchange_id, instrument.instrument_id);
  instruments_.insert_or_assign(instrument_hashed, instrument);
}

void StaticData::replace(const InstrumentFactor &instrument_factor) {
  auto instrument_factor_hashed = hash_instrument(instrument_factor.exchange_id, instrument_factor.instrument_id);
  instrument_factors_.insert_or_assign(instrument_factor_hashed, instrument_factor);
}

} // namespace kungfu::wingchun::book
