// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-06.
//

#include <kungfu/common.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

#include <spdlog/sinks/daily_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>

namespace kungfu::yijinjing::log {
bool signal_log = true;
thread_local uint64_t trigger_frame_uid = 0;
thread_local uint32_t trigger_initial_source_id_ = 0;
thread_local uint32_t trigger_source_id = 0;
thread_local uint32_t trigger_dest_id = 0;
thread_local int32_t trigger_msg_type = 0;
thread_local bool exception_log_frame = false;

void disable_signal_log() { signal_log = false; }

bool is_signal_log() { return signal_log; }

class pattern_formatter : public spdlog::formatter {
public:
  pattern_formatter() : spdlog_formatter(LOG_PATTERN) {}

  pattern_formatter(const pattern_formatter &other) = delete;
  pattern_formatter &operator=(const pattern_formatter &other) = delete;

  [[nodiscard]] std::unique_ptr<formatter> clone() const override {
    return spdlog::details::make_unique<pattern_formatter>();
  }

  void format(const spdlog::details::log_msg &msg, spdlog::memory_buf_t &dest) override {
    spdlog::details::fmt_helper::append_string_view(time::strftime(time::now_in_nano(), TS_PATTERN), dest);
    if (is_log_frame() or exception_log_frame) {
      spdlog::details::fmt_helper::append_string_view(
          fmt::format("[{:>10}:{:>10}->{:<10}:{:<10}:{:<20}]", get_trigger_initial_source_id(), get_trigger_source_id(),
                      get_trigger_dest_id(), get_trigger_msg_type(), get_trigger_frame_uid()),
          dest);
      exception_log_frame = false;
    }
    spdlog_formatter.format(msg, dest);
  }

private:
  spdlog::pattern_formatter spdlog_formatter;
};

class emitable_logger : public spdlog::logger {
public:
  emitable_logger(std::string name, spdlog::sink_ptr single_sink)
      : spdlog::logger(std::move(name), std::move(single_sink)) {}

  explicit emitable_logger(std::string name, spdlog::sinks_init_list sinks) : spdlog::logger(std::move(name), sinks) {}

  explicit emitable_logger(const logger &other) : spdlog::logger(other) {}

  std::shared_ptr<logger> clone(std::string logger_name) override {
    auto cloned = std::make_shared<emitable_logger>(*this);
    cloned->name_ = std::move(logger_name);
    return cloned;
  }

  void emit(const std::string &source_file, int &source_line, const std::string &funcname,
            const std::string &logger_name, int log_level, const std::string &msg) {
    spdlog::source_loc source_loc(source_file.c_str(), source_line, funcname.c_str());
    spdlog::details::log_msg record(source_loc, logger_name, static_cast<spdlog::level::level_enum>(log_level), msg);
    sink_it_(record);
  }
};

spdlog::level::level_enum get_env_log_level(const data::locator_ptr &locator) {
  auto level_name = locator->has_env(LOG_LEVEL_ENV) ? locator->get_env(LOG_LEVEL_ENV) : DEFAULT_LOG_LEVEL_NAME;
  return spdlog::level::from_str(level_name);
}

std::shared_ptr<spdlog::logger> get_main_logger() { return spdlog::default_logger(); }

const std::string &setup_log(const data::location_ptr &location, const std::string &name) {
  if (spdlog::default_logger()->name().empty()) {
    std::shared_ptr<emitable_logger> logger;
    std::string log_file = location->locator->layout_file(location, longfist::enums::layout::LOG, name);
    auto daily_sink = std::make_shared<spdlog::sinks::daily_file_sink_mt>(log_file, 0, 0);

    if (location->group != "node") {
      auto console_sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
      spdlog::sinks_init_list log_sinks = {console_sink, daily_sink};
      logger = std::make_shared<emitable_logger>(name, log_sinks);
    } else {
      logger = std::make_shared<emitable_logger>(name, daily_sink);
    }

    logger->set_formatter(spdlog::details::make_unique<pattern_formatter>());
    logger->set_level(get_env_log_level(location->locator));
    logger->flush_on(spdlog::level::trace);

    spdlog::set_default_logger(std::static_pointer_cast<spdlog::logger>(logger));
  } else {
    SPDLOG_WARN("Setup log for {} more than once", name);
  }
  return name;
}

void emit_log(const std::string &source_file, int &source_line, const std::string &funcname,
              const std::string &logger_name, int log_level, const std::string &msg) {
  try {
    auto logger = std::dynamic_pointer_cast<emitable_logger>(get_main_logger());
    logger->emit(source_file, source_line, funcname, logger_name, log_level, msg);
  } catch (const std::exception &e) {
    SPDLOG_ERROR("Failed to emit log: {}", e.what());
  }
}

bool is_log_frame() {
  static bool log_frame = std::getenv("KF_LOG_FRAME") != nullptr;
  return log_frame;
}

void set_trigger_frame_uid(uint64_t frame_uid) { trigger_frame_uid = frame_uid; }

void set_trigger_initial_source_id(uint32_t initial_source_id) { trigger_initial_source_id_ = initial_source_id; }

void set_trigger_source_id(uint32_t source_id) { trigger_source_id = source_id; }

void set_trigger_dest_id(uint32_t dest_id) { trigger_dest_id = dest_id; }

void set_trigger_msg_type(int32_t msg_type) { trigger_msg_type = msg_type; }

uint64_t get_trigger_frame_uid() { return trigger_frame_uid; }

uint32_t get_trigger_initial_source_id() { return trigger_initial_source_id_; }

uint32_t get_trigger_source_id() { return trigger_source_id; }

uint32_t get_trigger_dest_id() { return trigger_dest_id; }

int32_t get_trigger_msg_type() { return trigger_msg_type; }

void enable_exception_log_frame() { exception_log_frame = true; }

} // namespace kungfu::yijinjing::log
