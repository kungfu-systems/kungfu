#ifndef WINGCHUN_QUOTE_ORDERBOOK_H
#define WINGCHUN_QUOTE_ORDERBOOK_H

#include <kungfu/wingchun/orderbook/orderbooks.h>
#include <kungfu/yijinjing/time.h>

#include <utility>

namespace kungfu::wingchun::orderbook {

class DepthOrderbook;
class BidirectionMapOrderbookSide : public OrderbookSide {
  using Container = std::map<double, Level>;

public:
  class iterator { // implements ForwardIterator
  public:
    typedef Level value_type;
    typedef const value_type *pointer;
    typedef const value_type &reference;
    typedef ptrdiff_t difference_type;
    typedef std::forward_iterator_tag iterator_category;

    explicit iterator(Container::const_iterator iter, Container::const_reverse_iterator reiter,
                      longfist::enums::Side side)
        : iter_(std::move(iter)), reiter_(std::move(reiter)), side_(side) {}

    reference operator*() const { return is_bid() ? reiter_->second : iter_->second; }

    pointer operator->() const { return is_bid() ? &(reiter_->second) : &(iter_->second); }

    iterator &operator++() {
      if (is_bid())
        ++reiter_;
      else
        ++iter_;
      return *this;
    }

    iterator operator++(int) {
      iterator temp = *this;
      if (is_bid())
        ++reiter_;
      else
        ++iter_;
      return temp;
    }

    bool operator==(const iterator &rhs) const { return is_bid() ? reiter_ == rhs.reiter_ : iter_ == rhs.iter_; }

    bool operator!=(const iterator &rhs) const { return !operator==(rhs); }

  private:
    bool is_bid() const { return side_ == longfist::enums::Side::Buy; }
    Container::const_iterator iter_;
    Container::const_reverse_iterator reiter_;
    longfist::enums::Side side_;
  };

  iterator begin() const { return iterator(levels_.begin(), levels_.rbegin(), get_side()); }

  iterator end() const { return iterator(levels_.end(), levels_.rend(), get_side()); }

  explicit BidirectionMapOrderbookSide(longfist::enums::Side side) : OrderbookSide(side) {}

private:
  friend DepthOrderbook;
  Container levels_;
  std::unordered_map<int, Level> map_seq_id_2_level_;
};

class DepthOrderbook : public Orderbook<BidirectionMapOrderbookSide, BidirectionMapOrderbookSide> {
public:
  void on_entrust(const longfist::types::Entrust &entrust) override;

  void on_transaction(const longfist::types::Transaction &transaction) override;

private:
  int64_t next_trading_day_start_;

  int64_t get_next_trading_day_start(int64_t data_time);

  bool is_new_trading_day(int64_t data_time);

  void deal_trading_day(int64_t data_time);

  void clear_book();
};

using DepthOrderbooks = OrderbooksImpl<DepthOrderbook>;

} // namespace kungfu::wingchun::orderbook

#endif // WINGCHUN_QUOTE_ORDERBOOK_H
