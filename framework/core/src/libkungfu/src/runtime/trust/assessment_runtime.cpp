// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/trust/assessment_runtime.h>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/trust/assessment_schema.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/time.h>

#include <algorithm>
#include <charconv>
#include <filesystem>
#include <future>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace kungfu::runtime::trust {

namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr uint32_t ASSESSMENT_EVENT_SCHEMA_VERSION = 1;
constexpr const char *ASSESSMENT_NAMESPACE = "trust";
constexpr const char *ASSESSMENT_NAME = "assessment";

struct schema_contract {
  view::schema_handle handle;
  std::string root;
};

struct assessment_record {
  nlohmann::json event = nlohmann::json::object();
  uint64_t frame_uid = 0;
  int64_t frame_gen_time = 0;
};

struct recorded_episode {
  uint64_t episode_id = 0;
  std::vector<nlohmann::json> events = {};
  std::vector<action::record_receipt> receipts = {};
};

std::string content_root(const std::string &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value));
}

const schema_contract &assessment_schema() {
  static const auto contract = [] {
    const auto compiled = view::compile_schema(schema::ASSESSMENT_EVENT_FBS, false);
    if (!compiled.ok) {
      throw std::runtime_error("cannot compile assessment schema: " + compiled.error);
    }
    return schema_contract{view::schema_handle::from_bytes(compiled.bfbs),
                           content_root(std::string(schema::ASSESSMENT_EVENT_FBS))};
  }();
  return contract;
}

bool canonical_root(const std::string &value) {
  if (value.size() != 71 || !value.starts_with("sha256:")) {
    return false;
  }
  return std::all_of(value.begin() + 7, value.end(),
                     [](unsigned char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); });
}

std::string required_text(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty()) {
    throw std::invalid_argument(std::string(field) + " is required");
  }
  return value.at(field).get<std::string>();
}

std::string text_or(const nlohmann::json &value, const char *field, const std::string &fallback = {}) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null()) {
    return fallback;
  }
  if (!value.at(field).is_string()) {
    throw std::invalid_argument(std::string(field) + " must be a string");
  }
  return value.at(field).get<std::string>();
}

int64_t integer_value(const nlohmann::json &value, const char *field, int64_t fallback = 0) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null()) {
    return fallback;
  }
  const auto &item = value.at(field);
  if (item.is_number_unsigned()) {
    const auto parsed = item.get<uint64_t>();
    if (parsed <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
      return static_cast<int64_t>(parsed);
    }
    throw std::invalid_argument(std::string(field) + " exceeds signed integer range");
  }
  if (item.is_number_integer()) {
    return item.get<int64_t>();
  }
  if (item.is_string()) {
    const auto raw = item.get<std::string>();
    int64_t parsed = 0;
    const auto [end, error] = std::from_chars(raw.data(), raw.data() + raw.size(), parsed);
    if (error == std::errc{} && end == raw.data() + raw.size()) {
      return parsed;
    }
  }
  throw std::invalid_argument(std::string(field) + " must be an integer");
}

uint64_t unsigned_value(const nlohmann::json &value, const char *field, uint64_t fallback = 0) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null()) {
    return fallback;
  }
  const auto &item = value.at(field);
  if (item.is_number_unsigned()) {
    return item.get<uint64_t>();
  }
  if (item.is_number_integer()) {
    const auto parsed = item.get<int64_t>();
    if (parsed >= 0) {
      return static_cast<uint64_t>(parsed);
    }
  }
  if (item.is_string()) {
    const auto raw = item.get<std::string>();
    uint64_t parsed = 0;
    const auto [end, error] = std::from_chars(raw.data(), raw.data() + raw.size(), parsed);
    if (error == std::errc{} && end == raw.data() + raw.size()) {
      return parsed;
    }
  }
  throw std::invalid_argument(std::string(field) + " must be a non-negative integer");
}

uint64_t evidence_count(const nlohmann::json &value, const char *field) { return unsigned_value(value, field, 0); }

nlohmann::json string_array(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null()) {
    return nlohmann::json::array();
  }
  if (!value.at(field).is_array()) {
    throw std::invalid_argument(std::string(field) + " must be an array");
  }
  auto result = nlohmann::json::array();
  for (const auto &item : value.at(field)) {
    if (!item.is_string() || item.get<std::string>().empty()) {
      throw std::invalid_argument(std::string(field) + " entries must be non-empty strings");
    }
    result.push_back(item.get<std::string>());
  }
  return result;
}

nlohmann::json normalize_declaration_ref(const nlohmann::json &input, const char *field) {
  if (!input.is_object()) {
    throw std::invalid_argument(std::string(field) + " must be an object");
  }
  nlohmann::json result = {
      {"id", required_text(input, "id")},
      {"version", required_text(input, "version")},
      {"root", required_text(input, "root")},
  };
  if (!canonical_root(result.at("root").get<std::string>())) {
    throw std::invalid_argument(std::string(field) + ".root must be a canonical sha256 root");
  }
  return result;
}

nlohmann::json normalize_declaration_refs(const nlohmann::json &input) {
  if (!input.is_array()) {
    throw std::invalid_argument("fact_surfaces must be an array");
  }
  auto result = nlohmann::json::array();
  for (const auto &item : input) {
    result.push_back(normalize_declaration_ref(item, "fact_surfaces"));
  }
  return result;
}

nlohmann::json normalize_evidence(const nlohmann::json &input) {
  if (!input.is_object()) {
    throw std::invalid_argument("evidence must be an object");
  }
  return {{"canonical_fact_count", evidence_count(input, "canonical_fact_count")},
          {"conflict_count", evidence_count(input, "conflict_count")},
          {"admitted_count", evidence_count(input, "admitted_count")},
          {"unregistered_surface_count", evidence_count(input, "unregistered_surface_count")},
          {"incompatible_schema_count", evidence_count(input, "incompatible_schema_count")},
          {"ambiguous_authority_count", evidence_count(input, "ambiguous_authority_count")},
          {"unverifiable_count", evidence_count(input, "unverifiable_count")}};
}

void require_root(const nlohmann::json &request, const char *field) {
  if (!canonical_root(required_text(request, field))) {
    throw std::invalid_argument(std::string(field) + " must be a canonical sha256 root");
  }
}

nlohmann::json normalize_request(const nlohmann::json &input) {
  if (!input.is_object()) {
    throw std::invalid_argument("assessment request must be an object");
  }
  const auto work_episode_id = unsigned_value(input, "work_episode_id");
  if (work_episode_id == 0) {
    throw std::invalid_argument("work_episode_id is required");
  }
  nlohmann::json request = {
      {"assessment_key", ""},
      {"claim_id", required_text(input, "claim_id")},
      {"claim_type", required_text(input, "claim_type")},
      {"purpose", required_text(input, "purpose")},
      {"work_episode_id", work_episode_id},
      {"work_episode_root", required_text(input, "work_episode_root")},
      {"query_definition_root", required_text(input, "query_definition_root")},
      {"query_proof_root", required_text(input, "query_proof_root")},
      {"contract_world",
       normalize_declaration_ref(input.value("contract_world", nlohmann::json::object()), "contract_world")},
      {"fact_surfaces", normalize_declaration_refs(input.value("fact_surfaces", nlohmann::json::array()))},
      {"policy", normalize_declaration_ref(input.value("policy", nlohmann::json::object()), "policy")},
      {"evidence", normalize_evidence(input.value("evidence", nlohmann::json::object()))},
      {"deadline", integer_value(input, "deadline")},
      {"responsibility", required_text(input, "responsibility")},
      {"residual_risks", string_array(input, "residual_risks")},
  };
  for (const auto *field : {"work_episode_root", "query_definition_root", "query_proof_root"}) {
    require_root(request, field);
  }
  auto key_basis = request;
  key_basis.erase("assessment_key");
  const auto derived_key = content_root(key_basis.dump());
  const auto supplied_key = text_or(input, "assessment_key");
  if (!supplied_key.empty() && supplied_key != derived_key) {
    throw std::invalid_argument("assessment_key does not match the canonical request");
  }
  request["assessment_key"] = derived_key;
  return request;
}

void require_sealed_work_episode(const std::string &runtime_dir, const nlohmann::json &request) {
  yy_storage::episode_manifest_store episodes(runtime_dir);
  const auto inspected = episodes.inspect_typed(unsigned_value(request, "work_episode_id"));
  if (inspected.content_root.status != yy_storage::episode_content_root_status::Verified ||
      !inspected.content_root.computed.has_value()) {
    throw std::invalid_argument("work Episode must have a verified sealed content root");
  }
  const auto &root = *inspected.content_root.computed;
  const auto authoritative_root = root.algorithm + ":" + root.value;
  if (text_or(request, "work_episode_root") != authoritative_root) {
    throw std::invalid_argument("work_episode_root does not match the sealed Episode authority");
  }
}

std::string event_id(const std::string &kind, int64_t system_time, const nlohmann::json &body) {
  return content_root(nlohmann::json{{"kind", kind}, {"system_time", system_time}, {"body", body}}.dump());
}

nlohmann::json event_shell(const std::string &kind, int64_t system_time, const nlohmann::json &body) {
  nlohmann::json event = {{"schema_version", ASSESSMENT_EVENT_SCHEMA_VERSION},
                          {"event_id", event_id(kind, system_time, body)},
                          {"assessment_key", text_or(body, "assessment_key")},
                          {"kind", kind},
                          {"system_time", system_time},
                          {"assessment_episode_id", 0},
                          {"parent_episode_id", unsigned_value(body, "work_episode_id")}};
  if (kind == "AssessmentRequested") {
    event["request"] = body;
  } else if (kind == "AssessmentStarted") {
    event["execution"] = body;
    event["execution"].erase("work_episode_id");
  } else if (kind == "AssessmentCompleted") {
    event["execution"] = body.at("execution");
    event["execution"].erase("work_episode_id");
    event["report"] = body.at("report");
  } else if (kind == "AssessmentInvalidated") {
    event["reason"] = text_or(body, "reason");
    event["changed_root"] = text_or(body, "changed_root");
    event["relevant"] = true;
  } else {
    throw std::invalid_argument("unsupported assessment event kind: " + kind);
  }
  return event;
}

std::vector<uint8_t> encode_event(const nlohmann::json &event) {
  const auto encoded = assessment_schema().handle.encode_json(event.dump());
  if (!encoded.ok) {
    throw std::invalid_argument("assessment event does not match its FlatBuffers owner: " + encoded.error);
  }
  return std::vector<uint8_t>(encoded.bytes.begin(), encoded.bytes.end());
}

std::string action_type_for_kind(const std::string &kind) {
  if (kind == "AssessmentRequested") {
    return "trust.assessment.requested";
  }
  if (kind == "AssessmentStarted") {
    return "trust.assessment.started";
  }
  if (kind == "AssessmentCompleted") {
    return "trust.assessment.completed";
  }
  return "trust.assessment.invalidated";
}

view::action::envelope wrap_event(const nlohmann::json &event, std::vector<uint8_t> payload) {
  view::action::envelope envelope{};
  envelope.action_type = action_type_for_kind(text_or(event, "kind"));
  envelope.schema_ref = {ASSESSMENT_EVENT_SCHEMA_V1, ASSESSMENT_EVENT_SCHEMA_VERSION};
  envelope.payload =
      view::action::payload_view{view::action::payload_encoding::FlatBuffers,           std::move(payload), {}, {}, 0,
                                 "application/vnd.kungfu.assessment-event+flatbuffers", "present"};
  return envelope;
}

recorded_episode append_episode(const std::string &runtime_dir, std::vector<nlohmann::json> events, int64_t system_time,
                                uint64_t parent_episode_id, const std::string &title,
                                const std::string &journal_name = ASSESSMENT_NAME) {
  action::action_recorder recorder(runtime_dir, ASSESSMENT_NAMESPACE, journal_name);
  yy_storage::episode_manifest_store episodes(runtime_dir);
  yy_storage::episode_begin_options begin_options{};
  begin_options.parent_episode_id = parent_episode_id;
  begin_options.location_uid = recorder.get_location()->uid;
  begin_options.begin_time = system_time;
  begin_options.title = title;
  begin_options.actor = "libkungfu";
  begin_options.source = "adr-0052-assessment-runtime";
  const auto opened = episodes.begin(begin_options);

  recorded_episode result;
  result.episode_id = opened.episode_id;
  for (auto &event : events) {
    event["assessment_episode_id"] = result.episode_id;
    event["parent_episode_id"] = parent_episode_id;
    const auto envelope = wrap_event(event, encode_event(event));
    action::record_options options{};
    options.gen_time = integer_value(event, "system_time", system_time);
    const auto receipt = recorder.record_action(envelope, options);
    yy_storage::episode_frame_attach_options attached{};
    attached.episode_id = result.episode_id;
    attached.location_uid = receipt.source;
    attached.frame_uid = receipt.frame_uid;
    attached.trigger_frame_uid = receipt.trigger_frame_uid;
    attached.stream_id = receipt.stream_id;
    attached.gen_time = receipt.gen_time;
    attached.trigger_time = receipt.trigger_time;
    attached.carrier_type = receipt.carrier_type;
    attached.source = receipt.source;
    attached.dest = receipt.dest;
    attached.data_length = receipt.data_length;
    attached.integrity_version = receipt.integrity_version;
    attached.payload_checksum = receipt.payload_checksum;
    attached.frame_checksum = receipt.frame_checksum;
    (void)episodes.attach_frame(attached);
    result.events.push_back(event);
    result.receipts.push_back(receipt);
  }

  yy_storage::episode_ref_attach_options schema_ref{};
  schema_ref.episode_id = result.episode_id;
  schema_ref.location_uid = recorder.get_location()->uid;
  schema_ref.ref_kind = yy::enums::EpisodeRefKind::Schema;
  schema_ref.update_time = system_time;
  schema_ref.ref_id = ASSESSMENT_EVENT_SCHEMA_V1;
  schema_ref.ref_hash = assessment_schema().root;
  (void)episodes.attach_ref(schema_ref);

  yy_storage::episode_ref_attach_options parent_ref{};
  parent_ref.episode_id = result.episode_id;
  parent_ref.location_uid = recorder.get_location()->uid;
  parent_ref.ref_kind = yy::enums::EpisodeRefKind::Episode;
  parent_ref.ref_uid = parent_episode_id;
  parent_ref.update_time = system_time;
  parent_ref.ref_id = "work-episode";
  (void)episodes.attach_ref(parent_ref);

  yy_storage::episode_close_options close_options{};
  close_options.episode_id = result.episode_id;
  close_options.location_uid = recorder.get_location()->uid;
  close_options.status = yy::enums::EpisodeStatus::Ended;
  close_options.end_time = system_time;
  close_options.last_frame_uid = result.receipts.back().frame_uid;
  close_options.frame_count = result.receipts.size();
  close_options.reason = "assessment lifecycle recorded";
  (void)episodes.end(close_options);
  return result;
}

std::vector<assessment_record> read_location_events(const std::string &runtime_dir, const std::string &journal_name) {
  std::vector<assessment_record> records;
  const auto journal_dir =
      std::filesystem::path(runtime_dir) / "journal" / "system" / ASSESSMENT_NAMESPACE / journal_name / "live";
  if (!std::filesystem::exists(journal_dir)) {
    return records;
  }
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  ASSESSMENT_NAMESPACE, journal_name, locator);
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value()) {
          throw std::runtime_error("cannot decode assessment action envelope: " + error);
        }
        if (envelope->schema_ref.id == ASSESSMENT_EVENT_SCHEMA_V1 &&
            envelope->schema_ref.version == ASSESSMENT_EVENT_SCHEMA_VERSION && envelope->payload.has_value() &&
            envelope->payload->encoding == view::action::payload_encoding::FlatBuffers) {
          const auto &payload = envelope->payload->data;
          const auto decoded = assessment_schema().handle.decode_json(payload.data(), payload.size());
          if (!decoded.ok) {
            throw std::runtime_error("cannot decode assessment event: " + decoded.error);
          }
          records.push_back({nlohmann::json::parse(decoded.json), frame->frame_uid(), frame->gen_time()});
        }
      }
      reader.next();
    }
  } catch (const yy::journal::assemble_exception &) {
    return {};
  } catch (const std::runtime_error &error) {
    if (std::string(error.what()).find("no page for current journal") != std::string::npos) {
      return {};
    }
    throw;
  }
  return records;
}

std::string assessor_journal_name(const std::string &assessment_key, const std::string &executor_profile) {
  return "assessor-" + assessment_key.substr(7, 16) + "-" + executor_profile;
}

std::vector<assessment_record> read_events(const std::string &runtime_dir, const std::string &assessment_key = {}) {
  auto records = read_location_events(runtime_dir, ASSESSMENT_NAME);
  if (canonical_root(assessment_key)) {
    for (const auto *profile : {"inline", "thread", "process"}) {
      auto result_records = read_location_events(runtime_dir, assessor_journal_name(assessment_key, profile));
      records.insert(records.end(), std::make_move_iterator(result_records.begin()),
                     std::make_move_iterator(result_records.end()));
    }
    std::sort(records.begin(), records.end(), [](const auto &left, const auto &right) {
      if (left.frame_gen_time != right.frame_gen_time) {
        return left.frame_gen_time < right.frame_gen_time;
      }
      return left.frame_uid < right.frame_uid;
    });
  }
  return records;
}

std::string request_key(const nlohmann::json &event) {
  const auto event_key = text_or(event, "assessment_key");
  if (!event_key.empty()) {
    return event_key;
  }
  if (event.contains("request") && event.at("request").is_object()) {
    return text_or(event.at("request"), "assessment_key");
  }
  if (event.contains("execution") && event.at("execution").is_object()) {
    return text_or(event.at("execution"), "assessment_key");
  }
  if (event.contains("report") && event.at("report").is_object()) {
    return text_or(event.at("report"), "assessment_key");
  }
  return {};
}

std::string state_edge_name(const std::string &wire) {
  if (wire == "Pending")
    return "pending";
  if (wire == "Running")
    return "running";
  if (wire == "Fresh")
    return "fresh";
  if (wire == "Stale")
    return "stale";
  if (wire == "InsufficientEvidence")
    return "insufficient-evidence";
  if (wire == "Conflicted")
    return "conflicted";
  if (wire == "Unverifiable")
    return "unverifiable";
  if (wire == "FailedRetryable")
    return "failed-retryable";
  throw std::invalid_argument("unsupported assessment state: " + wire);
}

std::string state_wire_name(const nlohmann::json &evidence) {
  if (evidence_count(evidence, "conflict_count") != 0) {
    return "Conflicted";
  }
  if (evidence_count(evidence, "canonical_fact_count") == 0) {
    return "InsufficientEvidence";
  }
  if (evidence_count(evidence, "unregistered_surface_count") != 0 ||
      evidence_count(evidence, "incompatible_schema_count") != 0 ||
      evidence_count(evidence, "ambiguous_authority_count") != 0 ||
      evidence_count(evidence, "unverifiable_count") != 0) {
    return "Unverifiable";
  }
  return "Fresh";
}

nlohmann::json build_report(const nlohmann::json &request) {
  nlohmann::json report = {{"assessment_key", request.at("assessment_key")},
                           {"claim_id", request.at("claim_id")},
                           {"claim_type", request.at("claim_type")},
                           {"purpose", request.at("purpose")},
                           {"state", state_wire_name(request.at("evidence"))},
                           {"work_episode_id", request.at("work_episode_id")},
                           {"work_episode_root", request.at("work_episode_root")},
                           {"query_definition_root", request.at("query_definition_root")},
                           {"query_proof_root", request.at("query_proof_root")},
                           {"contract_world", request.at("contract_world")},
                           {"fact_surfaces", request.at("fact_surfaces")},
                           {"policy", request.at("policy")},
                           {"evidence", request.at("evidence")},
                           {"responsibility", request.at("responsibility")},
                           {"residual_risks", request.at("residual_risks")},
                           {"deterministic", true},
                           {"report_hash", ""}};
  auto hash_basis = report;
  hash_basis.erase("report_hash");
  report["report_hash"] = content_root(hash_basis.dump());
  return report;
}

nlohmann::json edge_report(nlohmann::json report) {
  report["state"] = state_edge_name(text_or(report, "state"));
  return report;
}

bool report_depends_on(const nlohmann::json &report, const std::string &root) {
  if (!canonical_root(root)) {
    return false;
  }
  for (const auto *field : {"work_episode_root", "query_definition_root", "query_proof_root"}) {
    if (text_or(report, field) == root) {
      return true;
    }
  }
  for (const auto *field : {"contract_world", "policy"}) {
    if (report.contains(field) && report.at(field).is_object() && text_or(report.at(field), "root") == root) {
      return true;
    }
  }
  if (report.contains("fact_surfaces") && report.at("fact_surfaces").is_array()) {
    for (const auto &surface : report.at("fact_surfaces")) {
      if (surface.is_object() && text_or(surface, "root") == root) {
        return true;
      }
    }
  }
  return false;
}

} // namespace

nlohmann::json assessment_contract_json() {
  return {{"schema", ASSESSMENT_CONTRACT_V1},
          {"owner", "libkungfu"},
          {"schema_owner", "flatbuffers"},
          {"event_schema", ASSESSMENT_EVENT_SCHEMA_V1},
          {"schema_root", assessment_schema().root},
          {"journal",
           {{"namespace", ASSESSMENT_NAMESPACE},
            {"request_name", ASSESSMENT_NAME},
            {"result_name_pattern", "assessor-<assessment-key-prefix>-<executor-profile>"}}},
          {"states", nlohmann::json::array({"pending", "running", "fresh", "stale", "insufficient-evidence",
                                            "conflicted", "unverifiable", "failed-retryable"})},
          {"executor_profiles", nlohmann::json::array({"inline", "thread", "process"})},
          {"deduplication", "canonical assessment_key"},
          {"result_model", "dependent immutable Assessment Episode"},
          {"known_limits", nlohmann::json::array({"single coordinator for the request journal",
                                                  "built-in deterministic evidence-summary assessor only"})}};
}

nlohmann::json request_assessment(const std::string &runtime_dir, const nlohmann::json &request, int64_t system_time) {
  const auto normalized = normalize_request(request);
  require_sealed_work_episode(runtime_dir, normalized);
  const auto key = text_or(normalized, "assessment_key");
  for (const auto &record : read_events(runtime_dir)) {
    if (record.event.contains("request") && request_key(record.event) == key) {
      return {{"schema", ASSESSMENT_CONTRACT_V1},
              {"assessment_key", key},
              {"state", "pending"},
              {"request", record.event.at("request")},
              {"assessment_episode_id", unsigned_value(record.event, "assessment_episode_id")},
              {"parent_episode_id", unsigned_value(record.event, "parent_episode_id")},
              {"reused", true}};
    }
  }
  const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
  const auto parent_id = unsigned_value(normalized, "work_episode_id");
  const auto recorded = append_episode(runtime_dir, {event_shell("AssessmentRequested", event_time, normalized)},
                                       event_time, parent_id, "assessment request " + key);
  return {{"schema", ASSESSMENT_CONTRACT_V1},
          {"assessment_key", key},
          {"state", "pending"},
          {"request", normalized},
          {"assessment_episode_id", recorded.episode_id},
          {"parent_episode_id", parent_id},
          {"reused", false}};
}

nlohmann::json execute_assessment(const std::string &runtime_dir, const std::string &assessment_key,
                                  const std::string &executor_profile, int64_t system_time) {
  if (!canonical_root(assessment_key)) {
    throw std::invalid_argument("assessment_key must be a canonical sha256 root");
  }
  if (executor_profile != "inline" && executor_profile != "thread" && executor_profile != "process") {
    throw std::invalid_argument("executor_profile must be inline, thread, or process");
  }
  const auto caller_thread = std::this_thread::get_id();
  const auto execute_once = [&]() -> nlohmann::json {
    nlohmann::json request;
    nlohmann::json prior_execution;
    nlohmann::json prior_report;
    uint64_t prior_episode_id = 0;
    uint64_t prior_parent_id = 0;
    bool invalidated = false;
    uint32_t prior_attempts = 0;
    for (const auto &record : read_events(runtime_dir, assessment_key)) {
      if (request_key(record.event) != assessment_key) {
        continue;
      }
      if (record.event.contains("request") && record.event.at("request").is_object()) {
        request = record.event.at("request");
      }
      if (record.event.contains("execution") && record.event.at("execution").is_object()) {
        prior_execution = record.event.at("execution");
        prior_attempts =
            std::max(prior_attempts, static_cast<uint32_t>(unsigned_value(record.event.at("execution"), "attempt")));
      }
      if (record.event.contains("report") && record.event.at("report").is_object()) {
        prior_report = record.event.at("report");
        prior_episode_id = unsigned_value(record.event, "assessment_episode_id");
        prior_parent_id = unsigned_value(record.event, "parent_episode_id");
        invalidated = false;
      }
      if (text_or(record.event, "kind") == "AssessmentInvalidated") {
        invalidated = true;
      }
    }
    if (!request.is_object()) {
      throw std::invalid_argument("assessment request not found");
    }
    require_sealed_work_episode(runtime_dir, request);
    if (prior_report.is_object()) {
      return {{"schema", ASSESSMENT_CONTRACT_V1},
              {"assessment_key", assessment_key},
              {"state", invalidated ? "stale" : state_edge_name(text_or(prior_report, "state"))},
              {"report", edge_report(prior_report)},
              {"execution", prior_execution},
              {"assessment_episode_id", prior_episode_id},
              {"parent_episode_id", prior_parent_id},
              {"reused", true}};
    }
    const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
    const auto attempt = prior_attempts + 1;
    const auto report = build_report(request);
    nlohmann::json started = {{"assessment_key", assessment_key},
                              {"executor_profile", executor_profile},
                              {"separate_thread_dispatch", std::this_thread::get_id() != caller_thread},
                              {"state", "Running"},
                              {"attempt", attempt},
                              {"started_at", event_time},
                              {"finished_at", 0},
                              {"failure_reason", ""},
                              {"work_episode_id", request.at("work_episode_id")}};
    nlohmann::json completed = started;
    completed["state"] = report.at("state");
    completed["finished_at"] = event_time;
    nlohmann::json completed_body = {
        {"execution", completed}, {"report", report}, {"work_episode_id", request.at("work_episode_id")}};
    const auto recorded =
        append_episode(runtime_dir,
                       {event_shell("AssessmentStarted", event_time, started),
                        event_shell("AssessmentCompleted", event_time, completed_body)},
                       event_time, unsigned_value(request, "work_episode_id"), "assessment result " + assessment_key,
                       assessor_journal_name(assessment_key, executor_profile));
    return {{"schema", ASSESSMENT_CONTRACT_V1},
            {"assessment_key", assessment_key},
            {"state", state_edge_name(text_or(report, "state"))},
            {"report", edge_report(report)},
            {"execution", completed},
            {"assessment_episode_id", recorded.episode_id},
            {"parent_episode_id", unsigned_value(request, "work_episode_id")},
            {"reused", false}};
  };
  if (executor_profile == "thread") {
    return std::async(std::launch::async, execute_once).get();
  }
  return execute_once();
}

nlohmann::json query_assessment(const std::string &runtime_dir, const std::string &assessment_key) {
  nlohmann::json request;
  nlohmann::json execution;
  nlohmann::json report;
  uint64_t assessment_episode_id = 0;
  uint64_t parent_episode_id = 0;
  bool invalidated = false;
  for (const auto &record : read_events(runtime_dir, assessment_key)) {
    if (request_key(record.event) != assessment_key) {
      continue;
    }
    assessment_episode_id = unsigned_value(record.event, "assessment_episode_id", assessment_episode_id);
    parent_episode_id = unsigned_value(record.event, "parent_episode_id", parent_episode_id);
    if (record.event.contains("request") && record.event.at("request").is_object())
      request = record.event.at("request");
    if (record.event.contains("execution") && record.event.at("execution").is_object())
      execution = record.event.at("execution");
    if (record.event.contains("report") && record.event.at("report").is_object())
      report = record.event.at("report");
    if (text_or(record.event, "kind") == "AssessmentInvalidated")
      invalidated = true;
  }
  if (!request.is_object()) {
    return {{"schema", ASSESSMENT_CONTRACT_V1}, {"assessment_key", assessment_key}, {"found", false}};
  }
  std::string state = "pending";
  if (invalidated)
    state = "stale";
  else if (report.is_object())
    state = state_edge_name(text_or(report, "state"));
  else if (execution.is_object())
    state = state_edge_name(text_or(execution, "state"));
  nlohmann::json result = {{"schema", ASSESSMENT_CONTRACT_V1},
                           {"assessment_key", assessment_key},
                           {"found", true},
                           {"state", state},
                           {"request", request},
                           {"assessment_episode_id", assessment_episode_id},
                           {"parent_episode_id", parent_episode_id}};
  if (execution.is_object())
    result["execution"] = execution;
  if (report.is_object())
    result["report"] = edge_report(report);
  return result;
}

nlohmann::json list_assessments(const std::string &runtime_dir) {
  std::vector<std::string> keys;
  for (const auto &record : read_events(runtime_dir)) {
    const auto key = request_key(record.event);
    if (!key.empty() && std::find(keys.begin(), keys.end(), key) == keys.end()) {
      keys.push_back(key);
    }
  }
  auto assessments = nlohmann::json::array();
  for (const auto &key : keys) {
    assessments.push_back(query_assessment(runtime_dir, key));
  }
  return {{"schema", ASSESSMENT_CONTRACT_V1}, {"assessments", assessments}, {"assessment_count", assessments.size()}};
}

nlohmann::json invalidate_assessment(const std::string &runtime_dir, const std::string &assessment_key,
                                     const std::string &changed_root, const std::string &reason, int64_t system_time) {
  if (!canonical_root(assessment_key) || !canonical_root(changed_root)) {
    throw std::invalid_argument("assessment_key and changed_root must be canonical sha256 roots");
  }
  const auto status = query_assessment(runtime_dir, assessment_key);
  if (!status.value("found", false) || !status.contains("report") || !status.at("report").is_object()) {
    return {{"schema", ASSESSMENT_CONTRACT_V1},
            {"assessment_key", assessment_key},
            {"invalidated", false},
            {"relevant", false},
            {"reason", "assessment-report-not-found"}};
  }
  if (!report_depends_on(status.at("report"), changed_root)) {
    return {{"schema", ASSESSMENT_CONTRACT_V1},
            {"assessment_key", assessment_key},
            {"invalidated", false},
            {"relevant", false},
            {"state", status.at("state")}};
  }
  if (text_or(status, "state") == "stale") {
    return {{"schema", ASSESSMENT_CONTRACT_V1},
            {"assessment_key", assessment_key},
            {"invalidated", false},
            {"relevant", true},
            {"state", "stale"},
            {"reused", true}};
  }
  const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
  nlohmann::json body = {{"assessment_key", assessment_key},
                         {"work_episode_id", unsigned_value(status.at("request"), "work_episode_id")},
                         {"changed_root", changed_root},
                         {"reason", reason.empty() ? "assessment dependency changed" : reason}};
  const auto recorded =
      append_episode(runtime_dir, {event_shell("AssessmentInvalidated", event_time, body)}, event_time,
                     unsigned_value(body, "work_episode_id"), "assessment invalidation " + assessment_key);
  return {{"schema", ASSESSMENT_CONTRACT_V1},
          {"assessment_key", assessment_key},
          {"invalidated", true},
          {"relevant", true},
          {"state", "stale"},
          {"assessment_episode_id", recorded.episode_id}};
}

nlohmann::json require_trust(const std::string &runtime_dir, const std::string &assessment_key,
                             const std::string &purpose) {
  const auto status = query_assessment(runtime_dir, assessment_key);
  if (!status.value("found", false)) {
    return {{"schema", ASSESSMENT_CONTRACT_V1}, {"allowed", false}, {"reason", "assessment-not-found"}};
  }
  if (text_or(status, "state") != "fresh") {
    return {{"schema", ASSESSMENT_CONTRACT_V1},
            {"allowed", false},
            {"reason", "assessment-not-fresh"},
            {"state", status.at("state")}};
  }
  if (!status.contains("report") || text_or(status.at("report"), "purpose") != purpose) {
    return {{"schema", ASSESSMENT_CONTRACT_V1}, {"allowed", false}, {"reason", "purpose-mismatch"}};
  }
  return {{"schema", ASSESSMENT_CONTRACT_V1},
          {"allowed", true},
          {"reason", "fresh-assessment"},
          {"assessment_key", assessment_key},
          {"report_hash", status.at("report").at("report_hash")}};
}

} // namespace kungfu::runtime::trust
