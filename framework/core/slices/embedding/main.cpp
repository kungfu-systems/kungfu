// SPDX-License-Identifier: Apache-2.0
//
// Embedding slice: a minimal EXTERNAL consumer of the yijinjing core.
//
// This program is built by a standalone CMake project (see CMakeLists.txt next
// to this file) that pulls the core in with add_subdirectory -- never through
// the kungfu parent build. It writes a short causal chain of Json events with
// a noop bus + noop publisher, closes the writer, reopens the directory with
// assemble, and asserts the chain survived the round trip.
//
// Exit 0 means the embedding contract holds end to end; any other exit means
// the contract regressed.
//
// Usage:  embed_smoke <journal-root-dir>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/assemble.h>
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
constexpr int32_t MSG_SMOKE = 20001;
constexpr uint64_t STREAM_ID = 1;
constexpr std::size_t EVENT_COUNT = 3;

std::string strip_trailing_nuls(std::string s) {
  while (!s.empty() && s.back() == '\0') {
    s.pop_back();
  }
  return s;
}
} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: embed_smoke <journal-root-dir>\n";
    return 2;
  }
  const std::string root = argv[1];
  const std::string group = "embedding_slice";
  const std::string name = "smoke";

  // ── write side ────────────────────────────────────────────────────
  std::vector<uint64_t> written_uids;
  {
    auto locator = std::make_shared<data::locator>(root);
    auto location = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM, group,
                                                name, locator);
    auto bus = std::make_shared<journal::bus>(false);
    auto publisher = std::make_shared<journal::noop_publisher>();
    auto writer = std::make_shared<journal::writer>(location, data::location::PUBLIC, /*lazy=*/true, publisher,
                                                    /*low_latency=*/false, bus);

    uint64_t prev_uid = 0;
    int64_t prev_gen_time = 0;
    for (std::size_t i = 0; i < EVENT_COUNT; ++i) {
      const std::string body = nlohmann::json{{"step", i}, {"note", "embedding smoke"}}.dump();
      bus->set_trigger_frame_uid(prev_uid);
      const int64_t gen_time = time::now_in_nano();
      auto frame = writer->open_frame(/*trigger_time=*/prev_gen_time, MSG_SMOKE, body.size(), STREAM_ID);
      frame->set_data_type(FrameDataType::Json);
      std::memcpy(const_cast<void *>(frame->data_address()), body.data(), body.size());
      const uint64_t this_uid = writer->current_frame_uid();
      writer->close_frame(body.size(), gen_time);
      written_uids.push_back(this_uid);
      prev_uid = this_uid;
      prev_gen_time = gen_time;
    }
  } // writer closed; from here on the process only reads the format

  // ── read side: reconstruct the identity, reopen, assert the chain ──
  auto locator = std::make_shared<data::locator>(root);
  auto location =
      data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM, group, name, locator);
  journal::assemble reader(location, data::location::PUBLIC, longfist::enums::AssembleMode::Channel, 0);

  std::size_t count = 0;
  uint64_t last_uid = 0;
  while (reader.data_available()) {
    auto frame = reader.current_frame();
    const uint64_t frame_uid = frame->frame_uid();
    const uint64_t trigger_frame_uid = frame->trigger_frame_uid();

    if (count >= written_uids.size()) {
      std::cerr << "FAIL: more events read than written\n";
      return 1;
    }
    if (frame_uid != written_uids[count]) {
      std::cerr << "FAIL: event " << count << " frame_uid mismatch (recomputed instead of read back?)\n";
      return 1;
    }
    if (count == 0 ? trigger_frame_uid != 0 : trigger_frame_uid != last_uid) {
      std::cerr << "FAIL: causal chain broken at event " << count << "\n";
      return 1;
    }
    const std::string payload = strip_trailing_nuls(frame->data_as_string());
    const auto parsed = nlohmann::json::parse(payload, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded() || parsed.value("step", SIZE_MAX) != count) {
      std::cerr << "FAIL: payload did not round-trip at event " << count << "\n";
      return 1;
    }
    last_uid = frame_uid;
    ++count;
    reader.next();
  }

  if (count != EVENT_COUNT) {
    std::cerr << "FAIL: wrote " << EVENT_COUNT << " events, read back " << count << "\n";
    return 1;
  }

  std::cout << "OK: embedded core wrote and re-read a " << count << "-event causal chain (root: " << root << ")"
            << std::endl;
  return 0;
}
