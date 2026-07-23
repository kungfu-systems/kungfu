// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/yijinjing/ownership.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <sys/resource.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace kungfu::runtime::durability;
using kungfu::runtime::state_service::bootstrap_outcome;
using kungfu::runtime::state_service::peer_state_requirement;
using kungfu::runtime::state_service::projection_bootstrap_store;
using kungfu::runtime::state_service::projection_mutation;
using kungfu::runtime::state_service::projection_options;
using kungfu::yijinjing::ownership::lease;

namespace {

using clock_type = std::chrono::steady_clock;

uint64_t elapsed_ns(clock_type::time_point start, clock_type::time_point end = clock_type::now()) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
}

uint64_t parse_u64(const char *value, const std::string &name, uint64_t minimum = 1) {
  try {
    const auto parsed = std::stoull(value);
    if (parsed < minimum) {
      throw std::invalid_argument(name + " is below its minimum");
    }
    return parsed;
  } catch (const std::exception &) {
    throw std::invalid_argument("invalid " + name + ": " + value);
  }
}

durability_profile parse_profile(const std::string &name) {
  if (name == "durable_group") {
    return durability_profile::DurableGroup;
  }
  if (name == "durable_sync") {
    return durability_profile::DurableSync;
  }
  throw std::invalid_argument("profile must be durable_group or durable_sync");
}

class histogram {
public:
  void observe(uint64_t value) {
    const auto index = bucket_index(value);
    ++counts_[index];
    ++count_;
    sum_ += static_cast<long double>(value);
    maximum_ = std::max(maximum_, value);
  }

  [[nodiscard]] json render() const {
    json buckets = json::array();
    for (const auto &[index, count] : counts_) {
      buckets.push_back({{"upper_bound_ns", bucket_upper(index)}, {"count", count}});
    }
    return {{"schema", "kungfu.durability.slo-histogram/v1"},
            {"count", count_},
            {"mean_ns", count_ == 0 ? 0.0 : static_cast<double>(sum_ / count_)},
            {"p50_ns", percentile(0.5)},
            {"p95_ns", percentile(0.95)},
            {"p99_ns", percentile(0.99)},
            {"p999_ns", percentile(0.999)},
            {"max_ns", maximum_},
            {"buckets", buckets}};
  }

private:
  static constexpr uint64_t SUB_BUCKETS = 32;

  static uint64_t bucket_index(uint64_t value) {
    if (value <= 1) {
      return 0;
    }
    const auto exponent = static_cast<uint64_t>(std::floor(std::log2(static_cast<long double>(value))));
    const auto base = std::ldexp(1.0L, static_cast<int>(exponent));
    const auto fraction = (static_cast<long double>(value) - base) / base;
    const auto sub = std::min<uint64_t>(SUB_BUCKETS - 1, static_cast<uint64_t>(fraction * SUB_BUCKETS));
    return exponent * SUB_BUCKETS + sub + 1;
  }

  static uint64_t bucket_upper(uint64_t index) {
    if (index == 0) {
      return 1;
    }
    const auto adjusted = index - 1;
    const auto exponent = adjusted / SUB_BUCKETS;
    const auto sub = adjusted % SUB_BUCKETS;
    const auto base = std::ldexp(1.0L, static_cast<int>(exponent));
    const auto upper = base * (1.0L + static_cast<long double>(sub + 1) / SUB_BUCKETS);
    if (upper >= static_cast<long double>(std::numeric_limits<uint64_t>::max())) {
      return std::numeric_limits<uint64_t>::max();
    }
    return static_cast<uint64_t>(std::ceil(upper));
  }

  [[nodiscard]] uint64_t percentile(double quantile) const {
    if (count_ == 0) {
      return 0;
    }
    const auto target = static_cast<uint64_t>(std::ceil(static_cast<double>(count_) * quantile));
    uint64_t seen = 0;
    for (const auto &[index, count] : counts_) {
      seen += count;
      if (seen >= target) {
        return bucket_upper(index);
      }
    }
    return maximum_;
  }

  std::map<uint64_t, uint64_t> counts_ = {};
  uint64_t count_ = 0;
  uint64_t maximum_ = 0;
  long double sum_ = 0;
};

struct resource_snapshot {
  uint64_t user_cpu_us = 0;
  uint64_t system_cpu_us = 0;
  uint64_t max_rss_kib = 0;
  uint64_t minor_faults = 0;
  uint64_t major_faults = 0;
  uint64_t read_bytes = 0;
  uint64_t write_bytes = 0;
  uint64_t mapped_regions = 0;
};

uint64_t read_proc_value(const fs::path &path, const std::string &key) {
  std::ifstream input(path);
  std::string name;
  uint64_t value = 0;
  while (input >> name >> value) {
    if (name == key + ":") {
      return value;
    }
    std::string ignored;
    std::getline(input, ignored);
  }
  return 0;
}

resource_snapshot resources() {
  resource_snapshot result;
#ifndef _WIN32
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) == 0) {
    result.user_cpu_us = static_cast<uint64_t>(usage.ru_utime.tv_sec) * 1000000ULL + usage.ru_utime.tv_usec;
    result.system_cpu_us = static_cast<uint64_t>(usage.ru_stime.tv_sec) * 1000000ULL + usage.ru_stime.tv_usec;
    result.max_rss_kib = static_cast<uint64_t>(usage.ru_maxrss);
    result.minor_faults = static_cast<uint64_t>(usage.ru_minflt);
    result.major_faults = static_cast<uint64_t>(usage.ru_majflt);
  }
  result.read_bytes = read_proc_value("/proc/self/io", "read_bytes");
  result.write_bytes = read_proc_value("/proc/self/io", "write_bytes");
  std::ifstream maps("/proc/self/maps");
  std::string line;
  while (std::getline(maps, line)) {
    ++result.mapped_regions;
  }
#endif
  return result;
}

json resource_delta(const resource_snapshot &before, const resource_snapshot &after) {
  const auto delta = [](uint64_t first, uint64_t second) { return second >= first ? second - first : 0; };
  return {{"user_cpu_us", delta(before.user_cpu_us, after.user_cpu_us)},
          {"system_cpu_us", delta(before.system_cpu_us, after.system_cpu_us)},
          {"max_rss_kib", after.max_rss_kib},
          {"minor_faults", delta(before.minor_faults, after.minor_faults)},
          {"major_faults", delta(before.major_faults, after.major_faults)},
          {"read_bytes", delta(before.read_bytes, after.read_bytes)},
          {"write_bytes", delta(before.write_bytes, after.write_bytes)},
          {"mapped_regions", after.mapped_regions}};
}

uint64_t tree_bytes(const fs::path &root) {
  uint64_t total = 0;
  for (const auto &entry : fs::recursive_directory_iterator(root)) {
    if (entry.is_regular_file()) {
      total += entry.file_size();
    }
  }
  return total;
}

void copy_tree_new(const fs::path &source, const fs::path &target) {
  if (fs::exists(target)) {
    throw std::runtime_error("refusing existing copy target: " + target.string());
  }
  fs::create_directories(target);
  for (const auto &entry : fs::recursive_directory_iterator(source)) {
    const auto relative = fs::relative(entry.path(), source);
    const auto destination = target / relative;
    if (entry.is_directory()) {
      fs::create_directories(destination);
    } else if (entry.is_regular_file()) {
      fs::create_directories(destination.parent_path());
      fs::copy_file(entry.path(), destination, fs::copy_options::none);
    } else {
      throw std::runtime_error("unsupported entry in fixture root: " + entry.path().string());
    }
  }
}

stream_position position(uint64_t sequence) { return {71, 5, sequence, 1000 + sequence}; }

ingest_options options(const fs::path &root, uint64_t segment_bytes, bool read_only = false) {
  ingest_options result{root.string(), 71,       5, "00000001.00000002", "candidate/linux-ext4-agent120-slo-v1", true,
                        segment_bytes, read_only};
  result.activation = ingest_activation::ProductionCandidate;
  return result;
}

struct run_config {
  fs::path root;
  std::string profile_name;
  durability_profile profile;
  uint64_t records;
  uint64_t payload_bytes;
  uint64_t batch_size;
  uint64_t segment_bytes;
  uint64_t duration_seconds;
  uint64_t target_rate;
};

json run(const run_config &config) {
  if (fs::exists(config.root)) {
    throw std::runtime_error("refusing existing run root: " + config.root.string());
  }
  fs::create_directories(config.root);
  const auto run_started = clock_type::now();
  const auto before = resources();
  histogram append_latency;
  histogram receipt_latency;
  uint64_t record_count = 0;
  uint64_t barrier_count = 0;
  uint64_t request_id = 10000;
  std::vector<std::string> violations;
  const std::string payload(config.payload_bytes, 'k');

  {
    const auto service_owner = lease::acquire_data_root_service(config.root.string());
    const auto writer_owner = lease::acquire_stream_writer(config.root.string(), "00000001.00000002");
    durable_ingest_log log(options(config.root, config.segment_bytes));
    const auto deadline = config.duration_seconds == 0
                              ? clock_type::time_point::max()
                              : clock_type::now() + std::chrono::seconds(config.duration_seconds);
    const auto target_period = config.target_rate == 0 ? std::chrono::nanoseconds(0)
                                                       : std::chrono::nanoseconds(1000000000ULL / config.target_rate);
    auto next_record_at = clock_type::now();
    while ((config.duration_seconds == 0 && record_count < config.records) ||
           (config.duration_seconds != 0 && clock_type::now() < deadline)) {
      std::vector<clock_type::time_point> appended_at;
      appended_at.reserve(config.batch_size);
      for (uint64_t index = 0; index < config.batch_size; ++index) {
        if ((config.duration_seconds == 0 && record_count >= config.records) ||
            (config.duration_seconds != 0 && clock_type::now() >= deadline)) {
          break;
        }
        if (config.target_rate != 0) {
          next_record_at += target_period;
          std::this_thread::sleep_until(next_record_at);
        }
        const auto append_started = clock_type::now();
        log.append(position(record_count + 1), 9001, payload, service_owner, writer_owner);
        const auto append_finished = clock_type::now();
        append_latency.observe(elapsed_ns(append_started, append_finished));
        appended_at.push_back(append_started);
        ++record_count;
      }
      if (appended_at.empty()) {
        continue;
      }
      const auto barrier_started = clock_type::now();
      const auto result = log.barrier(++request_id, config.profile, service_owner, writer_owner);
      const auto barrier_finished = clock_type::now();
      ++barrier_count;
      if (result.receipt.status != receipt_status::Succeeded || !result.receipt.durable_watermark.has_value() ||
          result.receipt.durable_watermark->sequence != record_count) {
        violations.push_back("barrier_receipt_or_watermark_mismatch");
        break;
      }
      for (const auto start : appended_at) {
        receipt_latency.observe(elapsed_ns(start, barrier_finished));
      }
      if (result.status.last_barrier_duration_ns == 0 || elapsed_ns(barrier_started, barrier_finished) == 0) {
        violations.push_back("barrier_duration_missing");
        break;
      }
    }
  }

  std::vector<durable_record> records;
  uint64_t recovery_ns = 0;
  {
    const auto recovery_started = clock_type::now();
    durable_ingest_log reopened(options(config.root, config.segment_bytes, true));
    records = reopened.read_durable_records();
    recovery_ns = elapsed_ns(recovery_started);
    if (records.size() != record_count || (record_count > 0 && records.back().position.sequence != record_count)) {
      violations.push_back("recovery_record_or_sequence_mismatch");
    }
  }

  const auto projection_root = config.root.parent_path() / (config.root.filename().string() + ".projection");
  if (fs::exists(projection_root)) {
    throw std::runtime_error("refusing existing projection target: " + projection_root.string());
  }
  fs::create_directories(projection_root);
  projection_options projection{projection_root.string(),
                                71,
                                5,
                                "slo",
                                "kungfu-durability-slo-projection-v1",
                                "candidate/linux-ext4-agent120-slo-v1"};
  projection_bootstrap_store store(projection, [](const durable_record &record) -> std::optional<projection_mutation> {
    return projection_mutation{std::to_string(record.position.sequence), record.payload_sha256, false};
  });
  const auto rebuild_started = clock_type::now();
  const auto snapshot = store.rebuild(records);
  const auto projection_rebuild_ns = elapsed_ns(rebuild_started);
  const auto bootstrap_started = clock_type::now();
  const auto bootstrap = store.bootstrap(records, peer_state_requirement::Required);
  const auto projection_bootstrap_ns = elapsed_ns(bootstrap_started);
  if (snapshot.state.size() != record_count || bootstrap.outcome != bootstrap_outcome::Ready ||
      bootstrap.status.lag_records != 0 || bootstrap.state != snapshot.state) {
    violations.push_back("projection_rebuild_or_bootstrap_mismatch");
  }

  const auto backup_root = config.root.parent_path() / (config.root.filename().string() + ".backup");
  const auto restore_root = config.root.parent_path() / (config.root.filename().string() + ".restore");
  const auto backup_started = clock_type::now();
  copy_tree_new(config.root, backup_root);
  const auto backup_ns = elapsed_ns(backup_started);
  const auto restore_started = clock_type::now();
  copy_tree_new(backup_root, restore_root);
  uint64_t restored_records = 0;
  {
    durable_ingest_log restored(options(restore_root, config.segment_bytes, true));
    restored_records = restored.read_durable_records().size();
  }
  const auto restore_ns = elapsed_ns(restore_started);
  if (restored_records != record_count || tree_bytes(backup_root) != tree_bytes(config.root) ||
      tree_bytes(restore_root) != tree_bytes(config.root)) {
    violations.push_back("backup_restore_mismatch");
  }

  const auto run_elapsed_ns = elapsed_ns(run_started);
  const auto after = resources();
  const auto bytes = record_count * config.payload_bytes;
  return {{"schema", "kungfu.durability.slo-fixture-result/v1"},
          {"profile", config.profile_name},
          {"qualification_profile", "candidate/linux-ext4-agent120-slo-v1"},
          {"workload",
           {{"records_target", config.records},
            {"records_completed", record_count},
            {"payload_bytes", config.payload_bytes},
            {"batch_size", config.batch_size},
            {"segment_max_bytes", config.segment_bytes},
            {"duration_seconds", config.duration_seconds},
            {"target_rate_records_per_second", config.target_rate}}},
          {"correctness",
           {{"passed", violations.empty()},
            {"violations", violations},
            {"durable_records", records.size()},
            {"restored_records", restored_records},
            {"last_sequence", record_count},
            {"projection_state_entries", snapshot.state.size()},
            {"projection_integrity_sha256", snapshot.integrity_sha256}}},
          {"metrics",
           {{"elapsed_ns", run_elapsed_ns},
            {"records_per_second", run_elapsed_ns == 0 ? 0.0 : record_count * 1e9 / run_elapsed_ns},
            {"payload_bytes_per_second", run_elapsed_ns == 0 ? 0.0 : bytes * 1e9 / run_elapsed_ns},
            {"barrier_count", barrier_count},
            {"candidate_append_latency", append_latency.render()},
            {"durability_receipt_latency", receipt_latency.render()},
            {"recovery_ns", recovery_ns},
            {"projection_rebuild_ns", projection_rebuild_ns},
            {"projection_bootstrap_ns", projection_bootstrap_ns},
            {"backup_ns", backup_ns},
            {"restore_ns", restore_ns},
            {"fixture_bytes", tree_bytes(config.root)},
            {"resources", resource_delta(before, after)}}},
          {"claims",
           {{"candidate_fixture_execution", true},
            {"host_envelope_qualified_by_fixture", false},
            {"mmap_visible_path_qualified", false},
            {"physical_power_loss_qualified", false},
            {"production_eligible", false}}}};
}

void usage() {
  std::cerr << "usage: kungfu_durability_slo_fixture run ROOT PROFILE RECORDS PAYLOAD_BYTES BATCH_SIZE "
               "SEGMENT_BYTES DURATION_SECONDS TARGET_RATE\n";
}

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc != 10 || std::string(argv[1]) != "run") {
      usage();
      return 2;
    }
    const run_config config{fs::path(argv[2]),
                            argv[3],
                            parse_profile(argv[3]),
                            parse_u64(argv[4], "records", 0),
                            parse_u64(argv[5], "payload bytes"),
                            parse_u64(argv[6], "batch size"),
                            parse_u64(argv[7], "segment bytes", 4096),
                            parse_u64(argv[8], "duration seconds", 0),
                            parse_u64(argv[9], "target rate", 0)};
    if (config.records == 0 && config.duration_seconds == 0) {
      throw std::invalid_argument("records or duration seconds must be nonzero");
    }
    if (config.records != 0 && config.duration_seconds != 0) {
      throw std::invalid_argument("records and duration seconds are mutually exclusive");
    }
    std::cout << run(config).dump() << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "durability_slo_fixture: " << error.what() << std::endl;
    return 1;
  }
}
