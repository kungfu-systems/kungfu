// SPDX-License-Identifier: Apache-2.0
//
// C++ shim for the host-spike probe: the one FFI seam between the Rust host
// shell and libkungfu. Rust calls a single extern "C" entry that
//
//   1. constructs locator / location / io_device — the runtime-layer core
//      init (installs the typed frame dumper + master kv provider, sets up
//      logging, initializes sqlite; see io_device's ctor), and
//   2. writes one frame through a standalone writer (noop bus + noop
//      publisher, the EMBEDDING.md-sanctioned shape) and re-reads it through
//      io_device::open_reader, asserting the payload survived.
//
// Returns 0 on success; nonzero codes identify the failing phase. The shim is
// compiled by build.rs with the sibling core's own compile flags so it matches
// the ABI vintage of the sibling-built libkungfu.dylib it links against.

#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/time.h>

#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using namespace kungfu::yijinjing;
namespace longfist = kungfu::longfist;

namespace {
constexpr int32_t MSG_SPIKE = 20001;
} // namespace

extern "C" int kf_shim_core_init(const char *root_c) {
  try {
    const std::string root(root_c);

    // ── runtime-layer core init ──────────────────────────────────────
    auto locator = std::make_shared<data::locator>(root);
    auto home = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM,
                                            "host_spike", "cpp", locator);
    auto io = std::make_shared<io_device>(home, /*low_latency=*/false, /*lazy=*/true);
    if (!io->get_home() || io->get_home()->name != "cpp") {
      std::fprintf(stderr, "[cpp] io_device init: home mismatch\n");
      return 1;
    }

    // ── journal write + read back (standalone writer, embedding shape) ──
    auto bus = std::make_shared<journal::bus>(false);
    auto publisher = std::make_shared<journal::noop_publisher>();
    auto writer = std::make_shared<journal::writer>(home, data::location::PUBLIC, /*lazy=*/true, publisher,
                                                    /*low_latency=*/false, bus);
    const std::string body = "host-spike-cpp-roundtrip";
    const std::vector<uint8_t> bytes(body.begin(), body.end());
    writer->write_bytes(time::now_in_nano(), MSG_SPIKE, bytes, static_cast<uint32_t>(bytes.size()));

    auto reader = io->open_reader(home, data::location::PUBLIC);
    std::size_t count = 0;
    bool matched = false;
    while (reader->data_available()) {
      auto frame = reader->current_frame();
      if (frame->msg_type() == MSG_SPIKE) {
        std::string payload = frame->data_as_string();
        while (!payload.empty() && payload.back() == '\0') {
          payload.pop_back();
        }
        matched = matched || payload == body;
      }
      ++count;
      reader->next();
    }
    if (count == 0 || !matched) {
      std::fprintf(stderr, "[cpp] journal roundtrip failed (frames=%zu matched=%d)\n", count, matched ? 1 : 0);
      return 2;
    }

    std::printf("[cpp] io_device init + journal roundtrip ok (%zu frame(s), root %s)\n", count, root.c_str());
    return 0;
  } catch (const std::exception &e) {
    std::fprintf(stderr, "[cpp] kf_shim_core_init: %s\n", e.what());
    return 3;
  } catch (...) {
    std::fprintf(stderr, "[cpp] kf_shim_core_init: unknown exception\n");
    return 3;
  }
}
