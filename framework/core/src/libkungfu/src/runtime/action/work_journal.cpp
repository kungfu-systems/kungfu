// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/work_journal.h>

#include <kungfu/runtime/action/work_event_schema.h>
#include <kungfu/runtime/action_recorder.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <flatbuffers/flatbuffers.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
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
        const auto found = EVENT_BINDINGS.find(envelope->action_type);
        if (found != EVENT_BINDINGS.end() && envelope->schema_ref.id == found->second.schema_id &&
            envelope->schema_ref.version == WORK_SCHEMA_VERSION && envelope->payload.has_value() &&
            envelope->payload->encoding == view::action::payload_encoding::FlatBuffers) {
          const auto &payload = envelope->payload->data;
          const auto decoded =
              work_schema().handle.decode_json(payload.data(), payload.size(), true, found->second.object_name);
          if (!decoded.ok)
            throw std::runtime_error("cannot decode Agent Work event: " + decoded.error);
          const auto envelope_bytes =
              std::string_view(reinterpret_cast<const char *>(frame->data_as_bytes()), frame->data_length());
          const auto preimage = record_root_preimage(envelope_bytes);
          events.push_back({{"actionType", envelope->action_type},
                            {"event", nlohmann::json::parse(decoded.json)},
                            {"payloadHex", hex_encode(std::string_view(reinterpret_cast<const char *>(payload.data()),
                                                                       payload.size()))},
                            {"envelopeHex", hex_encode(envelope_bytes)},
                            {"recordRoot", content_root(preimage)},
                            {"frameUid", frame->frame_uid()},
                            {"triggerFrameUid", frame->trigger_frame_uid()},
                            {"genTime", frame->gen_time()}});
        }
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

} // namespace kungfu::runtime::action
