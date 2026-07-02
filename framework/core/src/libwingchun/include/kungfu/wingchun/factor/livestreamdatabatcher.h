// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_LIVESTREAMDATABATCHER_H
#define WINGCHUN_LIVESTREAMDATABATCHER_H

#include <kungfu/longfist/enums.h>
#include <kungfu/longfist/types.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/wingchun/factor/streamdatabatcher.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::factor {

class LiveStreamDataBatcher : public StreamDataBatcher {
public:
  LiveStreamDataBatcher() = default;

  ~LiveStreamDataBatcher() = default;

  virtual void pop_batched_entrust_until(int64_t until_time, const std::string &instrument_id,
                                         const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Entrust>(until_time, instrument_id, exchange_id);
  }

  virtual void pop_batched_transaction_until(int64_t until_time, const std::string &instrument_id,
                                             const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Transaction>(until_time, instrument_id, exchange_id);
  }

  virtual void pop_batched_quote_until(int64_t until_time, const std::string &instrument_id,
                                       const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Quote>(until_time, instrument_id, exchange_id);
  }

  virtual void pop_batched_tree_until(int64_t until_time, const std::string &instrument_id,
                                      const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Tree>(until_time, instrument_id, exchange_id);
  }

  virtual void pop_batched_depth_until(int64_t until_time, const std::string &instrument_id,
                                       const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Depth>(until_time, instrument_id, exchange_id);
  }

  virtual void pop_batched_tick_until(int64_t until_time, const std::string &instrument_id,
                                      const std::string &exchange_id) override {
    pop_batched_until<longfist::types::Tick>(until_time, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Entrust> get_entrust_buffer(const std::string &source,
                                                                   const std::string &instrument_id,
                                                                   const std::string &exchange_id) override {
    return get_buffer<longfist::types::Entrust>(instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Transaction> get_transaction_buffer(const std::string &source,
                                                                           const std::string &instrument_id,
                                                                           const std::string &exchange_id) override {
    return get_buffer<longfist::types::Transaction>(instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Quote> get_quote_buffer(const std::string &source,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id) override {
    return get_buffer<longfist::types::Quote>(instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Tree> get_tree_buffer(const std::string &source,
                                                             const std::string &instrument_id,
                                                             const std::string &exchange_id) override {
    return get_buffer<longfist::types::Tree>(instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Depth> get_depth_buffer(const std::string &source,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id) override {
    return get_buffer<longfist::types::Depth>(instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Tick> get_tick_buffer(const std::string &source,
                                                             const std::string &instrument_id,
                                                             const std::string &exchange_id) override {
    return get_buffer<longfist::types::Tick>(instrument_id, exchange_id);
  }

  template <typename BufferType>
  void pop_batched_until(int64_t until_time, const std::string &instrument_id, const std::string &exchange_id) {
    std::vector<BufferType> &events = get_buffer<BufferType>(instrument_id, exchange_id).vec_;
    BufferType until_event;
    until_event.data_time = until_time;
    auto it = std::upper_bound(
        events.begin(), events.end(), until_event,
        [](const BufferType &event, const BufferType &until_event) { return event.data_time < until_event.data_time; });
    if (it == events.begin()) {
      return;
    }
    if (it == events.end()) {
      events.clear();
    } else {
      auto ori_begin = std::rotate(events.begin(), it, events.end());
      events.erase(ori_begin, events.end());
    }
  }

  template <typename BufferType>
  EventBuffer<BufferType> &get_buffer(const std::string &instrument_id, const std::string &exchange_id) {
    return reinterpret_cast<EventBuffer<BufferType> &>(hana::at_key(bufferMap, hana::int_c<BufferType::tag>)
                                                           .try_emplace(get_key(instrument_id, exchange_id))
                                                           .first->second);
  }

  void on_start(const rx::connectable_observable<event_ptr> &events);

protected:
  void on_entrust(const longfist::types::Entrust &entrust);

  void on_transaction(const longfist::types::Transaction &transaction);

  void on_quote(const longfist::types::Quote &quote);

  void on_tree(const longfist::types::Tree &tree);

  void on_depth(const longfist::types::Depth &depth);

  void on_tick(const longfist::types::Tick &tick);
};

} // namespace kungfu::wingchun::factor
#endif // WINGCHUN_LIVESTREAMDATABATCHER_H