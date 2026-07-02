// SPDX-License-Identifier: Apache-2.0

#include <kungfu/wingchun/orderbook/orderbooks.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;

namespace kungfu::wingchun::orderbook {

void Orderbooks::on_start(const rx::connectable_observable<event_ptr> &events) {
  events | is(Entrust::tag) | $$(on_entrust(event->data<Entrust>()););
  events | is(Transaction::tag) | $$(this->on_transaction(event->data<Transaction>()););
  events | is(Quote::tag) | $$(this->on_quote(event->data<Quote>()););
}

} // namespace kungfu::wingchun::orderbook