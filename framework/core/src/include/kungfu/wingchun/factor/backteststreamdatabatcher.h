// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_BACKTESTSTREAMDATABATCHER_H
#define WINGCHUN_BACKTESTSTREAMDATABATCHER_H

#include <kungfu/longfist/enums.h>
#include <kungfu/longfist/types.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/wingchun/factor/streamdatabatcher.h>
#include <kungfu/wingchun/tool/sliceindexer.h>
#include <kungfu/wingchun/tool/slicetool.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::factor {

class BackTestStreamDataBatcher : public StreamDataBatcher {
public:
  BackTestStreamDataBatcher(practice::apprentice &app, tool::SliceIndexer_ptr from_indexer)
      : app_(app), from_indexer_(std::move(from_indexer)) {}
  ~BackTestStreamDataBatcher() = default;

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
    return get_buffer<longfist::types::Entrust>(source, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Transaction> get_transaction_buffer(const std::string &source,
                                                                           const std::string &instrument_id,
                                                                           const std::string &exchange_id) override {
    return get_buffer<longfist::types::Transaction>(source, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Quote> get_quote_buffer(const std::string &source,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id) override {
    return get_buffer<longfist::types::Quote>(source, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Tree> get_tree_buffer(const std::string &source,
                                                             const std::string &instrument_id,
                                                             const std::string &exchange_id) override {
    return get_buffer<longfist::types::Tree>(source, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Depth> get_depth_buffer(const std::string &source,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id) override {
    return get_buffer<longfist::types::Depth>(source, instrument_id, exchange_id);
  }

  virtual EventBuffer<longfist::types::Tick> get_tick_buffer(const std::string &source,
                                                             const std::string &instrument_id,
                                                             const std::string &exchange_id) override {
    return get_buffer<longfist::types::Tick>(source, instrument_id, exchange_id);
  }

  template <typename BufferType>
  void pop_batched_until(int64_t until_time, const std::string &instrument_id, const std::string &exchange_id) {
    auto &events = hana::at_key(bufferMap, hana::int_c<BufferType::tag>)[get_key(instrument_id, exchange_id)].vec_;
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
      std::vector<BufferType>().swap(events);
    } else {
      auto ori_begin = std::rotate(events.begin(), it, events.end());
      events.erase(ori_begin, events.end());
      std::vector<BufferType>(events).swap(events);
    }
    time_stamp_map_[get_instrument_exchange_type_id(instrument_id, exchange_id, BufferType::tag)] = app_.now();
  }

  template <typename BufferType>
  EventBuffer<BufferType> &get_buffer(const std::string &source, const std::string &instrument_id,
                                      const std::string &exchange_id) {
    deal_data<BufferType>(source, instrument_id, exchange_id, BufferType::tag);
    return reinterpret_cast<EventBuffer<BufferType> &>(hana::at_key(bufferMap, hana::int_c<BufferType::tag>)
                                                           .try_emplace(get_key(instrument_id, exchange_id))
                                                           .first->second);
  }

protected:
  std::vector<yijinjing::data::location_ptr> get_locations(const std::string &source, int64_t begin_time,
                                                           const std::string &instrument_id,
                                                           const std::string &exchange_id, int32_t data_tag);

  [[nodiscard]] std::string get_instrument_exchange_type_id(const std::string &instrument_id,
                                                            const std::string &exchange_id, int32_t data_type) const {
    return instrument_id + exchange_id + std::to_string(data_type);
  }

private:
  practice::apprentice &app_;
  tool::SliceIndexer_ptr from_indexer_;
  std::unordered_map<std::string, int64_t> time_stamp_map_;
  int64_t get_begin_time(const std::string instrument_exchange_type_id);

  template <typename BufferType>
  void deal_data(const std::string &source, const std::string &instrument_id, const std::string &exchange_id,
                 int32_t type_name) {
    int64_t begin_time = get_begin_time(get_instrument_exchange_type_id(instrument_id, exchange_id, type_name));
    const std::vector<kungfu::yijinjing::data::location_ptr> &location_vec =
        get_locations(source, begin_time, instrument_id, exchange_id, BufferType::tag);
    yijinjing::journal::reader reader(true, true, std::make_shared<yijinjing::journal::bus>(false));
    if (location_vec.empty()) {
      // SPDLOG_WARN("location数组为空");
    } else {
      for (const auto &location : location_vec) {
        for (const auto dest_id : location->locator->list_location_dest(location)) {
          reader.join(location, dest_id, begin_time);
        }
      }
    }
    reader.seek_to_time(begin_time);
    const int64_t end_time = app_.now();
    while (reader.data_available()) {
      const yijinjing::journal::frame_ptr frame = reader.current_frame();
      if (frame->gen_time() > end_time) {
        break;
      }
      if (frame->msg_type() == BufferType::tag) {
        auto &event = const_cast<BufferType &>(frame->data<BufferType>());
        if (get_key(event.instrument_id, event.exchange_id) == get_key(instrument_id, exchange_id)) {
          hana::at_key(bufferMap, hana::int_c<BufferType::tag>)
              .try_emplace(get_key(instrument_id, exchange_id))
              .first->second.vec_.push_back(event);
        }
      }
      reader.next();
    }
  }
};

} // namespace kungfu::wingchun::factor
#endif // WINGCHUN_BACKTESTSTREAMDATABATCHER_H