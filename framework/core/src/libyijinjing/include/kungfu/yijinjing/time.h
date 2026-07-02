// SPDX-License-Identifier: Apache-2.0

#ifndef YIJINJING_TIME_H
#define YIJINJING_TIME_H

#include <cstdint>
#include <string>
#include <time.h>

#define KUNGFU_DATETIME_FORMAT "%F %T"
#define KUNGFU_TIMESTAMP_FORMAT "%F %T.%N"
#define KUNGFU_TRADING_DAY_FORMAT "%Y%m%d"
#define KUNGFU_HISTORY_DAY_FORMAT "%Y-%m-%d %H:%M:%S"

namespace kungfu::yijinjing {
struct time_unit {
  static constexpr int64_t MILLISECONDS_PER_SECOND = 1000;
  static constexpr int64_t MICROSECONDS_PER_MILLISECOND = 1000;
  static constexpr int64_t NANOSECONDS_PER_MICROSECOND = 1000;

  static constexpr int64_t SECONDS_PER_MINUTE = 60;
  static constexpr int64_t MINUTES_PER_HOUR = 60;
  static constexpr int64_t HOURS_PER_DAY = 24;
  static constexpr int64_t SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;

  static constexpr int64_t NANOSECONDS_PER_MILLISECOND = NANOSECONDS_PER_MICROSECOND * MICROSECONDS_PER_MILLISECOND;
  static constexpr int64_t NANOSECONDS_PER_SECOND = NANOSECONDS_PER_MILLISECOND * MILLISECONDS_PER_SECOND;
  static constexpr int64_t NANOSECONDS_PER_MINUTE = NANOSECONDS_PER_SECOND * SECONDS_PER_MINUTE;
  static constexpr int64_t NANOSECONDS_PER_HOUR = NANOSECONDS_PER_SECOND * SECONDS_PER_HOUR;
  static constexpr int64_t NANOSECONDS_PER_DAY = NANOSECONDS_PER_HOUR * HOURS_PER_DAY;

  static constexpr int64_t UTC_OFFSET = NANOSECONDS_PER_HOUR * 8;
};

struct time_point_info {
  int64_t system_clock_count;
  int64_t steady_clock_count;
};

class time {
public:
  /**
   * Get timestamp in nano seconds.
   * @return current nano time in int64_t (unix-timestamp * 1e9 + nano-part)
   */
  static int64_t now_in_nano();

  static uint32_t nano_hashed(int64_t nano_time);

  /**
   * Given a timestamp, returns the start point of next minute.
   * @param nanotime timestamp in nano seconds
   * @return start time point of next minute in nano seconds
   */
  static int64_t next_minute(int64_t nanotime);

  /**
   * Given a timestamp, returns the next end of trading time, i.e. 16:00 of today if the argument is before that,
   * otherwise 16:00 of tomorrow.
   * @param nanotime timestamp in nano seconds
   * @return the next trading session end time point in nano seconds
   */
  static int64_t next_trading_day_end(int64_t nanotime);

  /**
   * Given a timestamp, returns the start time of the corresponding calendar day.
   * @param nanotime timesamp in nano seconds
   * @return the start time point of the corresponding calendar day in nano seconds
   */
  static int64_t calendar_day_start(int64_t nanotime);

  /**
   * Start time of today (00:00:00) in nano seconds.
   * @return start time of today in nano seconds
   */
  static int64_t today_start();

  /**
   * Start time of trading day (the last 16:00:00) in nano seconds.   *
   * @return yesterday 16:00:00 if now earlier than 4.PM, else today  16:00:00 in nano seconds.
   */
  static int64_t trading_day_start();

  /**
   * Start time of trading day (yesterday 16:00:00) in nano seconds.
   * @return yesterday 16:00:00 in nano seconds, whenever is now.
   */
  static int64_t restore_start();

  /**
   * Parse string time to nano time.
   * @param time_string string-formatted time
   * @param format ref: https://en.cppreference.com/w/cpp/io/manip/put_time + %N for nanoseconds {:09d}
   * @return nano time in int64_t
   */
  static int64_t strptime(const std::string &time_string, const std::string &format = KUNGFU_TIMESTAMP_FORMAT);

  /**
   * Parse string time to nano time by matching one of the formats in list.
   * @param time_string string-formatted time
   * @param formats ref: https://en.cppreference.com/w/cpp/io/manip/put_time + %N for nanoseconds {:09d}
   * @return nano time in int64_t, -1 if no format matched
   */
  static int64_t strptime(const std::string &time_string, std::initializer_list<std::string> formats);

  /**
   * Format nano seconds to string.
   * @param nanotime nano time in int64_t
   * @param format ref: https://en.cppreference.com/w/cpp/io/manip/put_time + %N for nanoseconds {:09d}
   * @return string-formatted time
   */
  static std::string strftime(int64_t nanotime, const std::string &format = KUNGFU_TIMESTAMP_FORMAT);

  /**
   * Format now to string.
   * @param format ref: https://en.cppreference.com/w/cpp/io/manip/put_time + %N for nanoseconds {:09d}
   * @return string-formatted time
   */
  static std::string strfnow(const std::string &format = KUNGFU_TIMESTAMP_FORMAT);

  /**
   * Gets time base point of current process.
   * @return time base point which is set by the singleton method.
   */
  static time_point_info get_base();

  /**
   * Reset time base point so that multiprocess application can have synced time.
   * @param system_clock_count std::chrono::system_clock nano seconds count
   * @param steady_clock_count std::chrono::steady_clock nano seconds count
   */
  static void reset(int64_t system_clock_count, int64_t steady_clock_count);

private:
  time_point_info base_;
  time();

  static const time &get_instance();
};
} // namespace kungfu::yijinjing

#endif // YIJINJING_TIME_H