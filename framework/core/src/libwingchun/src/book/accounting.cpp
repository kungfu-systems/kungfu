// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/4.
//

#include "accounting/default/bond.hpp"
#include "accounting/default/crypto.hpp"
#include "accounting/default/crypto_future.hpp"
#include "accounting/default/crypto_ufuture.hpp"
#include "accounting/default/future.hpp"
#include "accounting/default/repo.hpp"
#include "accounting/default/stock.hpp"
#include "accounting/otc/otc_future.hpp"
#include "accounting/otc/stock.hpp"
#include <kungfu/wingchun/book/bookkeeper.h>

using namespace kungfu::wingchun;
using namespace kungfu::longfist::enums;

namespace kungfu::wingchun::book {
void AccountingMethod::setup_defaults(Bookkeeper &bookkeeper, const AccountingMethodType accounting_method_type) {
  auto bond_accounting_method = std::make_shared<BondAccountingMethod>();
  auto repo_accounting_method = std::make_shared<RepoAccountingMethod>();
  auto crypto_accounting_method = std::make_shared<CryptoAccountingMethod>();
  auto crypto_future_accounting_method = std::make_shared<CryptoFutureAccountingMethod>();
  auto crypto_ufuture_accounting_method = std::make_shared<CryptoUFutureAccountingMethod>();
  auto future_accounting_method = std::make_shared<FutureAccountingMethod>();

  if (accounting_method_type == AccountingMethodType::OTC) {
    auto otc_stock_accounting_method = std::make_shared<OtcStockAccountingMethod>();
    bookkeeper.set_accounting_method(InstrumentType::Unknown, otc_stock_accounting_method);
    bookkeeper.set_accounting_method(InstrumentType::Stock, otc_stock_accounting_method);
    bookkeeper.set_accounting_method(InstrumentType::TechStock, otc_stock_accounting_method);
    bookkeeper.set_accounting_method(InstrumentType::Fund, otc_stock_accounting_method);
    bookkeeper.set_accounting_method(InstrumentType::Index, otc_stock_accounting_method);
    auto otc_future_accounting_method = std::make_shared<OtcFutureAccountingMethod>();
    bookkeeper.set_accounting_method(InstrumentType::Future, otc_future_accounting_method);
  } else {
    auto stock_accouting_method = std::make_shared<StockAccountingMethod>();
    bookkeeper.set_accounting_method(InstrumentType::Unknown, stock_accouting_method);
    bookkeeper.set_accounting_method(InstrumentType::Stock, stock_accouting_method);
    bookkeeper.set_accounting_method(InstrumentType::TechStock, stock_accouting_method);
    bookkeeper.set_accounting_method(InstrumentType::Fund, stock_accouting_method);
    bookkeeper.set_accounting_method(InstrumentType::Index, stock_accouting_method);
    auto future_accounting_method = std::make_shared<FutureAccountingMethod>();
    bookkeeper.set_accounting_method(InstrumentType::Future, future_accounting_method);
  }

  bookkeeper.set_accounting_method(InstrumentType::StockOption, future_accounting_method);
  bookkeeper.set_accounting_method(InstrumentType::Bond, bond_accounting_method);
  bookkeeper.set_accounting_method(InstrumentType::Repo, repo_accounting_method);
  bookkeeper.set_accounting_method(InstrumentType::Crypto, crypto_accounting_method);
  bookkeeper.set_accounting_method(InstrumentType::CryptoFuture, crypto_future_accounting_method);
  bookkeeper.set_accounting_method(InstrumentType::CryptoUFuture, crypto_ufuture_accounting_method);
}

bool AccountingMethod::guard_order_accounting(uint32_t source, uint32_t dest, Book_ptr book,
                                              const longfist::types::Order &order) {
  if (not is_final_status(order.status)) {
    return false;
  }

  if (dest == location::SYNC or dest == location::PUBLIC) {
    return false;
  }

  return true;
}

bool AccountingMethod::guard_trade_accounting(uint32_t source, uint32_t dest, Book_ptr book,
                                              const longfist::types::Trade &trade) {
  if (dest == location::SYNC or dest == location::PUBLIC) {
    return false;
  }

  return true;
};

} // namespace kungfu::wingchun::book