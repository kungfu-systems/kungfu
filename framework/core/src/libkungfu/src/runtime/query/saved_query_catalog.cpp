// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/query/saved_query_catalog.h>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/query/fact_query.h>
#include <kungfu/runtime/query/saved_query_catalog_schema.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/time.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace kungfu::runtime::query {

namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr uint32_t EVENT_SCHEMA_VERSION = 1;
constexpr const char *CATALOG_NAMESPACE = "query";
constexpr const char *CATALOG_NAME = "saved-query-catalog";

struct schema_contract {
  view::schema_handle handle;
  std::string root;
};

struct catalog_record {
  nlohmann::json event = nlohmann::json::object();
  uint64_t frame_uid = 0;
  int64_t frame_gen_time = 0;
};

std::string content_root(const std::string &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value));
}

const schema_contract &catalog_schema() {
  static const auto contract = [] {
    const auto compiled = view::compile_schema(schema::SAVED_QUERY_CATALOG_EVENT_FBS, false);
    if (!compiled.ok) {
      throw std::runtime_error("cannot compile saved-query catalog schema: " + compiled.error);
    }
    return schema_contract{view::schema_handle::from_bytes(compiled.bfbs),
                           content_root(std::string(schema::SAVED_QUERY_CATALOG_EVENT_FBS))};
  }();
  return contract;
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

uint64_t revision_of(const nlohmann::json &value) {
  if (!value.contains("revision")) {
    return 0;
  }
  return value.at("revision").get<uint64_t>();
}

void validate_query_id(const std::string &query_id) {
  if (query_id.empty() || query_id.size() > 96 || !std::all_of(query_id.begin(), query_id.end(), [](unsigned char ch) {
        return std::isalnum(ch) != 0 || ch == '-' || ch == '_' || ch == '.';
      })) {
    throw std::invalid_argument("query_id must be 1..96 characters of [A-Za-z0-9._-]");
  }
}

nlohmann::json normalize_saved_view(const nlohmann::json &input) {
  if (!input.is_object() || text_or(input, "schema") != QUERY_VIEW_SCHEMA_V1) {
    throw std::invalid_argument("saved query must use kungfu.query.saved-view/v1");
  }
  const auto name = required_text(input, "name");
  if (!input.contains("definition") || !input.at("definition").is_object()) {
    throw std::invalid_argument("saved query requires a QueryDefinition");
  }
  if (!input.contains("view") || !input.at("view").is_object()) {
    throw std::invalid_argument("saved query requires a ViewSpec");
  }
  const auto view_kind = text_or(input.at("view"), "kind");
  if (view_kind != "table" && view_kind != "timeline" && view_kind != "diff" && view_kind != "causal-graph" &&
      view_kind != "attention") {
    throw std::invalid_argument("saved query requires a supported ViewSpec");
  }
  const auto definition = parse_query_definition(input.at("definition"));
  (void)plan_query(definition);
  return {{"schema", QUERY_VIEW_SCHEMA_V1},
          {"name", name},
          {"definition", query_definition_json(definition)},
          {"view", input.at("view")}};
}

std::vector<uint8_t> encode_event(const nlohmann::json &event) {
  const auto encoded = catalog_schema().handle.encode_json(event.dump());
  if (!encoded.ok) {
    throw std::invalid_argument("saved-query event does not match its FlatBuffers owner: " + encoded.error);
  }
  return std::vector<uint8_t>(encoded.bytes.begin(), encoded.bytes.end());
}

std::vector<catalog_record> read_events(const std::string &runtime_dir) {
  std::vector<catalog_record> records;
  const auto journal_dir =
      std::filesystem::path(runtime_dir) / "journal" / "system" / CATALOG_NAMESPACE / CATALOG_NAME / "live";
  if (!std::filesystem::exists(journal_dir)) {
    return records;
  }
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  CATALOG_NAMESPACE, CATALOG_NAME, locator);
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value()) {
          throw std::runtime_error("cannot decode saved-query action envelope: " + error);
        }
        if (envelope->schema_ref.id == SAVED_QUERY_EVENT_SCHEMA_V1 &&
            envelope->schema_ref.version == EVENT_SCHEMA_VERSION && envelope->payload.has_value() &&
            envelope->payload->encoding == view::action::payload_encoding::FlatBuffers) {
          const auto &payload = envelope->payload->data;
          const auto decoded = catalog_schema().handle.decode_json(payload.data(), payload.size());
          if (!decoded.ok) {
            throw std::runtime_error("cannot decode saved-query event: " + decoded.error);
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

std::map<std::string, catalog_record> fold_catalog(const std::vector<catalog_record> &records) {
  std::map<std::string, catalog_record> current;
  for (const auto &record : records) {
    const auto query_id = text_or(record.event, "query_id");
    if (query_id.empty()) {
      continue;
    }
    const auto found = current.find(query_id);
    if (found == current.end() || revision_of(record.event) > revision_of(found->second.event)) {
      current[query_id] = record;
    }
  }
  return current;
}

nlohmann::json render_entry(const catalog_record &record) {
  const auto &event = record.event;
  nlohmann::json result = {{"schema", "kungfu.query.saved-query-entry/v1"},
                           {"query_id", text_or(event, "query_id")},
                           {"revision", revision_of(event)},
                           {"previous_revision", event.value("previous_revision", uint64_t{0})},
                           {"state", text_or(event, "kind") == "Deleted" ? "deleted" : "active"},
                           {"event_id", text_or(event, "event_id")},
                           {"system_time", event.value("system_time", int64_t{0})},
                           {"saved_view_hash", text_or(event, "saved_view_hash")},
                           {"journal_frame_uid", record.frame_uid}};
  const auto saved_text = text_or(event, "saved_view_json");
  if (!saved_text.empty()) {
    result["saved_view"] = nlohmann::json::parse(saved_text);
  }
  return result;
}

nlohmann::json make_event(const std::string &kind, const std::string &query_id, uint64_t revision,
                          uint64_t previous_revision, int64_t system_time, const nlohmann::json &saved_view) {
  const auto saved_text = saved_view.dump();
  const auto saved_hash = content_root(saved_text);
  nlohmann::json event = {{"schema_version", EVENT_SCHEMA_VERSION},
                          {"event_id", ""},
                          {"query_id", query_id},
                          {"revision", revision},
                          {"previous_revision", previous_revision},
                          {"kind", kind},
                          {"system_time", system_time},
                          {"saved_view_hash", saved_hash},
                          {"saved_view_json", saved_text}};
  auto identity = event;
  identity.erase("event_id");
  event["event_id"] = content_root(identity.dump());
  return event;
}

catalog_record append_event(const std::string &runtime_dir, const nlohmann::json &event) {
  action::action_recorder recorder(runtime_dir, CATALOG_NAMESPACE, CATALOG_NAME);
  yy_storage::episode_manifest_store episodes(runtime_dir);
  yy_storage::episode_begin_options begin_options{};
  begin_options.location_uid = recorder.get_location()->uid;
  begin_options.begin_time = event.at("system_time").get<int64_t>();
  begin_options.title = "saved query " + text_or(event, "kind") + ": " + text_or(event, "query_id");
  begin_options.actor = "libkungfu";
  begin_options.source = "saved-query-catalog";
  const auto opened = episodes.begin(begin_options);

  view::action::envelope envelope{};
  envelope.action_type = "query.saved." + text_or(event, "kind");
  envelope.schema_ref = {SAVED_QUERY_EVENT_SCHEMA_V1, EVENT_SCHEMA_VERSION};
  envelope.payload = view::action::payload_view{view::action::payload_encoding::FlatBuffers,
                                                encode_event(event),
                                                {},
                                                {},
                                                0,
                                                "application/vnd.kungfu.saved-query-event+flatbuffers",
                                                "present"};
  action::record_options record_options{};
  record_options.gen_time = event.at("system_time").get<int64_t>();
  const auto receipt = recorder.record_action(envelope, record_options);

  yy_storage::episode_frame_attach_options attached{};
  attached.episode_id = opened.episode_id;
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

  yy_storage::episode_ref_attach_options schema_ref{};
  schema_ref.episode_id = opened.episode_id;
  schema_ref.location_uid = recorder.get_location()->uid;
  schema_ref.ref_kind = yy::enums::EpisodeRefKind::Schema;
  schema_ref.update_time = record_options.gen_time;
  schema_ref.ref_id = SAVED_QUERY_EVENT_SCHEMA_V1;
  schema_ref.ref_hash = catalog_schema().root;
  (void)episodes.attach_ref(schema_ref);

  yy_storage::episode_close_options close_options{};
  close_options.episode_id = opened.episode_id;
  close_options.location_uid = recorder.get_location()->uid;
  close_options.status = yy::enums::EpisodeStatus::Ended;
  close_options.end_time = record_options.gen_time;
  close_options.last_frame_uid = receipt.frame_uid;
  close_options.frame_count = 1;
  close_options.reason = "saved-query lifecycle recorded";
  (void)episodes.end(close_options);
  return {event, receipt.frame_uid, receipt.gen_time};
}

catalog_record require_current(const std::string &runtime_dir, const std::string &query_id, bool include_deleted) {
  validate_query_id(query_id);
  const auto current = fold_catalog(read_events(runtime_dir));
  const auto found = current.find(query_id);
  if (found == current.end() || (!include_deleted && text_or(found->second.event, "kind") == "Deleted")) {
    throw std::invalid_argument("saved query not found: " + query_id);
  }
  return found->second;
}

} // namespace

nlohmann::json saved_query_catalog_contract() {
  return {{"schema", SAVED_QUERY_CATALOG_SCHEMA_V1},
          {"authority", "workspace-journal"},
          {"event_schema", SAVED_QUERY_EVENT_SCHEMA_V1},
          {"artifact_schema", QUERY_VIEW_SCHEMA_V1},
          {"operations", {"put", "get", "list", "history", "delete", "rebuild"}},
          {"journal", {{"namespace", CATALOG_NAMESPACE}, {"name", CATALOG_NAME}}},
          {"projection", "deterministic-in-memory-fold/v1"}};
}

nlohmann::json saved_query_put(const std::string &runtime_dir, const nlohmann::json &saved_view,
                               const std::string &requested_id, uint64_t expected_revision, int64_t system_time) {
  const auto normalized = normalize_saved_view(saved_view);
  auto query_id = requested_id;
  const auto current = fold_catalog(read_events(runtime_dir));
  if (query_id.empty()) {
    query_id = "sq-" + content_root(normalized.dump()).substr(7, 16);
  }
  validate_query_id(query_id);
  const auto found = current.find(query_id);
  const auto previous_revision = found == current.end() ? 0 : revision_of(found->second.event);
  const auto deleted = found != current.end() && text_or(found->second.event, "kind") == "Deleted";
  if (expected_revision != 0 && expected_revision != previous_revision) {
    throw std::invalid_argument("saved query revision conflict");
  }
  if (found != current.end() && !deleted && expected_revision == 0) {
    throw std::invalid_argument("saved query already exists; expected_revision is required to update");
  }
  const auto kind = found == current.end() || deleted ? "Created" : "Updated";
  const auto now = system_time == 0 ? yy::time::now_in_nano() : system_time;
  return render_entry(
      append_event(runtime_dir, make_event(kind, query_id, previous_revision + 1, previous_revision, now, normalized)));
}

nlohmann::json saved_query_get(const std::string &runtime_dir, const std::string &query_id, bool include_deleted) {
  return render_entry(require_current(runtime_dir, query_id, include_deleted));
}

nlohmann::json saved_query_list(const std::string &runtime_dir, bool include_deleted) {
  const auto current = fold_catalog(read_events(runtime_dir));
  auto entries = nlohmann::json::array();
  for (const auto &[query_id, record] : current) {
    (void)query_id;
    if (!include_deleted && text_or(record.event, "kind") == "Deleted") {
      continue;
    }
    entries.push_back(render_entry(record));
  }
  const auto count = entries.size();
  return {{"schema", SAVED_QUERY_CATALOG_SCHEMA_V1},
          {"runtime_dir", runtime_dir},
          {"entries", std::move(entries)},
          {"count", count}};
}

nlohmann::json saved_query_history(const std::string &runtime_dir, const std::string &query_id) {
  validate_query_id(query_id);
  auto history = nlohmann::json::array();
  for (const auto &record : read_events(runtime_dir)) {
    if (text_or(record.event, "query_id") == query_id) {
      history.push_back(render_entry(record));
    }
  }
  if (history.empty()) {
    throw std::invalid_argument("saved query not found: " + query_id);
  }
  return {{"schema", "kungfu.query.saved-query-history/v1"}, {"query_id", query_id}, {"events", std::move(history)}};
}

nlohmann::json saved_query_delete(const std::string &runtime_dir, const std::string &query_id,
                                  uint64_t expected_revision, int64_t system_time) {
  const auto current = require_current(runtime_dir, query_id, false);
  const auto previous_revision = revision_of(current.event);
  if (expected_revision != 0 && expected_revision != previous_revision) {
    throw std::invalid_argument("saved query revision conflict");
  }
  const auto saved_view = nlohmann::json::parse(required_text(current.event, "saved_view_json"));
  const auto now = system_time == 0 ? yy::time::now_in_nano() : system_time;
  return render_entry(append_event(
      runtime_dir, make_event("Deleted", query_id, previous_revision + 1, previous_revision, now, saved_view)));
}

nlohmann::json saved_query_rebuild(const std::string &runtime_dir) {
  const auto records = read_events(runtime_dir);
  const auto current = fold_catalog(records);
  uint64_t active = 0;
  for (const auto &[query_id, record] : current) {
    (void)query_id;
    active += text_or(record.event, "kind") == "Deleted" ? 0 : 1;
  }
  return {{"schema", "kungfu.query.saved-query-rebuild/v1"},
          {"ok", true},
          {"authority_records", records.size()},
          {"catalog_entries", current.size()},
          {"active_entries", active},
          {"projection", "deterministic-in-memory-fold/v1"}};
}

} // namespace kungfu::runtime::query
