// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_MATCHER_H
#define WINGCHUN_MATCHER_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/book/bookkeeper.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <unordered_map>

namespace kungfu::wingchun::strategy {
FORWARD_DECLARE_CLASS_PTR(Runner)
class Matcher : public std::enable_shared_from_this<Matcher> {
public:
  Matcher() = default;
  virtual ~Matcher() = default;

  // 行情数据更新回调
  //@param quote             行情数据
  virtual void on_quote(const longfist::types::Quote &quote) {};

  // 逐笔委托更新回调
  //@param entrust           逐笔委托数据
  virtual void on_entrust(const longfist::types::Entrust &entrust) {};

  // 逐笔成交更新回调
  //@param transaction       逐笔成交数据
  virtual void on_transaction(const longfist::types::Transaction &transaction) {};

  // 行情数据更新回调
  // @param tree              行情数据
  // @param location          数据来源
  virtual void on_tree(const longfist::types::Tree &tree) {};

  // 行情数据更新回调
  // @param tree              行情数据
  // @param location          数据来源
  virtual void on_depth(const longfist::types::Depth &depth) {};

  // 行情数据更新回调
  // @param tree              行情数据
  // @param location          数据来源
  virtual void on_tick(const longfist::types::Tick &tick) {};

  // 订单信息更新回调
  //@param order             订单信息数据
  virtual void on_order_input(const longfist::types::OrderInput &order_input) {};

  // 订单操作回调
  //@param order             订单信息数据
  virtual void on_order_action(const longfist::types::OrderAction &order_action) {};

  void update_order(const longfist::types::Order &order);

  void update_trade(const longfist::types::Trade &trade);

  void update_order_action_error(const longfist::types::OrderActionError &error);

  std::pair<uint32_t, uint32_t> get_source_dest(uint64_t order_id) { return order_ids_.at(order_id); };

  book::Bookkeeper *get_bookkeeper() const { return bookkeeper_; };

  int64_t now() const { return app_->now(); };

  std::string get_config() const { return config_; };

private:
  friend void set_runner(Matcher &matcher, Runner *runner);
  friend void init_matcher(Matcher &matcher, book::Bookkeeper *bookkeeper, const std::string &matcher_config);
  friend void add_order_id(Matcher &matcher, uint64_t order_id, uint32_t source, uint32_t dest);
  friend void remove_order_id(Matcher &matcher, uint64_t order_id);
  practice::apprentice *app_;
  book::Bookkeeper *bookkeeper_;
  std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> order_ids_; // <order_id, std::pair<source, dest>>
  std::string config_{"{}"};
};
DECLARE_PTR(Matcher)

class BasicMatcher : public Matcher {
public:
  typedef std::unordered_map<uint64_t, longfist::types::Order> OrderMap;
  typedef std::unordered_map<uint32_t, longfist::types::Quote> QuoteMap;

  virtual void on_quote(const longfist::types::Quote &quote) override;

  virtual void on_order_input(const longfist::types::OrderInput &order_input) override;

  virtual void on_order_action(const longfist::types::OrderAction &order_action) override;

  void match();

  void filled_order_trade(longfist::types::Order &order, longfist::types::Trade &trade);

private:
  QuoteMap quotes_;
  OrderMap orders_;
};
} // namespace kungfu::wingchun::strategy

#endif // WINGCHUN_MATCHER_H