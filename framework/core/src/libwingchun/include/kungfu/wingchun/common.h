// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-19.
//

#ifndef WINGCHUN_COMMON_H
#define WINGCHUN_COMMON_H

#include <cmath>
#include <locale>

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <kungfu/yijinjing/time.h>
#include <kungfu/yijinjing/util/util.h>

#define EXCHANGE_SSE "SSE"     // 上交所
#define EXCHANGE_SZE "SZE"     // 深交所
#define EXCHANGE_BSE "BSE"     // 北交所
#define EXCHANGE_GFEX "GFEX"   // 广期所
#define EXCHANGE_SHFE "SHFE"   // 上期所
#define EXCHANGE_DCE "DCE"     // 大商所
#define EXCHANGE_CZCE "CZCE"   // 郑商所
#define EXCHANGE_CFFEX "CFFEX" // 中金所
#define EXCHANGE_INE "INE"     // 上海能源中心

// 全市场exchange id定义
#define EXCHANGE_HK "HK" // 港股: 4（香港交易所）
#define EXCHANGE_SHHK "SHHK"
#define EXCHANGE_SZHK "SZHK"
#define EXCHANGE_HK_FUTURE "HKFUT"     // 港股期货: 5（香港交易所）
#define EXCHANGE_US "US"               // 美股: 29（纳斯达克交易所）
#define EXCHANGE_US_FUTURE "USFUT"     // 美期: 29（纳斯达克交易所）
#define EXCHANGE_SGX "SGX"             // 新加坡交易所股票
#define EXCHANGE_SGX_FUTURE "SGXFUT"   // 新加坡交易所期货
#define EXCHANGE_EUR "EUR"             // 欧洲交易所股票
#define EXCHANGE_EUR_FUTURE "EURFUT"   // 欧洲坡交易所期货
#define EXCHANGE_LON "LON"             // 英股: 伦敦证券交易所
#define EXCHANGE_LON_FUTURE "LONFUT"   // 英期
#define EXCHANGE_AEX "AEX"             // 荷股
#define EXCHANGE_AEX_FUTURE "AEXFUT"   // 荷期
#define EXCHANGE_AUX "AUX"             // 澳股
#define EXCHANGE_AUX_FUTURE "AUXFUT"   // 澳期
#define EXCHANGE_HEXS "HEXS"           // 芬股
#define EXCHANGE_HEXS_FUTURE "HEXSFUT" // 芬期
#define EXCHANGE_IDX "IDX"             // 印尼股
#define EXCHANGE_IDX_FUTURE "IDXFUT"   // 印尼期
#define EXCHANGE_KORC "KORC"           // 韩碳所
#define EXCHANGE_LME "LME"             // 伦金所
#define EXCHANGE_MYS "MYS"             // 马来股
#define EXCHANGE_MYS_FUTURE "MYSFUT"   // 马来期
#define EXCHANGE_ABB "ABB"             // 美布告
#define EXCHANGE_PRX "PRX"             // 法股
#define EXCHANGE_PRX_FUTURE "PRXFUT"   // 法期
#define EXCHANGE_SIX "SIX"             // 瑞股
#define EXCHANGE_SIX_FUTURE "SIXFUT"   // 瑞期
#define EXCHANGE_TAX "TAX"             // 泰股
#define EXCHANGE_TAX_FUTURE "TAXFUT"   // 泰期
#define EXCHANGE_JP "JP"               // 日股
#define EXCHANGE_JP_FUTURE "JPFUT"     // 日期
#define EXCHANGE_TSE "TSE"             // 多股
#define EXCHANGE_TSE_FUTURE "TSEFUT"   // 多期
#define EXCHANGE_XETRA "XETRA"         // XETRA

#define EXCHANGE_GLFX "GLFX" // 全球外汇: 41
#define EXCHANGE_IPE "IPE"   // LME\IPE: 45(LME（伦敦金属交易所）、ICE)
#define EXCHANGE_CBOT "CBOT" // ES-CBOT: 62
#define EXCHANGE_CEC "CEC"   // ES-CEC: 63
#define EXCHANGE_LIFE "LIFE" // ES-LIFE: 64
#define EXCHANGE_MTIF "MTIF" // ES-MTIF: 65
#define EXCHANGE_NYCE "NYCE" // ES-NYCE: 66、49
#define EXCHANGE_CMX "CMX"   // ES-CMX: 67
#define EXCHANGE_NYME "NYME" // ES-NYME: 68
#define EXCHANGE_SIME "SIME" // ES-SIME: 69
#define EXCHANGE_CME "CME"   // ES-CME: 70
#define EXCHANGE_IMM "IMM"   // ES-IMM: 71
#define EXCHANGE_WIDX "WIDX" // ES-WIDX: 72
#define EXCHANGE_FREX "FREX" // ES-FREX: 73
#define EXCHANGE_METL "METL" // ES-METL: 74
#define EXCHANGE_IPM "IPM"   // 国际贵金属: 5000

#define EPSILON (1e-6)
#define DOUBLEMAX (1e16) // 一亿亿, 2018年A股总市值不到50万亿

#define EXCHANGE_HB "HB"                            //
#define EXCHANGE_OKX_SPOT "OKX-SPOT"                //
#define EXCHANGE_OKX_USD_FUTURE "OKX-UFUT"          //
#define EXCHANGE_OKX_COIN_FUTURE "OKX-CFUT"         //
#define EXCHANGE_BINANCE_SPOT "BINANCE-SPOT"        //
#define EXCHANGE_BINANCE_USD_FUTURE "BINANCE-UFUT"  //
#define EXCHANGE_BINANCE_COIN_FUTURE "BINANCE-CFUT" //

namespace kungfu::wingchun {
constexpr double VOLUME_ZERO = 0;
constexpr uint64_t UINT64_ZERO = 0;

class wingchun_error : public std::runtime_error {
public:
  explicit wingchun_error(const std::string &_s) : std::runtime_error(_s) { SPDLOG_CRITICAL(_s); }

  explicit wingchun_error(const char *_s) : std::runtime_error(_s) { SPDLOG_CRITICAL(_s); }

  ~wingchun_error() noexcept override = default;
};

inline bool is_greater(double x, double y) { return std::isgreater(x - y, EPSILON); }

inline bool is_less(double x, double y) { return std::isless(x - y, EPSILON * -1); }

inline bool is_equal(double x, double y) { return std::abs(x - y) <= EPSILON * std::abs(x); }

inline bool is_greater_equal(double x, double y) { return is_greater(x, y) || is_equal(x, y); }

inline bool is_less_equal(double x, double y) { return is_less(x, y) || is_equal(x, y); }

inline bool is_zero(double x) { return is_equal(x, 0.0); }

inline bool is_too_large(double x) { return is_greater(x, DOUBLEMAX); }

inline bool is_valid_price(double price) { return !is_less_equal(price, 0.0) && !is_too_large(price); }

inline double rounded(double x, int n) {
  if (is_too_large(x) || is_zero(x) || is_too_large(std::abs(x))) {
    return 0.0;
  } else {
    char out[64];
    double xrounded;
    sprintf(out, "%.*f", n, x);
    xrounded = strtod(out, nullptr);
    return xrounded;
  }
}

inline bool string_equals(const std::string &s1, const std::string &s2) {
  return std::strcmp(s1.c_str(), s2.c_str()) == 0;
}

inline bool string_equals_n(const std::string &s1, const std::string &s2, size_t l) {
  return std::strncmp(s1.c_str(), s2.c_str(), l) == 0;
}

inline bool endswith(const std::string &str, const std::string &suffix) {
  return str.size() >= suffix.size() && 0 == str.compare(str.size() - suffix.size(), suffix.size(), suffix);
}

inline bool startswith(const std::string &str, const std::string &prefix) {
  return str.size() >= prefix.size() && 0 == str.compare(0, prefix.size(), prefix);
}

inline bool is_final_status(const longfist::enums::OrderStatus &status) {
  if (std::find(longfist::enums::CONTINUING_STATUS.begin(), longfist::enums::CONTINUING_STATUS.end(), (int8_t)status) !=
      longfist::enums::CONTINUING_STATUS.end()) {
    return false;
  } else {
    return true;
  }
}

inline bool is_convertible_bond(const std::string &instrument_id, const std::string &exchange_id) {
  return ((string_equals_n(instrument_id, "123", 3) || string_equals_n(instrument_id, "128", 3) ||
           string_equals_n(instrument_id, "117", 3) || string_equals_n(instrument_id, "127", 3) ||
           string_equals_n(instrument_id, "125", 3) || string_equals_n(instrument_id, "126", 3)) &&
          string_equals(exchange_id, EXCHANGE_SZE)) ||
         ((string_equals_n(instrument_id, "110", 3) || string_equals_n(instrument_id, "113", 3)) &&
          string_equals(exchange_id, EXCHANGE_SSE));
}

inline bool is_repo(const std::string &instrument_id, const std::string &exchange_id) {
  return (string_equals_n(instrument_id, "204", 3) && string_equals(exchange_id, EXCHANGE_SSE)) ||
         (string_equals_n(instrument_id, "1318", 4) && string_equals(exchange_id, EXCHANGE_SZE));
}

inline double get_repo_commission_rate(const std::string &instrument_id) {
  if (string_equals(instrument_id, "204001") || string_equals(instrument_id, "131810")) {
    return 0.00001;
  } else if (string_equals(instrument_id, "204002") || string_equals(instrument_id, "131811")) {
    return 0.00002;
  } else if (string_equals(instrument_id, "204003") || string_equals(instrument_id, "131800")) {
    return 0.00003;
  } else if (string_equals(instrument_id, "204004") || string_equals(instrument_id, "131809")) {
    return 0.00004;
  } else if (string_equals(instrument_id, "204007") || string_equals(instrument_id, "131801")) {
    return 0.00005;
  } else if (string_equals(instrument_id, "204014") || string_equals(instrument_id, "131802")) {
    return 0.00010;
  } else if (string_equals(instrument_id, "204029") || string_equals(instrument_id, "131803")) {
    return 0.00020;
  } else if (string_equals(instrument_id, "204091") || string_equals(instrument_id, "131805")) {
    return 0.00030;
  } else if (string_equals(instrument_id, "204182") || string_equals(instrument_id, "131806")) {
    return 0.00030;
  } else {
    return 0.0;
  }
}

inline int get_repo_expire_days(const std::string &instrument_id) {
  if (string_equals(instrument_id, "204001") || string_equals(instrument_id, "131810")) {
    return 1;
  } else if (string_equals(instrument_id, "204002") || string_equals(instrument_id, "131811")) {
    return 2;
  } else if (string_equals(instrument_id, "204003") || string_equals(instrument_id, "131800")) {
    return 3;
  } else if (string_equals(instrument_id, "204004") || string_equals(instrument_id, "131809")) {
    return 4;
  } else if (string_equals(instrument_id, "204007") || string_equals(instrument_id, "131801")) {
    return 7;
  } else if (string_equals(instrument_id, "204014") || string_equals(instrument_id, "131802")) {
    return 14;
  } else if (string_equals(instrument_id, "204029") || string_equals(instrument_id, "131803")) {
    return 28;
  } else if (string_equals(instrument_id, "204091") || string_equals(instrument_id, "131805")) {
    return 91;
  } else if (string_equals(instrument_id, "204182") || string_equals(instrument_id, "131806")) {
    return 182;
  } else {
    return 0;
  }
}

// 标的代码和类型
struct HKCodeRule {
  int beg = 0;
  int end = 0;
  longfist::enums::InstrumentType type;
};

// 获取港股标的类型
inline longfist::enums::InstrumentType get_instrument_type_by_exchange_hk(const std::string &instrument_id) {
  // 查看地址：https://www.hkex.com.hk/-/media/HKEX-Market/Products/Securities/Stock-Code-Allocation-Plan/scap_c.pdf
  static std::vector<HKCodeRule> hk_code_type_def = {
      {1, 2799, longfist::enums::InstrumentType::Stock},
      {2800, 2849, longfist::enums::InstrumentType::Fund}, // 交易所買賣基金
      {3000, 3199, longfist::enums::InstrumentType::Fund},
      {3400, 3499, longfist::enums::InstrumentType::Fund},
      {4000, 4199, longfist::enums::InstrumentType::Bond}, // 香港金融管理局的外匯基金債券
      {4200, 4299, longfist::enums::InstrumentType::Bond},
      {4300, 4329, longfist::enums::InstrumentType::Bond},
      {4400, 4599, longfist::enums::InstrumentType::Bond},
      {5000, 6029, longfist::enums::InstrumentType::Bond},
      {40000, 40999, longfist::enums::InstrumentType::Bond},
      {4600, 4699, longfist::enums::InstrumentType::Stock},
      {4700, 4799, longfist::enums::InstrumentType::Bond},
      {4800, 4999, longfist::enums::InstrumentType::Stock}, // SPAC 權證
      {6200, 6299, longfist::enums::InstrumentType::Stock},
      {6300, 6399, longfist::enums::InstrumentType::Stock},
      {6750, 6799, longfist::enums::InstrumentType::Bond},  // 中華人民共和國財政部債券
      {7200, 7399, longfist::enums::InstrumentType::Stock}, // 槓桿及反向產品
      {7500, 7599, longfist::enums::InstrumentType::Stock},
      {7800, 7999, longfist::enums::InstrumentType::Stock}, // SPAC 股份
      {8000, 8999, longfist::enums::InstrumentType::Stock},
      {9000, 9199, longfist::enums::InstrumentType::Fund}, // 交易所買賣基金(以美元買賣)
      {9400, 9499, longfist::enums::InstrumentType::Fund},
      {9800, 9849, longfist::enums::InstrumentType::Fund},
      {9200, 9399, longfist::enums::InstrumentType::Stock}, // 槓桿及反向產品(以美元
      {9500, 9599, longfist::enums::InstrumentType::Stock},
      {10000, 29999, longfist::enums::InstrumentType::StockOption}, // 衍生權證
      {30000, 39999, longfist::enums::InstrumentType::Stock},       // 供日後使用
      {41000, 46999, longfist::enums::InstrumentType::Stock},       // 供日後使用
      {47000, 48999, longfist::enums::InstrumentType::StockOption}, // 界內證
      {49000, 49999, longfist::enums::InstrumentType::Stock},       // 供日後使用
      {50000, 69999, longfist::enums::InstrumentType::StockOption},
      {70000, 79999, longfist::enums::InstrumentType::Stock}, // 供日後使用
      {82800, 82849, longfist::enums::InstrumentType::Fund},  // 交易所買賣基金
      {83000, 83199, longfist::enums::InstrumentType::Fund},
      {83400, 83499, longfist::enums::InstrumentType::Fund},
      {84300, 84329, longfist::enums::InstrumentType::Bond}, // 僅售予專業投資者的債務證券
      {84400, 84599, longfist::enums::InstrumentType::Bond},
      {85000, 85743, longfist::enums::InstrumentType::Bond},
      {85901, 86029, longfist::enums::InstrumentType::Bond},
      {84600, 84699, longfist::enums::InstrumentType::Stock}, // 僅售予專業投資者優先股
      {85744, 85900, longfist::enums::InstrumentType::Stock},
      {86600, 86799, longfist::enums::InstrumentType::Bond}, // 中華人民共和國財政部債券
      {87000, 87099,
       longfist::enums::InstrumentType::Fund}, // 房地產投資信託基金及交易所買賣基金以外的單位信託 / 互惠基金
      {87200, 87399, longfist::enums::InstrumentType::Stock},       // 槓桿及反向產品
      {87500, 87599, longfist::enums::InstrumentType::Stock},       // 槓桿及反向產品
      {89000, 89999, longfist::enums::InstrumentType::StockOption}, // 衍生權證
      {90000, 99999, longfist::enums::InstrumentType::Stock},       // 供日後使用
  };
  int nId = 0;
  try {
    nId = std::stoi(instrument_id);
  } catch (const std::invalid_argument &ia) {
    // Handle invalid_argument exception
    SPDLOG_ERROR("Invalid argument: {}, instrument_id: {}", ia.what(), instrument_id);
    return longfist::enums::InstrumentType::Unknown;
  } catch (const std::out_of_range &oor) {
    // Handle out_of_range exception
    SPDLOG_ERROR("Out of range: {}, instrument_id: {}", oor.what(), instrument_id);
    return longfist::enums::InstrumentType::Unknown;
  }

  for (auto &iter : hk_code_type_def) {
    if (nId >= iter.beg && nId <= iter.end) {
      return iter.type;
    }
  }

  return longfist::enums::InstrumentType::Stock;
}

inline const std::string exchange_id_from_market_type(longfist::enums::MarketType market_type) {
  switch (market_type) {
  case longfist::enums::MarketType::BSE:
    return EXCHANGE_BSE;
  case longfist::enums::MarketType::SHFE:
    return EXCHANGE_SHFE;
  case longfist::enums::MarketType::CFFEX:
    return EXCHANGE_CFFEX;
  case longfist::enums::MarketType::DCE:
    return EXCHANGE_DCE;
  case longfist::enums::MarketType::CZCE:
    return EXCHANGE_CZCE;
  case longfist::enums::MarketType::INE:
    return EXCHANGE_INE;
  case longfist::enums::MarketType::SSE:
    return EXCHANGE_SSE;
  case longfist::enums::MarketType::SZE:
    return EXCHANGE_SZE;
  case longfist::enums::MarketType::All:
    return "";
  default:
    return "Unknown";
  }
}

inline longfist::enums::InstrumentType get_instrument_type(const std::string &exchange_id,
                                                           const std::string &instrument_id) {
  if (string_equals(exchange_id, EXCHANGE_SSE)) {
    if (instrument_id.length() == 8) {
      return longfist::enums::InstrumentType::StockOption;
    }
    if (startswith(instrument_id, "00")) {
      return longfist::enums::InstrumentType::Index;
    } else if (startswith(instrument_id, "0")) {
      return longfist::enums::InstrumentType::Bond;
    } else if (startswith(instrument_id, "1")) {
      return longfist::enums::InstrumentType::Bond;
    } else if (startswith(instrument_id, "2")) {
      return longfist::enums::InstrumentType::Repo;
    } else if (startswith(instrument_id, "5")) {
      return longfist::enums::InstrumentType::Fund;
    } else if (startswith(instrument_id, "688") || startswith(instrument_id, "787") ||
               startswith(instrument_id, "789")) {
      return longfist::enums::InstrumentType::TechStock;
    }

    return longfist::enums::InstrumentType::Stock;
  } else if (string_equals(exchange_id, EXCHANGE_SZE)) {
    if (instrument_id.length() == 8) {
      return longfist::enums::InstrumentType::StockOption;
    }
    if (startswith(instrument_id, "15") || startswith(instrument_id, "16") || startswith(instrument_id, "18")) {
      return longfist::enums::InstrumentType::Fund;
    } else if (startswith(instrument_id, "131")) {
      return longfist::enums::InstrumentType::Repo;
    } else if (startswith(instrument_id, "1")) {
      return longfist::enums::InstrumentType::Bond;
    }
    return longfist::enums::InstrumentType::Stock;
  } else if (endswith(exchange_id, "-SPOT")) {
    return longfist::enums::InstrumentType::Crypto;
  } else if (endswith(exchange_id, "-CFUT")) {
    return longfist::enums::InstrumentType::CryptoFuture;
  } else if (endswith(exchange_id, "-UFUT")) {
    return longfist::enums::InstrumentType::CryptoUFuture;
  } else if (string_equals(exchange_id, EXCHANGE_BSE)) {
    return longfist::enums::InstrumentType::Stock;
  } else if (string_equals(exchange_id, EXCHANGE_DCE) || string_equals(exchange_id, EXCHANGE_SHFE) ||
             string_equals(exchange_id, EXCHANGE_CFFEX) || string_equals(exchange_id, EXCHANGE_CZCE) ||
             string_equals(exchange_id, EXCHANGE_INE) || string_equals(exchange_id, EXCHANGE_GFEX)) {
    return longfist::enums::InstrumentType::Future;
  } else if (string_equals(exchange_id, EXCHANGE_HB)) {
    return longfist::enums::InstrumentType::Crypto;
  } else if (string_equals(exchange_id, EXCHANGE_HK) || string_equals(exchange_id, EXCHANGE_SHHK) ||
             string_equals(exchange_id, EXCHANGE_SZHK)) {
    return get_instrument_type_by_exchange_hk(instrument_id);
  } else if (string_equals(exchange_id, EXCHANGE_HK_FUTURE) || string_equals(exchange_id, EXCHANGE_US_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_SGX_FUTURE) || string_equals(exchange_id, EXCHANGE_LON_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_AEX_FUTURE) || string_equals(exchange_id, EXCHANGE_AUX_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_HEXS_FUTURE) || string_equals(exchange_id, EXCHANGE_IDX_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_KORC) || string_equals(exchange_id, EXCHANGE_LME) ||
             string_equals(exchange_id, EXCHANGE_MYS_FUTURE) || string_equals(exchange_id, EXCHANGE_ABB) ||
             string_equals(exchange_id, EXCHANGE_PRX_FUTURE) || string_equals(exchange_id, EXCHANGE_SIX_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_TAX_FUTURE) || string_equals(exchange_id, EXCHANGE_JP_FUTURE) ||
             string_equals(exchange_id, EXCHANGE_TSE_FUTURE) || string_equals(exchange_id, EXCHANGE_XETRA) ||
             string_equals(exchange_id, EXCHANGE_EUR_FUTURE)) {
    return longfist::enums::InstrumentType::Future;
  } else if (string_equals(exchange_id, EXCHANGE_US) || string_equals(exchange_id, EXCHANGE_SGX) ||
             string_equals(exchange_id, EXCHANGE_LON) || string_equals(exchange_id, EXCHANGE_AEX) ||
             string_equals(exchange_id, EXCHANGE_AUX) || string_equals(exchange_id, EXCHANGE_HEXS) ||
             string_equals(exchange_id, EXCHANGE_IDX) || string_equals(exchange_id, EXCHANGE_MYS) ||
             string_equals(exchange_id, EXCHANGE_PRX) || string_equals(exchange_id, EXCHANGE_SIX) ||
             string_equals(exchange_id, EXCHANGE_TAX) || string_equals(exchange_id, EXCHANGE_JP) ||
             string_equals(exchange_id, EXCHANGE_TSE) || string_equals(exchange_id, EXCHANGE_EUR)) {
    return longfist::enums::InstrumentType::Stock;
  } else if (string_equals(exchange_id, EXCHANGE_OKX_SPOT)) {
    return longfist::enums::InstrumentType::Crypto;
  } else if (string_equals(exchange_id, EXCHANGE_OKX_COIN_FUTURE)) {
    return longfist::enums::InstrumentType::CryptoFuture;
  } else if (string_equals(exchange_id, EXCHANGE_OKX_USD_FUTURE)) {
    return longfist::enums::InstrumentType::CryptoUFuture;
  }

  SPDLOG_ERROR("invalid instrument type for exchange {} and instrument {}", exchange_id, instrument_id);
  return longfist::enums::InstrumentType::Unknown;
}

inline std::string str_from_instrument_type(longfist::enums::InstrumentType type) {
  switch (type) {
  case longfist::enums::InstrumentType::Unknown:
    return "Unknown";
  case longfist::enums::InstrumentType::Stock:
    return "Stock";
  case longfist::enums::InstrumentType::Future:
    return "Future";
  case longfist::enums::InstrumentType::Bond:
    return "Bond";
  case longfist::enums::InstrumentType::StockOption:
    return "StockOption";
  case longfist::enums::InstrumentType::TechStock:
    return "TechStock";
  case longfist::enums::InstrumentType::Fund:
    return "Fund";
  case longfist::enums::InstrumentType::Index:
    return "Index";
  case longfist::enums::InstrumentType::Repo:
    return "Repo";
  case longfist::enums::InstrumentType::Crypto:
    return "Crypto";
  case longfist::enums::InstrumentType::CryptoFuture:
    return "CryptoFuture";
  case longfist::enums::InstrumentType::CryptoUFuture:
    return "CryptoUFuture";
  default:
    return "Unknown";
  }
}

inline longfist::enums::SubscribeInstrumentType
instrument_type_to_subscribe_instrument_type(longfist::enums::InstrumentType instrument_type) {
  switch (instrument_type) {
  case longfist::enums::InstrumentType::Stock:
    return longfist::enums::SubscribeInstrumentType::Stock;
  case longfist::enums::InstrumentType::Future:
    return longfist::enums::SubscribeInstrumentType::Future;
  case longfist::enums::InstrumentType::Bond:
    return longfist::enums::SubscribeInstrumentType::Bond;
  case longfist::enums::InstrumentType::Repo:
    return longfist::enums::SubscribeInstrumentType::Bond;
  case longfist::enums::InstrumentType::StockOption:
    return longfist::enums::SubscribeInstrumentType::StockOption;
  case longfist::enums::InstrumentType::TechStock:
    return longfist::enums::SubscribeInstrumentType::Stock;
  case longfist::enums::InstrumentType::Fund:
    return longfist::enums::SubscribeInstrumentType::Fund;
  case longfist::enums::InstrumentType::Index:
    return longfist::enums::SubscribeInstrumentType::Index;
  default:
    return longfist::enums::SubscribeInstrumentType::All;
  }
}

inline std::string get_instrument_product(const char *instrument_id) {
  std::string product = {};
  int i = 0;
  while (instrument_id[i] != 0) {
    if (instrument_id[i] < '0' || instrument_id[i] > '9') {
      product.push_back(std::toupper(instrument_id[i]));
    } else {
      break;
    }
    ++i;
  }
  return product;
}

inline longfist::enums::Direction get_future_direction(longfist::enums::Side side, longfist::enums::Offset offset) {
  if ((side == longfist::enums::Side::Buy && offset == longfist::enums::Offset::Open) ||
      (side == longfist::enums::Side::Sell && offset != longfist::enums::Offset::Open)) {
    return longfist::enums::Direction::Long;
  } else {
    return longfist::enums::Direction::Short;
  }
}

inline bool is_open(longfist::enums::InstrumentType instrument_type, longfist::enums::Side side,
                    longfist::enums::Offset offset) {
  if (instrument_type == longfist::enums::InstrumentType::Stock ||
      instrument_type == longfist::enums::InstrumentType::Bond) {
    return side == longfist::enums::Side::Buy;
  } else if (instrument_type == longfist::enums::InstrumentType::Future) {
    return offset == longfist::enums::Offset::Open;
  } else {
    return false;
  }
}

inline std::string get_exchange_id_from_future_instrument_id(const std::string &instrument_id) {
  std::size_t found = instrument_id.find_first_of("0123456789");
  std::string product = instrument_id.substr(0, found);
  std::transform(product.begin(), product.end(), product.begin(), ::tolower);
  if (product == "c" || product == "cs" || product == "a" || product == "b" || product == "m" || product == "y" ||
      product == "p" || product == "fb" || product == "bb" || product == "jd" || product == "rr" || product == "l" ||
      product == "v" || product == "pp" || product == "j" || product == "jm" || product == "i" || product == "eg" ||
      product == "eb" || product == "pg" || product == "lh") {
    return EXCHANGE_DCE;
  } else if (product == "wh" || product == "pm" || product == "cf" || product == "sr" || product == "oi" ||
             product == "ri" || product == "rs" || product == "rm" || product == "jr" || product == "lr" ||
             product == "cy" || product == "ap" || product == "cj" || product == "ta" || product == "ma" ||
             product == "zc" || product == "sf" || product == "sm" || product == "ur" || product == "fg" ||
             product == "sa" || product == "pf" || product == "pk") {
    return EXCHANGE_CZCE;
  } else if (product == "cu" || product == "al" || product == "zn" || product == "pb" || product == "ni" ||
             product == "sn" || product == "au" || product == "ag" || product == "rb" || product == "wr" ||
             product == "hc" || product == "ss" || product == "fu" || product == "bu" || product == "ru" ||
             product == "sp" || product == "ao" || product == "br") {
    return EXCHANGE_SHFE;
  } else if (product == "if" || product == "ic" || product == "ih" || product == "ts" || product == "tf" ||
             product == "tl" || product == "t" || product == "im") {
    return EXCHANGE_CFFEX;
  } else if (product == "sc" || product == "bc" || product == "lu" || product == "nr") {
    return EXCHANGE_INE;
  } else if (product == "si" || product == "lc") {
    return EXCHANGE_GFEX;
  } else {
    return "";
  }
}

inline bool is_shortable(longfist::enums::InstrumentType instrument_type) {
  return not(instrument_type == longfist::enums::InstrumentType::Stock or
             instrument_type == longfist::enums::InstrumentType::Bond or
             instrument_type == longfist::enums::InstrumentType::Fund or
             instrument_type == longfist::enums::InstrumentType::TechStock or
             instrument_type == longfist::enums::InstrumentType::Index or
             instrument_type == longfist::enums::InstrumentType::Repo);
}

inline longfist::enums::Direction get_direction(longfist::enums::InstrumentType instrument_type,
                                                longfist::enums::Side side, longfist::enums::Offset offset) {
  if (side == longfist::enums::Side::MarginTrade) {
    return longfist::enums::Direction::Long;
  } else if (side == longfist::enums::Side::ShortSell) {
    return longfist::enums::Direction::Short;
  } else if (side == longfist::enums::Side::RepayMargin) {
    return longfist::enums::Direction::Long;
  } else if (side == longfist::enums::Side::RepayStock) {
    return longfist::enums::Direction::Short;
  } else if (side == longfist::enums::Side::StockRepayStock) {
    return longfist::enums::Direction::Long;
  } else if (side == longfist::enums::Side::GuaranteeStockBuy) {
    return longfist::enums::Direction::Long;
  } else if (side == longfist::enums::Side::GuaranteeStockSell) {
    return longfist::enums::Direction::Long;
  }

  if (side == longfist::enums::Side::Exec) {
    return longfist::enums::Direction::Long;
  }

  if (not is_shortable(instrument_type)) {
    return longfist::enums::Direction::Long;
  }
  if (side == longfist::enums::Side::Buy and offset == longfist::enums::Offset::Open) {
    return longfist::enums::Direction::Long;
  }
  if (side == longfist::enums::Side::Sell and
      (offset == longfist::enums::Offset::Close or offset == longfist::enums::Offset::CloseToday or
       offset == longfist::enums::Offset::CloseYesterday)) {
    return longfist::enums::Direction::Long;
  }
  if (side == longfist::enums::Side::Sell and offset == longfist::enums::Offset::Open) {
    return longfist::enums::Direction::Short;
  }
  if (side == longfist::enums::Side::Buy and
      (offset == longfist::enums::Offset::Close or offset == longfist::enums::Offset::CloseToday or
       offset == longfist::enums::Offset::CloseYesterday)) {
    return longfist::enums::Direction::Short;
  }
  throw wingchun_error(fmt::format("get_direction error: invalid direction args {} {} {}", (int)instrument_type,
                                   (int)side, (int)offset));
}

inline longfist::enums::Direction get_opposite_direction(longfist::enums::InstrumentType instrument_type,
                                                         longfist::enums::Side side, longfist::enums::Offset offset) {
  auto direction = get_direction(instrument_type, side, offset);
  return direction == longfist::enums::Direction::Long ? longfist::enums::Direction::Short
                                                       : longfist::enums::Direction::Long;
}

inline uint32_t hash_product(const char *exchange_id, const char *product_id) {
  return yijinjing::util::hash_str_32(product_id) ^ yijinjing::util::hash_str_32(exchange_id);
}

inline uint32_t hash_instrument(const char *exchange_id, const char *instrument_id) {
  return yijinjing::util::hash_str_32(instrument_id) ^ yijinjing::util::hash_str_32(exchange_id);
}

inline uint32_t hash_instrument(const longfist::types::Order &order) {
  int32_t flag =
      get_direction(order.instrument_type, order.side, order.offset) == longfist::enums::Direction::Short ? -1 : 1;
  int32_t instrument_key = hash_instrument(order.exchange_id, order.instrument_id) * flag;
  return instrument_key;
}

inline uint32_t hash_instrument(uint32_t source_id, const char *exchange_id, const char *instrument_id) {
  return source_id ^ yijinjing::util::hash_str_32(exchange_id) ^ yijinjing::util::hash_str_32(instrument_id);
}

inline uint32_t hash_basket_instrument(uint32_t basket_uid, const char *exchange_id, const char *instrument_id) {
  return basket_uid ^ yijinjing::util::hash_str_32(instrument_id) ^ yijinjing::util::hash_str_32(exchange_id);
}

inline uint32_t hash_account(const std::string &source_name, const std::string &account_id) {
  return yijinjing::util::hash_str_32(source_name) ^ yijinjing::util::hash_str_32(account_id);
}

inline uint32_t hash_operator(const std::string &operator_group, const std::string &operator_name) {
  return yijinjing::util::hash_str_32(operator_group) ^ yijinjing::util::hash_str_32(operator_name);
}

inline uint32_t hash_backtest_cache(std::string source_name, int64_t start, int64_t end) {
  return yijinjing::util::hash_str_32(source_name) ^
         yijinjing::util::hash_32(reinterpret_cast<unsigned char *>(&start), sizeof(start)) ^
         yijinjing::util::hash_32(reinterpret_cast<unsigned char *>(&end), sizeof(end));
}

inline uint64_t get_source_op_id(uint32_t holder_uid, uint32_t source_id) {
  return static_cast<uint64_t>(holder_uid) << 32u | static_cast<uint64_t>(source_id);
}

inline void order_from_input(const longfist::types::OrderInput &input, longfist::types::Order &order) {
  order.order_id = input.order_id;

  kungfu::copy_string(order.instrument_id, input.instrument_id);
  kungfu::copy_string(order.exchange_id, input.exchange_id);
  kungfu::copy_string(order.contract_id, input.contract_id);

  order.instrument_type = input.instrument_type;

  order.limit_price = input.limit_price;
  order.frozen_price = input.frozen_price;

  order.volume = input.volume;
  order.volume_left = input.volume;
  order.status = longfist::enums::OrderStatus::Pending;

  order.side = input.side;
  order.offset = input.offset;

  order.is_swap = input.is_swap;

  order.hedge_flag = input.hedge_flag;
  order.price_type = input.price_type;
  order.volume_condition = input.volume_condition;
  order.time_condition = input.time_condition;

  order.parent_id = input.parent_id;
}

inline void trade_from_order(const longfist::types::Order &order, longfist::types::Trade &trade) {
  trade.order_id = order.order_id;
  kungfu::copy_string(trade.instrument_id, order.instrument_id);
  kungfu::copy_string(trade.exchange_id, order.exchange_id);
  kungfu::copy_string(trade.external_order_id, order.external_order_id);
  kungfu::copy_string(trade.contract_id, order.contract_id);
  trade.instrument_type = order.instrument_type;
  trade.side = order.side;
  trade.offset = order.offset;
  trade.hedge_flag = order.hedge_flag;
}

inline void order_trigger_from_input(const longfist::types::OrderTriggerInput &input,
                                     longfist::types::OrderTrigger &trigger) {
  trigger.trigger_id = input.trigger_id;

  kungfu::copy_string(trigger.instrument_id, input.instrument_id);
  kungfu::copy_string(trigger.exchange_id, input.exchange_id);
  trigger.instrument_type = input.instrument_type;

  trigger.limit_price = input.limit_price;
  trigger.frozen_price = input.frozen_price;
  trigger.volume = input.volume;
  trigger.stop_price = input.stop_price;

  trigger.status = longfist::enums::OrderStatus::Pending;

  trigger.side = input.side;
  trigger.offset = input.offset;
  trigger.is_swap = input.is_swap;
  trigger.hedge_flag = input.hedge_flag;
  trigger.price_type = input.price_type;
  trigger.volume_condition = input.volume_condition;
  trigger.time_condition = input.time_condition;
  trigger.trigger_type = input.trigger_type;
  trigger.action_flag = longfist::enums::OrderTriggerFlag::TriggerInsert;
}

inline void order_trigger_from_order(const longfist::types::Order &order, longfist::types::OrderTrigger &trigger) {
  trigger.order_id = order.order_id;
  kungfu::copy_string(trigger.instrument_id, order.instrument_id);
  kungfu::copy_string(trigger.exchange_id, order.exchange_id);
  kungfu::copy_string(trigger.external_order_id, order.external_order_id);
  trigger.instrument_type = order.instrument_type;
  trigger.limit_price = order.limit_price;
  trigger.frozen_price = order.frozen_price;
  trigger.volume = order.volume;
  trigger.status = longfist::enums::OrderStatus::Pending;
  trigger.side = order.side;
  trigger.offset = order.offset;
  trigger.is_swap = order.is_swap;
  trigger.hedge_flag = order.hedge_flag;
  trigger.price_type = order.price_type;
  trigger.volume_condition = order.volume_condition;
  trigger.time_condition = order.time_condition;
  trigger.trigger_type = longfist::enums::OrderTriggerType::ParkedOrder;
  trigger.action_flag = longfist::enums::OrderTriggerFlag::TriggerCancel;
}

inline void order_input_from_trigger_order(const longfist::types::OrderTriggerInput &trigger_input,
                                           longfist::types::OrderInput &order_input) {
  order_input.order_id = trigger_input.trigger_id;
  kungfu::copy_string(order_input.instrument_id, trigger_input.instrument_id);
  kungfu::copy_string(order_input.exchange_id, trigger_input.exchange_id);
  order_input.instrument_type = trigger_input.instrument_type;
  order_input.limit_price = trigger_input.limit_price;
  order_input.frozen_price = trigger_input.frozen_price;
  order_input.volume = trigger_input.volume;
  order_input.side = trigger_input.side;
  order_input.offset = trigger_input.offset;
  order_input.is_swap = trigger_input.is_swap;
  order_input.hedge_flag = trigger_input.hedge_flag;
  order_input.price_type = trigger_input.price_type;
  order_input.volume_condition = trigger_input.volume_condition;
}

inline void algo_order_from_input(const longfist::types::AlgoOrderInput &algo_order_input,
                                  longfist::types::AlgoOrder &algo_order) {
  algo_order.order_id = algo_order_input.order_id;
  algo_order.begin_time = algo_order_input.begin_time;
  algo_order.end_time = algo_order_input.end_time;
  algo_order.insert_time = algo_order_input.insert_time;

  kungfu::copy_string(algo_order.instrument_id, algo_order_input.instrument_id);
  kungfu::copy_string(algo_order.exchange_id, algo_order_input.exchange_id);
  algo_order.instrument_type = algo_order_input.instrument_type;

  algo_order.side = algo_order_input.side;
  algo_order.offset = algo_order_input.offset;
  algo_order.price_type = algo_order_input.price_type;
  algo_order.price_level = algo_order_input.price_level;
  algo_order.price_offset = algo_order_input.price_offset;

  algo_order.volume = algo_order_input.volume;
  algo_order.volume_left = algo_order_input.volume;

  algo_order.is_local = algo_order_input.is_local;
  algo_order.basket_uid = algo_order_input.basket_uid;

  kungfu::copy_string(algo_order.algo_type_id, algo_order_input.algo_type_id);
  kungfu::copy_string(algo_order.algo_id, algo_order_input.algo_id);

  algo_order.status = longfist::enums::OrderStatus::Pending;
}

} // namespace kungfu::wingchun

namespace kungfu::wingchun::map {

// key = hash_product(exchange_id, product_id)
typedef std::unordered_map<uint32_t, longfist::types::Commission> CommissionMap;

// key = hash_instrument(exchange_id, instrument_id)
typedef std::unordered_map<uint32_t, longfist::types::Instrument> InstrumentMap;

// key = hash_instrument(source_id, exchange_id, instrument_id)
typedef std::unordered_map<uint32_t, longfist::types::InstrumentFactor> InstrumentFactorMap;

// key = hash_instrument(source_id, exchange_id, instrument_id)
typedef std::unordered_map<uint32_t, longfist::types::Position> PositionMap;

// key = order_id
typedef std::unordered_map<uint64_t, longfist::types::OrderInput> OrderInputMap;

// key = order_id
typedef std::unordered_map<uint64_t, longfist::types::Order> OrderMap;

// key = trade_id
typedef std::unordered_map<uint64_t, longfist::types::Trade> TradeMap;

// key = basket_uid
typedef std::unordered_map<uint32_t, longfist::types::Basket> BasketMap;

// key = hash_basket_instrument(basket_uid, exchange_id, instrument_id)
typedef std::unordered_map<uint32_t, longfist::types::BasketInstrument> BasketInstrumentMap;

// key = order_id
typedef std::unordered_map<uint64_t, longfist::types::AlgoOrderInput> AlgoOrderInputMap;

// key = order_id
typedef std::unordered_map<uint64_t, longfist::types::AlgoOrder> AlgoOrderMap;

} // namespace kungfu::wingchun::map

#endif // WINGCHUN_COMMON_H
