// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_STREAMDATABATCHER_H
#define WINGCHUN_STREAMDATABATCHER_H

#include <kungfu/longfist/enums.h>
#include <kungfu/longfist/types.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/practice/apprentice.h>
namespace kungfu::wingchun::factor {

class StreamDataBatcher;
class LiveStreamDataBatcher;
class BackTestStreamDataBatcher;

template <typename BufferType> class EventBuffer {
public:
  EventBuffer() = default;
  ~EventBuffer() = default;

  const std::vector<BufferType> &get_events() const { return vec_; }

private:
  friend class StreamDataBatcher;
  friend class LiveStreamDataBatcher;
  friend class BackTestStreamDataBatcher;
  std::vector<BufferType> vec_;
};

#define DEFINE_BUFFER(Buffer, Type)                                                                                    \
  class Buffer {                                                                                                       \
  public:                                                                                                              \
    Buffer() = default;                                                                                                \
    ~Buffer() = default;                                                                                               \
    const std::vector<Type> &get_events() const { return vec_; }                                                       \
                                                                                                                       \
  private:                                                                                                             \
    friend StreamDataBatcher;                                                                                          \
    friend LiveStreamDataBatcher;                                                                                      \
    friend BackTestStreamDataBatcher;                                                                                  \
    std::vector<Type> vec_;                                                                                            \
  };

DEFINE_BUFFER(EntrustBuffer, longfist::types::Entrust)
DEFINE_BUFFER(TransactionBuffer, longfist::types::Transaction)
DEFINE_BUFFER(QuoteBuffer, longfist::types::Quote)
DEFINE_BUFFER(TreeBuffer, longfist::types::Tree)
DEFINE_BUFFER(DepthBuffer, longfist::types::Depth)
DEFINE_BUFFER(TickBuffer, longfist::types::Tick)

class StreamDataBatcher {
public:
  StreamDataBatcher() = default;

  virtual ~StreamDataBatcher() = default;

  StreamDataBatcher(const StreamDataBatcher &) = delete;

  StreamDataBatcher &operator=(const StreamDataBatcher &) = delete;

  virtual void pop_batched_entrust_until(int64_t until_time, const std::string &instrument_id,
                                         const std::string &exchange_id) = 0;
  virtual void pop_batched_transaction_until(int64_t until_time, const std::string &instrument_id,
                                             const std::string &exchange_id) = 0;
  virtual void pop_batched_quote_until(int64_t until_time, const std::string &instrument_id,
                                       const std::string &exchange_id) = 0;
  virtual void pop_batched_tree_until(int64_t until_time, const std::string &instrument_id,
                                      const std::string &exchange_id) = 0;
  virtual void pop_batched_depth_until(int64_t until_time, const std::string &instrument_id,
                                       const std::string &exchange_id) = 0;
  virtual void pop_batched_tick_until(int64_t until_time, const std::string &instrument_id,
                                      const std::string &exchange_id) = 0;

  virtual EventBuffer<longfist::types::Entrust>
  get_entrust_buffer(const std::string &source, const std::string &instrument_id, const std::string &exchange_id) = 0;
  virtual EventBuffer<longfist::types::Transaction> get_transaction_buffer(const std::string &source,
                                                                           const std::string &instrument_id,
                                                                           const std::string &exchange_id) = 0;
  virtual EventBuffer<longfist::types::Quote>
  get_quote_buffer(const std::string &source, const std::string &instrument_id, const std::string &exchange_id) = 0;
  virtual EventBuffer<longfist::types::Tree>
  get_tree_buffer(const std::string &source, const std::string &instrument_id, const std::string &exchange_id) = 0;
  virtual EventBuffer<longfist::types::Depth>
  get_depth_buffer(const std::string &source, const std::string &instrument_id, const std::string &exchange_id) = 0;
  virtual EventBuffer<longfist::types::Tick>
  get_tick_buffer(const std::string &source, const std::string &instrument_id, const std::string &exchange_id) = 0;

protected:
  [[nodiscard]] std::string get_key(const std::string &instrument_id, const std::string &exchange_id) const {
    return instrument_id + exchange_id;
  }

  std::unordered_map<std::string, EventBuffer<longfist::types::Entrust>> entrust_map_;
  std::unordered_map<std::string, EventBuffer<longfist::types::Transaction>> transaction_map_;
  std::unordered_map<std::string, EventBuffer<longfist::types::Quote>> quote_map_;
  std::unordered_map<std::string, EventBuffer<longfist::types::Tree>> tree_map_;
  std::unordered_map<std::string, EventBuffer<longfist::types::Depth>> depth_map_;
  std::unordered_map<std::string, EventBuffer<longfist::types::Tick>> tick_map_;

  decltype(hana::make_map(hana::make_pair(hana::int_c<longfist::types::Entrust::tag>, entrust_map_),
                          hana::make_pair(hana::int_c<longfist::types::Transaction::tag>, transaction_map_),
                          hana::make_pair(hana::int_c<longfist::types::Quote::tag>, quote_map_),
                          hana::make_pair(hana::int_c<longfist::types::Tree::tag>, tree_map_),
                          hana::make_pair(hana::int_c<longfist::types::Depth::tag>, depth_map_),
                          hana::make_pair(hana::int_c<longfist::types::Tick::tag>, tick_map_))) bufferMap;
};

} // namespace kungfu::wingchun::factor
#endif // WINGCHUN_STREAMDATABATCHER_H