// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#ifndef WINGCHUN_RUNNER_H
#define WINGCHUN_RUNNER_H

#include <kungfu/wingchun/strategy/backtest.h>
#include <kungfu/wingchun/strategy/live.h>
#include <kungfu/wingchun/strategy/matcher.h>
#include <kungfu/wingchun/strategy/strategy.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::strategy {
class Runner : public practice::apprentice {
public:
  Runner(const yijinjing::data::locator_ptr &locator, const std::string &group, const std::string &name,
         longfist::enums::mode m, bool low_latency, const std::string &arguments = "{}");

  ~Runner() override = default;

  [[nodiscard]] Context_ptr get_context() const;

  void add_strategy(const Strategy_ptr &strategy);

  void set_matcher(const Matcher_ptr &matcher);

  void set_from_indexer(const tool::SliceIndexer_ptr &indexer);

  void set_to_indexer(const tool::SliceIndexer_ptr &indexer);

  void set_report(const tool::Report_ptr &report);

  tool::Report_ptr get_report() const;

  void set_time_interval(int64_t time_interval);

  void set_backtest_config(const std::string &backtest_config);

  void on_exit() override;

  bool is_reactable(const event_ptr &event) override;

  void set_strategy_dir(const std::string &strategy_dir);

protected:
  void react() override;

  void on_react() override;

  void on_start() override;

  void on_active() override;

  virtual Context_ptr make_context();

  virtual void pre_start();

  virtual void post_start();

  virtual void pre_stop();

  virtual void post_stop();

private:
  std::vector<Strategy_ptr> strategies_ = {};
  Context_ptr context_;
  Matcher_ptr matcher_;
  tool::SliceIndexer_ptr from_indexer_;
  tool::SliceIndexer_ptr to_indexer_;
  tool::Report_ptr report_;
  int64_t time_interval_{yijinjing::time_unit::NANOSECONDS_PER_SECOND};
  std::string backtest_config_;
  bool has_post_started_ = false;
  std::string strategy_dir_;

  void inspect_channel(const event_ptr &event);

  template <typename OnMethod = void (Strategy::*)(Context_ptr &)> void invoke(OnMethod method) {
    for (const auto &strategy : strategies_) {
      (*strategy.*method)(context_);
    }
  }

  template <typename TradingData, typename OnMethod = void (Strategy::*)(Context_ptr &, const TradingData &)>
  void invoke(OnMethod method, const TradingData &data) {
    for (const auto &strategy : strategies_) {
      (*strategy.*method)(context_, data);
    }
  }

  template <typename TradingData, typename OnMethod = void (Strategy::*)(Context_ptr &, const TradingData &,
                                                                         const kungfu::yijinjing::data::location_ptr &)>
  void invoke(OnMethod method, const TradingData &data, const kungfu::yijinjing::data::location_ptr &location) {
    for (const auto &strategy : strategies_) {
      (*strategy.*method)(context_, data, location);
    }
  }

  template <typename TradingData,
            typename OnMethod = void (Strategy::*)(Context_ptr &, const TradingData &,
                                                   const kungfu::yijinjing::data::location_ptr &, uint32_t)>
  void invoke(OnMethod method, const TradingData &data, const kungfu::yijinjing::data::location_ptr &location,
              uint32_t dest) {
    for (const auto &strategy : strategies_) {
      (*strategy.*method)(context_, data, location, dest);
    }
  }

  template <typename OnMethod = void (Strategy::*)(Context_ptr &, uint32_t, const std::vector<uint8_t> &, uint32_t,
                                                   const kungfu::yijinjing::data::location_ptr &, uint32_t)>
  void invoke(OnMethod method, uint32_t msg_type, const std::vector<uint8_t> &data, uint32_t length,
              const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) {
    for (const auto &strategy : strategies_) {
      (*strategy.*method)(context_, msg_type, data, length, location, dest);
    }
  }

  class BookListener : public wingchun::book::BookListener {
  public:
    explicit BookListener(Runner &runner);

    ~BookListener() = default;

    void on_position_sync_reset(const wingchun::book::Book &old_book, const wingchun::book::Book &new_book) override;

    void on_asset_sync_reset(const longfist::types::Asset &old_asset, const longfist::types::Asset &new_asset) override;

  private:
    Runner &runner_;
  };
  DECLARE_PTR(BookListener);
};

} // namespace kungfu::wingchun::strategy

#endif // WINGCHUN_RUNNER_H
