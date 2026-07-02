// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#ifndef WINGCHUN_ACCOUNTING_H
#define WINGCHUN_ACCOUNTING_H

#include <kungfu/longfist/enums.h>
#include <kungfu/wingchun/book/book.h>

namespace kungfu::wingchun::book {
static const longfist::enums::AccountingMethodType get_accounting_method_type() {
  char *is_otc = std::getenv("IS_OTC_ACCOUNTING_TYPE");
  if (is_otc == nullptr) {
    SPDLOG_DEBUG("AccountingMethod::setup_defaults IS_OTC_ACCOUNTING_TYPE is unset, use DEFAULT");
    return longfist::enums::AccountingMethodType::Default;
  }

  SPDLOG_DEBUG("AccountingMethod::setup_defaults IS_OTC_ACCOUNTING_TYPE = {}", is_otc);
  std::string yes_str = "1";
  if (strcmp(is_otc, yes_str.c_str()) == 0) {
    return longfist::enums::AccountingMethodType::OTC;
  }
  return longfist::enums::AccountingMethodType::Default;
}

class AccountingMethod {
public:
  AccountingMethod() = default;

  virtual ~AccountingMethod() = default;

  virtual void apply_quote(Book_ptr &book, const longfist::types::Quote &quote) = 0;

  virtual void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book,
                                 const longfist::types::OrderInput &input) = 0;

  virtual void apply_order(uint32_t account_id, uint32_t dest, Book_ptr &book, const longfist::types::Order &order) = 0;

  virtual void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const longfist::types::Trade &trade) = 0;

  virtual void update_position(Book_ptr &book, longfist::types::Position &position) = 0;

  virtual bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                            longfist::types::Asset &asset, const longfist::types::Position &position) = 0;

  static void setup_defaults(Bookkeeper &bookkeeper,
                             const longfist::enums::AccountingMethodType accounting_method_type);

  bool guard_order_accounting(uint32_t source, uint32_t dest, Book_ptr book, const longfist::types::Order &order);

  bool guard_trade_accounting(uint32_t source, uint32_t dest, Book_ptr book, const longfist::types::Trade &trade);
};

DECLARE_PTR(AccountingMethod)
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_H
