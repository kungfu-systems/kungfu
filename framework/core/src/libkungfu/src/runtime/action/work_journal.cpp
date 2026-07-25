// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/work_journal.h>

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/work_event_schema.h>
#include <kungfu/runtime/action_recorder.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <flatbuffers/flatbuffers.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <cstdio>
#endif

namespace kungfu::runtime::action {

namespace fs = std::filesystem;
namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr uint32_t WORK_SCHEMA_VERSION = 1;
constexpr const char *WORK_NAMESPACE = "work";
constexpr const char *WORK_JOURNAL_NAME = "items";

struct event_binding {
  const char *object_name;
  const char *schema_id;
};

const std::map<std::string, event_binding> EVENT_BINDINGS = {
    {"work.artifact.recorded", {"ArtifactRecorded", "kungfu.work.ArtifactRecorded"}},
    {"work.checkpoint.recorded", {"CheckpointRecorded", "kungfu.work.CheckpointRecorded"}},
    {"work.decision.recorded", {"DecisionRecorded", "kungfu.work.DecisionRecorded"}},
    {"work.item.created", {"WorkItemCreated", "kungfu.work.WorkItemCreated"}},
    {"work.next_action.set", {"NextActionSet", "kungfu.work.NextActionSet"}},
    {"work.run.linked", {"RunLinked", "kungfu.work.RunLinked"}},
    {"work.status.changed", {"WorkStatusChanged", "kungfu.work.WorkStatusChanged"}},
    {"work.validation.recorded", {"ValidationRecorded", "kungfu.work.ValidationRecorded"}},
};

struct work_schema_contract {
  view::schema_handle handle;
  std::string source_bytes;
  std::string bfbs_bytes;
  std::string source_root;
  std::string bfbs_root;
};

std::string content_root(std::string_view bytes) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(bytes.data(), bytes.size()));
}

std::string protocol_root(std::string_view protocol, const nlohmann::json &value) {
  std::string preimage(protocol);
  preimage.push_back('\0');
  preimage += action_canonical_json(value);
  return content_root(preimage);
}

bool canonical_root(const std::string &value) {
  return value.size() == 71 && value.rfind("sha256:", 0) == 0 &&
         std::all_of(value.begin() + 7, value.end(), [](const char character) {
           return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
         });
}

std::optional<std::string> optional_root(const nlohmann::json &value, const char *field) {
  if (!value.contains(field))
    return std::nullopt;
  if (!value.at(field).is_string() || !canonical_root(value.at(field).get<std::string>()))
    throw std::invalid_argument(std::string(field) + " must be a canonical sha256 Root");
  return value.at(field).get<std::string>();
}

std::string lifecycle_request_root(const std::string &operation_id, const nlohmann::json &input) {
  auto identity_input = input;
  identity_input.erase("requestRoot");
  return protocol_root(WORK_REQUEST_ROOT_PROTOCOL_V1,
                       {{"operationId", operation_id}, {"input", std::move(identity_input)}});
}

std::string record_root_preimage(std::string_view envelope_bytes) {
  std::string preimage(WORK_RECORD_ROOT_PROTOCOL_V1);
  preimage.push_back('\0');
  const auto size = static_cast<uint64_t>(envelope_bytes.size());
  for (int shift = 56; shift >= 0; shift -= 8)
    preimage.push_back(static_cast<char>((size >> shift) & UINT64_C(0xff)));
  preimage.append(envelope_bytes);
  return preimage;
}

std::string hex_encode(std::string_view bytes) {
  static constexpr char DIGITS[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (const auto value : bytes) {
    const auto byte = static_cast<unsigned char>(value);
    result.push_back(DIGITS[byte >> 4U]);
    result.push_back(DIGITS[byte & 0x0fU]);
  }
  return result;
}

std::string hex_decode(std::string_view hex) {
  if (hex.size() % 2 != 0)
    throw std::runtime_error("embedded Agent Work BFBS hex has an odd length");
  const auto digit = [](const char value) -> unsigned char {
    if (value >= '0' && value <= '9')
      return static_cast<unsigned char>(value - '0');
    if (value >= 'a' && value <= 'f')
      return static_cast<unsigned char>(value - 'a' + 10);
    throw std::runtime_error("embedded Agent Work BFBS hex is invalid");
  };
  std::string result;
  result.reserve(hex.size() / 2);
  for (size_t index = 0; index < hex.size(); index += 2)
    result.push_back(static_cast<char>((digit(hex[index]) << 4U) | digit(hex[index + 1])));
  return result;
}

std::string read_file_bytes(const fs::path &file) {
  std::ifstream input(file, std::ios::binary);
  if (!input)
    throw std::runtime_error("cannot read Agent Work authority file: " + file.string());
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void atomic_replace(const fs::path &destination, std::string_view bytes) {
  const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
  const auto temporary = destination.parent_path() / (destination.filename().string() + ".tmp." + suffix);
  {
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output)
      throw std::runtime_error("cannot stage Agent Work authority file: " + temporary.string());
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    output.flush();
    if (!output)
      throw std::runtime_error("cannot flush Agent Work authority file: " + temporary.string());
  }
#ifdef _WIN32
  if (::MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
    const auto error = static_cast<int>(::GetLastError());
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw std::system_error(error, std::system_category(), "publish Agent Work authority file");
  }
#else
  if (::rename(temporary.c_str(), destination.c_str()) != 0) {
    const auto error = errno;
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw std::system_error(error, std::generic_category(), "publish Agent Work authority file");
  }
#endif
}

const work_schema_contract &work_schema() {
  static const auto contract = [] {
    const std::string source(work_event_schema::WORK_EVENT_FBS);
    const auto bfbs = hex_decode(work_event_schema::WORK_EVENT_BFBS_HEX);
    return work_schema_contract{view::schema_handle::from_bytes(bfbs), source, bfbs, content_root(source),
                                content_root(bfbs)};
  }();
  return contract;
}

const event_binding &binding_for(const std::string &action_type) {
  const auto found = EVENT_BINDINGS.find(action_type);
  if (found == EVENT_BINDINGS.end()) {
    throw std::invalid_argument("unsupported Agent Work event action: " + action_type);
  }
  return found->second;
}

std::string required_text(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get_ref<const std::string &>().empty()) {
    throw std::invalid_argument(std::string(field) + " must be a non-empty string");
  }
  return value.at(field).get<std::string>();
}

flatbuffers::Offset<flatbuffers::String> optional_string(flatbuffers::FlatBufferBuilder &builder,
                                                         const nlohmann::json &event, const char *field) {
  if (!event.contains(field) || !event.at(field).is_string() || event.at(field).get_ref<const std::string &>().empty())
    return {};
  return builder.CreateString(event.at(field).get_ref<const std::string &>());
}

void add_offset(flatbuffers::FlatBufferBuilder &builder, flatbuffers::voffset_t field,
                flatbuffers::Offset<flatbuffers::String> value) {
  if (!value.IsNull())
    builder.AddOffset(field, value);
}

void validate_event(const std::string &action_type, const nlohmann::json &event) {
  const std::map<std::string, std::set<std::string>> allowed_fields = {
      {"work.artifact.recorded", {"kind", "ref", "work_id"}},
      {"work.checkpoint.recorded", {"note", "work_id"}},
      {"work.decision.recorded", {"decided_by", "decision", "work_id"}},
      {"work.item.created", {"kind", "schema_version", "summary", "title", "work_id"}},
      {"work.next_action.set", {"next_action", "work_id"}},
      {"work.run.linked", {"run_id", "work_id"}},
      {"work.status.changed", {"reason", "status", "work_id"}},
      {"work.validation.recorded", {"command", "note", "result", "work_id"}},
  };
  const auto &allowed = allowed_fields.at(action_type);
  for (const auto &[field, value] : event.items()) {
    if (!allowed.contains(field))
      throw std::invalid_argument("unknown field for " + action_type + ": " + field);
    if (field == "status" || field == "result" || field == "schema_version") {
      if (!value.is_number_integer())
        throw std::invalid_argument(field + " must be an integer");
    } else if (!value.is_string()) {
      throw std::invalid_argument(field + " must be a string");
    }
  }
  (void)required_text(event, "work_id");
  if (action_type == "work.item.created") {
    if (!event.contains("schema_version") || event.at("schema_version").get<int64_t>() != WORK_SCHEMA_VERSION)
      throw std::invalid_argument("schema_version must equal 1");
  } else if (action_type == "work.status.changed") {
    if (!event.contains("status") || event.at("status").get<int64_t>() < 0 || event.at("status").get<int64_t>() > 4)
      throw std::invalid_argument("status must be an Agent Work status in [0, 4]");
  } else if (action_type == "work.validation.recorded") {
    if (!event.contains("result") || event.at("result").get<int64_t>() < 0 || event.at("result").get<int64_t>() > 1)
      throw std::invalid_argument("result must be an Agent Work validation result in [0, 1]");
  }
}

std::vector<uint8_t> encode_payload(const std::string &action_type, const nlohmann::json &event) {
  (void)binding_for(action_type);
  if (!event.is_object())
    throw std::invalid_argument("Agent Work event must be an object");
  validate_event(action_type, event);
  flatbuffers::FlatBufferBuilder builder(256);
  const auto work_id = optional_string(builder, event, "work_id");
  flatbuffers::uoffset_t root = 0;
  if (action_type == "work.item.created") {
    const auto title = optional_string(builder, event, "title");
    const auto kind = optional_string(builder, event, "kind");
    const auto summary = optional_string(builder, event, "summary");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, title);
    add_offset(builder, 8, kind);
    add_offset(builder, 10, summary);
    builder.AddElement<uint32_t>(12, event.value("schema_version", uint32_t{0}), 0);
    root = builder.EndTable(start);
  } else if (action_type == "work.status.changed") {
    const auto reason = optional_string(builder, event, "reason");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    builder.AddElement<int8_t>(6, event.value("status", int8_t{0}), 0);
    add_offset(builder, 8, reason);
    root = builder.EndTable(start);
  } else if (action_type == "work.next_action.set") {
    const auto next_action = optional_string(builder, event, "next_action");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, next_action);
    root = builder.EndTable(start);
  } else if (action_type == "work.checkpoint.recorded") {
    const auto note = optional_string(builder, event, "note");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, note);
    root = builder.EndTable(start);
  } else if (action_type == "work.decision.recorded") {
    const auto decision = optional_string(builder, event, "decision");
    const auto decided_by = optional_string(builder, event, "decided_by");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, decision);
    add_offset(builder, 8, decided_by);
    root = builder.EndTable(start);
  } else if (action_type == "work.validation.recorded") {
    const auto command = optional_string(builder, event, "command");
    const auto note = optional_string(builder, event, "note");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    builder.AddElement<int8_t>(6, event.value("result", int8_t{0}), 0);
    add_offset(builder, 8, command);
    add_offset(builder, 10, note);
    root = builder.EndTable(start);
  } else if (action_type == "work.artifact.recorded") {
    const auto ref = optional_string(builder, event, "ref");
    const auto kind = optional_string(builder, event, "kind");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, ref);
    add_offset(builder, 8, kind);
    root = builder.EndTable(start);
  } else if (action_type == "work.run.linked") {
    const auto run_id = optional_string(builder, event, "run_id");
    const auto start = builder.StartTable();
    add_offset(builder, 4, work_id);
    add_offset(builder, 6, run_id);
    root = builder.EndTable(start);
  }
  builder.Finish(flatbuffers::Offset<flatbuffers::Table>(root));
  return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

view::action::envelope make_envelope(const std::string &action_type, std::vector<uint8_t> payload) {
  const auto &binding = binding_for(action_type);
  view::action::envelope envelope{};
  envelope.action_type = action_type;
  envelope.schema_ref = {binding.schema_id, WORK_SCHEMA_VERSION};
  envelope.payload =
      view::action::payload_view{view::action::payload_encoding::FlatBuffers, std::move(payload), {}, {}, 0, "", ""};
  return envelope;
}

nlohmann::json encoded_event(const std::string &action_type, const nlohmann::json &event) {
  const auto payload = encode_payload(action_type, event);
  const auto envelope_bytes = view::action::encode(make_envelope(action_type, payload));
  const auto preimage = record_root_preimage(
      std::string_view(reinterpret_cast<const char *>(envelope_bytes.data()), envelope_bytes.size()));
  return {{"schema", "kungfu.work-journal.encoded-event/v1"},
          {"actionType", action_type},
          {"eventSchema", binding_for(action_type).schema_id},
          {"eventSchemaVersion", WORK_SCHEMA_VERSION},
          {"payloadHex", hex_encode(std::string_view(reinterpret_cast<const char *>(payload.data()), payload.size()))},
          {"envelopeHex",
           hex_encode(std::string_view(reinterpret_cast<const char *>(envelope_bytes.data()), envelope_bytes.size()))},
          {"recordRootProtocol", WORK_RECORD_ROOT_PROTOCOL_V1},
          {"recordRootPreimageHex", hex_encode(preimage)},
          {"recordRoot", content_root(preimage)},
          {"schemaSourceRoot", work_schema().source_root},
          {"schemaBfbsRoot", work_schema().bfbs_root}};
}

fs::path emit_manifest(const std::string &runtime_dir) {
  const auto store_dir = fs::path(runtime_dir) / "work" / "store";
  const auto schemas_dir = store_dir / "schemas";
  fs::create_directories(schemas_dir);
  const auto bfbs_name = work_schema().bfbs_root.substr(7) + ".bfbs";
  const auto bfbs_path = schemas_dir / bfbs_name;
  if (!fs::exists(bfbs_path)) {
    atomic_replace(bfbs_path, work_schema().bfbs_bytes);
  }
  if (read_file_bytes(bfbs_path) != work_schema().bfbs_bytes) {
    throw std::runtime_error("published Agent Work schema bytes do not match their content address");
  }

  nlohmann::json bindings = nlohmann::json::object();
  for (const auto &[action_type, binding] : EVENT_BINDINGS) {
    bindings[action_type] = {{"schema_kind", "flatbuffers"},
                             {"name", binding.object_name},
                             {"schema_version", WORK_SCHEMA_VERSION},
                             {"schema_hash", work_schema().bfbs_root.substr(7)}};
  }
  const nlohmann::json manifest = {
      {"capture_boundary",
       "schema bindings cover work-item events only; frames of other action types in the same journal are out of scope "
       "for this manifest"},
      {"hash_algorithm", yy_storage::CONTENT_HASH_ALGORITHM_SHA256},
      {"schema_bindings", std::move(bindings)},
      {"source",
       {{"dest", 0},
        {"mode", "live"},
        {"name", WORK_JOURNAL_NAME},
        {"namespace", WORK_NAMESPACE},
        {"role", "system"},
        {"root", runtime_dir}}},
      {"spec_version", "0.1"}};
  fs::create_directories(store_dir);
  const auto manifest_path = store_dir / "manifest.json";
  atomic_replace(manifest_path, manifest.dump(2));
  return manifest_path;
}

nlohmann::json record_event(action_recorder &recorder, const fs::path &manifest_path, const nlohmann::json &request) {
  const auto action_type = required_text(request, "actionType");
  if (!request.contains("event") || !request.at("event").is_object()) {
    throw std::invalid_argument("event must be an object");
  }
  const auto encoded = encoded_event(action_type, request.at("event"));
  const auto payload = encode_payload(action_type, request.at("event"));
  record_options options{};
  if (request.contains("genTime")) {
    if (!request.at("genTime").is_number_integer())
      throw std::invalid_argument("genTime must be an integer");
    options.gen_time = request.at("genTime").get<int64_t>();
  }
  const auto receipt = recorder.record_action(make_envelope(action_type, payload), options);
  nlohmann::json result = {{"schema", "kungfu.work-journal.append-receipt/v1"},
                           {"status", "admitted"},
                           {"actionType", action_type},
                           {"recordRoot", encoded.at("recordRoot")},
                           {"schemaSourceRoot", work_schema().source_root},
                           {"schemaBfbsRoot", work_schema().bfbs_root},
                           {"manifestPath", manifest_path.string()},
                           {"frame",
                            {{"carrierType", receipt.carrier_type},
                             {"dataLength", receipt.data_length},
                             {"dest", receipt.dest},
                             {"frameChecksum", receipt.frame_checksum},
                             {"frameUid", receipt.frame_uid},
                             {"genTime", receipt.gen_time},
                             {"integrityVersion", receipt.integrity_version},
                             {"payloadChecksum", receipt.payload_checksum},
                             {"source", receipt.source},
                             {"streamId", receipt.stream_id},
                             {"triggerFrameUid", receipt.trigger_frame_uid},
                             {"triggerTime", receipt.trigger_time}}}};
  auto root_input = result;
  result["receiptRoot"] = content_root(root_input.dump());
  return result;
}

nlohmann::json append_event(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!request.contains("event") || !request.at("event").is_object())
    throw std::invalid_argument("event must be an object");
  (void)encoded_event(required_text(request, "actionType"), request.at("event"));
  const auto manifest_path = emit_manifest(runtime_dir);
  action_recorder recorder(runtime_dir, WORK_NAMESPACE, WORK_JOURNAL_NAME);
  return record_event(recorder, manifest_path, request);
}

nlohmann::json append_batch(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!request.contains("events") || !request.at("events").is_array() || request.at("events").empty())
    throw std::invalid_argument("events must be a non-empty array");
  for (const auto &event : request.at("events")) {
    if (!event.is_object() || !event.contains("event") || !event.at("event").is_object())
      throw std::invalid_argument("every batch event must contain an event object");
    if (event.contains("genTime") && !event.at("genTime").is_number_integer())
      throw std::invalid_argument("genTime must be an integer");
    (void)encoded_event(required_text(event, "actionType"), event.at("event"));
  }
  const auto manifest_path = emit_manifest(runtime_dir);
  action_recorder recorder(runtime_dir, WORK_NAMESPACE, WORK_JOURNAL_NAME);
  auto receipts = nlohmann::json::array();
  for (const auto &event : request.at("events"))
    receipts.push_back(record_event(recorder, manifest_path, event));
  return {{"schema", "kungfu.work-journal.append-batch-receipt/v1"},
          {"status", "admitted"},
          {"eventCount", receipts.size()},
          {"receipts", std::move(receipts)}};
}

nlohmann::json replay_events(const std::string &runtime_dir) {
  auto events = nlohmann::json::array();
  const auto journal_dir = fs::path(runtime_dir) / "journal" / "system" / WORK_NAMESPACE / WORK_JOURNAL_NAME / "live";
  if (!fs::exists(journal_dir)) {
    return {{"schema", "kungfu.work-journal.replay/v1"}, {"events", std::move(events)}};
  }
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  WORK_NAMESPACE, WORK_JOURNAL_NAME, locator);
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value())
          throw std::runtime_error("cannot decode Agent Work action envelope: " + error);
        const auto envelope_bytes =
            std::string_view(reinterpret_cast<const char *>(frame->data_as_bytes()), frame->data_length());
        const auto preimage = record_root_preimage(envelope_bytes);
        nlohmann::json record = {
            {"actionType", envelope->action_type},
            {"schemaRef", {{"id", envelope->schema_ref.id}, {"version", envelope->schema_ref.version}}},
            {"envelopeHex", hex_encode(envelope_bytes)},
            {"recordRoot", content_root(preimage)},
            {"frameUid", frame->frame_uid()},
            {"triggerFrameUid", frame->trigger_frame_uid()},
            {"genTime", frame->gen_time()},
            {"recognized", false}};
        const auto found = EVENT_BINDINGS.find(envelope->action_type);
        if (found != EVENT_BINDINGS.end() && envelope->schema_ref.id == found->second.schema_id &&
            envelope->schema_ref.version == WORK_SCHEMA_VERSION && envelope->payload.has_value() &&
            envelope->payload->encoding == view::action::payload_encoding::FlatBuffers) {
          const auto &payload = envelope->payload->data;
          const auto decoded =
              work_schema().handle.decode_json(payload.data(), payload.size(), true, found->second.object_name);
          if (decoded.ok) {
            record["event"] = nlohmann::json::parse(decoded.json);
            record["payloadHex"] =
                hex_encode(std::string_view(reinterpret_cast<const char *>(payload.data()), payload.size()));
            record["recognized"] = true;
          } else {
            record["decodeError"] = decoded.error;
          }
        }
        events.push_back(std::move(record));
      }
      reader.next();
    }
  } catch (const yy::journal::assemble_exception &) {
    events = nlohmann::json::array();
  } catch (const std::runtime_error &error) {
    if (std::string(error.what()).find("no page for current journal") != std::string::npos)
      events = nlohmann::json::array();
    else
      throw;
  }
  return {{"schema", "kungfu.work-journal.replay/v1"},
          {"schemaSourceRoot", work_schema().source_root},
          {"schemaBfbsRoot", work_schema().bfbs_root},
          {"events", std::move(events)}};
}

struct lifecycle_state {
  nlohmann::json records = nlohmann::json::array();
  nlohmann::json items = nlohmann::json::object();
  nlohmann::json unknown_records = nlohmann::json::array();
  std::string journal_root;
};

const std::map<int64_t, std::string> STATUS_NAMES = {
    {0, "active"}, {1, "waiting"}, {2, "blocked"}, {3, "ready"}, {4, "done"}};
const std::map<std::string, int64_t> STATUS_VALUES = {
    {"active", 0}, {"waiting", 1}, {"blocked", 2}, {"ready", 3}, {"done", 4}};

std::string item_root(const std::string &work_id, const nlohmann::json &record_roots) {
  return protocol_root(WORK_ITEM_ROOT_PROTOCOL_V1, {{"workId", work_id}, {"recordRoots", record_roots}});
}

nlohmann::json empty_item(const std::string &work_id) {
  return {{"workId", work_id},
          {"title", nullptr},
          {"kind", nullptr},
          {"summary", nullptr},
          {"status", nullptr},
          {"nextAction", nullptr},
          {"createdTime", nullptr},
          {"updatedTime", nullptr},
          {"checkpoints", nlohmann::json::array()},
          {"decisions", nlohmann::json::array()},
          {"validations", nlohmann::json::array()},
          {"artifacts", nlohmann::json::array()},
          {"runs", nlohmann::json::array()},
          {"history", nlohmann::json::array()},
          {"recordRoots", nlohmann::json::array()}};
}

void fold_record(lifecycle_state &state, const nlohmann::json &record) {
  if (!record.value("recognized", false) || !record.contains("event") || !record.at("event").is_object()) {
    state.unknown_records.push_back(record);
    return;
  }
  const auto &event = record.at("event");
  const auto work_id = event.value("work_id", std::string{});
  if (work_id.empty()) {
    state.unknown_records.push_back(record);
    return;
  }
  if (!state.items.contains(work_id))
    state.items[work_id] = empty_item(work_id);
  auto &item = state.items[work_id];
  const auto gen_time = record.at("genTime");
  item["updatedTime"] = gen_time;
  item["recordRoots"].push_back(record.at("recordRoot"));
  const auto action_type = record.at("actionType").get<std::string>();
  if (action_type == "work.item.created") {
    item["title"] = event.value("title", std::string{});
    item["kind"] = event.value("kind", std::string{});
    item["summary"] = event.value("summary", std::string{});
    item["status"] = "active";
    item["createdTime"] = gen_time;
    item["history"].push_back({{"time", gen_time}, {"event", "created"}});
  } else if (action_type == "work.status.changed") {
    const auto found = STATUS_NAMES.find(event.value("status", int64_t{-1}));
    const auto status = found == STATUS_NAMES.end() ? std::string{"unknown"} : found->second;
    item["status"] = status;
    item["history"].push_back(
        {{"time", gen_time}, {"event", "status"}, {"status", status}, {"reason", event.value("reason", "")}});
  } else if (action_type == "work.next_action.set") {
    item["nextAction"] = event.value("next_action", std::string{});
  } else if (action_type == "work.checkpoint.recorded") {
    item["checkpoints"].push_back({{"time", gen_time}, {"note", event.value("note", "")}});
  } else if (action_type == "work.decision.recorded") {
    item["decisions"].push_back(
        {{"time", gen_time}, {"decision", event.value("decision", "")}, {"decidedBy", event.value("decided_by", "")}});
  } else if (action_type == "work.validation.recorded") {
    item["validations"].push_back({{"time", gen_time},
                                   {"result", event.value("result", int64_t{-1}) == 0 ? "pass" : "fail"},
                                   {"command", event.value("command", "")},
                                   {"note", event.value("note", "")}});
  } else if (action_type == "work.artifact.recorded") {
    item["artifacts"].push_back(
        {{"time", gen_time}, {"ref", event.value("ref", "")}, {"kind", event.value("kind", "")}});
  } else if (action_type == "work.run.linked") {
    item["runs"].push_back({{"time", gen_time}, {"runId", event.value("run_id", "")}});
  }
}

lifecycle_state load_lifecycle_state(const std::string &runtime_dir) {
  lifecycle_state state{};
  const auto replay = replay_events(runtime_dir);
  state.records = replay.at("events");
  auto roots = nlohmann::json::array();
  for (const auto &record : state.records) {
    roots.push_back(record.at("recordRoot"));
    fold_record(state, record);
  }
  state.journal_root = protocol_root(WORK_JOURNAL_ROOT_PROTOCOL_V1, {{"recordRoots", std::move(roots)}});
  for (auto &[work_id, item] : state.items.items())
    item["workRoot"] = item_root(work_id, item.at("recordRoots"));
  return state;
}

nlohmann::json lifecycle_receipt(std::string schema, std::string status, std::string reason_code,
                                 const std::string &operation_id, const lifecycle_state &state) {
  return {{"schema", std::move(schema)},
          {"operationId", operation_id},
          {"status", std::move(status)},
          {"reasonCode", std::move(reason_code)},
          {"journalRoot", state.journal_root},
          {"authority", "native-work-journal"},
          {"authorityExecuted", false},
          {"admitted", false},
          {"writeOccurred", false}};
}

nlohmann::json finalize_lifecycle_receipt(nlohmann::json receipt) {
  receipt.erase("receiptRoot");
  receipt["receiptRoot"] = protocol_root("kungfu.work.lifecycle-receipt/v1", receipt);
  return receipt;
}

bool has_record_root(const nlohmann::json &item, const std::string &record_root) {
  return std::any_of(item.at("recordRoots").begin(), item.at("recordRoots").end(), [&](const auto &root) {
    return root.is_string() && root.template get<std::string>() == record_root;
  });
}

nlohmann::json require_mutation_basis(const std::string &operation_id, const nlohmann::json &input,
                                      const lifecycle_state &state, const nlohmann::json *item,
                                      const std::string &receipt_schema) {
  auto receipt = lifecycle_receipt(receipt_schema, "denied", "missing-authority", operation_id, state);
  const auto expected_request_root = lifecycle_request_root(operation_id, input);
  receipt["requestRoot"] = expected_request_root;
  if (!input.contains("requestRoot") || !input.at("requestRoot").is_string() ||
      input.at("requestRoot").get<std::string>() != expected_request_root) {
    receipt["message"] = "requestRoot does not match the canonical lifecycle request";
    return receipt;
  }
  const auto expected_journal = optional_root(input, "expectedJournalRoot");
  if (!expected_journal.has_value() || *expected_journal != state.journal_root) {
    receipt["reasonCode"] = "stale-ref";
    receipt["errorClass"] = "stale-ref";
    receipt["message"] = "expectedJournalRoot does not match native Work authority";
    return receipt;
  }
  if (item != nullptr) {
    const auto expected_work = optional_root(input, "expectedWorkRoot");
    if (!expected_work.has_value() || *expected_work != item->at("workRoot").get<std::string>()) {
      receipt["reasonCode"] = "stale-ref";
      receipt["errorClass"] = "stale-ref";
      receipt["message"] = "expectedWorkRoot does not match native Work authority";
      return receipt;
    }
  }
  receipt["status"] = "verified";
  receipt["reasonCode"] = "ok";
  return receipt;
}

nlohmann::json append_lifecycle_event(const std::string &runtime_dir, const std::string &operation_id,
                                      const std::string &receipt_schema, const lifecycle_state &before,
                                      const std::string &action_type, const nlohmann::json &event,
                                      const std::string &request_root, const std::string &work_id) {
  const auto authority_receipt = append_event(runtime_dir, {{"actionType", action_type}, {"event", event}});
  const auto after = load_lifecycle_state(runtime_dir);
  auto receipt = lifecycle_receipt(receipt_schema, "admitted", "ok", operation_id, after);
  receipt["authorityExecuted"] = true;
  receipt["admitted"] = true;
  receipt["writeOccurred"] = true;
  receipt["requestRoot"] = request_root;
  receipt["recordRoot"] = authority_receipt.at("recordRoot");
  receipt["authorityReceipt"] = authority_receipt;
  receipt["predecessorJournalRoot"] = before.journal_root;
  receipt["successorJournalRoot"] = after.journal_root;
  if (after.items.contains(work_id)) {
    receipt["workId"] = work_id;
    receipt["successorWorkRoot"] = after.items.at(work_id).at("workRoot");
    if (before.items.contains(work_id))
      receipt["predecessorWorkRoot"] = before.items.at(work_id).at("workRoot");
    else
      receipt["predecessorWorkRoot"] = nullptr;
  }
  return finalize_lifecycle_receipt(std::move(receipt));
}

nlohmann::json inspect_work(const std::string &operation_id, const nlohmann::json &input,
                            const lifecycle_state &state) {
  auto receipt = lifecycle_receipt("kungfu.work.query-result/v1", "current", "ok", operation_id, state);
  if (const auto expected = optional_root(input, "expectedJournalRoot");
      expected.has_value() && *expected != state.journal_root) {
    receipt["status"] = "denied";
    receipt["reasonCode"] = "root-mismatch";
    receipt["errorClass"] = "root-mismatch";
    receipt["message"] = "expectedJournalRoot does not match native Work authority";
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  receipt["authorityExecuted"] = true;
  receipt["admitted"] = true;
  receipt["queryBasis"] = {{"journalRoot", state.journal_root}};
  receipt["records"] = state.records;
  receipt["unknownRecords"] = state.unknown_records;
  if (input.contains("workId")) {
    const auto work_id = required_text(input, "workId");
    receipt["queryBasis"]["workId"] = work_id;
    receipt["item"] = state.items.contains(work_id) ? state.items.at(work_id) : nlohmann::json(nullptr);
    if (!state.items.contains(work_id)) {
      receipt["status"] = "not-found";
      receipt["reasonCode"] = "evidence-unavailable";
    }
  } else {
    receipt["items"] = state.items;
  }
  return finalize_lifecycle_receipt(std::move(receipt));
}

nlohmann::json create_work(const std::string &runtime_dir, const std::string &operation_id, const nlohmann::json &input,
                           bool execute, const lifecycle_state &state) {
  const auto work_id = required_text(input, "workId");
  const nlohmann::json event = {{"work_id", work_id},
                                {"title", required_text(input, "title")},
                                {"kind", required_text(input, "kind")},
                                {"schema_version", WORK_SCHEMA_VERSION}};
  auto normalized_event = event;
  if (input.contains("summary")) {
    if (!input.at("summary").is_string())
      throw std::invalid_argument("summary must be a string");
    normalized_event["summary"] = input.at("summary");
  }
  const auto encoded = encoded_event("work.item.created", normalized_event);
  const auto request_root = lifecycle_request_root(operation_id, input);
  if (state.items.contains(work_id)) {
    auto receipt =
        lifecycle_receipt("kungfu.work.admission-receipt/v1", "denied", "identity-conflict", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["workId"] = work_id;
    receipt["workRoot"] = state.items.at(work_id).at("workRoot");
    if (has_record_root(state.items.at(work_id), encoded.at("recordRoot").get<std::string>()) &&
        input.value("requestRoot", std::string{}) == request_root) {
      receipt["status"] = "current";
      receipt["reasonCode"] = "ok";
      receipt["authorityExecuted"] = true;
      receipt["admitted"] = true;
      receipt["recordRoot"] = encoded.at("recordRoot");
    }
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  if (!execute) {
    auto receipt = lifecycle_receipt("kungfu.work.admission-receipt/v1", "prepared", "ok", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["recordRoot"] = encoded.at("recordRoot");
    receipt["workId"] = work_id;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto basis = require_mutation_basis(operation_id, input, state, nullptr, "kungfu.work.admission-receipt/v1");
  if (basis.at("status") != "verified")
    return finalize_lifecycle_receipt(basis);
  return append_lifecycle_event(runtime_dir, operation_id, "kungfu.work.admission-receipt/v1", state,
                                "work.item.created", normalized_event, request_root, work_id);
}

nlohmann::json update_work(const std::string &runtime_dir, const std::string &operation_id, const nlohmann::json &input,
                           bool execute, const lifecycle_state &state) {
  const auto work_id = required_text(input, "workId");
  const auto action_type = required_text(input, "actionType");
  if (action_type == "work.item.created" || action_type == "work.status.changed" ||
      !EVENT_BINDINGS.contains(action_type))
    throw std::invalid_argument("update actionType must be a supported non-create, non-transition Work event");
  if (!input.contains("event") || !input.at("event").is_object())
    throw std::invalid_argument("event must be an object");
  auto event = input.at("event");
  if (event.contains("work_id") && event.at("work_id") != work_id)
    throw std::invalid_argument("event.work_id must match workId");
  event["work_id"] = work_id;
  const auto encoded = encoded_event(action_type, event);
  const auto request_root = lifecycle_request_root(operation_id, input);
  if (!state.items.contains(work_id)) {
    auto receipt =
        lifecycle_receipt("kungfu.work.event-receipt/v1", "denied", "evidence-unavailable", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["workId"] = work_id;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto &item = state.items.at(work_id);
  if (has_record_root(item, encoded.at("recordRoot").get<std::string>()) &&
      (!execute || input.value("requestRoot", std::string{}) == request_root)) {
    auto receipt = lifecycle_receipt("kungfu.work.event-receipt/v1", "current", "ok", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["recordRoot"] = encoded.at("recordRoot");
    receipt["workId"] = work_id;
    receipt["workRoot"] = item.at("workRoot");
    receipt["authorityExecuted"] = true;
    receipt["admitted"] = true;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  if (!execute) {
    auto receipt = lifecycle_receipt("kungfu.work.event-receipt/v1", "prepared", "ok", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["recordRoot"] = encoded.at("recordRoot");
    receipt["workId"] = work_id;
    receipt["predecessorWorkRoot"] = item.at("workRoot");
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto basis = require_mutation_basis(operation_id, input, state, &item, "kungfu.work.event-receipt/v1");
  if (basis.at("status") != "verified")
    return finalize_lifecycle_receipt(basis);
  return append_lifecycle_event(runtime_dir, operation_id, "kungfu.work.event-receipt/v1", state, action_type, event,
                                request_root, work_id);
}

int64_t requested_status(const nlohmann::json &input) {
  if (!input.contains("status"))
    throw std::invalid_argument("status is required");
  if (input.at("status").is_number_integer()) {
    const auto value = input.at("status").get<int64_t>();
    if (!STATUS_NAMES.contains(value))
      throw std::invalid_argument("status must be an Agent Work status in [0, 4]");
    return value;
  }
  if (input.at("status").is_string()) {
    const auto value = input.at("status").get<std::string>();
    if (!STATUS_VALUES.contains(value))
      throw std::invalid_argument("status must be active, waiting, blocked, ready, or done");
    return STATUS_VALUES.at(value);
  }
  throw std::invalid_argument("status must be an integer or string");
}

nlohmann::json transition_work(const std::string &runtime_dir, const std::string &operation_id,
                               const nlohmann::json &input, bool execute, const lifecycle_state &state) {
  const auto work_id = required_text(input, "workId");
  const auto status_value = requested_status(input);
  const auto status_name = STATUS_NAMES.at(status_value);
  const auto request_root = lifecycle_request_root(operation_id, input);
  if (!state.items.contains(work_id)) {
    auto receipt =
        lifecycle_receipt("kungfu.work.transition-receipt/v1", "denied", "evidence-unavailable", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["workId"] = work_id;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto &item = state.items.at(work_id);
  const auto current_status = item.value("status", std::string{});
  auto event = nlohmann::json{{"work_id", work_id}, {"status", status_value}};
  if (input.contains("reason")) {
    if (!input.at("reason").is_string())
      throw std::invalid_argument("reason must be a string");
    event["reason"] = input.at("reason");
  }
  const auto encoded = encoded_event("work.status.changed", event);
  if (has_record_root(item, encoded.at("recordRoot").get<std::string>()) &&
      (!execute || input.value("requestRoot", std::string{}) == request_root)) {
    auto receipt = lifecycle_receipt("kungfu.work.transition-receipt/v1", "current", "ok", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["recordRoot"] = encoded.at("recordRoot");
    receipt["workId"] = work_id;
    receipt["workRoot"] = item.at("workRoot");
    receipt["authorityExecuted"] = true;
    receipt["admitted"] = true;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  if (current_status == status_name || current_status == "done") {
    auto receipt =
        lifecycle_receipt("kungfu.work.transition-receipt/v1", "denied", "invalid-transition", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["workId"] = work_id;
    receipt["currentStatus"] = current_status;
    receipt["requestedStatus"] = status_name;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  if (!execute) {
    auto receipt = lifecycle_receipt("kungfu.work.transition-receipt/v1", "prepared", "ok", operation_id, state);
    receipt["requestRoot"] = request_root;
    receipt["recordRoot"] = encoded.at("recordRoot");
    receipt["workId"] = work_id;
    receipt["currentStatus"] = current_status;
    receipt["requestedStatus"] = status_name;
    receipt["predecessorWorkRoot"] = item.at("workRoot");
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto basis = require_mutation_basis(operation_id, input, state, &item, "kungfu.work.transition-receipt/v1");
  if (basis.at("status") != "verified")
    return finalize_lifecycle_receipt(basis);
  auto receipt = append_lifecycle_event(runtime_dir, operation_id, "kungfu.work.transition-receipt/v1", state,
                                        "work.status.changed", event, request_root, work_id);
  receipt["previousStatus"] = current_status;
  receipt["statusValue"] = status_name;
  return finalize_lifecycle_receipt(std::move(receipt));
}

nlohmann::json export_work(const std::string &operation_id, const nlohmann::json &input, const lifecycle_state &state) {
  auto receipt = lifecycle_receipt("kungfu.work.export-receipt/v1", "current", "ok", operation_id, state);
  if (const auto expected = optional_root(input, "expectedJournalRoot");
      expected.has_value() && *expected != state.journal_root) {
    receipt["status"] = "denied";
    receipt["reasonCode"] = "root-mismatch";
    receipt["errorClass"] = "root-mismatch";
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  auto records = nlohmann::json::array();
  for (const auto &record : state.records) {
    records.push_back({{"envelopeHex", record.at("envelopeHex")},
                       {"recordRoot", record.at("recordRoot")},
                       {"genTime", record.at("genTime")}});
  }
  nlohmann::json bundle = {{"schema", WORK_EXPORT_BUNDLE_PROTOCOL_V1},
                           {"readerVersion", 1},
                           {"journalRoot", state.journal_root},
                           {"records", std::move(records)}};
  receipt["bundleRoot"] = protocol_root(WORK_EXPORT_BUNDLE_PROTOCOL_V1, bundle);
  receipt["bundle"] = std::move(bundle);
  receipt["recordCount"] = state.records.size();
  receipt["unknownRecordCount"] = state.unknown_records.size();
  receipt["authorityExecuted"] = true;
  receipt["admitted"] = true;
  return finalize_lifecycle_receipt(std::move(receipt));
}

nlohmann::json import_work(const std::string &runtime_dir, const std::string &operation_id, const nlohmann::json &input,
                           bool execute, const lifecycle_state &state) {
  if (!input.contains("bundle") || !input.at("bundle").is_object())
    throw std::invalid_argument("bundle must be an object");
  const auto &bundle = input.at("bundle");
  if (bundle.value("schema", "") != WORK_EXPORT_BUNDLE_PROTOCOL_V1 || bundle.value("readerVersion", 0) != 1 ||
      !bundle.contains("records") || !bundle.at("records").is_array())
    throw std::invalid_argument("bundle is not a compatible Work export bundle");
  const auto actual_bundle_root = protocol_root(WORK_EXPORT_BUNDLE_PROTOCOL_V1, bundle);
  const auto declared_bundle_root = optional_root(input, "bundleRoot");
  auto receipt = lifecycle_receipt("kungfu.work.import-receipt/v1", "denied", "root-mismatch", operation_id, state);
  receipt["bundleRoot"] = actual_bundle_root;
  receipt["requestRoot"] = lifecycle_request_root(operation_id, input);
  if (!declared_bundle_root.has_value() || *declared_bundle_root != actual_bundle_root) {
    receipt["message"] = "bundleRoot does not match the exact Work export bundle";
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto empty_root = protocol_root(WORK_JOURNAL_ROOT_PROTOCOL_V1, {{"recordRoots", nlohmann::json::array()}});
  if (state.journal_root != empty_root) {
    receipt["reasonCode"] = "migration-incompatible";
    receipt["message"] = "Work import requires an empty destination journal";
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  auto decoded_records = std::vector<std::vector<uint8_t>>{};
  auto imported_roots = nlohmann::json::array();
  auto imported_gen_times = std::vector<int64_t>{};
  for (const auto &record : bundle.at("records")) {
    if (!record.is_object() || !record.contains("envelopeHex") || !record.at("envelopeHex").is_string() ||
        !record.contains("recordRoot") || !record.at("recordRoot").is_string())
      throw std::invalid_argument("every import record requires envelopeHex and recordRoot");
    std::string bytes_text;
    try {
      bytes_text = hex_decode(record.at("envelopeHex").get<std::string>());
    } catch (const std::runtime_error &error) {
      throw std::invalid_argument("import envelopeHex is invalid: " + std::string(error.what()));
    }
    std::vector<uint8_t> bytes(bytes_text.begin(), bytes_text.end());
    std::string error;
    if (!view::action::decode(bytes, &error).has_value())
      throw std::invalid_argument("import record is not a valid ActionEnvelope: " + error);
    const auto preimage = record_root_preimage(bytes_text);
    const auto root = content_root(preimage);
    if (root != record.at("recordRoot").get<std::string>())
      throw std::invalid_argument("import recordRoot does not match exact envelope bytes");
    imported_roots.push_back(root);
    decoded_records.push_back(std::move(bytes));
    imported_gen_times.push_back(record.value("genTime", int64_t{0}));
  }
  const auto imported_journal_root = protocol_root(WORK_JOURNAL_ROOT_PROTOCOL_V1, {{"recordRoots", imported_roots}});
  if (bundle.value("journalRoot", "") != imported_journal_root) {
    receipt["message"] = "bundle journalRoot does not match its exact record sequence";
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  if (!execute) {
    receipt["status"] = "prepared";
    receipt["reasonCode"] = "ok";
    receipt["recordCount"] = decoded_records.size();
    receipt["successorJournalRoot"] = imported_journal_root;
    return finalize_lifecycle_receipt(std::move(receipt));
  }
  const auto basis = require_mutation_basis(operation_id, input, state, nullptr, "kungfu.work.import-receipt/v1");
  if (basis.at("status") != "verified")
    return finalize_lifecycle_receipt(basis);
  (void)emit_manifest(runtime_dir);
  action_recorder recorder(runtime_dir, WORK_NAMESPACE, WORK_JOURNAL_NAME);
  for (size_t index = 0; index < decoded_records.size(); ++index) {
    record_options options{};
    options.gen_time = imported_gen_times.at(index);
    (void)recorder.record_bytes(view::action::ACTION_ENVELOPE_CARRIER_TYPE, decoded_records.at(index), options);
  }
  const auto after = load_lifecycle_state(runtime_dir);
  receipt = lifecycle_receipt(
      "kungfu.work.import-receipt/v1", after.journal_root == imported_journal_root ? "admitted" : "unknown",
      after.journal_root == imported_journal_root ? "ok" : "import-interrupted", operation_id, after);
  receipt["bundleRoot"] = actual_bundle_root;
  receipt["requestRoot"] = lifecycle_request_root(operation_id, input);
  receipt["predecessorJournalRoot"] = state.journal_root;
  receipt["successorJournalRoot"] = after.journal_root;
  receipt["recordCount"] = decoded_records.size();
  receipt["authorityExecuted"] = true;
  receipt["admitted"] = after.journal_root == imported_journal_root;
  receipt["writeOccurred"] = !decoded_records.empty();
  return finalize_lifecycle_receipt(std::move(receipt));
}

} // namespace

nlohmann::json work_journal_capabilities() {
  auto actions = nlohmann::json::array();
  for (const auto &[action_type, binding] : EVENT_BINDINGS) {
    actions.push_back(
        {{"actionType", action_type}, {"eventSchema", binding.schema_id}, {"eventSchemaVersion", WORK_SCHEMA_VERSION}});
  }
  return {
      {"schema", "kungfu.work-journal.capabilities/v1"},
      {"protocol", WORK_JOURNAL_PROTOCOL_V1},
      {"recordRootProtocol", WORK_RECORD_ROOT_PROTOCOL_V1},
      {"authority", "libkungfu-native-work-journal"},
      {"writer", "native-only"},
      {"modes", nlohmann::json::array({"capabilities", "encode", "append", "append_batch", "emit_manifest", "replay"})},
      {"schemaSourceRoot", work_schema().source_root},
      {"schemaBfbsRoot", work_schema().bfbs_root},
      {"actions", std::move(actions)}};
}

nlohmann::json run_work_journal_operation(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!request.is_object())
    throw std::invalid_argument("work_journal request must be an object");
  const auto mode = request.value("mode", std::string{"capabilities"});
  if (mode == "capabilities")
    return work_journal_capabilities();
  if (mode == "encode")
    return encoded_event(required_text(request, "actionType"), request.value("event", nlohmann::json::object()));
  if (mode == "append")
    return append_event(runtime_dir, request);
  if (mode == "append_batch")
    return append_batch(runtime_dir, request);
  if (mode == "emit_manifest")
    return {{"schema", "kungfu.work-journal.manifest-receipt/v1"},
            {"manifestPath", emit_manifest(runtime_dir).string()},
            {"schemaSourceRoot", work_schema().source_root},
            {"schemaBfbsRoot", work_schema().bfbs_root}};
  if (mode == "replay")
    return replay_events(runtime_dir);
  throw std::invalid_argument("unknown work_journal mode: " + mode);
}

nlohmann::json run_work_lifecycle_operation(const std::string &runtime_dir, const std::string &operation_id,
                                            const nlohmann::json &input, bool execute) {
  if (!input.is_object())
    throw std::invalid_argument("Work lifecycle input must be an object");
  const auto state = load_lifecycle_state(runtime_dir);
  if (operation_id == "work.lifecycle.work.inspect/v1")
    return inspect_work(operation_id, input, state);
  if (operation_id == "work.lifecycle.work.create/v1")
    return create_work(runtime_dir, operation_id, input, execute, state);
  if (operation_id == "work.lifecycle.work.update/v1")
    return update_work(runtime_dir, operation_id, input, execute, state);
  if (operation_id == "work.lifecycle.work.transition/v1")
    return transition_work(runtime_dir, operation_id, input, execute, state);
  if (operation_id == "work.lifecycle.work.export/v1")
    return export_work(operation_id, input, state);
  if (operation_id == "work.lifecycle.work.import/v1")
    return import_work(runtime_dir, operation_id, input, execute, state);
  throw std::invalid_argument("unsupported native Work lifecycle operation: " + operation_id);
}

} // namespace kungfu::runtime::action
