// SPDX-License-Identifier: Apache-2.0
//
// Multi-process journal publication-protocol stress harness.
//
// ADR-0001 established that the frame `length` field and the page-header
// `last_frame_position` field are release/acquire publication tokens that must
// carry a writer's payload stores to a reader running in a *different process*
// on a weak-memory machine. That correctness was found by a human reading a
// torn frame once. This harness turns that discovery into a machine that keeps
// trying to read the problem out: a real single writer process and several
// real reader processes share the same mmap-backed journal pages, and each
// reader content-verifies every frame it observes.
//
// It is an evidence tool, not a shipped runtime component: it exercises the
// qualified production surface (writer / journal reader) but is never linked
// into libkungfu. All state lives under a temporary scratch root; nothing is
// written to the repository or the current working directory.
//
// Windows uses a different process model; the multi-process modes are POSIX
// (fork) and are skipped with an explicit message off POSIX. The checker
// self-test is portable and is the piece wired into ctest.

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/utsname.h>
#include <sys/wait.h>
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

namespace {

// Payload contract (harness-private; NOT a journal schema type). Every stress
// frame carries this fixed header followed by body_len bytes whose content is a
// deterministic function of seq. The body_hash lets a reader detect a torn or
// partially-visible body: if `length` were published before the body stores
// were visible cross-process, the recomputed hash would not match.
constexpr uint64_t STRESS_MAGIC = 0x4b46'5354'5245'5353ULL; // "KFSTRESS"
constexpr int32_t STRESS_CARRIER = 20001;
constexpr int32_t SENTINEL_CARRIER = 20002;
constexpr uint32_t MIN_BODY = 64;
constexpr uint32_t MAX_BODY = 4096;

struct stress_payload_header {
  uint64_t magic;
  uint64_t seq;
  uint32_t body_len;
  uint32_t reserved;
  uint64_t body_hash;
};
static_assert(sizeof(stress_payload_header) == 32, "stress payload header must stay 32 bytes");

// FNV-1a 64. Dependency-free and deterministic so writer and reader compute the
// same body hash across processes and toolchains.
uint64_t fnv1a64(const unsigned char *data, size_t length) {
  uint64_t hash = 1469598103934665603ULL;
  for (size_t i = 0; i < length; ++i) {
    hash ^= data[i];
    hash *= 1099511628211ULL;
  }
  return hash;
}

uint64_t mix64(uint64_t x) {
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return x;
}

uint32_t body_len_for(uint64_t seq) { return MIN_BODY + static_cast<uint32_t>(mix64(seq) % (MAX_BODY - MIN_BODY)); }

void fill_body(uint64_t seq, unsigned char *body, uint32_t body_len) {
  const uint64_t base = mix64(seq * 2654435761ULL + 0x9e3779b97f4a7c15ULL);
  for (uint32_t i = 0; i < body_len; ++i) {
    body[i] = static_cast<unsigned char>((base + i * 131u) & 0xffu);
  }
}

// Build a valid stress payload for `seq` into `out` (header + body). Returns the
// total byte length. When corrupt_hash is true the stored hash is deliberately
// wrong (used by end-to-end injection and by the checker self-test).
uint32_t build_payload(uint64_t seq, std::vector<unsigned char> &out, bool corrupt_hash = false) {
  const uint32_t body_len = body_len_for(seq);
  out.resize(sizeof(stress_payload_header) + body_len);
  auto *header = reinterpret_cast<stress_payload_header *>(out.data());
  auto *body = out.data() + sizeof(stress_payload_header);
  fill_body(seq, body, body_len);
  header->magic = STRESS_MAGIC;
  header->seq = seq;
  header->body_len = body_len;
  header->reserved = 0;
  header->body_hash = fnv1a64(body, body_len) ^ (corrupt_hash ? 0x1ULL : 0x0ULL);
  return static_cast<uint32_t>(out.size());
}

enum class violation_kind { none, magic, torn_body, reorder_or_duplicate, gap, short_frame };

const char *violation_name(violation_kind kind) {
  switch (kind) {
  case violation_kind::none:
    return "none";
  case violation_kind::magic:
    return "magic";
  case violation_kind::torn_body:
    return "torn_body";
  case violation_kind::reorder_or_duplicate:
    return "reorder_or_duplicate";
  case violation_kind::gap:
    return "gap";
  case violation_kind::short_frame:
    return "short_frame";
  }
  return "unknown";
}

struct check_result {
  violation_kind kind = violation_kind::none;
  uint64_t observed_seq = 0;
  uint64_t expected_seq = 0;
};

// Pure checker: inspects one observed data-frame payload against the running
// expected sequence. Advances expected_seq. This is the single source of the
// detection logic used by both readers and the portable self-test.
check_result check_payload(const unsigned char *payload, uint32_t data_length, uint64_t &expected_seq) {
  check_result result;
  result.expected_seq = expected_seq;
  if (data_length < sizeof(stress_payload_header)) {
    result.kind = violation_kind::short_frame;
    return result;
  }
  stress_payload_header header{};
  std::memcpy(&header, payload, sizeof(header));
  result.observed_seq = header.seq;
  if (header.magic != STRESS_MAGIC) {
    result.kind = violation_kind::magic;
    return result;
  }
  if (header.body_len > MAX_BODY || data_length < sizeof(stress_payload_header) + header.body_len) {
    result.kind = violation_kind::short_frame;
    return result;
  }
  const auto *body = payload + sizeof(stress_payload_header);
  if (fnv1a64(body, header.body_len) != header.body_hash) {
    result.kind = violation_kind::torn_body;
    return result;
  }
  if (header.seq < expected_seq) {
    result.kind = violation_kind::reorder_or_duplicate;
    return result;
  }
  if (header.seq > expected_seq) {
    result.kind = violation_kind::gap;
    expected_seq = header.seq + 1; // resync so one gap does not cascade
    return result;
  }
  expected_seq = header.seq + 1;
  return result;
}

json host_facts() {
  json facts = {{"pointer_bits", sizeof(void *) * 8}};
#ifdef _WIN32
  facts["os"] = "windows";
#else
  utsname name{};
  if (uname(&name) == 0) {
    facts["os"] = name.sysname;
    facts["os_release"] = name.release;
    facts["machine"] = name.machine;
  }
#endif
#if defined(__clang__)
  facts["compiler"] = "clang";
  facts["compiler_version"] = __clang_version__;
#elif defined(__GNUC__)
  facts["compiler"] = "gcc";
  facts["compiler_version"] = __VERSION__;
#endif
  return facts;
}

auto make_location(const fs::path &root, const std::string &group) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, group, "stress", page_locator);
}

constexpr uint32_t DEST_ID = location::PUBLIC;
constexpr uint64_t JOURNAL_PAGE_SIZE_MB = 2; // small pages => frequent page rolls => more turn-page races
const std::string JOURNAL_GROUP = "journal_stress";

enum class inject_mode { none, corrupt_body, gap, duplicate, reorder };

inject_mode parse_inject(const std::string &value) {
  if (value == "none")
    return inject_mode::none;
  if (value == "corrupt-body")
    return inject_mode::corrupt_body;
  if (value == "gap")
    return inject_mode::gap;
  if (value == "duplicate")
    return inject_mode::duplicate;
  if (value == "reorder")
    return inject_mode::reorder;
  throw std::runtime_error("unknown --inject mode: " + value);
}

const char *inject_name(inject_mode mode) {
  switch (mode) {
  case inject_mode::none:
    return "none";
  case inject_mode::corrupt_body:
    return "corrupt-body";
  case inject_mode::gap:
    return "gap";
  case inject_mode::duplicate:
    return "duplicate";
  case inject_mode::reorder:
    return "reorder";
  }
  return "unknown";
}

struct config {
  std::string profile = "smoke";
  uint64_t frames = 200'000;     // used when duration_seconds == 0
  uint64_t duration_seconds = 0; // soak mode when > 0
  int readers = 3;
  inject_mode inject = inject_mode::none;
  fs::path output;
};

fs::path report_path(const fs::path &root, const std::string &name) { return root / (name + ".json"); }

void write_report(const fs::path &path, const json &report) {
  std::ofstream stream(path);
  stream << report.dump(2) << '\n';
}

// ---------------------------------------------------------------------------
// Writer process
// ---------------------------------------------------------------------------
int run_writer(const fs::path &root, const config &cfg) {
  json report = {{"role", "writer"}, {"inject", inject_name(cfg.inject)}};
  try {
    auto loc = make_location(root, JOURNAL_GROUP);
    auto publisher = std::make_shared<noop_publisher>();
    auto page_bus = std::make_shared<bus>(false);
    writer output(loc, DEST_ID, publisher, false, page_bus, JOURNAL_PAGE_SIZE_MB, 0);

    // The injected frame sits well into the run so it lands mid-page-history.
    const uint64_t inject_at = 5000;

    std::vector<unsigned char> buffer;
    uint64_t seq = 0;
    uint64_t frames_written = 0;
    int64_t gen_time = 1'000'000;
    const uint32_t start_page = output.get_current_page()->get_page_id();
    const auto start = clock_type::now();
    const auto deadline = start + std::chrono::seconds(cfg.duration_seconds);

    const auto should_continue = [&]() {
      if (cfg.duration_seconds > 0) {
        return clock_type::now() < deadline;
      }
      return seq < cfg.frames;
    };

    const auto emit = [&](uint64_t payload_seq, bool corrupt) {
      const uint32_t length = build_payload(payload_seq, buffer, corrupt);
      output.write_raw_at_as(gen_time, gen_time, loc->uid, DEST_ID, STRESS_CARRIER,
                             reinterpret_cast<uintptr_t>(buffer.data()), length);
      gen_time += 1'000;
      ++frames_written;
    };

    while (should_continue()) {
      const bool at_inject = cfg.inject != inject_mode::none && seq == inject_at;
      if (at_inject) {
        switch (cfg.inject) {
        case inject_mode::corrupt_body:
          emit(seq, /*corrupt=*/true); // publishes a frame whose stored hash != body
          ++seq;
          break;
        case inject_mode::gap:
          ++seq; // skip one sequence number entirely
          emit(seq, false);
          ++seq;
          break;
        case inject_mode::duplicate:
          emit(seq, false);
          emit(seq, false); // same seq twice
          ++seq;
          break;
        case inject_mode::reorder:
          emit(seq + 1, false); // write the later seq first
          emit(seq, false);
          seq += 2;
          break;
        case inject_mode::none:
          break;
        }
        continue;
      }
      emit(seq, false);
      ++seq;
    }

    // Sentinel: last published frame. Its payload carries the authoritative
    // count of data frames the writer emitted (frames_written excludes it).
    const uint64_t total_data_frames = frames_written;
    std::vector<unsigned char> sentinel(sizeof(uint64_t));
    std::memcpy(sentinel.data(), &total_data_frames, sizeof(uint64_t));
    output.write_raw_at_as(gen_time, gen_time, loc->uid, DEST_ID, SENTINEL_CARRIER,
                           reinterpret_cast<uintptr_t>(sentinel.data()), sizeof(uint64_t));
    output.get_current_page()->flush();

    const uint32_t end_page = output.get_current_page()->get_page_id();
    report["ok"] = true;
    report["frames_written"] = total_data_frames;
    report["max_seq"] = seq == 0 ? 0 : seq - 1;
    report["pages_rolled"] = end_page - start_page;
    report["elapsed_ns"] = std::chrono::duration_cast<std::chrono::nanoseconds>(clock_type::now() - start).count();
    write_report(report_path(root, "report-writer"), report);
    return 0;
  } catch (const std::exception &error) {
    report["ok"] = false;
    report["exception"] = error.what();
    write_report(report_path(root, "report-writer"), report);
    std::cerr << "writer failed: " << error.what() << '\n';
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Reader process
// ---------------------------------------------------------------------------
int run_reader(const fs::path &root, int reader_idx, const config &cfg) {
  const std::string report_name = "report-reader-" + std::to_string(reader_idx);
  json report = {{"role", "reader"}, {"reader_idx", reader_idx}};
  json violations = json::array();
  const int stall_timeout_seconds = cfg.duration_seconds > 0 ? 120 : 45;
  const int32_t page_end_tag = kungfu::yijinjing::types::PageEnd::tag;

  try {
    auto loc = make_location(root, JOURNAL_GROUP);
    auto page_bus = std::make_shared<bus>(false);

    // The writer creates page 1 as it opens; a reader may start first. Retry
    // the open/seek until the page exists or a bounded startup budget expires.
    // A missing page during that window is expected, so silence the library's
    // open-failure logging until the first successful open.
    std::optional<journal> input;
    const auto open_deadline = clock_type::now() + std::chrono::seconds(30);
    const auto prior_level = spdlog::get_level();
    spdlog::set_level(spdlog::level::off);
    while (true) {
      try {
        input.emplace(loc, DEST_ID, journal_open_policy::reader(), false, page_bus, JOURNAL_PAGE_SIZE_MB * MB);
        input->seek_to_time(0);
        break;
      } catch (const std::exception &) {
        if (clock_type::now() > open_deadline) {
          spdlog::set_level(prior_level);
          throw;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    }
    spdlog::set_level(prior_level);

    uint64_t expected_seq = 0;
    uint64_t frames_observed = 0;
    uint64_t data_frames = 0;
    uint64_t max_seq = 0;
    bool saw_sentinel = false;
    uint64_t sentinel_count = 0;
    auto last_progress = clock_type::now();

    while (true) {
      auto frame = input->current_frame();
      if (!frame->has_data()) {
        if (clock_type::now() - last_progress > std::chrono::seconds(stall_timeout_seconds)) {
          report["stalled"] = true;
          break;
        }
        std::this_thread::yield();
        continue;
      }
      const int32_t carrier = frame->carrier_type();
      if (carrier == SENTINEL_CARRIER) {
        if (frame->data_length() >= sizeof(uint64_t)) {
          std::memcpy(&sentinel_count, frame->data_as_bytes(), sizeof(uint64_t));
        }
        saw_sentinel = true;
        break;
      }
      if (carrier == STRESS_CARRIER) {
        ++data_frames;
        const auto *payload = reinterpret_cast<const unsigned char *>(frame->data_as_bytes());
        const auto result = check_payload(payload, frame->data_length(), expected_seq);
        if (result.observed_seq > max_seq) {
          max_seq = result.observed_seq;
        }
        if (result.kind != violation_kind::none && violations.size() < 32) {
          violations.push_back({{"kind", violation_name(result.kind)},
                                {"observed_seq", result.observed_seq},
                                {"expected_seq", result.expected_seq},
                                {"page_id", input->current_page_id()}});
        }
      } else if (carrier != page_end_tag) {
        if (violations.size() < 32) {
          violations.push_back({{"kind", "unexpected_carrier"}, {"carrier", carrier}});
        }
      }
      ++frames_observed;
      last_progress = clock_type::now();
      input->next();
    }

    report["ok"] = saw_sentinel && violations.empty();
    report["saw_sentinel"] = saw_sentinel;
    report["frames_observed"] = frames_observed;
    report["data_frames_observed"] = data_frames;
    report["max_seq"] = max_seq;
    report["sentinel_count"] = sentinel_count;
    report["count_matches"] = saw_sentinel && sentinel_count == data_frames;
    report["violations"] = violations;
    if (!report.contains("stalled")) {
      report["stalled"] = false;
    }
    write_report(report_path(root, report_name), report);
    return report["ok"].get<bool>() ? 0 : 2;
  } catch (const std::exception &error) {
    report["ok"] = false;
    report["exception"] = error.what();
    report["violations"] = violations;
    write_report(report_path(root, report_name), report);
    std::cerr << "reader " << reader_idx << " failed: " << error.what() << '\n';
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Portable checker self-test (wired into ctest): proves the checker has
// detection power by feeding it known-bad frame streams. No child processes,
// no journal I/O, always runnable including on Windows.
// ---------------------------------------------------------------------------
int run_self_test_checker() {
  struct case_result {
    const char *name;
    bool detected;
    const char *got;
  };
  std::vector<case_result> results;

  const auto expect = [&](const char *name, violation_kind want, const std::function<check_result()> &fn) {
    const auto got = fn();
    results.push_back({name, got.kind == want, violation_name(got.kind)});
  };

  // clean stream must NOT flag
  {
    uint64_t expected = 0;
    std::vector<unsigned char> buf;
    bool clean = true;
    for (uint64_t s = 0; s < 8; ++s) {
      build_payload(s, buf);
      if (check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected).kind != violation_kind::none) {
        clean = false;
      }
    }
    results.push_back({"clean_stream", clean, clean ? "none" : "spurious"});
  }
  expect("torn_body", violation_kind::torn_body, [] {
    uint64_t expected = 0;
    std::vector<unsigned char> buf;
    build_payload(0, buf, /*corrupt=*/true);
    return check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected);
  });
  expect("magic", violation_kind::magic, [] {
    uint64_t expected = 0;
    std::vector<unsigned char> buf;
    build_payload(0, buf);
    std::memset(buf.data(), 0, sizeof(uint64_t)); // wipe magic
    return check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected);
  });
  expect("short_frame", violation_kind::short_frame, [] {
    uint64_t expected = 0;
    std::vector<unsigned char> buf(8, 0);
    return check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected);
  });
  expect("gap", violation_kind::gap, [] {
    uint64_t expected = 5; // expecting 5 but frame carries 7
    std::vector<unsigned char> buf;
    build_payload(7, buf);
    return check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected);
  });
  expect("reorder_or_duplicate", violation_kind::reorder_or_duplicate, [] {
    uint64_t expected = 5; // expecting 5 but frame carries 3 (backwards)
    std::vector<unsigned char> buf;
    build_payload(3, buf);
    return check_payload(buf.data(), static_cast<uint32_t>(buf.size()), expected);
  });

  bool all = true;
  std::cout << "journal-stress checker self-test\n";
  for (const auto &r : results) {
    std::cout << "  [" << (r.detected ? "PASS" : "FAIL") << "] " << r.name << " (got " << r.got << ")\n";
    all = all && r.detected;
  }
  std::cout << (all ? "self-test OK" : "self-test FAILED") << '\n';
  return all ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Temp scratch root (parent-owned; removed on parent destruction only).
// ---------------------------------------------------------------------------
class temp_tree {
public:
  temp_tree() {
    const auto nonce = clock_type::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-journal-stress-" + std::to_string(nonce));
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

config parse_config(int argc, char **argv, bool &self_test) {
  config cfg;
  for (int i = 1; i < argc; ++i) {
    const std::string arg(argv[i]);
    const auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        throw std::runtime_error("missing value for " + arg);
      }
      return argv[++i];
    };
    if (arg == "--self-test-checker") {
      self_test = true;
    } else if (arg == "--profile") {
      cfg.profile = next();
      if (cfg.profile == "smoke") {
        cfg.frames = 200'000;
        cfg.duration_seconds = 0;
      } else if (cfg.profile == "soak") {
        cfg.frames = 0;
        cfg.duration_seconds = 1800;
      } else {
        throw std::runtime_error("unknown --profile: " + cfg.profile);
      }
    } else if (arg == "--frames") {
      cfg.frames = std::stoull(next());
      cfg.duration_seconds = 0;
    } else if (arg == "--duration-seconds") {
      cfg.duration_seconds = std::stoull(next());
    } else if (arg == "--readers") {
      cfg.readers = std::stoi(next());
    } else if (arg == "--inject") {
      cfg.inject = parse_inject(next());
    } else if (arg == "--output") {
      cfg.output = next();
    } else {
      throw std::runtime_error("usage: yijinjing_journal_stress [--self-test-checker] "
                               "[--profile smoke|soak] [--frames N] [--duration-seconds S] "
                               "[--readers K] [--inject none|corrupt-body|gap|duplicate|reorder] "
                               "[--output file.json]");
    }
  }
  if (cfg.readers < 1) {
    throw std::runtime_error("--readers must be >= 1");
  }
  return cfg;
}

} // namespace

#ifndef _WIN32
int run_multiprocess(const config &cfg) {
  if (!cfg.output.empty() && fs::exists(cfg.output)) {
    std::cerr << "refusing to overwrite evidence file: " << cfg.output << '\n';
    return 1;
  }
  temp_tree tree;
  const fs::path root = tree.root();

  const pid_t writer_pid = fork();
  if (writer_pid < 0) {
    std::cerr << "fork writer failed\n";
    return 1;
  }
  if (writer_pid == 0) {
    _exit(run_writer(root, cfg));
  }

  std::vector<pid_t> reader_pids;
  for (int i = 0; i < cfg.readers; ++i) {
    const pid_t pid = fork();
    if (pid < 0) {
      std::cerr << "fork reader failed\n";
      break;
    }
    if (pid == 0) {
      _exit(run_reader(root, i, cfg));
    }
    reader_pids.push_back(pid);
  }

  const auto wait_child = [](pid_t pid) -> json {
    int status = 0;
    waitpid(pid, &status, 0);
    json result;
    if (WIFEXITED(status)) {
      result["exit_code"] = WEXITSTATUS(status);
      result["signaled"] = false;
    } else if (WIFSIGNALED(status)) {
      result["exit_code"] = -1;
      result["signaled"] = true;
      result["signal"] = WTERMSIG(status);
    }
    return result;
  };

  const json writer_wait = wait_child(writer_pid);
  std::vector<json> reader_waits;
  reader_waits.reserve(reader_pids.size());
  for (const pid_t pid : reader_pids) {
    reader_waits.push_back(wait_child(pid));
  }

  const auto load_report = [&](const std::string &name) -> json {
    std::ifstream stream(report_path(root, name));
    if (!stream) {
      return json{{"missing", true}};
    }
    json parsed;
    try {
      stream >> parsed;
    } catch (const std::exception &error) {
      return json{{"parse_error", error.what()}};
    }
    return parsed;
  };

  json writer_report = load_report("report-writer");
  writer_report["process"] = writer_wait;

  json readers_report = json::array();
  bool all_readers_clean = true;
  bool any_injection_detected = false;
  for (size_t i = 0; i < reader_pids.size(); ++i) {
    json rep = load_report("report-reader-" + std::to_string(i));
    rep["process"] = reader_waits[i];
    const bool child_ok = reader_waits[i].value("exit_code", -1) == 0;
    const bool report_ok = rep.value("ok", false);
    const bool has_violations = rep.contains("violations") && !rep["violations"].empty();
    // A reader killed by a signal (SIGBUS on a bad mapping, say) surfaced the
    // fault just as much as a recorded violation did.
    const bool child_signaled = reader_waits[i].value("signaled", false);
    if (!child_ok || !report_ok) {
      all_readers_clean = false;
    }
    if (has_violations || child_signaled) {
      any_injection_detected = true;
    }
    readers_report.push_back(rep);
  }

  const bool writer_ok = writer_report.value("ok", false) && writer_wait.value("exit_code", -1) == 0;

  std::string verdict;
  int exit_code;
  if (cfg.inject == inject_mode::none) {
    const bool clean = writer_ok && all_readers_clean;
    verdict = clean ? "clean" : "violated";
    exit_code = clean ? 0 : 3;
  } else {
    // Under injection the harness must SURFACE the fault; a clean run means the
    // harness is blind, which is itself a failure.
    verdict = any_injection_detected ? "injected_detected" : "injection_escaped";
    exit_code = any_injection_detected ? 0 : 4;
  }

  json receipt = {{"schema", "kungfu.journal-stress.v1"},
                  {"profile", cfg.profile},
                  {"inject", inject_name(cfg.inject)},
                  {"host", host_facts()},
                  {"source",
                   {{"git_head", std::getenv("KUNGFU_QUALIFICATION_GIT_HEAD") != nullptr
                                     ? std::getenv("KUNGFU_QUALIFICATION_GIT_HEAD")
                                     : "unknown"},
                    {"git_dirty", std::getenv("KUNGFU_QUALIFICATION_GIT_DIRTY") != nullptr
                                      ? std::getenv("KUNGFU_QUALIFICATION_GIT_DIRTY")
                                      : "unknown"}}},
                  {"fixture",
                   {{"temporary_root", true},
                    {"journal_page_size_bytes", JOURNAL_PAGE_SIZE_MB * MB},
                    {"readers", cfg.readers},
                    {"frames_target", cfg.frames},
                    {"duration_seconds", cfg.duration_seconds}}},
                  {"writer", writer_report},
                  {"readers", readers_report},
                  {"verdict", verdict}};

  if (cfg.output.empty()) {
    std::cout << receipt.dump(2) << '\n';
  } else {
    std::ofstream stream(cfg.output);
    stream << receipt.dump(2) << '\n';
    std::cout << "journal stress evidence: " << cfg.output << " verdict=" << verdict << '\n';
  }
  return exit_code;
}
#endif

int main(int argc, char **argv) {
  try {
    bool self_test = false;
    const config cfg = parse_config(argc, argv, self_test);
    if (self_test) {
      return run_self_test_checker();
    }
#ifdef _WIN32
    std::cout << "journal stress multi-process modes require POSIX fork; skipped on Windows. "
                 "Use --self-test-checker for the portable checker test.\n";
    return 0;
#else
    return run_multiprocess(cfg);
#endif
  } catch (const std::exception &error) {
    std::cerr << "journal stress harness failed: " << error.what() << '\n';
    return 1;
  }
}
