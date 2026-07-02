// SPDX-License-Identifier: Apache-2.0

#include <assert.h>
#include <iomanip>
#include <unordered_map>
#include <vector>

#include <kungfu/wingchun/timezone.h>

#define ONE_HOUR_SECOND 3600
#define ONE_DAY_SECOND (ONE_HOUR_SECOND * 24)

namespace kungfu::wingchun {
// 夏令时计算结构体
struct SummerDayTime {
public:
  SummerDayTime() {}

  SummerDayTime(int m, int s, int h) : month(m), sunday_index(s), hour(h) {}

public:
  int month = 0;
  int sunday_index = 0;
  int hour = 0;
};

// 实现_mkgmtime函数的功能，可以跨平台使用
time_t mkgmtime(struct tm *unixdate) {
  time_t tUnixTime = mktime(unixdate);
  struct tm *fDate = gmtime(&tUnixTime);

  int32_t nOffset = fDate->tm_hour - unixdate->tm_hour;
  if (nOffset > 12) {
    nOffset = 24 - nOffset;
  }
  return tUnixTime - nOffset * ONE_HOUR_SECOND;
}

/*
 * 夏令时时间信息
 * 夏令时一般的定义规则：在month+1月份第sunday_index个星期日，hour小时开始（或结束）
 * ps: 当 sunday_index <0 表示倒序，比如最后一个星期日就是-1
 */
time_t CalculateSummerDayTimeByMonth_Sunday_Hour(time_t time, int month, int sunday_index, int hour) {
  // 根据需要判断的时间戳，得出格林威治时间
  struct tm *t_gmt = gmtime(&time);
  struct tm *summer_day = gmtime(&time);

  summer_day->tm_year = t_gmt->tm_year;

  // 当sunday_index<0 时，需要计算下个月第一天倒推
  summer_day->tm_mon = sunday_index > 0 ? month : (month + 1);
  summer_day->tm_mday = 1;
  summer_day->tm_hour = hour;
  summer_day->tm_min = 0;
  summer_day->tm_sec = 0;

  time_t summer_day_seconds = mkgmtime(summer_day);
  summer_day = gmtime(&summer_day_seconds);

  int week = summer_day->tm_wday;
  int offset_weeks = sunday_index > 0 ? (sunday_index - 1) : sunday_index;

  // 先向前对齐到周日
  summer_day_seconds += (7 - week) % 7 * ONE_DAY_SECOND;

  // 再按周进行偏移
  summer_day_seconds += offset_weeks * 7 * ONE_DAY_SECOND;
  return summer_day_seconds;
}
/*
 * 地区时间信息
 */
struct LocationTimeData {
public:
  LocationTimeData(int time_zone, ZoneTimeType standard_type) : zone(time_zone) { zone_times.push_back(standard_type); }

  LocationTimeData(int time_zone, SummerDayTime beg, SummerDayTime end, ZoneTimeType standard_type,
                   ZoneTimeType daylight_type)
      : zone(time_zone), has_summer_day(true), summer_begin(beg), summer_end(end) {
    zone_times.push_back(standard_type);
    zone_times.push_back(daylight_type);
  }

public:
  int zone = 0;                // 时区（TimeZone），例如：北京时间为8
  bool has_summer_day = false; // 该地区是否有夏令时

  SummerDayTime summer_begin;
  SummerDayTime summer_end;

  std::vector<ZoneTimeType> zone_times;
};

const std::unordered_map<LocationTimeType, LocationTimeData> g_locationTimeMap = {
    {LocationTimeType::Beijing, LocationTimeData(8, ZoneTimeType::BJ)},
    {LocationTimeType::Singapore, LocationTimeData(8, ZoneTimeType::SGT)},
    {LocationTimeType::Tokyo, LocationTimeData(9, ZoneTimeType::JST)},
    {LocationTimeType::Amsterdam, LocationTimeData(9, ZoneTimeType::CET)},
    {LocationTimeType::Finland, LocationTimeData(9, ZoneTimeType::CEST)},
    {LocationTimeType::Jakarta, LocationTimeData(9, ZoneTimeType::KRAT)},
    {LocationTimeType::Korea, LocationTimeData(9, ZoneTimeType::KST)},
    {LocationTimeType::Malaysia, LocationTimeData(9, ZoneTimeType::BJ)},
    {LocationTimeType::Paris, LocationTimeData(9, ZoneTimeType::CET)},
    {LocationTimeType::Switzerland, LocationTimeData(9, ZoneTimeType::CET)},
    {LocationTimeType::Thailand, LocationTimeData(9, ZoneTimeType::KRAT)},
    {LocationTimeType::Toronto, LocationTimeData(9, ZoneTimeType::EST)},
    {LocationTimeType::AmericaEastern,
     // 美东时间夏令时：[3月第二个星期日凌晨2点，11月第一个周日凌晨2点]
     LocationTimeData(-5, SummerDayTime(2, 2, 2), SummerDayTime(10, 1, 2), ZoneTimeType::EST, ZoneTimeType::EDT)},
    {LocationTimeType::AmericaCentral,
     // 美中时间夏令时与美东类似
     LocationTimeData(-6, SummerDayTime(2, 2, 2), SummerDayTime(10, 1, 2), ZoneTimeType::CST, ZoneTimeType::CDT)},
    {LocationTimeType::London,
     // 伦敦时间夏令时：[3月最后一个星期日凌晨1点，10月最后一个星期日凌晨2点]
     LocationTimeData(0, SummerDayTime(2, -1, 1), SummerDayTime(9, -1, 2), ZoneTimeType::BST, ZoneTimeType::BDT)},
    {LocationTimeType::AustraliaEastern,
     // 澳洲东部时间夏令时：[10月第一个星期日凌晨2点，4月第一个星期日凌晨3点]
     LocationTimeData(10, SummerDayTime(9, 1, 2), SummerDayTime(3, 1, 3), ZoneTimeType::AEST, ZoneTimeType::AEDT)},
    {LocationTimeType::Berlin,
     // 德国时间夏令时：[3月最后一个星期日凌晨2点，10月最后一个星期日凌晨3点]
     LocationTimeData(1, SummerDayTime(2, -1, 2), SummerDayTime(9, -1, 3), ZoneTimeType::CEST, ZoneTimeType::CET)}
    // Add more LocationTime here...
};

namespace TimeUtil {
time_t TimeToSeconds(const std::string &time, bool is_gmt) {
  int year, month, day, hour, minute, second;
  sscanf(time.c_str(), "%d-%d-%d %d:%d:%d", &year, &month, &day, &hour, &minute, &second);

  return TimeToSeconds(year, month, day, hour, minute, second, is_gmt);
}

time_t TimeToSeconds(int year, int month, int day, int hour, int minute, int second, bool is_gmt) {
  tm t_temp = {0};
  t_temp.tm_year = year - 1900;
  t_temp.tm_mon = month - 1;
  t_temp.tm_mday = day;
  t_temp.tm_hour = hour;
  t_temp.tm_min = minute;
  t_temp.tm_sec = second;
  t_temp.tm_isdst = 0;

  return is_gmt ? mkgmtime(&t_temp) : mktime(&t_temp);
}

time_t DateToSeconds(const std::string &time, bool is_gmt) {
  int year, month, day;
  sscanf(time.c_str(), "%d-%d-%d", &year, &month, &day);

  return TimeToSeconds(year, month, day, 0, 0, 0, is_gmt);
}

const LocationTimeData &GetLocationTimeDataByType(LocationTimeType loc_type) {
  std::unordered_map<LocationTimeType, LocationTimeData>::const_iterator it = g_locationTimeMap.find(loc_type);
  if (it == g_locationTimeMap.end()) {
    assert("find loc_type fail！");

    // 找不到对应的Location，先按北京时间返回
    it = g_locationTimeMap.find(LocationTimeType::Beijing);
  }
  return it->second;
}

std::shared_ptr<LocalTimeInfo> TranslateGMTimeToLocalTime(time_t gmt, const LocationTimeData &info) {
  std::shared_ptr<LocalTimeInfo> t_local = std::make_shared<LocalTimeInfo>();
  do {
    t_local->seconds = gmt + info.zone * ONE_HOUR_SECOND;
    t_local->has_summer_day = info.has_summer_day;

    if (!info.has_summer_day) {
      break;
    }

    int64_t begin = CalculateSummerDayTimeByMonth_Sunday_Hour(gmt, info.summer_begin.month,
                                                              info.summer_begin.sunday_index, info.summer_begin.hour);
    int64_t end = CalculateSummerDayTimeByMonth_Sunday_Hour(gmt, info.summer_end.month, info.summer_end.sunday_index,
                                                            info.summer_end.hour);

    /*
     * 处于区间内，一般表示处于夏令时；不过对于本年内的begin>end这种case来说，区间内恰恰表示不在夏令时。
     * 所以使用 begin > end 异或取反矫正一下
     */
    t_local->is_summer_day = (gmt >= std::min(begin, end) && gmt <= std::max(begin, end)) ^ (begin > end);
    if (t_local->is_summer_day) {
      t_local->seconds += ONE_HOUR_SECOND;
    }

  } while (false);

  t_local->zone_time_type = info.zone_times[t_local->is_summer_day];
  return t_local;
}

time_t TranslateLocalTimeToGMTime(time_t local_seconds, LocationTimeType loc_type, LocalTimeInfo *info /*= nullptr*/) {
  const LocationTimeData &data = GetLocationTimeDataByType(loc_type);

  /*
   * 同一个 local_seconds有可能对应冬令时和夏令时的不同时间
   * 我们优先按照是否在Location中保存的区间内的进行判断，这种方式有可能精确结果与预期不符，但基本不影响业务逻辑
   */
  time_t assume_gmt = local_seconds - data.zone * ONE_HOUR_SECOND;
  std::shared_ptr<LocalTimeInfo> ret = TranslateGMTimeToLocalTime(assume_gmt, data);

  // 如果是夏令时，那么往回再减一个小时作为矫正
  if (ret->is_summer_day) {
    ret->seconds -= ONE_HOUR_SECOND;
    assume_gmt -= ONE_HOUR_SECOND;
  }

  if (info) {
    *info = *ret;
  }
  return assume_gmt;
}

std::shared_ptr<LocalTimeInfo> TranslateGMTimeToLocalTime(time_t gmt, LocationTimeType loc_type) {
  const LocationTimeData &info = GetLocationTimeDataByType(loc_type);
  return TranslateGMTimeToLocalTime(gmt, info);
}
} // namespace TimeUtil
} // namespace kungfu::wingchun