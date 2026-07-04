// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_REPORT_H
#define WINGCHUN_REPORT_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/book/bookkeeper.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <unordered_map>

namespace kungfu::wingchun::tool {
class Report {
public:
  Report() = default;

  virtual ~Report() = default;

  // 获取Bookkeeper
  //@return Bookkeeper
  book::Bookkeeper *get_bookkeeper() const { return bookkeeper_; };

  // 初始化
  virtual void init() {};

  // 报告撰写
  //@return 报告文本
  virtual std::string sumerize() { return {}; };

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
  virtual void on_tree(const longfist::types::Tree &tree) {};

  // 行情数据更新回调
  // @param depth 行情数据
  virtual void on_depth(const longfist::types::Depth &depth) {};

  // 行情数据更新回调
  // @param tick              行情数据
  virtual void on_tick(const longfist::types::Tick &tick) {};

  // 接收合成数据更新回调
  // @param synthetic_data    合成数据
  virtual void on_read_synthetic_data(const longfist::types::SyntheticData &synthetic_data) {};

  // 发出合成数据更新回调
  // @param synthetic_data    合成数据
  virtual void on_write_synthetic_data(const longfist::types::SyntheticData &synthetic_data) {};

  // 订单信息更新回调
  // @param order             订单信息数据
  virtual void on_order(const longfist::types::Order &order) {};

  // 订单成交回报回调
  // @param trade             订单成交数据
  virtual void on_trade(const longfist::types::Trade &trade) {};

  int64_t now() const { return app_->now(); };

  std::string get_config() const { return config_; };

private:
  friend void init_report(Report &report, practice::apprentice *runner, book::Bookkeeper *bookkeeper,
                          const std::string &config) {
    report.app_ = runner;
    report.bookkeeper_ = bookkeeper;
    report.config_ = config;
  }

  practice::apprentice *app_;
  book::Bookkeeper *bookkeeper_;
  std::string config_{"{}"};
};
DECLARE_PTR(Report)

} // namespace kungfu::wingchun::tool

#endif // WINGCHUN_REPORT_H