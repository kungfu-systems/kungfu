// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_TIMEZONE_H
#define WINGCHUN_TIMEZONE_H

#include <chrono>
#include <ctime>
#include <memory>

//////////////////////////////////////////////////////////////////////////////
#include "common.h"

namespace kungfu::wingchun {
/*****************************************************************************
 *  @Copyright (c) 2022, Marsjliu
 *  @All rights reserved
 *  @date     : 2022/06/06 11:15
 *****************************************************************************/
enum class LocationTimeType : char {
  London,  //
  Beijing, //
  Singapore,
  Tokyo,            //
  AmericaEastern,   //
  AmericaCentral,   //
  AustraliaEastern, //
  Berlin,           //
  Amsterdam,        // UTC/GMT +1
  Finland,          // UTC/CMT +2
  Jakarta,          // UTC/GMT +7
  Korea,            // UTC/GMT +9 KST
  Malaysia,         // UTC/GMT +8
  Paris,            // UTC/GMT +1
  Switzerland,      // UTC+1
  Thailand,         // UTC/CMT +7
  Toronto           // UTC/GMT -5
};

/*
 * http://zh.thetimenow.com/time-zones-abbreviations.php
 */
enum class ZoneTimeType : char {
  BST,  //
  BDT,  //
  BJ,   //  UTC +8:00
  JST,  //
  SGT,  //
  EST,  // EST - Eastern Standard Time	UTC -5:00
  EDT,  //
  CST,  //
  CDT,  //
  AEST, //
  AEDT, //
  CET,  // CET - Central European Time	UTC +1:00
  CEST, // CEST - Central European Summer Time	UTC +2:00
  KRAT, // KRAT - Krasnoyarsk Time	UTC +7:00
  KST   // KST - Korea Standard Time	UTC +9:00
};

struct LocalTimeInfo {
  time_t seconds = 0;

  bool has_summer_day = false;
  bool is_summer_day = false;

  ZoneTimeType zone_time_type = ZoneTimeType::BST;
};

namespace TimeUtil {
time_t TimeToSeconds(const std::string &time, bool is_gmt);
time_t TimeToSeconds(int year, int month, int day, int hour, int minute, int second, bool is_gmt);

time_t DateToSeconds(const std::string &time, bool is_gmt);

time_t TranslateLocalTimeToGMTime(time_t local_seconds, LocationTimeType loc_type, LocalTimeInfo *info = nullptr);
std::shared_ptr<LocalTimeInfo> TranslateGMTimeToLocalTime(time_t gmt, LocationTimeType loc_type);
} // namespace TimeUtil

//
// param1: local time
// param2: exchangeid
// params3:  YYYYMMDD
inline std::string translate_GMTime_to_localdate_by_exchange_id(time_t lTime, const std::string &exchangeId,
                                                                const std::string &strformat = "%Y%m%d") {
  // ExchangeId LocationTime
  static const std::unordered_map<std::string, LocationTimeType> location_time_exchange_id_map = {
      {EXCHANGE_US, LocationTimeType::AmericaEastern},           //
      {EXCHANGE_HK, LocationTimeType::Beijing},                  //
      {EXCHANGE_SHHK, LocationTimeType::Beijing},                //
      {EXCHANGE_SZHK, LocationTimeType::Beijing},                //
      {EXCHANGE_SSE, LocationTimeType::Beijing},                 //
      {EXCHANGE_SZE, LocationTimeType::Beijing},                 //
      {EXCHANGE_BSE, LocationTimeType::Beijing},                 //
      {EXCHANGE_SHFE, LocationTimeType::Beijing},                //
      {EXCHANGE_HK_FUTURE, LocationTimeType::Beijing},           //
      {EXCHANGE_SGX, LocationTimeType::Beijing},                 //
      {EXCHANGE_SGX_FUTURE, LocationTimeType::Beijing},          //
      {EXCHANGE_EUR, LocationTimeType::London},                  //
      {EXCHANGE_EUR_FUTURE, LocationTimeType::London},           //
      {EXCHANGE_LON, LocationTimeType::London},                  //
      {EXCHANGE_LON_FUTURE, LocationTimeType::London},           //
      {EXCHANGE_AEX, LocationTimeType::Amsterdam},               //
      {EXCHANGE_AEX_FUTURE, LocationTimeType::Amsterdam},        //
      {EXCHANGE_AUX, LocationTimeType::AustraliaEastern},        //
      {EXCHANGE_AUX_FUTURE, LocationTimeType::AustraliaEastern}, //
      {EXCHANGE_HEXS, LocationTimeType::Finland},                //
      {EXCHANGE_HEXS_FUTURE, LocationTimeType::Finland},         //
      {EXCHANGE_IDX, LocationTimeType::Jakarta},                 //
      {EXCHANGE_IDX_FUTURE, LocationTimeType::Jakarta},          //
      {EXCHANGE_KORC, LocationTimeType::Korea},                  //
      {EXCHANGE_LME, LocationTimeType::London},                  //
      {EXCHANGE_MYS, LocationTimeType::Malaysia},                //
      {EXCHANGE_MYS_FUTURE, LocationTimeType::Malaysia},         //
      {EXCHANGE_ABB, LocationTimeType::AmericaEastern},          //
      {EXCHANGE_PRX, LocationTimeType::Paris},                   //
      {EXCHANGE_PRX_FUTURE, LocationTimeType::Paris},            //
      {EXCHANGE_SIX, LocationTimeType::Switzerland},             //
      {EXCHANGE_SIX_FUTURE, LocationTimeType::Switzerland},      //
      {EXCHANGE_TAX, LocationTimeType::Thailand},                //
      {EXCHANGE_TAX_FUTURE, LocationTimeType::Thailand},         //
      {EXCHANGE_JP, LocationTimeType::Tokyo},                    //
      {EXCHANGE_JP_FUTURE, LocationTimeType::Tokyo},             //
      {EXCHANGE_TSE, LocationTimeType::Toronto},                 //
      {EXCHANGE_TSE_FUTURE, LocationTimeType::Toronto},          //
      {EXCHANGE_XETRA, LocationTimeType::Berlin},                //
      {EXCHANGE_GLFX, LocationTimeType::Beijing},                //
      {EXCHANGE_IPE, LocationTimeType::London},                  //
      {EXCHANGE_US_FUTURE, LocationTimeType::AmericaEastern},    //
      {EXCHANGE_CBOT, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_CEC, LocationTimeType::AmericaEastern},          //
      {EXCHANGE_LIFE, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_MTIF, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_NYCE, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_CMX, LocationTimeType::AmericaEastern},          //
      {EXCHANGE_SIME, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_CME, LocationTimeType::AmericaEastern},          //
      {EXCHANGE_IMM, LocationTimeType::AmericaEastern},          //
      {EXCHANGE_WIDX, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_FREX, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_METL, LocationTimeType::AmericaEastern},         //
      {EXCHANGE_IPM, LocationTimeType::London},                  //
      {EXCHANGE_OKX_SPOT, LocationTimeType::Beijing},            //
      {EXCHANGE_OKX_USD_FUTURE, LocationTimeType::Beijing},      //
      {EXCHANGE_OKX_COIN_FUTURE, LocationTimeType::Beijing}      //
  };
  LocationTimeType type = LocationTimeType::Beijing;
  auto it = location_time_exchange_id_map.find(exchangeId);

  if (it != location_time_exchange_id_map.end()) {
    type = it->second;
  }

  time_t local_time = TimeUtil::TranslateGMTimeToLocalTime(lTime, type)->seconds;

  char datebuf[256] = {0};
  strftime(datebuf, 256, strformat.c_str(), gmtime(&local_time));
  return datebuf;
}

} // namespace kungfu::wingchun

#endif // WINGCHUN_TIMEZONE_H
