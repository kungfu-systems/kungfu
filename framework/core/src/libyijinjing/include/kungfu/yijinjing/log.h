// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-06.
//

#ifndef KUNGFU_LOG_H
#define KUNGFU_LOG_H

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>

#define LOG_LEVEL_ENV "KF_LOG_LEVEL"
#define DEFAULT_LOG_LEVEL_NAME "info"
#define TS_PATTERN "[%m/%d %H:%M:%S.%N] "
#define LOG_PATTERN "[%^%=8l%$] [%6P/%-6t] [%s:%##%!] %v"

#ifndef KUNGFU_SETUP_LOGGER
#define KUNGFU_SETUP_LOGGER(location, name) kungfu::yijinjing::log::copy_log_settings(location, name)
#endif // KUNGFU_SETUP_LOGGER

#define KF_LOG_TRACE                                                                                                   \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_TRACE
#define KF_LOG_DEBUG                                                                                                   \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_DEBUG
#define KF_LOG_INFO                                                                                                    \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_INFO
#define KF_LOG_WARN                                                                                                    \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_WARN
#define KF_LOG_ERROR                                                                                                   \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_ERROR
#define KF_LOG_CRITICAL                                                                                                \
  if (kungfu::yijinjing::log::is_signal_log())                                                                         \
  SPDLOG_CRITICAL

#define SPDLOGF_TRACE                                                                                                  \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_TRACE
#define SPDLOGF_DEBUG                                                                                                  \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_DEBUG
#define SPDLOGF_INFO                                                                                                   \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_INFO
#define SPDLOGF_WARN                                                                                                   \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_WARN
#define SPDLOGF_ERROR                                                                                                  \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_ERROR
#define SPDLOGF_CRITICAL                                                                                               \
  kungfu::yijinjing::log::enable_exception_log_frame();                                                                \
  SPDLOG_CRITICAL

namespace kungfu::yijinjing::log {

bool is_log_frame();

void enable_exception_log_frame();

void set_trigger_frame_uid(uint64_t frame_uid);

void set_trigger_initial_source_id(uint32_t initial_source_id);

void set_trigger_source_id(uint32_t source_id);

void set_trigger_dest_id(uint32_t dest_id);

void set_trigger_msg_type(int32_t msg_type);

uint64_t get_trigger_frame_uid();

uint32_t get_trigger_initial_source_id();

uint32_t get_trigger_source_id();

uint32_t get_trigger_dest_id();

int32_t get_trigger_msg_type();

void disable_signal_log();

bool is_signal_log();

std::shared_ptr<spdlog::logger> get_main_logger();

spdlog::level::level_enum get_env_log_level(const data::locator_ptr &locator);

const std::string &setup_log(const data::location_ptr &location, const std::string &name);

void emit_log(const std::string &source_file, int &source_line, const std::string &funcname,
              const std::string &logger_name, int log_level, const std::string &msg);

inline void copy_log_settings(const data::location_ptr &location, const std::string &name) {
  if (get_main_logger()->name().empty()) {
    setup_log(location, name);
  }
  auto logger_cloned = get_main_logger()->clone(name);
  spdlog::set_default_logger(logger_cloned);
}
} // namespace kungfu::yijinjing::log

#endif // KUNGFU_LOG_H
