
// SPDX-License-Identifier: Apache-2.0
#ifndef WINGCHUN_OPERATOR_CONTEXT_H
#define WINGCHUN_OPERATOR_CONTEXT_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/book/bookkeeper.h>
#include <kungfu/wingchun/book/staticdata.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/wingchun/factor/backteststreamdatabatcher.h>
#include <kungfu/wingchun/factor/crosssection.h>
#include <kungfu/wingchun/factor/livestreamdatabatcher.h>
#include <kungfu/wingchun/factor/streamdatabatcher.h>
#include <kungfu/wingchun/orderbook/orderbooks.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::op {
class Context : public std::enable_shared_from_this<Context> {
public:
  Context(practice::apprentice &app, const rx::connectable_observable<event_ptr> &events);

  virtual ~Context() = default;

  /**
   * checked_ is strated started.
   * @return current time in nano seconds
   */
  virtual bool is_started() const = 0;

  /**
   * Get current time in nano seconds.
   * @return current time in nano seconds
   */
  virtual int64_t now() const = 0;

  /**
   * Get location_uid of current process
   * @return location_uid
   */
  virtual uint32_t get_home_uid() const = 0;

  /**
   * Get config from database.
   * @return  config of current location_uid
   */
  virtual const std::string get_config() const = 0;

  /**
   * Get arguments kfc run -a
   * @return string of arguments
   */

  virtual std::string get_arguments() { return app_.get_arguments(); };

  /**
   * Add one shot timer callback.
   * @param nanotime when to call in nano seconds
   * @param callback callback function
   */
  virtual int32_t add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) = 0;

  /**
   * Add periodically callback.
   * @param duration duration in nano seconds
   * @param callback callback function
   */
  virtual int32_t add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) = 0;

  /**
   * Clear timer
   * @param timer_id id of timer, return by add_timer and add_time_interval
   */
  virtual void clear_timer(int32_t timer_id) = 0;

  /**
   * Subscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange ID
   */
  virtual void subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                         const std::string &exchange_id) = 0;

  /**
   * Unubscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange ID
   */
  virtual void unsubscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                           const std::string &exchange_id){};

  /**
   * Subscribe all from given MD
   * @param source MD group
   */
  virtual void subscribe_all(const std::string &source, uint8_t market_type = 0, uint64_t instrument_type = 0,
                             uint64_t data_type = 0) = 0;

  /**
   * Subscribe operator data.
   * @param group OPERATOR group
   * @param name OPERATOR name
   */
  virtual void subscribe_operator(const std::string &group, const std::string &name) = 0;

  /**
   * publish operator data.
   * @param key key of data to be published
   * @param value value of data to be published
   */
  virtual void publish_synthetic_data(const std::string &key, const std::string &value) = 0;

  /**
   * request deregister.
   * @return void
   */
  virtual void req_deregister() {}

  /**
   * Update Strategy State
   * @param state StrategyState
   * @param infos vector<string>, info_a, info_b, info_c.
   */
  virtual void update_operator_state(longfist::types::OperatorStateUpdate &state_update) {}

  /**
   * Get broker client.
   * @return broker client reference
   */
  virtual broker::Client &get_broker_client() = 0;

  /**
   * Get bookkeeper.
   * @return bookkeeper reference
   */
  virtual book::Bookkeeper &get_bookkeeper() = 0;

  /**
   *
   * @param location_uid
   * @return location_ptr of location_uid
   */
  virtual yijinjing::data::location_ptr get_location(uint32_t location_uid) = 0;

  /**
   *
   * @param resume_policy
   * @return void
   */
  virtual void set_resume_policy(longfist::enums::ResumePolicy resume_policy){};

  /**
   *
   * @return longfist::enums::ResumePolicy
   */
  virtual longfist::enums::ResumePolicy get_resume_policy() { return longfist::enums::ResumePolicy::Now; };

  /**
   * attach the orderbooks to market data received.
   * @param orderbooks
   */
  void attach_orderbooks(orderbook::Orderbooks &orderbooks);

  /**
   * attach the factor cache to market data received.
   * @param factor_cache
   */
  void attach_factor_cache(factor::MultiCrossSectionalFactor &factor_cache);

  /**
   * the directory of operator
   * @return
   */
  const std::string &get_operator_dir();

  virtual std::shared_ptr<wingchun::factor::StreamDataBatcher> batch_streaming() = 0;

protected:
  practice::apprentice &app_;
  const rx::connectable_observable<event_ptr> &events_;
  std::string operator_dir_;
  bool started_ = false;

  virtual void on_start(){};

  virtual void prepare(const event_ptr &event) = 0;

  virtual void post_stop(){};

private:
  friend void enable(Context &context) { context.on_start(); }

  friend void prepare(const event_ptr &event, Context &context) { context.prepare(event); }

  friend void make_operator_dir(Context &context, const std::string &operator_dir) {
    context.operator_dir_ = operator_dir;
  }

  friend void stop(Context &context) { context.post_stop(); }
};
} // namespace kungfu::wingchun::op

#endif // WINGCHUN_OPERATOR_CONTEXT_H
