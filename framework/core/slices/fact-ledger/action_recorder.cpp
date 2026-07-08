// SPDX-License-Identifier: Apache-2.0
//
// C++ action_recorder smoke: record a causal chain through the core recorder,
// reopen it with assemble, and verify receipts against the journal bytes.

#include <kungfu/yijinjing/action_recorder.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/assemble.h>

#include <nlohmann/json.hpp>

#include "../common/sha256.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

using namespace kungfu::yijinjing;
namespace longfist = kungfu::longfist;
using kungfu::slices::sha256;

namespace {
constexpr int32_t MSG_ACTION = 20031;
constexpr uint64_t STREAM_ID = 7001;

std::vector<uint8_t> bytes_for_step(std::size_t step) {
  nlohmann::json payload = {
      {"schema", "kungfu.fact-ledger-action/v1"},
      {"step", step},
      {"action_type", "slice.fact.record"},
  };
  const std::string text = payload.dump();
  return {text.begin(), text.end()};
}

bool padding_is_zero(const std::vector<uint8_t> &bytes, std::size_t from) {
  return std::all_of(bytes.begin() + static_cast<std::ptrdiff_t>(from), bytes.end(),
                     [](uint8_t value) { return value == 0; });
}

std::string payload_hash(const std::vector<uint8_t> &bytes, std::size_t length) {
  const std::string view{reinterpret_cast<const char *>(bytes.data()), length};
  return sha256::hex(view);
}

void fail(const std::string &message) { std::cerr << "fact_ledger_action_recorder: " << message << "\n"; }
} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: fact_ledger_action_recorder <journal-root-dir> [event-count]\n";
    return 2;
  }

  const std::string root = argv[1];
  const std::size_t n = argc >= 3 ? static_cast<std::size_t>(std::stoul(argv[2])) : 4;
  if (n < 2) {
    fail("event-count must be >= 2");
    return 2;
  }

  const std::string group = "fact_ledger_slice";
  const std::string name = "action_recorder";

  action::action_recorder recorder(root, group, name, data::location::PUBLIC, STREAM_ID);
  std::vector<action::record_receipt> receipts;
  std::vector<std::vector<uint8_t>> payloads;

  for (std::size_t i = 0; i < n; ++i) {
    auto payload = bytes_for_step(i);
    payloads.push_back(payload);
    receipts.push_back(recorder.record_bytes(MSG_ACTION, payload));
  }

  auto locator = std::make_shared<data::locator>(root);
  auto location =
      data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM, group, name, locator);
  journal::assemble reader(location, data::location::PUBLIC, longfist::enums::AssembleMode::Channel, 0);
  auto frames = reader.read_bytes(MSG_ACTION);
  if (frames.size() != receipts.size()) {
    fail("frame count mismatch");
    return 1;
  }

  for (std::size_t i = 0; i < receipts.size(); ++i) {
    const auto &receipt = receipts[i];
    const auto &header = frames[i].first;
    const auto &bytes = frames[i].second;
    const auto expected_parent = i == 0 ? 0 : receipts[i - 1].frame_uid;

    if (receipt.frame_uid != header.frame_uid || receipt.msg_type != header.msg_type ||
        receipt.gen_time != header.gen_time || receipt.stream_id != header.stream_id ||
        receipt.trigger_frame_uid != header.trigger_frame_uid || receipt.trigger_frame_uid != expected_parent ||
        receipt.data_length != payloads[i].size() || bytes.size() < payloads[i].size() ||
        !padding_is_zero(bytes, payloads[i].size()) ||
        payload_hash(bytes, payloads[i].size()) != payload_hash(payloads[i], payloads[i].size())) {
      fail("receipt/readback mismatch at step " + std::to_string(i));
      return 1;
    }
  }

  nlohmann::json out = {
      {"root", root},
      {"group", group},
      {"name", name},
      {"event_count", receipts.size()},
      {"causal_chain_verified", true},
      {"record_surface", "kungfu::yijinjing::action::action_recorder"},
  };
  std::cout << out.dump(2) << "\n";
  return 0;
}
