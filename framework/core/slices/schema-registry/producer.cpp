// SPDX-License-Identifier: Apache-2.0
//
// Schema-registry slice, write side.
//
// Writes a short causal chain of FlatBuffer events (schema'd) plus one Json
// event (self-describing at the value level), then emits the bundle's format
// pieces next to the journal: content-addressed schema blobs and a run
// manifest with per-run schema bindings. The producer naturally owns its
// schema (generated code); the point of the exercise is that the DECODER does
// not (see decoder.cpp).
//
// Usage: schema_registry_producer <journal-root> <bundle-dir> <schema-version 1|2> <bfbs-path>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

#include "../common/sha256.h"
#include "demo_v1_generated.h"
#include "demo_v2_generated.h"

#include <flatbuffers/flatbuffers.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

using namespace kungfu::yijinjing;
using kungfu::slices::sha256;
namespace longfist = kungfu::longfist;
using longfist::enums::FrameDataType;

namespace {
// docs/msg-type-ranges.md, capability-slice range
constexpr int32_t MSG_DEMO_FB = 20021;
constexpr int32_t MSG_DEMO_JSON = 20022;
constexpr uint64_t STREAM_ID = 1;
constexpr std::size_t FB_EVENT_COUNT = 3;

std::string kind_for(std::size_t step) { return step % 2 == 0 ? "observe" : "act"; }

std::string read_file(const std::string &path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("cannot read " + path);
  }
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
} // namespace

int main(int argc, char **argv) {
  if (argc < 5) {
    std::cerr << "usage: schema_registry_producer <journal-root> <bundle-dir> <schema-version 1|2> <bfbs-path>\n";
    return 2;
  }
  const std::string root = argv[1];
  const std::filesystem::path bundle = argv[2];
  const int version = std::stoi(argv[3]);
  const std::string bfbs_path = argv[4];

  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM,
                                              "schema_registry_slice", "producer", locator);
  auto bus = std::make_shared<journal::bus>(false);
  auto publisher = std::make_shared<journal::noop_publisher>();
  auto writer = std::make_shared<journal::writer>(location, data::location::PUBLIC, /*lazy=*/true, publisher,
                                                  /*low_latency=*/false, bus);

  uint64_t prev_uid = 0;
  int64_t prev_gen_time = 0;
  auto append = [&](int32_t msg_type, FrameDataType data_type, const void *bytes, std::size_t len) {
    bus->set_trigger_frame_uid(prev_uid);
    const int64_t gen_time = time::now_in_nano();
    auto frame = writer->open_frame(prev_gen_time, msg_type, len, STREAM_ID);
    frame->set_data_type(data_type);
    std::memcpy(const_cast<void *>(frame->data_address()), bytes, len);
    prev_uid = writer->current_frame_uid();
    writer->close_frame(len, gen_time);
    prev_gen_time = gen_time;
  };

  // FB events: built with the generated code for the requested schema version.
  for (std::size_t i = 0; i < FB_EVENT_COUNT; ++i) {
    flatbuffers::FlatBufferBuilder fbb;
    if (version == 1) {
      fbb.Finish(slices::demo::v1::CreateSmokeEventDirect(fbb, static_cast<uint32_t>(i), kind_for(i).c_str()));
    } else {
      fbb.Finish(slices::demo::v2::CreateSmokeEventDirect(fbb, static_cast<uint32_t>(i), kind_for(i).c_str(),
                                                          "added in v2"));
    }
    append(MSG_DEMO_FB, FrameDataType::Raw, fbb.GetBufferPointer(), fbb.GetSize());
  }

  // One Json event: self-describing at the value level; the binding records it
  // as schema_kind=json (registered, not schema-verified in v0).
  const std::string json_body = nlohmann::json{{"step", FB_EVENT_COUNT}, {"kind", "summary"}}.dump();
  append(MSG_DEMO_JSON, FrameDataType::Json, json_body.data(), json_body.size());

  // ── bundle format pieces ──────────────────────────────────────────
  // Schema blob, content-addressed: schemas/<sha256>.bfbs
  const std::string bfbs = read_file(bfbs_path);
  const std::string schema_hash = sha256::hex(bfbs);
  std::filesystem::create_directories(bundle / "schemas");
  {
    std::ofstream out(bundle / "schemas" / (schema_hash + ".bfbs"), std::ios::binary);
    out.write(bfbs.data(), static_cast<std::streamsize>(bfbs.size()));
  }

  // Run manifest with the per-run schema bindings. One msg_type binds to one
  // schema per run; evolution happens between runs.
  nlohmann::json manifest = {
      {"spec_version", "0.1"},
      {"source",
       {{"root", root},
        {"mode", "LIVE"},
        {"category", "SYSTEM"},
        {"group", "schema_registry_slice"},
        {"name", "producer"},
        {"dest", data::location::PUBLIC}}},
      {"hash_algorithm", "sha256"},
      {"schema_bindings",
       {{std::to_string(MSG_DEMO_FB),
         {{"schema_kind", "flatbuffers"},
          {"name", "SmokeEvent"},
          {"schema_version", version},
          {"schema_hash", schema_hash}}},
        {std::to_string(MSG_DEMO_JSON),
         {{"schema_kind", "json"}, {"name", "RunSummary"}, {"schema_version", 1}}}}},
      {"capture_boundary",
       "schema bindings cover this run's FB and Json events only; legacy closed-set POD frames "
       "are not decodable from the bundle and are out of scope by design"},
  };
  {
    std::ofstream out(bundle / "manifest.json");
    out << manifest.dump(2) << std::endl;
  }

  std::cout << "OK: wrote " << FB_EVENT_COUNT << " FB events (schema v" << version
            << ", hash " << schema_hash.substr(0, 12) << "...) + 1 Json event; bundle at " << bundle << std::endl;
  return 0;
}
