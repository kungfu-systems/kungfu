// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/facts/fact_admission.h>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/facts/domain_fact_schema.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/time.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace kungfu::runtime::facts {

namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr uint32_t FACT_EVENT_SCHEMA_VERSION = 1;
constexpr const char *FACT_NAMESPACE = "facts";
constexpr const char *FACT_NAME = "admission";
constexpr auto FACT_WRITER_WAIT_TIMEOUT = std::chrono::milliseconds(5000);

struct schema_contract {
  view::schema_handle handle;
  std::string root;
};

struct fact_record {
  nlohmann::json event = nlohmann::json::object();
  uint64_t frame_uid = 0;
  int64_t frame_gen_time = 0;
};

struct recorded_episode {
  uint64_t episode_id = 0;
  std::vector<nlohmann::json> events = {};
  std::vector<action::record_receipt> receipts = {};
};

struct owned_ref {
  yy::enums::EpisodeRefKind kind = yy::enums::EpisodeRefKind::Payload;
  std::string id = {};
  std::string hash = {};
};

std::string content_root(const std::string &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value));
}

const schema_contract &domain_schema() {
  static const auto contract = [] {
    const auto compiled = view::compile_schema(schema::DOMAIN_FACT_EVENT_FBS, false);
    if (!compiled.ok) {
      throw std::runtime_error("cannot compile domain fact schema: " + compiled.error);
    }
    return schema_contract{view::schema_handle::from_bytes(compiled.bfbs),
                           content_root(std::string(schema::DOMAIN_FACT_EVENT_FBS))};
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
    const auto text = item.get<std::string>();
    int64_t parsed = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (error == std::errc{} && end == text.data() + text.size()) {
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
    if (parsed < 0) {
      throw std::invalid_argument(std::string(field) + " must be non-negative");
    }
    return static_cast<uint64_t>(parsed);
  }
  if (item.is_string()) {
    const auto text = item.get<std::string>();
    uint64_t parsed = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (error == std::errc{} && end == text.data() + text.size()) {
      return parsed;
    }
  }
  throw std::invalid_argument(std::string(field) + " must be a non-negative integer");
}

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

void require_effective_range(const nlohmann::json &declaration) {
  const auto from = integer_value(declaration, "effective_from");
  const auto until = integer_value(declaration, "effective_until");
  if (from < 0 || until < 0 || (until != 0 && until <= from)) {
    throw std::invalid_argument("effective range requires 0 <= from < until, or until=0");
  }
}

bool effective_at(const nlohmann::json &declaration, int64_t system_time) {
  const auto from = integer_value(declaration, "effective_from");
  const auto until = integer_value(declaration, "effective_until");
  return system_time >= from && (until == 0 || system_time < until);
}

nlohmann::json declaration_reference(const nlohmann::json &declaration) {
  return {{"id", declaration.at("id")}, {"version", declaration.at("version")}, {"root", declaration.at("root")}};
}

std::string event_id(const std::string &kind, int64_t system_time, const nlohmann::json &body) {
  return content_root(nlohmann::json{{"kind", kind}, {"system_time", system_time}, {"body", body}}.dump());
}

nlohmann::json event_shell(const std::string &kind, int64_t system_time, const nlohmann::json &body,
                           const std::string &causal_parent = {}) {
  auto event = nlohmann::json{{"schema_version", FACT_EVENT_SCHEMA_VERSION},
                              {"event_id", event_id(kind, system_time, body)},
                              {"kind", kind},
                              {"system_time", system_time},
                              {"causal_parent_event_id", causal_parent},
                              {"episode_id", 0}};
  if (kind == "ContractWorldDeclared") {
    event["contract_world_declaration"] = body;
  } else if (kind == "FactSurfaceDeclared") {
    event["fact_surface_declaration"] = body;
  } else if (kind == "ObservationRecorded") {
    event["observation"] = body;
  } else if (kind == "AdmissionDecided") {
    event["admission"] = body;
  }
  return event;
}

std::vector<uint8_t> encode_event(const nlohmann::json &event) {
  const auto encoded = domain_schema().handle.encode_json(event.dump());
  if (!encoded.ok) {
    throw std::invalid_argument("domain fact event does not match its FlatBuffers owner: " + encoded.error);
  }
  return std::vector<uint8_t>(encoded.bytes.begin(), encoded.bytes.end());
}

std::string action_type_for_kind(const std::string &kind) {
  if (kind == "ContractWorldDeclared") {
    return "facts.contract-world.declared";
  }
  if (kind == "FactSurfaceDeclared") {
    return "facts.fact-surface.declared";
  }
  if (kind == "ObservationRecorded") {
    return "facts.observation.recorded";
  }
  if (kind == "AdmissionDecided") {
    return "facts.admission.decided";
  }
  throw std::invalid_argument("unsupported domain fact event kind: " + kind);
}

view::action::envelope wrap_event(const nlohmann::json &event, std::vector<uint8_t> payload) {
  view::action::envelope envelope{};
  envelope.action_type = action_type_for_kind(text_or(event, "kind"));
  envelope.schema_ref = {DOMAIN_FACT_EVENT_SCHEMA_V1, FACT_EVENT_SCHEMA_VERSION};
  envelope.payload = view::action::payload_view{view::action::payload_encoding::FlatBuffers,
                                                std::move(payload),
                                                {},
                                                {},
                                                0,
                                                "application/vnd.kungfu.domain-fact-event+flatbuffers",
                                                "present"};
  return envelope;
}

std::unique_ptr<action::action_recorder> open_admission_writer(const std::string &runtime_dir) {
  const auto deadline = std::chrono::steady_clock::now() + FACT_WRITER_WAIT_TIMEOUT;
  while (true) {
    try {
      return std::make_unique<action::action_recorder>(runtime_dir, FACT_NAMESPACE, FACT_NAME);
    } catch (const yy::ownership::busy_error &error) {
      if (std::chrono::steady_clock::now() >= deadline) {
        throw std::runtime_error("fact_writer_busy_timeout: fact admission writer remained busy for 5000 ms: " +
                                 std::string(error.what()));
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }
}

recorded_episode append_episode(action::action_recorder &recorder, const std::string &runtime_dir,
                                std::vector<nlohmann::json> events, int64_t system_time, const std::string &title,
                                const std::vector<owned_ref> &owned_refs = {}) {
  yy_storage::episode_manifest_store episodes(runtime_dir);
  yy_storage::episode_begin_options begin_options{};
  begin_options.location_uid = recorder.get_location()->uid;
  begin_options.begin_time = system_time;
  begin_options.title = title;
  begin_options.actor = "libkungfu";
  begin_options.source = "adr-0051-fact-admission";
  const auto episode_id = yy_storage::episode_manifest_store::resolve_episode_id(begin_options);
  begin_options.episode_id = episode_id;
  yy_storage::episode_append_options manifest{};
  manifest.begin = begin_options;

  recorded_episode result;
  result.episode_id = episode_id;
  for (auto &event : events) {
    event["episode_id"] = episode_id;
    const auto binary = encode_event(event);
    const auto envelope = wrap_event(event, binary);
    action::record_options options{};
    options.gen_time = integer_value(event, "system_time", system_time);
    const auto receipt = recorder.record_action(envelope, options);
    yy_storage::episode_frame_attach_options attached{};
    attached.episode_id = episode_id;
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
    manifest.frames.push_back(attached);
    result.events.push_back(event);
    result.receipts.push_back(receipt);
  }

  yy_storage::episode_ref_attach_options schema_ref{};
  schema_ref.episode_id = episode_id;
  schema_ref.location_uid = recorder.get_location()->uid;
  schema_ref.ref_kind = yy::enums::EpisodeRefKind::Schema;
  schema_ref.update_time = system_time;
  schema_ref.ref_id = DOMAIN_FACT_EVENT_SCHEMA_V1;
  schema_ref.ref_hash = domain_schema().root;
  manifest.refs.push_back(schema_ref);

  for (const auto &ref : owned_refs) {
    yy_storage::episode_ref_attach_options content_ref{};
    content_ref.episode_id = episode_id;
    content_ref.location_uid = recorder.get_location()->uid;
    content_ref.ref_kind = ref.kind;
    content_ref.update_time = system_time;
    content_ref.ref_id = ref.id;
    content_ref.ref_hash = ref.hash;
    manifest.refs.push_back(content_ref);
  }

  yy_storage::episode_close_options close_options{};
  close_options.episode_id = episode_id;
  close_options.location_uid = recorder.get_location()->uid;
  close_options.status = yy::enums::EpisodeStatus::Ended;
  close_options.end_time = system_time;
  close_options.last_frame_uid = result.receipts.back().frame_uid;
  close_options.frame_count = result.receipts.size();
  close_options.reason = "fact admission recorded";
  manifest.close = close_options;
  (void)episodes.append(manifest);
  return result;
}

std::vector<fact_record> read_events(const std::string &runtime_dir, int64_t cut_system_time = 0) {
  std::vector<fact_record> records;
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  FACT_NAMESPACE, FACT_NAME, locator);
  if (locator->list_page_id(location, yy::data::location::PUBLIC).empty()) {
    return records;
  }
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE &&
          (cut_system_time == 0 || frame->gen_time() <= cut_system_time)) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value()) {
          throw std::runtime_error("cannot decode fact action envelope: " + error);
        }
        if (envelope->schema_ref.id != DOMAIN_FACT_EVENT_SCHEMA_V1 ||
            envelope->schema_ref.version != FACT_EVENT_SCHEMA_VERSION || !envelope->payload.has_value() ||
            envelope->payload->encoding != view::action::payload_encoding::FlatBuffers) {
          reader.next();
          continue;
        }
        const auto &payload = envelope->payload->data;
        const auto decoded = domain_schema().handle.decode_json(payload.data(), payload.size());
        if (!decoded.ok) {
          throw std::runtime_error("cannot decode domain fact event: " + decoded.error);
        }
        auto event = nlohmann::json::parse(decoded.json);
        records.push_back({std::move(event), frame->frame_uid(), frame->gen_time()});
      }
      reader.next();
    }
  } catch (const yy::journal::assemble_exception &) {
    return {};
  }
  return records;
}

std::string enum_name(const nlohmann::json &value, const char *field) {
  const auto name = text_or(value, field);
  if (!name.empty()) {
    return name;
  }
  return {};
}

std::string action_edge_name(const nlohmann::json &observation) {
  const auto name = enum_name(observation, "action");
  if (name == "Assert" || name == "assert") {
    return "assert";
  }
  if (name == "Correct" || name == "correct") {
    return "correct";
  }
  if (name == "Retract" || name == "retract") {
    return "retract";
  }
  throw std::invalid_argument("unsupported observation action: " + name);
}

std::string outcome_edge_name(const nlohmann::json &admission) {
  const auto name = enum_name(admission, "outcome");
  if (name == "Admitted" || name == "admitted") {
    return "admitted";
  }
  if (name == "UnregisteredSurface" || name == "unregistered-surface") {
    return "unregistered-surface";
  }
  if (name == "IncompatibleSchema" || name == "incompatible-schema") {
    return "incompatible-schema";
  }
  if (name == "AmbiguousAuthority" || name == "ambiguous-authority") {
    return "ambiguous-authority";
  }
  if (name == "Unverifiable" || name == "unverifiable") {
    return "unverifiable";
  }
  throw std::invalid_argument("unsupported admission outcome: " + name);
}

std::string outcome_wire_name(const std::string &outcome) {
  if (outcome == "admitted") {
    return "Admitted";
  }
  if (outcome == "unregistered-surface") {
    return "UnregisteredSurface";
  }
  if (outcome == "incompatible-schema") {
    return "IncompatibleSchema";
  }
  if (outcome == "ambiguous-authority") {
    return "AmbiguousAuthority";
  }
  return "Unverifiable";
}

std::string action_wire_name(const std::string &action) {
  if (action == "assert") {
    return "Assert";
  }
  if (action == "correct") {
    return "Correct";
  }
  if (action == "retract") {
    return "Retract";
  }
  throw std::invalid_argument("action must be assert, correct, or retract");
}

std::vector<nlohmann::json> declarations_of(const std::vector<fact_record> &records, const char *field) {
  std::vector<nlohmann::json> declarations;
  for (const auto &record : records) {
    if (record.event.contains(field) && record.event.at(field).is_object()) {
      declarations.push_back(record.event.at(field));
    }
  }
  return declarations;
}

std::vector<nlohmann::json> effective_declarations(const std::vector<nlohmann::json> &declarations,
                                                   const std::string &id, int64_t system_time) {
  std::vector<nlohmann::json> result;
  for (const auto &declaration : declarations) {
    if (text_or(declaration, "id") == id && effective_at(declaration, system_time)) {
      result.push_back(declaration);
    }
  }
  return result;
}

struct admission_verdict {
  std::string outcome;
  std::string reason;
  nlohmann::json contract_world = nlohmann::json::object();
  nlohmann::json fact_surface = nlohmann::json::object();
};

admission_verdict admit_observation(const std::vector<fact_record> &records, const nlohmann::json &observation,
                                    int64_t system_time) {
  admission_verdict verdict{"unverifiable", "observation evidence is incomplete"};
  const auto worlds = effective_declarations(declarations_of(records, "contract_world_declaration"),
                                             required_text(observation, "contract_world_id"), system_time);
  const auto surfaces = effective_declarations(declarations_of(records, "fact_surface_declaration"),
                                               required_text(observation, "fact_surface_id"), system_time);
  if (worlds.empty() || surfaces.empty()) {
    verdict.outcome = "unregistered-surface";
    verdict.reason = "no registered contract-world and fact-surface declarations are effective at the observation";
    return verdict;
  }
  if (worlds.size() != 1 || surfaces.size() != 1) {
    verdict.outcome = "ambiguous-authority";
    verdict.reason = "more than one declaration is effective at the observation system time";
    return verdict;
  }
  verdict.contract_world = declaration_reference(worlds.front());
  verdict.fact_surface = declaration_reference(surfaces.front());
  const auto surface_world = surfaces.front().value("contract_world", nlohmann::json::object());
  if (surface_world != verdict.contract_world) {
    verdict.outcome = "unverifiable";
    verdict.reason = "fact-surface declaration does not bind the effective contract-world root";
    return verdict;
  }
  if (text_or(observation, "schema_owner_root") != text_or(surfaces.front(), "schema_owner_root")) {
    verdict.outcome = "incompatible-schema";
    verdict.reason = "observation schema owner root is incompatible with the effective declaration";
    return verdict;
  }
  const auto authorities = string_array(surfaces.front(), "source_authorities");
  const auto source = text_or(observation, "source_id");
  if (source.empty() && authorities.size() > 1) {
    verdict.outcome = "ambiguous-authority";
    verdict.reason = "observation omits source identity while multiple authorities are declared";
    return verdict;
  }
  if (source.empty() || std::find(authorities.begin(), authorities.end(), source) == authorities.end()) {
    verdict.outcome = "unverifiable";
    verdict.reason = "observation source is not verifiable under the effective declaration";
    return verdict;
  }
  if (!canonical_root(text_or(observation, "payload_hash"))) {
    verdict.outcome = "unverifiable";
    verdict.reason = "observation payload hash is not a canonical sha256 root";
    return verdict;
  }
  const auto action_name = action_edge_name(observation);
  if (action_name != "assert") {
    const auto target = text_or(observation, "target_observation_id");
    bool target_admitted = false;
    nlohmann::json target_observation = nlohmann::json::object();
    for (const auto &record : records) {
      if (record.event.contains("observation") && record.event.at("observation").is_object()) {
        const auto &candidate = record.event.at("observation");
        if (text_or(candidate, "observation_id") == target) {
          target_observation = candidate;
        }
      }
      if (record.event.contains("admission") && record.event.at("admission").is_object() &&
          text_or(record.event.at("admission"), "observation_id") == target &&
          outcome_edge_name(record.event.at("admission")) == "admitted") {
        target_admitted = true;
      }
    }
    if (target.empty() || !target_admitted) {
      verdict.outcome = "unverifiable";
      verdict.reason = "correction or retraction target is not an admitted observation";
      return verdict;
    }
    if (text_or(target_observation, "source_id") != source) {
      verdict.outcome = "ambiguous-authority";
      verdict.reason = "correction or retraction source does not own the target observation";
      return verdict;
    }
    for (const auto *field : {"contract_world_id", "fact_surface_id", "subject_key"}) {
      if (text_or(target_observation, field) != text_or(observation, field)) {
        verdict.outcome = "unverifiable";
        verdict.reason = "correction or retraction target belongs to a different fact identity";
        return verdict;
      }
    }
  }
  verdict.outcome = "admitted";
  verdict.reason = "observation satisfies the effective declared fact surface";
  return verdict;
}

nlohmann::json normalize_world(const nlohmann::json &input) {
  nlohmann::json declaration = {{"id", required_text(input, "id")},
                                {"version", required_text(input, "version")},
                                {"effective_from", integer_value(input, "effective_from")},
                                {"effective_until", integer_value(input, "effective_until")},
                                {"fact_surface_ids", string_array(input, "fact_surface_ids")}};
  require_effective_range(declaration);
  declaration["root"] = content_root(declaration.dump());
  return declaration;
}

nlohmann::json normalize_surface(const nlohmann::json &input) {
  const auto world = input.value("contract_world", nlohmann::json::object());
  if (!world.is_object() || !canonical_root(text_or(world, "root"))) {
    throw std::invalid_argument("contract_world requires id, version, and canonical root");
  }
  nlohmann::json declaration = {
      {"id", required_text(input, "id")},
      {"version", required_text(input, "version")},
      {"contract_world",
       {{"id", required_text(world, "id")},
        {"version", required_text(world, "version")},
        {"root", required_text(world, "root")}}},
      {"effective_from", integer_value(input, "effective_from")},
      {"effective_until", integer_value(input, "effective_until")},
      {"schema_owner_root", required_text(input, "schema_owner_root")},
      {"source_authorities", string_array(input, "source_authorities")},
      {"identity_policy", required_text(input, "identity_policy")},
      {"valid_time_policy", required_text(input, "valid_time_policy")},
      {"system_time_policy", required_text(input, "system_time_policy")},
      {"causal_time_policy", required_text(input, "causal_time_policy")},
      {"reducer_policy", required_text(input, "reducer_policy")},
      {"correction_policy", required_text(input, "correction_policy")},
      {"retraction_policy", required_text(input, "retraction_policy")},
      {"conflict_policy", required_text(input, "conflict_policy")},
      {"redaction_policy", required_text(input, "redaction_policy")},
      {"compatibility_policy", required_text(input, "compatibility_policy")},
      {"known_limits", string_array(input, "known_limits")},
  };
  require_effective_range(declaration);
  if (!canonical_root(text_or(declaration, "schema_owner_root")) || declaration.at("source_authorities").empty()) {
    throw std::invalid_argument("fact surface requires a canonical schema_owner_root and source authorities");
  }
  declaration["root"] = content_root(declaration.dump());
  return declaration;
}

nlohmann::json normalize_observation(const nlohmann::json &input) {
  const auto action_name = text_or(input, "action", "assert");
  nlohmann::json observation = {
      {"observation_id", required_text(input, "observation_id")},
      {"contract_world_id", required_text(input, "contract_world_id")},
      {"fact_surface_id", required_text(input, "fact_surface_id")},
      {"schema_owner_root", required_text(input, "schema_owner_root")},
      {"source_id", text_or(input, "source_id")},
      {"subject_key", required_text(input, "subject_key")},
      {"valid_from", integer_value(input, "valid_from")},
      {"valid_until", integer_value(input, "valid_until")},
      {"payload_hash", text_or(input, "payload_hash")},
      {"payload_ref", text_or(input, "payload_ref")},
      {"action", action_wire_name(action_name)},
      {"target_observation_id", text_or(input, "target_observation_id")},
  };
  const auto valid_from = integer_value(observation, "valid_from");
  const auto valid_until = integer_value(observation, "valid_until");
  if (valid_from < 0 || valid_until < 0 || (valid_until != 0 && valid_until <= valid_from)) {
    throw std::invalid_argument("valid range requires 0 <= from < until, or until=0");
  }
  return observation;
}

nlohmann::json active_declaration_projection(const std::vector<nlohmann::json> &declarations, int64_t cut) {
  std::vector<nlohmann::json> effective;
  for (const auto &declaration : declarations) {
    if (effective_at(declaration, cut)) {
      effective.push_back(declaration_reference(declaration));
    }
  }
  if (effective.size() == 1) {
    return effective.front();
  }
  return nlohmann::json(nullptr);
}

nlohmann::json declaration_catalog(const std::vector<fact_record> &records, const char *field) {
  auto catalog = nlohmann::json::array();
  for (const auto &record : records) {
    if (!record.event.contains(field) || !record.event.at(field).is_object()) {
      continue;
    }
    auto declaration = record.event.at(field);
    declaration["event_id"] = text_or(record.event, "event_id");
    declaration["episode_id"] = unsigned_value(record.event, "episode_id");
    declaration["system_time"] = integer_value(record.event, "system_time", record.frame_gen_time);
    catalog.push_back(std::move(declaration));
  }
  return catalog;
}

} // namespace

nlohmann::json fact_contract_json() {
  return {{"schema", DOMAIN_FACT_CONTRACT_V1},
          {"owner", "libkungfu"},
          {"schema_owner", "flatbuffers"},
          {"event_schema", DOMAIN_FACT_EVENT_SCHEMA_V1},
          {"schema_root", domain_schema().root},
          {"journal",
           {{"namespace", FACT_NAMESPACE},
            {"name", FACT_NAME},
            {"carrier_type", view::action::ACTION_ENVELOPE_CARRIER_TYPE}}},
          {"event_kinds", nlohmann::json::array({"contract-world-declared", "fact-surface-declared",
                                                 "observation-recorded", "admission-decided"})},
          {"observation_actions", nlohmann::json::array({"assert", "correct", "retract"})},
          {"admission_outcomes", nlohmann::json::array({"admitted", "unregistered-surface", "incompatible-schema",
                                                        "ambiguous-authority", "unverifiable"})},
          {"time_basis",
           {{"valid_time", "explicit observation range"},
            {"system_time", "journaled declaration/admission event time"},
            {"causal_time", "event parent plus frame trigger uid"}}},
          {"writer_admission",
           {{"mode", "bounded-core-wait/v1"},
            {"timeout_ms", FACT_WRITER_WAIT_TIMEOUT.count()},
            {"physical_writer", "single"},
            {"concurrent_clients", "queued-before-read"}}},
          {"authority", "yijinjing-journal"},
          {"known_limits", nlohmann::json::array({"single physical admission writer", "bounded concurrent client wait",
                                                  "opaque payload hash/ref only"})}};
}

nlohmann::json declare_contract_world(const std::string &runtime_dir, const nlohmann::json &declaration,
                                      int64_t system_time) {
  auto recorder = open_admission_writer(runtime_dir);
  const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
  const auto normalized = normalize_world(declaration);
  const auto recorded =
      append_episode(*recorder, runtime_dir, {event_shell("ContractWorldDeclared", event_time, normalized)}, event_time,
                     "contract world declaration");
  return {{"schema", DOMAIN_FACT_CONTRACT_V1},
          {"declaration", normalized},
          {"reference", declaration_reference(normalized)},
          {"event_id", recorded.events.front().at("event_id")},
          {"episode_id", recorded.episode_id}};
}

nlohmann::json declare_fact_surface(const std::string &runtime_dir, const nlohmann::json &declaration,
                                    int64_t system_time, const std::string &owned_schema_hash) {
  auto recorder = open_admission_writer(runtime_dir);
  const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
  const auto normalized = normalize_surface(declaration);
  const auto records = read_events(runtime_dir, event_time);
  bool world_registered = false;
  for (const auto &world : declarations_of(records, "contract_world_declaration")) {
    if (declaration_reference(world) == normalized.at("contract_world")) {
      world_registered = true;
      break;
    }
  }
  if (!world_registered) {
    throw std::invalid_argument("fact surface references an unregistered contract-world declaration");
  }
  std::vector<owned_ref> owned_refs;
  if (!owned_schema_hash.empty()) {
    if (owned_schema_hash != text_or(normalized, "schema_owner_root")) {
      throw std::invalid_argument("owned schema hash must match schema_owner_root");
    }
    owned_refs.push_back({yy::enums::EpisodeRefKind::Schema, text_or(normalized, "id"), owned_schema_hash});
  }
  const auto recorded =
      append_episode(*recorder, runtime_dir, {event_shell("FactSurfaceDeclared", event_time, normalized)}, event_time,
                     "fact surface declaration", owned_refs);
  return {{"schema", DOMAIN_FACT_CONTRACT_V1},
          {"declaration", normalized},
          {"reference", declaration_reference(normalized)},
          {"event_id", recorded.events.front().at("event_id")},
          {"episode_id", recorded.episode_id}};
}

nlohmann::json record_observation(const std::string &runtime_dir, const nlohmann::json &observation,
                                  int64_t system_time, const std::string &owned_payload_hash) {
  auto recorder = open_admission_writer(runtime_dir);
  const auto event_time = system_time == 0 ? yy::time::now_in_nano() : system_time;
  const auto normalized = normalize_observation(observation);
  const auto records = read_events(runtime_dir, event_time);
  std::string causal_parent_event_id;
  for (const auto &record : records) {
    if (!record.event.contains("observation") || !record.event.at("observation").is_object()) {
      continue;
    }
    const auto &candidate = record.event.at("observation");
    if (text_or(candidate, "observation_id") == text_or(normalized, "observation_id")) {
      throw std::invalid_argument("observation_id is already recorded");
    }
    if (text_or(candidate, "observation_id") == text_or(normalized, "target_observation_id")) {
      causal_parent_event_id = text_or(record.event, "event_id");
    }
  }
  const auto verdict = admit_observation(records, normalized, event_time);
  const auto observation_event = event_shell("ObservationRecorded", event_time, normalized, causal_parent_event_id);
  nlohmann::json proof_basis = {{"observation", normalized},
                                {"contract_world", verdict.contract_world},
                                {"fact_surface", verdict.fact_surface},
                                {"outcome", verdict.outcome}};
  nlohmann::json admission = {{"observation_id", normalized.at("observation_id")},
                              {"outcome", outcome_wire_name(verdict.outcome)},
                              {"contract_world", verdict.contract_world},
                              {"fact_surface", verdict.fact_surface},
                              {"reason", verdict.reason},
                              {"proof_hash", content_root(proof_basis.dump())}};
  const auto admission_event =
      event_shell("AdmissionDecided", event_time, admission, observation_event.at("event_id").get<std::string>());
  std::vector<owned_ref> owned_refs;
  if (!owned_payload_hash.empty()) {
    if (owned_payload_hash != text_or(normalized, "payload_hash")) {
      throw std::invalid_argument("owned payload hash must match payload_hash");
    }
    owned_refs.push_back(
        {yy::enums::EpisodeRefKind::Payload, text_or(normalized, "observation_id"), owned_payload_hash});
  }
  const auto recorded =
      append_episode(*recorder, runtime_dir, {observation_event, admission_event}, event_time,
                     "observation admission " + normalized.at("observation_id").get<std::string>(), owned_refs);
  auto edge_admission = admission;
  edge_admission["outcome"] = verdict.outcome;
  return {{"schema", DOMAIN_FACT_CONTRACT_V1},
          {"observation", normalized},
          {"admission", edge_admission},
          {"observation_event_id", recorded.events.front().at("event_id")},
          {"admission_event_id", recorded.events.back().at("event_id")},
          {"episode_id", recorded.episode_id}};
}

nlohmann::json query_fact_state(const std::string &runtime_dir, int64_t cut_system_time,
                                const std::string &subject_key) {
  const auto records = read_events(runtime_dir, cut_system_time);
  int64_t resolved_cut = cut_system_time;
  if (resolved_cut == 0) {
    for (const auto &record : records) {
      resolved_cut = std::max(resolved_cut, integer_value(record.event, "system_time", record.frame_gen_time));
    }
  }

  std::map<std::string, nlohmann::json> observations;
  std::map<std::string, nlohmann::json> admissions;
  std::map<std::string, std::string> observation_event_ids;
  std::map<std::string, std::string> observation_causal_parent_ids;
  std::map<std::string, uint64_t> observation_episode_ids;
  std::map<std::string, int64_t> observation_times;
  for (const auto &record : records) {
    if (record.event.contains("observation") && record.event.at("observation").is_object()) {
      const auto observation = record.event.at("observation");
      const auto id = text_or(observation, "observation_id");
      observations[id] = observation;
      observation_event_ids[id] = text_or(record.event, "event_id");
      observation_causal_parent_ids[id] = text_or(record.event, "causal_parent_event_id");
      observation_episode_ids[id] = unsigned_value(record.event, "episode_id");
      observation_times[id] = integer_value(record.event, "system_time", record.frame_gen_time);
    }
    if (record.event.contains("admission") && record.event.at("admission").is_object()) {
      const auto admission = record.event.at("admission");
      admissions[text_or(admission, "observation_id")] = admission;
    }
  }

  std::vector<std::string> ordered_ids;
  ordered_ids.reserve(observations.size());
  for (const auto &[id, observation] : observations) {
    (void)observation;
    ordered_ids.push_back(id);
  }
  std::sort(ordered_ids.begin(), ordered_ids.end(), [&observation_times](const auto &left, const auto &right) {
    if (observation_times.at(left) != observation_times.at(right)) {
      return observation_times.at(left) < observation_times.at(right);
    }
    return left < right;
  });

  std::map<std::string, std::string> active_by_source;
  auto history = nlohmann::json::array();
  std::map<std::string, uint64_t> outcome_counts;
  for (const auto &id : ordered_ids) {
    const auto &observation = observations.at(id);
    if (!subject_key.empty() && text_or(observation, "subject_key") != subject_key) {
      continue;
    }
    const auto admission_it = admissions.find(id);
    const auto outcome =
        admission_it == admissions.end() ? std::string("unverifiable") : outcome_edge_name(admission_it->second);
    ++outcome_counts[outcome];
    const auto action_name = action_edge_name(observation);
    history.push_back(
        {{"observation_id", id},
         {"action", action_name},
         {"outcome", outcome},
         {"contract_world_id", observation.at("contract_world_id")},
         {"fact_surface_id", observation.at("fact_surface_id")},
         {"schema_owner_root", observation.at("schema_owner_root")},
         {"subject_key", observation.at("subject_key")},
         {"source_id", observation.at("source_id")},
         {"payload_hash", observation.at("payload_hash")},
         {"payload_ref", observation.at("payload_ref")},
         {"valid_time",
          {{"from", integer_value(observation, "valid_from")}, {"until", integer_value(observation, "valid_until")}}},
         {"system_time", observation_times.at(id)},
         {"causal_parent_event_id", observation_causal_parent_ids.at(id)},
         {"event_id", observation_event_ids.at(id)},
         {"episode_id", observation_episode_ids.at(id)}});
    if (outcome != "admitted") {
      continue;
    }
    const auto target = text_or(observation, "target_observation_id");
    if (action_name != "assert" && observations.contains(target)) {
      const auto &target_observation = observations.at(target);
      active_by_source.erase(
          text_or(target_observation, "contract_world_id") + "\n" + text_or(target_observation, "fact_surface_id") +
          "\n" + text_or(target_observation, "subject_key") + "\n" + text_or(target_observation, "source_id"));
    }
    if (action_name != "retract") {
      active_by_source[text_or(observation, "contract_world_id") + "\n" + text_or(observation, "fact_surface_id") +
                       "\n" + text_or(observation, "subject_key") + "\n" + text_or(observation, "source_id")] = id;
    }
  }

  auto canonical_facts = nlohmann::json::array();
  std::map<std::string, std::vector<std::string>> active_by_subject;
  for (const auto &[key, id] : active_by_source) {
    (void)key;
    const auto &observation = observations.at(id);
    canonical_facts.push_back(
        {{"observation_id", id},
         {"contract_world_id", observation.at("contract_world_id")},
         {"fact_surface_id", observation.at("fact_surface_id")},
         {"schema_owner_root", observation.at("schema_owner_root")},
         {"subject_key", observation.at("subject_key")},
         {"source_id", observation.at("source_id")},
         {"payload_hash", observation.at("payload_hash")},
         {"payload_ref", observation.at("payload_ref")},
         {"valid_time",
          {{"from", integer_value(observation, "valid_from")}, {"until", integer_value(observation, "valid_until")}}},
         {"system_time", observation_times.at(id)},
         {"episode_id", observation_episode_ids.at(id)},
         {"causal_parent_event_id", observation_causal_parent_ids.at(id)}});
    active_by_subject[text_or(observation, "contract_world_id") + "\n" + text_or(observation, "fact_surface_id") +
                      "\n" + text_or(observation, "subject_key")]
        .push_back(id);
  }
  std::sort(canonical_facts.begin(), canonical_facts.end(), [](const auto &left, const auto &right) {
    return text_or(left, "observation_id") < text_or(right, "observation_id");
  });

  auto conflicts = nlohmann::json::array();
  for (auto &[identity, ids] : active_by_subject) {
    (void)identity;
    std::set<std::string> hashes;
    std::set<std::string> sources;
    for (const auto &id : ids) {
      hashes.insert(text_or(observations.at(id), "payload_hash"));
      sources.insert(text_or(observations.at(id), "source_id"));
    }
    if (ids.size() > 1 && hashes.size() > 1) {
      std::sort(ids.begin(), ids.end());
      conflicts.push_back({{"subject_key", observations.at(ids.front()).at("subject_key")},
                           {"observation_ids", ids},
                           {"source_ids", std::vector<std::string>(sources.begin(), sources.end())}});
    }
  }

  nlohmann::json counts = nlohmann::json::object();
  for (const auto *name :
       {"admitted", "ambiguous-authority", "incompatible-schema", "unregistered-surface", "unverifiable"}) {
    if (outcome_counts.contains(name)) {
      counts[name] = outcome_counts.at(name);
    }
  }
  const auto worlds = declarations_of(records, "contract_world_declaration");
  const auto surfaces = declarations_of(records, "fact_surface_declaration");
  return {{"schema", "kungfu.facts.state/v1"},
          {"cut", {{"kind", cut_system_time == 0 ? "head" : "system_time"}, {"system_time", resolved_cut}}},
          {"declarations",
           {{"contract_world", active_declaration_projection(worlds, resolved_cut)},
            {"fact_surface", active_declaration_projection(surfaces, resolved_cut)}}},
          {"catalog",
           {{"contract_worlds", declaration_catalog(records, "contract_world_declaration")},
            {"fact_surfaces", declaration_catalog(records, "fact_surface_declaration")}}},
          {"canonical_facts", canonical_facts},
          {"observation_history", history},
          {"conflicts", conflicts},
          {"admission_outcomes", counts},
          {"proof",
           {{"authority", "yijinjing-journal"},
            {"schema_owner", "flatbuffers"},
            {"event_schema", DOMAIN_FACT_EVENT_SCHEMA_V1},
            {"schema_root", domain_schema().root},
            {"record_count", records.size()},
            {"determinism", "pinned-effective-declarations"},
            {"time_basis", {{"valid_time", "explicit"}, {"system_time", "event"}, {"causal_time", "event-parent"}}}}}};
}

} // namespace kungfu::runtime::facts
