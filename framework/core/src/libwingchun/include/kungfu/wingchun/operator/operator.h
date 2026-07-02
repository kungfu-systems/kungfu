// SPDX-License-Identifier: Apache-2.0
#ifndef WINGCHUN_OPERATOR_H
#define WINGCHUN_OPERATOR_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::op {
FORWARD_DECLARE_CLASS_PTR(Context)

class Operator {
public:
  virtual ~Operator() = default;

  // 运行前
  virtual void pre_start(Context_ptr &context){};

  virtual void post_start(Context_ptr &context){};

  // 退出前
  virtual void pre_stop(Context_ptr &context){};

  virtual void post_stop(Context_ptr &context){};

  // 行情数据更新回调
  //@param quote             行情数据
  virtual void on_quote(Context_ptr &context, const longfist::types::Quote &quote,
                        const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 逐笔委托更新回调
  //@param entrust           逐笔委托数据
  virtual void on_entrust(Context_ptr &context, const longfist::types::Entrust &entrust,
                          const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 逐笔成交更新回调
  //@param transaction       逐笔成交数据
  virtual void on_transaction(Context_ptr &context, const longfist::types::Transaction &transaction,
                              const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 行情数据更新回调
  // @param tree              行情数据
  // @param location          数据来源
  virtual void on_tree(Context_ptr &context, const longfist::types::Tree &tree,
                       const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 行情数据更新回调
  // @param depth              行情数据
  // @param location          数据来源
  virtual void on_depth(Context_ptr &context, const longfist::types::Depth &depth,
                        const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 行情数据更新回调
  // @param tick              行情数据
  // @param location          数据来源
  virtual void on_tick(Context_ptr &context, const longfist::types::Tick &tick,
                       const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 用于做行情转录时的任意类型行情事件回调, 考虑不提供python binding
  //@param event md发布的任意类型行情事件
  virtual void on_event(Context_ptr &context, const event_ptr &event){};

  // Operator publish 的 synthetic_data 回调
  //@param synthetic_data   Operator publish 的 synthetic_data
  virtual void on_synthetic_data(Context_ptr &context, const longfist::types::SyntheticData &synthetic_data,
                                 const kungfu::yijinjing::data::location_ptr &location, uint32_t dest){};

  // 断开回调
  //@param deregister     断开数据
  virtual void on_deregister(Context_ptr &context, const longfist::types::Deregister &deregister,
                             const kungfu::yijinjing::data::location_ptr &location){};

  // 客户端状态变化回调
  //@param broker_state_update     状态变化
  virtual void on_broker_state_change(Context_ptr &context,
                                      const longfist::types::BrokerStateUpdate &broker_state_update,
                                      const kungfu::yijinjing::data::location_ptr &location){};

  // 订阅的其他算子器状态变化回调
  //@param operator_state_update     状态变化
  virtual void on_operator_state_change(Context_ptr &context,
                                        const longfist::types::OperatorStateUpdate &operator_state_update,
                                        const kungfu::yijinjing::data::location_ptr &location){};
};

DECLARE_PTR(Operator)
} // namespace kungfu::wingchun::op
#endif // WINGCHUN_OPERATOR_H
