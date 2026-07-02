
// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_FACTOR_CROSSSECTION_H
#define WINGCHUN_FACTOR_CROSSSECTION_H

#include <cstdint>
#include <kungfu/longfist/enums.h>
#include <kungfu/longfist/types.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <kungfu/yijinjing/time.h>
#include <unordered_map>

namespace kungfu::wingchun::factor {

inline std::string to_instrument_key(const std::string &instrument_id, const std::string &exchange_id) {
  return instrument_id + "@" + exchange_id;
}

inline std::pair<std::string, std::string> from_instrument_key(const std::string &instrument_key) {
  auto pos = instrument_key.find('@');
  if (pos == std::string::npos) {
    return {instrument_key, ""};
  }
  return {instrument_key.substr(0, pos), instrument_key.substr(pos + 1)};
}

struct CrossSection {
  CrossSection() = default;
  CrossSection(std::unordered_map<std::string, double> cross_sectional_factor,
               std::unordered_map<std::string, double> cross_sectional_price, int64_t gen_time)
      : factors(std::move(cross_sectional_factor)), prices(std::move(cross_sectional_price)), gen_time(gen_time) {}

  std::string to_string() const;

  void from_string(const std::string &serialized_cross_section);

  static CrossSection loads(const std::string &serialized_cross_section);

  static std::string dumps(const CrossSection &cross_section);

  std::unordered_map<std::string, double> factors;
  std::unordered_map<std::string, double> prices;
  int64_t gen_time;
};

class MultiCrossSectionalFactor {
public:
  MultiCrossSectionalFactor() = default;

  MultiCrossSectionalFactor(const MultiCrossSectionalFactor &) = delete;

  MultiCrossSectionalFactor &operator=(const MultiCrossSectionalFactor &) = delete;

  virtual ~MultiCrossSectionalFactor() = default;

  void update_price(const std::string &instrument_id, const std::string &exchange_id, double price);

  void update_factor(std::string factor_name, const std::string &instrument_id, const std::string &exchange_id,
                     double value);

  double get_factor(std::string factor_name, const std::string &instrument_id, const std::string &exchange_id,
                    double default_value);

  std::map<std::string, CrossSection> generate_cross_sectional_factor(bool clear_price_cache, bool clear_factor_cache);

  virtual void on_start(const rx::connectable_observable<event_ptr> &events);

protected:
  virtual void on_tick(const longfist::types::Tick &tick){};

  virtual void on_quote(const longfist::types::Quote &quote);

  virtual void on_entrust(const longfist::types::Entrust &entrust){};

  virtual void on_transaction(const longfist::types::Transaction &transaction){};

  virtual void on_tree(const longfist::types::Tree &tree){};

  virtual void on_depth(const longfist::types::Depth &depth){};

  int64_t now() const {
    if (not app_)
      SPDLOG_ERROR("MultiCrossSectionalFactor had not been attached.");
    return app_->now();
  }

private:
  struct TimeStampPrice {
    int64_t time;
    double price;
  };
  friend void set_runner(MultiCrossSectionalFactor &factor_cache, practice::apprentice *runner);

  practice::apprentice *app_;
  std::map<std::string, std::unordered_map<std::string, double>> multi_cross_sectional_factor_cache_;
  std::unordered_map<std::string, TimeStampPrice> price_cache_;
};

} // namespace kungfu::wingchun::factor
#endif // WINGCHUN_FACTOR_CROSSSECTION_H