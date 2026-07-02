// SPDX-License-Identifier: Apache-2.0
//
// Minimal fact-ledger host (write path).
//
// Proves that the journal spine can be embedded in a plain process that starts
// no master, no bus drain loop and no network sockets: it opens a journal
// location with a noop bus + noop publisher, appends N (>= 3) Json events, and
// records a causal chain inside the spine -- event k's trigger_frame_uid points
// at event k-1's frame_uid. The process then exits; an independent tool reopens
// the directory and exports it (see export.cpp).
//
// Usage:  fact_ledger_host <journal-root-dir> [event-count]
//
// The causal parent is fed explicitly through bus::set_trigger_frame_uid before
// each frame is closed. In the live trading runtime this value is set by the
// hero drain loop; here we set it by hand, which is exactly the point of the
// "cut the core out of the runtime" test.

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using namespace kungfu::yijinjing;
namespace longfist = kungfu::longfist;
using longfist::enums::FrameDataType;

namespace {
// Custom message types for this slice, from the capability-slice range
// (docs/msg-type-ranges.md). These are opaque ints on the
// wire; the export tool carries them through verbatim (a real deployment would
// resolve them via a schema registry, which this minimal slice does not build).
constexpr int32_t MSG_OBSERVE = 20011;
constexpr int32_t MSG_DECIDE = 20012;
constexpr int32_t MSG_ACT = 20013;

// One logical run of the causal chain, tagged onto every frame's stream_id so a
// consumer can group a bundle by run.
constexpr uint64_t STREAM_ID = 1;

int32_t msg_type_for_step(std::size_t step) {
  switch (step % 3) {
  case 0:
    return MSG_OBSERVE;
  case 1:
    return MSG_DECIDE;
  default:
    return MSG_ACT;
  }
}

std::string step_kind(std::size_t step) {
  switch (step % 3) {
  case 0:
    return "observe";
  case 1:
    return "decide";
  default:
    return "act";
  }
}
} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: fact_ledger_host <journal-root-dir> [event-count]\n";
    return 2;
  }
  const std::string root = argv[1];
  const std::size_t n = argc >= 3 ? static_cast<std::size_t>(std::stoul(argv[2])) : 3;
  if (n < 3) {
    std::cerr << "event-count must be >= 3 (need a chain to verify)\n";
    return 2;
  }

  // Location identity. A separate reader reconstructs the same identity to
  // reopen the directory, so we print it as JSON for the driver / export tool.
  const std::string group = "fact_ledger_slice";
  const std::string name = "host";

  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM, group, name,
                                              locator);

  // The whole point: a noop bus (no hero/drain loop) and a noop publisher (no
  // nng socket). Nothing here starts the trading runtime.
  auto bus = std::make_shared<journal::bus>(false);
  auto publisher = std::make_shared<journal::noop_publisher>();
  auto writer =
      std::make_shared<journal::writer>(location, data::location::PUBLIC, /*lazy=*/true, publisher,
                                        /*low_latency=*/false, bus);

  uint64_t prev_uid = 0;   // 0 == root cause (no parent) for the first event
  int64_t prev_gen_time = 0;

  std::vector<nlohmann::json> chain; // for a human-readable stderr trace only

  for (std::size_t i = 0; i < n; ++i) {
    nlohmann::json payload = {
        {"step", i},
        {"kind", step_kind(i)},
        {"note", "minimal fact-ledger slice event"},
    };
    const std::string body = payload.dump();

    // Feed the causal parent explicitly, then open/close the frame. close_frame
    // reads this value off the bus and stamps it into trigger_frame_uid.
    bus->set_trigger_frame_uid(prev_uid);

    const int64_t gen_time = time::now_in_nano();
    auto frame = writer->open_frame(/*trigger_time=*/prev_gen_time, msg_type_for_step(i), body.size(), STREAM_ID);
    frame->set_data_type(FrameDataType::Json);
    std::memcpy(const_cast<void *>(frame->data_address()), body.data(), body.size());

    // Capture the uid this frame will be stamped with, BEFORE close_frame's
    // internal next() advances the shared frame object. This is the write-side
    // canonical uid (writer::current_frame_uid), and it is what we feed as the
    // next event's causal parent.
    const uint64_t this_uid = writer->current_frame_uid();
    writer->close_frame(body.size(), gen_time);

    chain.push_back({{"step", i}, {"frame_uid", this_uid}, {"trigger_frame_uid", prev_uid}});
    prev_uid = this_uid;
    prev_gen_time = gen_time;
  }

  // Emit the location identity + the expected chain to stdout so the driver can
  // locate the journal. Authoritative verification is done by the independent
  // export tool re-deriving these from disk, not from this print.
  nlohmann::json out = {
      {"root", root},
      {"mode", "LIVE"},
      {"category", "SYSTEM"},
      {"group", group},
      {"name", name},
      {"dest", data::location::PUBLIC},
      {"event_count", n},
      {"expected_chain", chain},
  };
  std::cout << out.dump(2) << std::endl;
  return 0;
}
