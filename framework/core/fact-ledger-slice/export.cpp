// SPDX-License-Identifier: Apache-2.0
//
// Independent fact-ledger export tool (read path).
//
// Reopens a journal directory that some other process wrote and then exited,
// WITHOUT starting the trading runtime (no master, no bus drain loop, no nng).
// It iterates the frames in written order and produces two portable artifacts:
//
//   <out>.jsonl          one line per event, stable field set, payload verbatim
//   <out>.manifest.json  spec/platform/provenance + content checksums + the
//                        explicit capture-boundary (what is and isn't captured)
//
// ADR-0010 4.6 invariant: frame_uid / trigger_frame_uid are read straight off
// each recorded frame header and copied out verbatim. We never call
// writer::current_frame_uid() or otherwise regenerate an id on the read path --
// doing so would break the causal graph the spine records.
//
// Usage:  fact_ledger_export <journal-root-dir> [group] [name] [out-prefix]

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/journal.h>

#include <nlohmann/json.hpp>

#include "sha256.h"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace kungfu::yijinjing;
namespace longfist = kungfu::longfist;
using kungfu::fact_ledger_slice::sha256;

namespace {
constexpr const char *SPEC_VERSION = "0.1";      // portable-bundle format contract
constexpr const char *FORMAT_VERSION = "0.1";    // event-log line schema
constexpr const char *PRODUCER = "fact_ledger_export/0.1.0";
constexpr const char *HASH_ALGORITHM = "sha256";

const char *platform_os() {
#if defined(__APPLE__)
  return "macos";
#elif defined(__linux__)
  return "linux";
#elif defined(_WIN32)
  return "windows";
#else
  return "unknown";
#endif
}

const char *platform_arch() {
#if defined(__aarch64__) || defined(_M_ARM64)
  return "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
  return "x86_64";
#else
  return "unknown";
#endif
}

// The journal reserves payload space rounded up to a CPU word, so the recorded
// data_length can carry trailing NUL padding after the JSON text. JSON text
// never contains an interior NUL, so stripping trailing NULs recovers the exact
// bytes the writer memcpy'd -- the verbatim payload.
std::string strip_trailing_nuls(std::string s) {
  while (!s.empty() && s.back() == '\0') {
    s.pop_back();
  }
  return s;
}

const char *data_type_name(int8_t dt) {
  switch (dt) {
  case int8_t(longfist::enums::FrameDataType::Raw):
    return "Raw";
  case int8_t(longfist::enums::FrameDataType::Json):
    return "Json";
  default:
    return "Unknown";
  }
}
} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: fact_ledger_export <journal-root-dir> [group] [name] [out-prefix]\n";
    return 2;
  }
  const std::string root = argv[1];
  const std::string group = argc >= 3 ? argv[2] : "fact_ledger_slice";
  const std::string name = argc >= 4 ? argv[3] : "host";
  const std::string out_prefix = argc >= 5 ? argv[4] : (root + "/export");

  // Reconstruct the same location identity from the directory coordinates and
  // reopen it read-only. assemble uses a noop bus internally; nothing here
  // starts the runtime.
  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM, group, name,
                                              locator);
  journal::assemble reader(location, data::location::PUBLIC, longfist::enums::AssembleMode::Channel, 0);

  // Build the JSONL body in memory so the whole-segment checksum is computed
  // over exactly the bytes we write out.
  std::string jsonl;
  std::vector<nlohmann::json> event_digests; // per-event checksum records for the manifest
  std::vector<int64_t> prev_uid_seen;        // to assert the causal chain links back

  std::size_t count = 0;
  bool chain_ok = true;
  uint64_t last_uid = 0;

  while (reader.data_available()) {
    auto frame = reader.current_frame();

    const uint64_t frame_uid = frame->frame_uid();               // read verbatim, never recomputed
    const uint64_t trigger_frame_uid = frame->trigger_frame_uid(); // read verbatim
    const std::string payload_raw = frame->is_json() ? strip_trailing_nuls(frame->data_as_string()) : std::string{};
    const std::string payload_sha = sha256::hex(payload_raw);

    // Causal-chain check: event 0 is root (trigger 0); event k (k>0) must point
    // at event k-1's frame_uid.
    if (count == 0) {
      if (trigger_frame_uid != 0) {
        chain_ok = false;
      }
    } else if (trigger_frame_uid != last_uid) {
      chain_ok = false;
    }
    last_uid = frame_uid;

    nlohmann::json line = {
        {"seq", count},
        {"frame_uid", frame_uid},
        {"trigger_frame_uid", trigger_frame_uid},
        {"gen_time", frame->gen_time()},
        {"trigger_time", frame->trigger_time()},
        {"msg_type", frame->msg_type()},
        {"source", frame->source()},
        {"initial_source", frame->initial_source()},
        {"dest", frame->dest()},
        {"data_type", data_type_name(frame->data_type())},
        {"stream_id", frame->stream_id()},
        {"payload_sha256", payload_sha},
    };
    // Verbatim payload text + parsed structure (parsed only when it is valid JSON).
    line["payload_raw"] = payload_raw;
    if (frame->is_json() && !payload_raw.empty()) {
      line["payload"] = nlohmann::json::parse(payload_raw, nullptr, /*allow_exceptions=*/false);
    }

    jsonl += line.dump();
    jsonl += "\n";

    event_digests.push_back({{"seq", count}, {"frame_uid", frame_uid}, {"payload_sha256", payload_sha}});

    ++count;
    reader.next();
  }

  // Write the event log.
  const std::string jsonl_path = out_prefix + ".jsonl";
  {
    std::ofstream f(jsonl_path, std::ios::binary | std::ios::trunc);
    if (!f) {
      std::cerr << "cannot open output: " << jsonl_path << "\n";
      return 1;
    }
    f.write(jsonl.data(), static_cast<std::streamsize>(jsonl.size()));
  }

  // Whole-segment checksum over exactly the bytes written -- verifiable with
  // `shasum -a 256 <jsonl>`.
  const std::string segment_sha = sha256::hex(jsonl);

  nlohmann::json manifest = {
      {"spec_version", SPEC_VERSION},
      {"format_version", FORMAT_VERSION},
      {"producer", PRODUCER},
      {"platform", {{"os", platform_os()}, {"arch", platform_arch()}}},
      {"hash_algorithm", HASH_ALGORITHM},
      {"source", {{"root", root}, {"mode", "LIVE"}, {"category", "SYSTEM"}, {"group", group}, {"name", name}, {"dest", data::location::PUBLIC}}},
      {"event_count", count},
      {"event_log", {{"path", jsonl_path}, {"segment_sha256", segment_sha}}},
      {"event_checksums", event_digests},
      {"causal_chain_verified", chain_ok},
  };

  // D1 honesty: state exactly what this bundle captures and what it does not.
  manifest["capture_boundary"] = {
      {"completeness", "complete"},
      {"scope", "single_process"},
      {"what_captured",
       {"frame_uid", "trigger_frame_uid (causal parent)", "gen_time", "trigger_time", "msg_type", "source",
        "initial_source", "dest", "data_type", "stream_id", "json_payload_verbatim"}},
      {"what_not_captured",
       {"in_frame_payload_content_hash (design B2, external blob store is future work)",
        "self_describing_schema_registry (msg_type is an opaque int here)",
        "wall_clock_to_external_trusted_time_source", "system_calls / memory / external_io"}},
      {"known_limitations",
       {"Build-time link still depends on the monolithic libkungfu; only the RUNTIME is decoupled "
        "(no master, no bus drain loop, no nng sockets). Pure journal-core extraction is future work.",
        "frame_uid low bits are derived from a per-writer-run nano hash, so uids are stable within a "
        "bundle and across re-reads, but not reproducible across separate write runs (ADR-0010 8.2.3 not adopted)."}},
  };

  const std::string manifest_path = out_prefix + ".manifest.json";
  {
    std::ofstream f(manifest_path, std::ios::binary | std::ios::trunc);
    if (!f) {
      std::cerr << "cannot open output: " << manifest_path << "\n";
      return 1;
    }
    const std::string body = manifest.dump(2);
    f.write(body.data(), static_cast<std::streamsize>(body.size()));
    f.put('\n');
  }

  std::cout << "exported " << count << " events\n"
            << "  jsonl:    " << jsonl_path << "\n"
            << "  manifest: " << manifest_path << "\n"
            << "  segment_sha256: " << segment_sha << "\n"
            << "  causal_chain_verified: " << (chain_ok ? "true" : "false") << "\n";

  // Non-zero exit if the causal chain did not verify or nothing was read, so the
  // driver / CI can gate on it.
  if (count == 0 || !chain_ok) {
    return 1;
  }
  return 0;
}
