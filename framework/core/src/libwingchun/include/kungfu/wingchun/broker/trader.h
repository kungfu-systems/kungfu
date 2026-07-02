// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#ifndef WINGCHUN_TRADER_H
#define WINGCHUN_TRADER_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/broker/broker.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::broker {

FORWARD_DECLARE_CLASS_PTR(TraderVendor)
FORWARD_DECLARE_CLASS_PTR(Trader)
FORWARD_DECLARE_CLASS_PTR(TraderWriterHook)
FORWARD_DECLARE_CLASS_PTR(BaseService)
FORWARD_DECLARE_CLASS_PTR(OrderService)
FORWARD_DECLARE_CLASS_PTR(OrderTriggerService)
FORWARD_DECLARE_CLASS_PTR(AlgoOrderService)

typedef std::unordered_map<uint64_t, state<longfist::types::Order>> OrderMap;
typedef std::unordered_map<uint64_t, state<longfist::types::OrderAction>> OrderActionMap;
typedef std::unordered_map<uint64_t, state<longfist::types::Trade>> TradeMap;
typedef std::unordered_map<uint64_t, state<longfist::types::OrderTrigger>> OrderTriggerMap;
typedef std::unordered_map<uint64_t, state<longfist::types::OrderTriggerAction>> OrderTriggerActionMap;

typedef std::unordered_map<uint64_t, longfist::types::Order> Orders;
typedef std::unordered_map<uint64_t, Orders> SubOrders;
typedef std::vector<longfist::types::OrderInput> OrderInputs;
typedef std::unordered_map<uint32_t, OrderInputs> SubOrderInputs;
typedef std::unordered_map<uint64_t, state<longfist::types::AlgoOrder>> AlgoOrderMap;
typedef std::unordered_map<uint64_t, state<longfist::types::AlgoOrderInput>> AlgoOrderInputMap;
typedef std::unordered_map<uint64_t, state<longfist::types::AlgoOrderAction>> AlgoOrderActionMap;

typedef std::unordered_map<uint64_t, longfist::types::BlockMessage> BlockMessages;

inline std::pair<bool, bool> get_status(const Orders &orders) {
  bool all_finished = true;
  bool has_error = false;
  for (auto &iter : orders) {
    if (not is_final_status(iter.second.status)) {
      all_finished = false;
    }
    if (iter.second.status == longfist::enums::OrderStatus::Error) {
      has_error = true;
    }
  }
  return std::make_pair(all_finished, has_error);
}

class BaseService {
public:
  explicit BaseService(TraderVendor &vendor) : vendor_(vendor){};

  virtual ~BaseService() = default;

  virtual void on_recover() { recover_done_ = true; };

  virtual void on_active(){};

  virtual void on_frame(){};

protected:
  TraderVendor &vendor_;
  bool recover_done_ = false;

  Trader &get_service();
};

class OrderService : public BaseService {
public:
  explicit OrderService(TraderVendor &vendor) : BaseService(vendor) {}

  void on_order_input(const event_ptr &event);

  void on_order_action(const event_ptr &event);

  void on_order(int64_t gen_time, uint32_t source, uint32_t dest, const longfist::types::Order &order);

  void on_trade(int64_t gen_time, uint32_t source, uint32_t dest, const longfist::types::Trade &trade);

  void on_batch_order_tag(const event_ptr &event);

  void on_block_message(const longfist::types::BlockMessage &block_message);

  void lost_orders(bool bypass_recover = false);

  void lost_orders(uint32_t source, const longfist::types::OrderInput &order_input, bool bypass_recover = false);

  void clean_finished_orders(uint64_t now = INT64_MAX);

  void clean_trades();

  [[nodiscard]] const OrderMap &get_orders() const;

  [[nodiscard]] bool has_order(uint64_t order_id) const;

  kungfu::state<longfist::types::Order> &get_order(uint64_t order_id);

  [[nodiscard]] const TradeMap &get_trades() const;

  [[nodiscard]] const OrderActionMap &get_order_actions() const;

  [[nodiscard]] bool has_order_action(uint64_t action_id) const;

  [[nodiscard]] kungfu::state<longfist::types::OrderAction> &get_order_action(uint64_t action_id);

private:
  OrderMap orders_{};
  TradeMap trades_{};
  OrderActionMap order_actions_{};
  BlockMessages block_messages_ = {};
  std::unordered_map<uint32_t, bool> batch_status_{};
  SubOrderInputs batch_order_inputs_{};

  void clear_batch_order_inputs(uint32_t location_uid);
};

class OrderTriggerService : public BaseService {
public:
  explicit OrderTriggerService(TraderVendor &vendor) : BaseService(vendor) {}

  void on_order_trigger_input(const event_ptr &event);

  void on_order_trigger_action(const event_ptr &event);

  void on_order_trigger(int64_t gen_time, uint32_t source, uint32_t dest,
                        const longfist::types::OrderTrigger &order_trigger);

  void clean_order_triggers(bool bypass_recover = false);

  void clean_order_triggers(uint32_t source, const longfist::types::OrderTriggerInput &order_trigger_input,
                            bool bypass_recover = false);

  [[nodiscard]] const OrderTriggerMap &get_order_triggers() const;

  [[nodiscard]] bool has_order_trigger(uint64_t trigger_id) const;

  kungfu::state<longfist::types::OrderTrigger> &get_order_trigger(uint64_t trigger_id);

  [[nodiscard]] const OrderTriggerActionMap &get_order_trigger_actions() const;

  [[nodiscard]] bool has_order_trigger_action(uint64_t action_id) const;

  [[nodiscard]] kungfu::state<longfist::types::OrderTriggerAction> &get_order_trigger_action(uint64_t action_id);

private:
  OrderTriggerMap order_triggers_{};
  OrderTriggerActionMap order_trigger_actions_{};
};

class AlgoOrderService : public BaseService {
public:
  explicit AlgoOrderService(TraderVendor &vendor) : BaseService(vendor) {}

  void on_algo_order_input(const event_ptr &event);

  void on_algo_order_action(const event_ptr &event);

  void on_order(int64_t gen_time, uint32_t source, uint32_t dest, const longfist::types::Order &order);

  void on_algo_order(int64_t gen_time, uint32_t source, uint32_t dest, const longfist::types::AlgoOrder &algo_order);

  void on_trade(int64_t gen_time, uint32_t source, uint32_t dest, const longfist::types::Trade &trade);

  void clean_algo_orders(bool bypass_recover = false);

  void clean_algo_orders(uint32_t source, const longfist::types::AlgoOrderInput &algo_order_input,
                         bool bypass_recover = false);

  [[nodiscard]] const AlgoOrderMap &get_algo_orders() const;

  [[nodiscard]] bool has_algo_order(uint64_t algo_order_id) const;

  kungfu::state<longfist::types::AlgoOrder> &get_algo_order(uint64_t algo_order_id);

  [[nodiscard]] const AlgoOrderActionMap &get_algo_order_actions() const;

  void on_frame() override;

private:
  AlgoOrderMap local_algo_orders_;
  AlgoOrderMap waiting_record_local_algo_orders_;
  AlgoOrderMap algo_orders_;
  SubOrders local_sub_orders_;
  std::unordered_map<uint64_t, uint64_t> order_id_to_algo_order_id_;
  AlgoOrderActionMap algo_order_actions_;

  void try_update_sub_orders(const longfist::types::Order &order);

  std::pair<bool, bool> get_all_order_status(uint64_t algo_order_id);

  int64_t get_volume_traded(uint64_t algo_order_id);
};

class TraderWriterHook : public yijinjing::journal::writer_hook {
public:
  explicit TraderWriterHook(TraderVendor &vendor);

  void on_open_frame(int64_t trigger_time, yijinjing::journal::frame_ptr frame) override;

  void on_close_frame(int64_t gen_time, yijinjing::journal::frame_ptr frame) override;

private:
  TraderVendor &vendor_;

  BrokerService_ptr get_service();

  OrderService &get_order_service();

  OrderTriggerService &get_order_trigger_service();

  AlgoOrderService &get_algo_order_service();

  template <typename T> T &guard_update_time(const T &ct) {
    auto &t = const_cast<T &>(ct);
    t.update_time = yijinjing::time::now_in_nano();
    return t;
  }

  void guard_position(const longfist::types::Position &position);

  void guard_asset(const longfist::types::Asset &asset);
};

class TraderVendor : public BrokerVendor {
  friend class BaseService;

  friend class TraderWriterHook;

  friend class Trader;

public:
  TraderVendor(locator_ptr locator, const std::string &group, const std::string &name, longfist::enums::mode m,
               bool low_latency, const std::string &arguments = "{}");

  void set_service(Trader_ptr service);

  BrokerService_ptr get_service() override;

  void on_recover();

protected:
  void react() override;

  void on_start() override;

  void on_write_to(const event_ptr &event) override;

  void on_active() override;

  void on_frame() override;

private:
  Trader_ptr service_{};
  AlgoOrderService algo_order_service_;
  OrderService order_service_;
  OrderTriggerService order_trigger_service_;
  TraderWriterHook_ptr hook_;

  OrderService &get_order_service();

  const OrderService &get_order_service() const;

  OrderTriggerService &get_order_trigger_service();

  const OrderTriggerService &get_order_trigger_service() const;

  AlgoOrderService &get_algo_order_service();

  const AlgoOrderService &get_algo_order_service() const;
};

class Trader : public BrokerService {
  friend class TraderVendor;

public:
  explicit Trader(BrokerVendor &vendor) : BrokerService(vendor){};

  [[nodiscard]] virtual longfist::enums::AccountType get_account_type() const = 0;

  virtual bool insert_order(const event_ptr &event) = 0;

  virtual bool insert_order_trigger(const event_ptr &event) { return true; }

  virtual bool insert_block_order(const event_ptr &event, const longfist::types::BlockMessage &block_message) {
    return true;
  }

  virtual bool insert_batch_orders(const event_ptr &event, const OrderInputs &order_inputs) { return true; }

  virtual bool insert_algo_order(const event_ptr &event);

  virtual bool cancel_order(const event_ptr &event) = 0;

  virtual bool cancel_order_trigger(const event_ptr &event) { return true; }

  virtual bool cancel_algo_order(const event_ptr &event) { return true; }

  virtual bool toggle_algo_order(const event_ptr &event) { return true; }

  virtual bool req_position() = 0;

  virtual bool req_account() = 0;

  virtual bool req_order_trigger() { return true; }

  virtual bool req_contract() { return true; }

  virtual bool req_algo_order(const event_ptr &event) { return true; }

  virtual bool req_history_order(const event_ptr &event) { return true; }

  virtual bool req_history_trade(const event_ptr &event) { return true; }

  virtual void on_band(const event_ptr &event) {}

  virtual void on_time_key_value(const event_ptr &event) {}

  virtual bool on_strategy_exit(const event_ptr &event) { return true; }

  void on_risk_setting(const longfist::types::RiskSetting &risk_setting);

  [[nodiscard]] const std::string &get_account_id() const;

  [[nodiscard]] yijinjing::journal::writer_ptr get_asset_writer() const;

  [[nodiscard]] yijinjing::journal::writer_ptr get_position_writer() const;

  void enable_asset_sync();

  void enable_positions_sync();

  [[nodiscard]] const OrderMap &get_orders() const;

  [[nodiscard]] bool has_order(uint64_t order_id) const;

  [[nodiscard]] kungfu::state<longfist::types::Order> &get_order(uint64_t order_id);

  [[nodiscard]] const OrderActionMap &get_order_actions() const;

  [[nodiscard]] bool has_order_action(uint64_t action_id) const;

  [[nodiscard]] kungfu::state<longfist::types::OrderAction> &get_order_action(uint64_t action_id);

  [[nodiscard]] const TradeMap &get_trades() const;

  [[nodiscard]] const OrderTriggerMap &get_order_triggers() const;

  [[nodiscard]] bool has_order_trigger(uint64_t trigger_id) const;

  [[nodiscard]] kungfu::state<longfist::types::OrderTrigger> &get_order_trigger(uint64_t trigger_id);

  [[nodiscard]] const OrderTriggerActionMap &get_order_trigger_actions() const;

  [[nodiscard]] bool has_order_trigger_action(uint64_t action_id) const;

  [[nodiscard]] kungfu::state<longfist::types::OrderTriggerAction> &get_order_trigger_action(uint64_t action_id);

  [[nodiscard]] const AlgoOrderMap &get_algo_orders() const;

  [[nodiscard]] bool has_algo_order(uint64_t algo_order_id) const;

  [[nodiscard]] kungfu::state<longfist::types::AlgoOrder> &get_algo_order(uint64_t algo_order_id);

  [[nodiscard]] const AlgoOrderActionMap &get_algo_order_actions() const;

  [[nodiscard]] uint32_t get_risk_uid() const;

  void disable_recover();

  virtual void on_recover(){};

  [[nodiscard]] bool is_sync_account() const { return sync_account_; }

  void enable_sync_account() { sync_account_ = true; }

  void disable_sync_account() { sync_account_ = false; }

  void try_req_account();

protected:
  bool disable_recover_ = false;

private:
  bool sync_asset_ = false;
  bool sync_position_ = false;
  bool sync_account_ = false;
  uint32_t risk_uid_ = 0;

  void on_asset_sync();

  void on_position_sync();

  void recover();

  void recover_from_journal();

  void deal_write_frame();

  void deal_read_frame();

  void clean_finished_orders();

  [[nodiscard]] OrderService &get_order_service();

  [[nodiscard]] const OrderService &get_order_service() const;

  [[nodiscard]] OrderTriggerService &get_order_trigger_service();

  [[nodiscard]] const OrderTriggerService &get_order_trigger_service() const;

  [[nodiscard]] AlgoOrderService &get_algo_order_service();

  [[nodiscard]] const AlgoOrderService &get_algo_order_service() const;
};

} // namespace kungfu::wingchun::broker

#endif // WINGCHUN_TRADER_H
