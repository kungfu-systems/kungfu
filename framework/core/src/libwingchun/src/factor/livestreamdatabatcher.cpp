// SPDX-License-Identifier: Apache-2.0

#include <kungfu/wingchun/factor/livestreamdatabatcher.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;

namespace kungfu::wingchun::factor {

void LiveStreamDataBatcher::on_start(const rx::connectable_observable<event_ptr> &events) {
  events | is(Entrust::tag) | $$(on_entrust(event->data<Entrust>()););
  events | is(Transaction::tag) | $$(this->on_transaction(event->data<Transaction>()););
  events | is(Quote::tag) | $$(this->on_quote(event->data<Quote>()););
  events | is(Tree::tag) | $$(on_tree(event->data<Tree>()););
  events | is(Depth::tag) | $$(this->on_depth(event->data<Depth>()););
  events | is(Tick::tag) | $$(this->on_tick(event->data<Tick>()););
}

void LiveStreamDataBatcher::on_entrust(const Entrust &entrust) {
  get_buffer<Entrust>(entrust.instrument_id, entrust.exchange_id).vec_.push_back(entrust);
}

void LiveStreamDataBatcher::on_transaction(const Transaction &transaction) {
  get_buffer<Transaction>(transaction.instrument_id, transaction.exchange_id).vec_.push_back(transaction);
}

void LiveStreamDataBatcher::on_quote(const Quote &quote) {
  get_buffer<Quote>(quote.instrument_id, quote.exchange_id).vec_.push_back(quote);
}

void LiveStreamDataBatcher::on_tree(const Tree &tree) {
  get_buffer<Tree>(tree.instrument_id, tree.exchange_id).vec_.push_back(tree);
}

void LiveStreamDataBatcher::on_depth(const Depth &depth) {
  get_buffer<Depth>(depth.instrument_id, depth.exchange_id).vec_.push_back(depth);
}

void LiveStreamDataBatcher::on_tick(const Tick &tick) {
  get_buffer<Tick>(tick.instrument_id, tick.exchange_id).vec_.push_back(tick);
}

} // namespace kungfu::wingchun::factor