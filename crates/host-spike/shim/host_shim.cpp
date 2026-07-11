// SPDX-License-Identifier: Apache-2.0
//
// Fixture-only helper for the host-spike. It deliberately does not expose a
// reader or lifecycle seam: Rust reads the frame through the same versioned
// libkungfu C ABI table that the native KFX probe consumes.
//
// Returns 0 on success; nonzero codes identify the failing phase. The shim is
// compiled by build.rs with the sibling core's own compile flags so it matches
// the ABI vintage of the sibling-built libkungfu.dylib it links against.

#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using namespace kungfu::yijinjing;

namespace {
constexpr int32_t MSG_SPIKE = 20001;
} // namespace

extern "C" int kf_shim_seed_fixture(const char *root_c) {
  try {
    const std::string root(root_c);

    auto locator = std::make_shared<data::locator>(root);
    auto home =
        data::location::make_shared(enums::mode::LIVE, enums::location_role::SYSTEM, "host_spike", "cpp", locator);
    auto bus = std::make_shared<journal::bus>(false);
    auto publisher = std::make_shared<journal::noop_publisher>();
    auto writer = std::make_shared<journal::writer>(home, data::location::PUBLIC, /*lazy=*/true, publisher,
                                                    /*low_latency=*/false, bus);
    const std::string body = "host-spike-cpp-roundtrip";
    const std::vector<uint8_t> bytes(body.begin(), body.end());
    writer->write_bytes(time::now_in_nano(), MSG_SPIKE, bytes, static_cast<uint32_t>(bytes.size()));

    std::printf("[cpp] seeded host-spike fixture under %s\n", root.c_str());
    return 0;
  } catch (const std::exception &e) {
    std::fprintf(stderr, "[cpp] kf_shim_seed_fixture: %s\n", e.what());
    return 3;
  } catch (...) {
    std::fprintf(stderr, "[cpp] kf_shim_seed_fixture: unknown exception\n");
    return 3;
  }
}
