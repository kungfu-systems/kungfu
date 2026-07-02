// SPDX-License-Identifier: Apache-2.0
#ifndef WINGCHUN_OPERATOR_RUNNER_H
#define WINGCHUN_OPERATOR_RUNNER_H

#include <kungfu/wingchun/operator/backtest.h>
#include <kungfu/wingchun/operator/live.h>
#include <kungfu/wingchun/operator/operator.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::op {
class Runner : public practice::apprentice {
public:
  Runner(yijinjing::data::locator_ptr locator, const std::string &group, const std::string &name,
         longfist::enums::mode m, bool low_latency, const std::string &arguments = "{}");

  ~Runner() override = default;

  [[nodiscard]] Context_ptr get_context() const;

  void add_operator(const Operator_ptr &op);

  void set_from_indexer(const tool::SliceIndexer_ptr &indexer);

  void set_to_indexer(const tool::SliceIndexer_ptr &indexer);

  void set_report(const tool::Report_ptr &report);

  tool::Report_ptr get_report() const;

  void set_time_interval(int64_t time_interval);

  void set_backtest_config(const std::string &backtest_config);

  void on_exit() override;

  bool is_reactable(const event_ptr &event) override;

  void set_operator_dir(const std::string &oprator_dir);

protected:
  void on_react() override;

  void on_start() override;

  void on_active() override;

  virtual Context_ptr make_context();

  virtual void pre_start();

  virtual void post_start();

  virtual void pre_stop();

  virtual void post_stop();

private:
  std::vector<Operator_ptr> operators_ = {};
  Context_ptr context_;
  tool::SliceIndexer_ptr from_indexer_;
  tool::SliceIndexer_ptr to_indexer_;
  tool::Report_ptr report_;
  int64_t time_interval_{yijinjing::time_unit::NANOSECONDS_PER_SECOND};
  std::string backtest_config_;
  bool has_post_started_ = false;
  std::string operator_dir_;

  template <typename OnMethod = void (Operator::*)(Context_ptr &)> void invoke(OnMethod method) {
    auto context = std::dynamic_pointer_cast<Context>(context_);
    for (const auto &op : operators_) {
      (*op.*method)(context);
    }
  };

  template <typename TradingData, typename OnMethod = void (Operator::*)(Context_ptr &, const TradingData &)>
  void invoke(OnMethod method, const TradingData &data) {
    auto context = std::dynamic_pointer_cast<Context>(context_);
    for (const auto &op : operators_) {
      (*op.*method)(context, data);
    }
  };

  template <typename TradingData, typename OnMethod = void (Operator::*)(Context_ptr &, const TradingData &,
                                                                         const kungfu::yijinjing::data::location_ptr &)>
  void invoke(OnMethod method, const TradingData &data, const kungfu::yijinjing::data::location_ptr &location) {
    auto context = std::dynamic_pointer_cast<Context>(context_);
    for (const auto &op : operators_) {
      (*op.*method)(context, data, location);
    }
  };

  template <typename TradingData,
            typename OnMethod = void (Operator::*)(Context_ptr &, const TradingData &,
                                                   const kungfu::yijinjing::data::location_ptr &, uint32_t)>
  void invoke(OnMethod method, const TradingData &data, const kungfu::yijinjing::data::location_ptr &location,
              uint32_t dest) {
    auto context = std::dynamic_pointer_cast<Context>(context_);
    for (const auto &op : operators_) {
      (*op.*method)(context, data, location, dest);
    }
  };
};

static const int64_t NANO_MILLISECOND = int64_t(1000000);

} // namespace kungfu::wingchun::op

#endif // WINGCHUN_OPERATOR_RUNNER_H