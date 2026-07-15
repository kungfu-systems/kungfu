// SPDX-License-Identifier: Apache-2.0
//
// ADR-0078: the generic decode primitive must read identically on every membrane.
// pybind's decode_flatbuffer_payload_json opts into the integer enum form and takes
// an object_name table selector; these tests pin the C ABI decode_frame_json (and
// therefore its Rust mirror, which only forwards) to the same two contract points.
//
// The oracle is the C++ authority itself: each membrane decode is compared against
// schema_handle::decode_json with the contract arguments, and against the identifier
// form it must NOT produce — so the fixture proves it actually discriminates rather
// than passing vacuously.
#include <kungfu/embedding.h>
#include <kungfu/view/schema.h>

#include <chrono>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using kungfu::view::schema_handle;

namespace {

// A byte enum + a string, mirroring the shape the reflection decoders read: the
// identifier form renders side as "SELL", the integer form as 1.
constexpr const char *ORDER_FBS = "enum Side : byte { BUY = 0, SELL = 1 }\n"
                                  "table Order { id: long; side: Side; sym: string; }\n"
                                  "root_type Order;\n";

// The same two tables under two different root_type declarations. Encoding runs
// through the Event-rooted schema; decoding runs through the Other-rooted one, so
// reaching Event is only possible via object_name — which is exactly the multi-table
// bundle shape rewind decodes (its event tables are not the .bfbs root).
constexpr const char *EVENT_ROOT_FBS = "enum Side : byte { BUY = 0, SELL = 1 }\n"
                                       "table Event { seq: long; side: Side; }\n"
                                       "table Other { note: string; }\n"
                                       "root_type Event;\n";
constexpr const char *OTHER_ROOT_FBS = "enum Side : byte { BUY = 0, SELL = 1 }\n"
                                       "table Event { seq: long; side: Side; }\n"
                                       "table Other { note: string; }\n"
                                       "root_type Other;\n";

void require(bool condition, const std::string &message) {
  if (not condition) {
    throw std::runtime_error(message);
  }
}

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-embedding-codec-test-" + std::to_string(nonce));
    fs::create_directories(root_);
  }

  ~temp_tree() {
    std::error_code ignored;
    fs::remove_all(root_, ignored);
  }

  temp_tree(const temp_tree &) = delete;
  temp_tree &operator=(const temp_tree &) = delete;

  [[nodiscard]] std::string root() const { return root_.string(); }

private:
  fs::path root_;
};

std::string compile(const char *fbs_text) {
  auto compiled = kungfu::view::compile_schema(fbs_text, false);
  require(compiled.ok, "test fixture schema failed to compile: " + compiled.error);
  return compiled.bfbs;
}

// The membrane is live-context gated, so every decode needs a context even though
// the decode itself is generic (schema + frame only).
class membrane {
public:
  membrane() {
    const auto status = kungfu_embedding_get_api(KF_EMBEDDING_ABI_V3, sizeof(api_), &api_);
    require(status == KF_EMBEDDING_OK && api_.abi_version == KF_EMBEDDING_ABI_V3,
            "ABI v3 negotiation failed: " + std::to_string(status));
    require((api_.capabilities & KF_EMBEDDING_CAP_GENERIC_CODEC) != 0 && api_.decode_frame_json != nullptr,
            "ABI v3 did not advertise the generic-codec surface");
    root_ = tree_.root();
    config_.struct_size = sizeof(config_);
    config_.root = root_.c_str();
    config_.host_namespace = "embedding_codec_tests";
    config_.host_name = "fixture";
    config_.mode = KF_EMBEDDING_MODE_LIVE;
    require(api_.context_open(&config_, &context_) == KF_EMBEDDING_OK, "context_open failed");
  }

  ~membrane() {
    if (context_ != nullptr) {
      api_.context_close(context_);
    }
  }

  membrane(const membrane &) = delete;
  membrane &operator=(const membrane &) = delete;

  // Decode through the C ABI and hand back the JSON as an owned copy, releasing the
  // membrane's blob so the report lifetime never leaks into an assertion.
  [[nodiscard]] std::string decode(const std::string &bfbs, const std::string &frame, const char *object_name) const {
    kf_embedding_report_v1 report{};
    report.struct_size = sizeof(report);
    const auto status =
        api_.decode_frame_json(context_, reinterpret_cast<const uint8_t *>(bfbs.data()), bfbs.size(),
                               reinterpret_cast<const uint8_t *>(frame.data()), frame.size(), object_name, &report);
    require(status == KF_EMBEDDING_OK, "decode_frame_json failed: " + std::to_string(status));
    require(report.ok == 1 && report.format == KF_EMBEDDING_REPORT_FORMAT_JSON, "decode report is not ok JSON");
    std::string json(reinterpret_cast<const char *>(report.data), static_cast<size_t>(report.data_size));
    require(api_.report_release(&report) == KF_EMBEDDING_OK, "report_release failed");
    return json;
  }

  [[nodiscard]] int32_t decode_status(const std::string &bfbs, const std::string &frame,
                                      const char *object_name) const {
    kf_embedding_report_v1 report{};
    report.struct_size = sizeof(report);
    return api_.decode_frame_json(context_, reinterpret_cast<const uint8_t *>(bfbs.data()), bfbs.size(),
                                  reinterpret_cast<const uint8_t *>(frame.data()), frame.size(), object_name, &report);
  }

  [[nodiscard]] const kf_embedding_api_v3 &api() const { return api_; }
  [[nodiscard]] kf_embedding_context *context() const { return context_; }

private:
  temp_tree tree_;
  std::string root_;
  kf_embedding_api_v3 api_{};
  kf_embedding_context_config_v1 config_{};
  kf_embedding_context *context_ = nullptr;
};

std::string encode(const std::string &bfbs, const std::string &json) {
  auto encoded = schema_handle::from_bytes(bfbs).encode_json(json);
  require(encoded.ok, "test fixture frame failed to encode: " + encoded.error);
  return encoded.bytes;
}

// The membrane decodes enums as integers, matching pybind and the three reflection
// decoders — not as the schema identifiers the domain-runtime consumers still use.
void test_decode_frame_json_emits_integer_enums() {
  const auto bfbs = compile(ORDER_FBS);
  const auto frame = encode(bfbs, R"({"id": 7, "side": "SELL", "sym": "KF"})");
  const auto schema = schema_handle::from_bytes(bfbs);
  const auto buf = reinterpret_cast<const uint8_t *>(frame.data());

  const auto integer_form = schema.decode_json(buf, frame.size(), /*enum_as_int=*/true);
  const auto identifier_form = schema.decode_json(buf, frame.size(), /*enum_as_int=*/false);
  require(integer_form.ok && identifier_form.ok, "fixture frame did not decode against its own schema");
  // Guard against a vacuous pass: the fixture must actually distinguish the forms.
  require(integer_form.json != identifier_form.json, "fixture enum does not discriminate the two forms");
  require(identifier_form.json.find("SELL") != std::string::npos, "identifier form lost its enum identifier");
  require(integer_form.json.find("SELL") == std::string::npos, "integer form kept an enum identifier");

  const membrane live;
  const auto json = live.decode(bfbs, frame, nullptr);
  require(json == integer_form.json, "membrane decode did not emit the integer enum form: " + json);
}

// A null/empty object_name means the .bfbs root_type — the existing single-root
// consumers must keep reading exactly as before.
void test_null_and_empty_object_name_decode_the_root() {
  const auto bfbs = compile(ORDER_FBS);
  const auto frame = encode(bfbs, R"({"id": 3, "side": "BUY", "sym": "KF"})");
  const auto expected =
      schema_handle::from_bytes(bfbs).decode_json(reinterpret_cast<const uint8_t *>(frame.data()), frame.size(),
                                                  /*enum_as_int=*/true);
  require(expected.ok, "fixture frame did not decode against its own schema");

  const membrane live;
  require(live.decode(bfbs, frame, nullptr) == expected.json, "null object_name did not decode the root table");
  require(live.decode(bfbs, frame, "") == expected.json, "empty object_name did not decode the root table");
}

// object_name selects a non-root table, so a consumer can read a bundle whose event
// tables are not the root — the case that motivated exposing this on the C ABI at
// all (ADR-0078 Decision 2: the ring closure must hold for Rust and cross-process
// consumers, not only Python).
void test_object_name_selects_a_non_root_table() {
  const auto event_root_bfbs = compile(EVENT_ROOT_FBS);
  const auto other_root_bfbs = compile(OTHER_ROOT_FBS);
  const auto frame = encode(event_root_bfbs, R"({"seq": 11, "side": "SELL"})");

  const auto expected = schema_handle::from_bytes(other_root_bfbs)
                            .decode_json(reinterpret_cast<const uint8_t *>(frame.data()), frame.size(),
                                         /*enum_as_int=*/true, "Event");
  require(expected.ok, "fixture event frame did not decode against the Other-rooted schema");
  require(expected.json.find("11") != std::string::npos, "fixture event frame lost its payload");
  require(expected.json.find("SELL") == std::string::npos, "non-root decode kept an enum identifier");

  const membrane live;
  const auto json = live.decode(other_root_bfbs, frame, "Event");
  require(json == expected.json, "object_name did not select the non-root table: " + json);
}

// An object_name naming no table in the schema must fail closed, not silently fall
// back to the root (which would hand the caller a plausible but wrong decode).
void test_unknown_object_name_fails_closed() {
  const auto bfbs = compile(ORDER_FBS);
  const auto frame = encode(bfbs, R"({"id": 5, "side": "BUY", "sym": "KF"})");

  const membrane live;
  require(live.decode_status(bfbs, frame, "NoSuchTable") == KF_EMBEDDING_CORE_ERROR,
          "unknown object_name did not fail closed");
}

// The added parameter must not weaken the argument guard.
void test_invalid_arguments_are_rejected() {
  const auto bfbs = compile(ORDER_FBS);
  const auto frame = encode(bfbs, R"({"id": 1, "side": "BUY", "sym": "KF"})");
  const membrane live;
  const auto buf = reinterpret_cast<const uint8_t *>(frame.data());
  const auto schema_buf = reinterpret_cast<const uint8_t *>(bfbs.data());
  kf_embedding_report_v1 report{};
  report.struct_size = sizeof(report);

  require(live.api().decode_frame_json(nullptr, schema_buf, bfbs.size(), buf, frame.size(), nullptr, &report) ==
              KF_EMBEDDING_INVALID_ARGUMENT,
          "null context was accepted");
  require(live.api().decode_frame_json(live.context(), nullptr, bfbs.size(), buf, frame.size(), nullptr, &report) ==
              KF_EMBEDDING_INVALID_ARGUMENT,
          "null schema was accepted");
  require(live.api().decode_frame_json(live.context(), schema_buf, 0, buf, frame.size(), nullptr, &report) ==
              KF_EMBEDDING_INVALID_ARGUMENT,
          "zero-length schema was accepted");
  require(live.api().decode_frame_json(live.context(), schema_buf, bfbs.size(), nullptr, frame.size(), nullptr,
                                       &report) == KF_EMBEDDING_INVALID_ARGUMENT,
          "null frame was accepted");
  require(live.api().decode_frame_json(live.context(), schema_buf, bfbs.size(), buf, frame.size(), nullptr, nullptr) ==
              KF_EMBEDDING_INVALID_ARGUMENT,
          "null out_report was accepted");
}

} // namespace

int main() {
  // Report which contract point broke. An uncaught throw here would abort with
  // only "uncaught exception", leaving a CI failure undiagnosable from the log.
  try {
    test_decode_frame_json_emits_integer_enums();
    test_null_and_empty_object_name_decode_the_root();
    test_object_name_selects_a_non_root_table();
    test_unknown_object_name_fails_closed();
    test_invalid_arguments_are_rejected();
  } catch (const std::exception &error) {
    std::fprintf(stderr, "embedding generic-codec contract failed: %s\n", error.what());
    return 1;
  }
  return 0;
}
