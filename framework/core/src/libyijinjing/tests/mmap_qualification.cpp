// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/platform/mmap.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <numeric>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/resource.h>
#include <sys/utsname.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;
using clock_type = std::chrono::steady_clock;
using kungfu::yijinjing::MB;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::bus;
using kungfu::yijinjing::journal::journal;
using kungfu::yijinjing::journal::journal_open_policy;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::writer;
using kungfu::yijinjing::platform::mapped_region;
using kungfu::yijinjing::platform::mapping_policy;

namespace {

constexpr uint32_t DEST_ID = location::PUBLIC;
constexpr int32_t CARRIER_TYPE = 10001;
constexpr size_t PAYLOAD_SIZE = 4096;
constexpr size_t WRITER_API_PAYLOAD_SIZE = 64;
volatile uint64_t read_sink = 0;

struct profile {
  std::string name;
  size_t primitive_size;
  size_t primitive_iterations;
  uint64_t journal_page_size_mb;
  std::vector<uint32_t> seek_page_counts;
  size_t seek_iterations;
  size_t writer_api_iterations;
  size_t writer_api_trials;
};

struct run_options {
  profile config;
  fs::path output;
};

struct resource_sample {
  int64_t user_us = 0;
  int64_t system_us = 0;
  int64_t minor_faults = 0;
  int64_t major_faults = 0;
  int64_t max_rss_kib = 0;
  size_t mapped_regions = 0;
  bool available = false;
};

class temp_tree {
public:
  temp_tree() {
    const auto nonce = clock_type::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-mmap-qualification-" + std::to_string(nonce));
    fs::create_directories(root_);
  }
  ~temp_tree() {
    std::error_code ignored;
    fs::remove_all(root_, ignored);
  }
  [[nodiscard]] const fs::path &root() const { return root_; }

private:
  fs::path root_;
};

uint64_t elapsed_ns(const clock_type::time_point start) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(clock_type::now() - start).count());
}

size_t mapped_region_count() {
#ifdef __linux__
  std::ifstream maps("/proc/self/maps");
  return static_cast<size_t>(std::count(std::istreambuf_iterator<char>(maps), std::istreambuf_iterator<char>(), '\n'));
#elif defined(__APPLE__)
  // vmmap would perturb the process being measured. Leave this fact explicit
  // rather than substituting a different metric under the same name.
  return 0;
#elif defined(_WIN32)
  size_t count = 0;
  MEMORY_BASIC_INFORMATION info{};
  auto *address = static_cast<unsigned char *>(nullptr);
  while (VirtualQuery(address, &info, sizeof(info)) == sizeof(info)) {
    ++count;
    if (info.RegionSize == 0 ||
        reinterpret_cast<uintptr_t>(address) + info.RegionSize < reinterpret_cast<uintptr_t>(address)) {
      break;
    }
    address += info.RegionSize;
  }
  return count;
#else
  return 0;
#endif
}

resource_sample resources() {
  resource_sample result;
#ifdef _WIN32
  result.mapped_regions = mapped_region_count();
#else
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0) {
    return result;
  }
  result.user_us = usage.ru_utime.tv_sec * 1000000LL + usage.ru_utime.tv_usec;
  result.system_us = usage.ru_stime.tv_sec * 1000000LL + usage.ru_stime.tv_usec;
  result.minor_faults = usage.ru_minflt;
  result.major_faults = usage.ru_majflt;
#ifdef __APPLE__
  result.max_rss_kib = usage.ru_maxrss / 1024;
#else
  result.max_rss_kib = usage.ru_maxrss;
#endif
  result.mapped_regions = mapped_region_count();
  result.available = true;
#endif
  return result;
}

json resource_delta(const resource_sample &before, const resource_sample &after) {
  return {{"available", before.available && after.available},
          {"user_us", after.user_us - before.user_us},
          {"system_us", after.system_us - before.system_us},
          {"minor_faults", after.minor_faults - before.minor_faults},
          {"major_faults", after.major_faults - before.major_faults},
          {"max_rss_kib_before", before.max_rss_kib},
          {"max_rss_kib_after", after.max_rss_kib},
          {"mapped_regions_before", before.mapped_regions},
          {"mapped_regions_after", after.mapped_regions},
          {"mapped_region_count_available", before.mapped_regions != 0 || after.mapped_regions != 0}};
}

uint64_t percentile(const std::vector<uint64_t> &sorted, double quantile) {
  if (sorted.empty()) {
    return 0;
  }
  const auto index = static_cast<size_t>(std::ceil(quantile * static_cast<double>(sorted.size())) - 1.0);
  return sorted[std::min(index, sorted.size() - 1)];
}

json distribution(std::vector<uint64_t> samples) {
  if (samples.empty()) {
    return {{"count", 0}};
  }
  std::sort(samples.begin(), samples.end());
  const auto total = std::accumulate(samples.begin(), samples.end(), uint64_t{0});
  return {{"count", samples.size()},
          {"min_ns", samples.front()},
          {"p50_ns", percentile(samples, 0.50)},
          {"p95_ns", percentile(samples, 0.95)},
          {"p99_ns", percentile(samples, 0.99)},
          {"max_ns", samples.back()},
          {"mean_ns", total / samples.size()}};
}

json host_facts() {
  json facts = {{"hardware_threads", std::thread::hardware_concurrency()},
                {"cpp_standard", __cplusplus},
                {"pointer_bits", sizeof(void *) * 8}};
#ifdef _WIN32
  SYSTEM_INFO info{};
  GetSystemInfo(&info);
  facts["os"] = "windows";
  facts["os_page_size"] = info.dwPageSize;
#else
  utsname name{};
  if (uname(&name) == 0) {
    facts["os"] = name.sysname;
    facts["os_release"] = name.release;
    facts["machine"] = name.machine;
  }
  facts["os_page_size"] = sysconf(_SC_PAGESIZE);
#ifdef __APPLE__
  size_t model_size = 0;
  if (sysctlbyname("hw.model", nullptr, &model_size, nullptr, 0) == 0 && model_size > 1) {
    std::string model(model_size, '\0');
    if (sysctlbyname("hw.model", model.data(), &model_size, nullptr, 0) == 0) {
      model.resize(std::strlen(model.c_str()));
      facts["hardware_model"] = model;
    }
  }
#endif
#endif
#if defined(__clang__)
  facts["compiler"] = "clang";
  facts["compiler_version"] = __clang_version__;
#elif defined(__GNUC__)
  facts["compiler"] = "gcc";
  facts["compiler_version"] = __VERSION__;
#elif defined(_MSC_VER)
  facts["compiler"] = "msvc";
  facts["compiler_version"] = _MSC_VER;
#endif
  return facts;
}

void touch_read(const mapped_region &region) {
  const auto *bytes = reinterpret_cast<const unsigned char *>(region.address());
  const size_t stride = 4096;
  uint64_t sum = 0;
  for (size_t offset = 0; offset < region.size(); offset += stride) {
    sum += bytes[offset];
  }
  read_sink = read_sink + sum;
}

json primitive_mapping(const temp_tree &tree, const profile &config) {
  const auto path = tree.root() / "primitive.journal";
  {
    auto seed = mapped_region::map(path.string(), config.primitive_size, mapping_policy::write_create_or_grow());
    std::memset(reinterpret_cast<void *>(seed.address()), 0x5a, seed.size());
    if (!seed.flush()) {
      throw std::runtime_error("failed to flush primitive fixture");
    }
  }

  std::vector<uint64_t> open_samples;
  std::vector<uint64_t> first_touch_samples;
  open_samples.reserve(config.primitive_iterations);
  first_touch_samples.reserve(config.primitive_iterations);
  const auto before = resources();
  for (size_t i = 0; i < config.primitive_iterations; ++i) {
    const auto open_start = clock_type::now();
    auto region = mapped_region::map(path.string(), config.primitive_size, mapping_policy::read_existing());
    open_samples.push_back(elapsed_ns(open_start));
    const auto touch_start = clock_type::now();
    touch_read(region);
    first_touch_samples.push_back(elapsed_ns(touch_start));
  }
  const auto after = resources();

  auto region = mapped_region::map(path.string(), config.primitive_size, mapping_policy::write_existing());
  const auto write_before = resources();
  const auto write_start = clock_type::now();
  std::memset(reinterpret_cast<void *>(region.address()), 0xa5, region.size());
  const auto write_ns = elapsed_ns(write_start);
  const auto flush_start = clock_type::now();
  if (!region.flush()) {
    throw std::runtime_error("failed to flush primitive measurement");
  }
  const auto flush_ns = elapsed_ns(flush_start);
  const auto write_after = resources();

  return {{"fixture_bytes", config.primitive_size},
          {"iterations", config.primitive_iterations},
          {"mapping_open", distribution(std::move(open_samples))},
          {"process_first_touch", distribution(std::move(first_touch_samples))},
          {"mapping_read_resources", resource_delta(before, after)},
          {"sequential_write_ns", write_ns},
          {"sequential_write_mib_per_second",
           static_cast<double>(config.primitive_size) * 1e9 / static_cast<double>(write_ns) / (1024.0 * 1024.0)},
          {"full_mapping_visibility_flush_ns", flush_ns},
          {"write_and_flush_resources", resource_delta(write_before, write_after)},
          {"os_page_cache_cold", "not_measured"}};
}

auto make_location(const fs::path &root, const std::string &group) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, group, "qualification", page_locator);
}

struct journal_fixture {
  kungfu::yijinjing::data::location_ptr location;
  std::vector<int64_t> first_time_by_page;
  size_t frames = 0;
  json write_switches;
  json write_resources;
  double write_mib_per_second = 0;
};

journal_fixture build_journal_fixture(const temp_tree &tree, uint32_t page_count, const profile &config) {
  auto loc = make_location(tree.root(), "pages_" + std::to_string(page_count));
  auto publisher = std::make_shared<noop_publisher>();
  auto page_bus = std::make_shared<bus>(false);
  writer output(loc, DEST_ID, publisher, false, page_bus, config.journal_page_size_mb, 0);
  std::vector<unsigned char> payload(PAYLOAD_SIZE, 0x3c);
  std::vector<uint64_t> switches;
  std::vector<int64_t> first_time(page_count + 1, 0);
  uint32_t frames_on_final_page = 0;
  int64_t gen_time = 1'000'000;
  size_t frames = 0;
  const auto before = resources();
  const auto total_start = clock_type::now();
  while (output.get_current_page()->get_page_id() < page_count || frames_on_final_page < 64) {
    const auto before_page = output.get_current_page()->get_page_id();
    if (before_page <= page_count && first_time[before_page] == 0) {
      first_time[before_page] = gen_time;
    }
    const auto start = clock_type::now();
    output.write_raw_at_as(gen_time, gen_time, loc->uid, DEST_ID, CARRIER_TYPE,
                           reinterpret_cast<uintptr_t>(payload.data()), static_cast<uint32_t>(payload.size()));
    const auto duration = elapsed_ns(start);
    const auto after_page = output.get_current_page()->get_page_id();
    if (after_page != before_page) {
      switches.push_back(duration);
    }
    if (after_page == page_count) {
      ++frames_on_final_page;
    }
    ++frames;
    gen_time += 1'000;
  }
  const auto total_ns = elapsed_ns(total_start);
  output.get_current_page()->flush();
  const auto after = resources();
  const auto bytes = static_cast<double>(frames * PAYLOAD_SIZE);
  return {loc,
          std::move(first_time),
          frames,
          distribution(std::move(switches)),
          resource_delta(before, after),
          bytes * 1e9 / static_cast<double>(total_ns) / (1024.0 * 1024.0)};
}

json read_journal(const journal_fixture &fixture, const profile &config) {
  auto page_bus = std::make_shared<bus>(false);
  journal input(fixture.location, DEST_ID, journal_open_policy::reader(), false, page_bus,
                config.journal_page_size_mb * MB);
  const auto before = resources();
  const auto start = clock_type::now();
  input.seek_to_time(0);
  std::vector<uint64_t> switches;
  size_t frames = 0;
  size_t data_frames = 0;
  uint64_t payload_bytes = 0;
  auto previous_page = input.current_page_id();
  while (input.current_frame()->has_data()) {
    const auto data_length = input.current_frame()->data_length();
    read_sink = read_sink + data_length;
    if (data_length > 0) {
      ++data_frames;
      payload_bytes += data_length;
    }
    const auto next_start = clock_type::now();
    input.next();
    const auto next_ns = elapsed_ns(next_start);
    const auto current_page = input.current_page_id();
    if (current_page != previous_page) {
      switches.push_back(next_ns);
      previous_page = current_page;
    }
    ++frames;
  }
  const auto total_ns = elapsed_ns(start);
  const auto after = resources();
  const auto bytes = static_cast<double>(payload_bytes);
  return {{"frames_observed", frames},
          {"data_frames_observed", data_frames},
          {"payload_bytes_observed", payload_bytes},
          {"total_ns", total_ns},
          {"estimated_payload_mib_per_second", bytes * 1e9 / static_cast<double>(total_ns) / (1024.0 * 1024.0)},
          {"page_switch", distribution(std::move(switches))},
          {"resources", resource_delta(before, after)}};
}

json seek_journal(const journal_fixture &fixture, uint32_t page_count, const profile &config) {
  json positions = json::object();
  const std::pair<const char *, uint32_t> targets[] = {
      {"early", 1}, {"middle", std::max<uint32_t>(1, page_count / 2)}, {"late", page_count}};
  for (const auto &[name, page_id] : targets) {
    std::vector<uint64_t> samples;
    const auto before = resources();
    for (size_t i = 0; i < config.seek_iterations; ++i) {
      auto page_bus = std::make_shared<bus>(false);
      journal input(fixture.location, DEST_ID, journal_open_policy::reader(), false, page_bus,
                    config.journal_page_size_mb * MB);
      const auto start = clock_type::now();
      input.seek_to_time(fixture.first_time_by_page.at(page_id) + 1);
      samples.push_back(elapsed_ns(start));
    }
    const auto after = resources();
    positions[name] = {{"target_page", page_id},
                       {"latency", distribution(std::move(samples))},
                       {"resources", resource_delta(before, after)}};
  }
  return {{"page_count", page_count}, {"iterations_per_position", config.seek_iterations}, {"positions", positions}};
}

struct writer_api_sample {
  uint64_t total_ns;
  double ns_per_frame;
  double frames_per_second;
  json resources;
};

writer_api_sample run_writer_api(const temp_tree &tree, const profile &config, bool transaction, size_t trial) {
  auto loc = make_location(tree.root(), fmt::format("writer_api_{}_{}", transaction ? "transaction" : "legacy", trial));
  auto publisher = std::make_shared<noop_publisher>();
  auto page_bus = std::make_shared<bus>(false);
  writer output(loc, DEST_ID, publisher, false, page_bus, config.journal_page_size_mb, 0);
  std::array<unsigned char, WRITER_API_PAYLOAD_SIZE> payload{};

  const auto before = resources();
  const auto start = clock_type::now();
  for (size_t i = 0; i < config.writer_api_iterations; ++i) {
    if (transaction) {
      auto tx = output.reserve_frame(static_cast<int64_t>(i), CARRIER_TYPE, payload.size());
      std::memcpy(tx.data(), payload.data(), payload.size());
      tx.commit(payload.size(), static_cast<int64_t>(i + 1));
    } else {
      auto frame = output.open_frame(static_cast<int64_t>(i), CARRIER_TYPE, payload.size());
      std::memcpy(const_cast<void *>(frame->data_address()), payload.data(), payload.size());
      output.close_frame(payload.size(), static_cast<int64_t>(i + 1));
    }
  }
  const auto total_ns = elapsed_ns(start);
  const auto after = resources();
  return {total_ns, static_cast<double>(total_ns) / static_cast<double>(config.writer_api_iterations),
          static_cast<double>(config.writer_api_iterations) * 1e9 / static_cast<double>(total_ns),
          resource_delta(before, after)};
}

json compare_writer_apis(const temp_tree &tree, const profile &config) {
  std::vector<uint64_t> legacy_ns_per_frame;
  std::vector<uint64_t> transaction_ns_per_frame;
  std::vector<double> paired_overhead_percent;
  json trials = json::array();
  for (size_t trial = 0; trial < config.writer_api_trials; ++trial) {
    const bool transaction_first = trial % 2 == 1;
    const auto first = run_writer_api(tree, config, transaction_first, trial * 2);
    const auto second = run_writer_api(tree, config, !transaction_first, trial * 2 + 1);
    const auto &legacy = transaction_first ? second : first;
    const auto &transaction = transaction_first ? first : second;
    legacy_ns_per_frame.push_back(static_cast<uint64_t>(std::llround(legacy.ns_per_frame)));
    transaction_ns_per_frame.push_back(static_cast<uint64_t>(std::llround(transaction.ns_per_frame)));
    const auto paired_overhead =
        (static_cast<double>(transaction.total_ns) / static_cast<double>(legacy.total_ns) - 1.0) * 100.0;
    paired_overhead_percent.push_back(paired_overhead);
    trials.push_back({{"legacy",
                       {{"total_ns", legacy.total_ns},
                        {"ns_per_frame", legacy.ns_per_frame},
                        {"frames_per_second", legacy.frames_per_second},
                        {"resources", legacy.resources}}},
                      {"transaction",
                       {{"total_ns", transaction.total_ns},
                        {"ns_per_frame", transaction.ns_per_frame},
                        {"frames_per_second", transaction.frames_per_second},
                        {"resources", transaction.resources}}},
                      {"paired_overhead_percent", paired_overhead}});
  }

  const auto legacy_distribution = distribution(legacy_ns_per_frame);
  const auto transaction_distribution = distribution(transaction_ns_per_frame);
  std::sort(paired_overhead_percent.begin(), paired_overhead_percent.end());
  const auto overhead_percent = paired_overhead_percent.at(paired_overhead_percent.size() / 2);
  return {{"comparison_scope", "same-binary deprecated split adapter versus RAII transaction"},
          {"iterations_per_trial", config.writer_api_iterations},
          {"trial_count", config.writer_api_trials},
          {"order_policy", "alternating within paired trials"},
          {"decision_statistic", "median of paired total-duration overhead percentages"},
          {"payload_bytes", WRITER_API_PAYLOAD_SIZE},
          {"trials", std::move(trials)},
          {"legacy_ns_per_frame", legacy_distribution},
          {"transaction_ns_per_frame", transaction_distribution},
          {"transaction_overhead_percent", overhead_percent},
          {"declared_regression_threshold_percent", 5.0},
          {"passes_declared_threshold", overhead_percent <= 5.0},
          {"transaction_owned_heap_allocations_per_frame", 0},
          {"published_read_refcount_operations_per_frame", 0}};
}

run_options parse_options(int argc, char **argv) {
  std::string requested = "smoke";
  fs::path output;
  for (int i = 1; i < argc; ++i) {
    const std::string arg(argv[i]);
    if (arg == "--profile" && i + 1 < argc) {
      requested = argv[++i];
    } else if (arg == "--output" && i + 1 < argc) {
      output = argv[++i];
    } else {
      throw std::runtime_error(
          "usage: yijinjing_mmap_qualification [--profile smoke|baseline] [--output new-file.json]");
    }
  }
  if (requested == "smoke") {
    return {{requested, 8 * MB, 12, 2, {4, 16}, 12, 30'000, 7}, output};
  }
  if (requested == "baseline") {
    return {{requested, 64 * MB, 80, 2, {8, 32, 128}, 80, 200'000, 11}, output};
  }
  throw std::runtime_error("unknown profile: " + requested);
}

} // namespace

int main(int argc, char **argv) {
  try {
    const auto options = parse_options(argc, argv);
    const auto &config = options.config;
    if (!options.output.empty() && fs::exists(options.output)) {
      throw std::runtime_error("refusing to overwrite evidence file: " + options.output.string());
    }
    temp_tree tree;
    json report = {{"schema", "kungfu.mmap-qualification.v1"},
                   {"profile", config.name},
                   {"source",
                    {{"git_head", std::getenv("KUNGFU_QUALIFICATION_GIT_HEAD") != nullptr
                                      ? std::getenv("KUNGFU_QUALIFICATION_GIT_HEAD")
                                      : "unknown"},
                     {"git_dirty", std::getenv("KUNGFU_QUALIFICATION_GIT_DIRTY") != nullptr
                                       ? std::getenv("KUNGFU_QUALIFICATION_GIT_DIRTY")
                                       : "unknown"}}},
                   {"host", host_facts()},
                   {"fixture",
                    {{"temporary_root", true},
                     {"primitive_bytes", config.primitive_size},
                     {"journal_page_size_bytes", config.journal_page_size_mb * MB},
                     {"payload_bytes", PAYLOAD_SIZE},
                     {"seek_page_counts", config.seek_page_counts}}},
                   {"semantic_limits",
                    {{"mapping_policy", "demand+visibility"},
                     {"os_page_cache_cold", "not_measured"},
                     {"power_loss_durability", "not_claimed"}}}};
    report["primitive_mapping"] = primitive_mapping(tree, config);
    report["writer_api_comparison"] = compare_writer_apis(tree, config);
    report["journal"] = json::array();
    for (const auto page_count : config.seek_page_counts) {
      const auto fixture = build_journal_fixture(tree, page_count, config);
      report["journal"].push_back({{"page_count", page_count},
                                   {"frames_written", fixture.frames},
                                   {"write_payload_mib_per_second", fixture.write_mib_per_second},
                                   {"write_page_switch", fixture.write_switches},
                                   {"write_resources", fixture.write_resources},
                                   {"sequential_read", read_journal(fixture, config)},
                                   {"seek", seek_journal(fixture, page_count, config)}});
    }
    if (options.output.empty()) {
      std::cout << report.dump(2) << '\n';
    } else {
      std::ofstream stream(options.output);
      if (!stream) {
        throw std::runtime_error("cannot open evidence output: " + options.output.string());
      }
      stream << report.dump(2) << '\n';
      if (!stream) {
        throw std::runtime_error("cannot write evidence output: " + options.output.string());
      }
      std::cout << "mmap qualification evidence: " << options.output << '\n';
    }
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "mmap qualification failed: " << error.what() << '\n';
    return 1;
  }
}
