#include <kungfu/wingchun/factor/crosssection.h>

using namespace kungfu::yijinjing;
using namespace kungfu::practice;
using namespace kungfu::longfist::types;
using namespace kungfu::rx;
namespace kungfu::wingchun::factor {

CrossSection CrossSection::loads(const std::string &serialized_cross_section) {
  CrossSection cross_section;
  cross_section.from_string(serialized_cross_section);
  return cross_section;
}

std::string CrossSection::dumps(const CrossSection &cross_section) { return cross_section.to_string(); }

std::string CrossSection::to_string() const {
  nlohmann::json j;
  j["factors"] = factors;
  j["prices"] = prices;
  j["gen_time"] = gen_time;
  return j.dump();
}

void CrossSection::from_string(const std::string &serialized_cross_section) {
  nlohmann::json j = nlohmann::json::parse(serialized_cross_section);
  factors = j["factors"].get<std::unordered_map<std::string, double>>();
  prices = j["prices"].get<std::unordered_map<std::string, double>>();
  gen_time = j["gen_time"].get<int64_t>();
}

void set_runner(MultiCrossSectionalFactor &factor_cache, apprentice *app) { factor_cache.app_ = app; }

void MultiCrossSectionalFactor::on_start(const rx::connectable_observable<event_ptr> &events) {
  events | is(Quote::tag) | $$(on_quote(event->data<Quote>()););
  events | is(Entrust::tag) | $$(on_entrust(event->data<Entrust>()););
  events | is(Transaction::tag) | $$(on_transaction(event->data<Transaction>()););
  events | is(Tree::tag) | $$(on_tree(event->data<Tree>()););
  events | is(Depth::tag) | $$(on_depth(event->data<Depth>()););
  events | is(Tick::tag) | $$(on_tick(event->data<Tick>()););
}

void MultiCrossSectionalFactor::update_price(const std::string &instrument_id, const std::string &exchange_id,
                                             double price) {
  const auto instrument_key = to_instrument_key(instrument_id, exchange_id);
  price_cache_.insert_or_assign(instrument_key, TimeStampPrice{now(), price});
}

double MultiCrossSectionalFactor::get_factor(std::string factor_name, const std::string &instrument_id,
                                             const std::string &exchange_id, double default_value) {
  const auto instrument_key = to_instrument_key(instrument_id, exchange_id);
  auto &cross_sectional_factor = multi_cross_sectional_factor_cache_[factor_name];
  auto it = cross_sectional_factor.find(instrument_key);
  if (it == cross_sectional_factor.end()) {
    cross_sectional_factor.emplace(instrument_key, default_value);
    return default_value;
  }
  return it->second;
}

void MultiCrossSectionalFactor::on_quote(const Quote &quote) {
  const double ask1_price = quote.ask_price[0];
  const double bid1_price = quote.bid_price[0];
  if (ask1_price == 0 || bid1_price == 0) {
    SPDLOG_WARN("Invalid quote in instrument={} at={}, ask1_price={}, bid1_price={}", quote.instrument_id,
                yijinjing::time::strftime(quote.data_time), ask1_price, bid1_price);
    return;
  }
  double mid_price = (ask1_price + bid1_price) / 2.0;
  update_price(quote.instrument_id, quote.exchange_id, mid_price);
}

void MultiCrossSectionalFactor::update_factor(std::string factor_name, const std::string &instrument_id,
                                              const std::string &exchange_id, double value) {
  const auto instrument_key = to_instrument_key(instrument_id, exchange_id);
  auto &cross_sectional_factor = multi_cross_sectional_factor_cache_[factor_name];
  cross_sectional_factor.insert_or_assign(instrument_key, value);
}

std::map<std::string, CrossSection>
MultiCrossSectionalFactor::generate_cross_sectional_factor(bool clear_price_cache, bool clear_factor_cache) {
  std::map<std::string, CrossSection> cross_sectional_factors;
  std::unordered_map<std::string, double> cross_sectional_prices;
  int64_t _now = now();
  for (const auto &[instrument_key, time_stamp_price] : price_cache_) {
    if (_now - time_stamp_price.time > 10 * yijinjing::time_unit::NANOSECONDS_PER_SECOND) {
      SPDLOG_WARN("Price is too old, instrument_key={}, last update time={}, now={}", instrument_key,
                  yijinjing::time::strftime(time_stamp_price.time), yijinjing::time::strftime(_now));
    }
    cross_sectional_prices[instrument_key] = time_stamp_price.price;
  }
  for (const auto &[factor_name, cross_section_factor] : multi_cross_sectional_factor_cache_) {
    cross_sectional_factors.try_emplace(factor_name, CrossSection{cross_section_factor, cross_sectional_prices, _now});
  }
  if (clear_factor_cache)
    multi_cross_sectional_factor_cache_.clear();
  if (clear_price_cache)
    price_cache_.clear();
  return cross_sectional_factors;
}

} // namespace kungfu::wingchun::factor