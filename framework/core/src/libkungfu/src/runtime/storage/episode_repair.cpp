// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/storage/sync_root.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace detail {

storage_repair_subject repair_subject(const storage_fsck_issue &issue) {
  return std::visit(
      [](const auto &detail) {
        using detail_t = std::decay_t<decltype(detail)>;
        storage_repair_subject subject{};
        if constexpr (std::is_same_v<detail_t, storage_fsck_cross_issue>) {
          subject.source_id = detail.source_id;
          subject.path = detail.path;
          subject.payload_hash = detail.payload_hash;
        } else if constexpr (std::is_same_v<detail_t, yy_storage::manifest_catalog_fsck_issue>) {
          subject.source_id = detail.source_id;
          subject.subject = detail.subject;
          subject.state = detail.state;
          subject.payload_hash = detail.payload_hash;
        } else if constexpr (std::is_same_v<detail_t, yy_storage::episode_fsck_issue>) {
          subject.episode_id = detail.episode_id;
          subject.dependency_episode_id = detail.dependency_episode_id;
          subject.frame_uid = detail.frame_uid;
          subject.dependent_frame_uid = detail.dependent_frame_uid;
          subject.ref_id = detail.ref_id;
          subject.ref_hash = detail.ref_hash;
        }
        return subject;
      },
      issue.detail);
}

std::optional<episode_repair_descriptor> repair_descriptor_for_issue(const storage_fsck_issue &issue) {
  const auto &code = issue.code;
  if (code == "episode_dependency_missing")
    return episode_repair_descriptor{"fetch_episode", {"source_or_episode_bundle"}};
  if (code == "episode_root_trigger_frame_missing" || code == "episode_trigger_frame_missing")
    return episode_repair_descriptor{"fetch_frame_or_declare_external_input", {"source_or_episode_bundle"}};
  if (code == "episode_payload_ref_missing" || code == "episode_payload_ref_hash_mismatch")
    return episode_repair_descriptor{"fetch_payload_by_hash", {"payload_store_or_episode_bundle"}};
  if (code == "payload_not_present") {
    const auto *detail = std::get_if<yy_storage::manifest_catalog_fsck_issue>(&issue.detail);
    if (detail != nullptr && !detail->intentional.value_or(true))
      return episode_repair_descriptor{"fetch_payload_by_hash", {"source_or_bundle"}};
  }
  return std::nullopt;
}

std::optional<storage_repair_candidate_view> repair_candidate_from_issue(const storage_fsck_issue &issue) {
  const auto &code = issue.code;
  const auto descriptor = repair_descriptor_for_issue(issue);
  if (!descriptor.has_value()) {
    return std::nullopt;
  }
  std::string candidate_code;
  std::string kind;
  std::string role;
  if (code == "episode_dependency_missing") {
    candidate_code = "repair_episode_dependency";
    kind = "episode";
    const auto *detail = std::get_if<yy_storage::episode_fsck_issue>(&issue.detail);
    role = detail == nullptr ? "ref" : detail->role.value_or("ref");
  } else if (code == "episode_root_trigger_frame_missing") {
    candidate_code = "repair_episode_root_trigger_frame";
    kind = "frame";
    role = "root_trigger";
  } else if (code == "episode_trigger_frame_missing") {
    candidate_code = "repair_episode_trigger_frame";
    kind = "frame";
    role = "trigger";
  } else if (code == "episode_payload_ref_missing" || code == "episode_payload_ref_hash_mismatch") {
    candidate_code = "repair_episode_payload_ref";
    kind = "payload";
    role = "payload_ref";
  } else if (code == "payload_not_present") {
    candidate_code = "repair_source_payload";
    kind = "payload";
    role = "source_record";
  } else {
    // Projection repair is exposed by the qualification contract through the
    // dedicated rebuild operation, not as a storage repair-plan bundle row.
    return std::nullopt;
  }
  return storage_repair_candidate_view{
      candidate_code,        code, kind, role, descriptor->action, false, descriptor->required_inputs,
      repair_subject(issue), issue};
}

storage_repair_plan_result repair_plan_typed_impl(const storage_repair_plan_request &request) {
  if (!request.dry_run) {
    throw std::invalid_argument("storage_repair_requires_dry_run");
  }
  storage_repair_plan_result result{};
  result.scope = request.scope;
  if (!request.source_id.empty())
    result.source_id = request.source_id;
  if (request.episode_id != 0)
    result.episode_id = request.episode_id;
  result.fsck =
      default_storage_service().fsck({request.runtime_dir, request.provider, request.provider_config_source,
                                      request.scope, request.source_id, request.episode_id, request.verify_frames});
  // Preserve the public plan ordering: degraded/fetchable warnings first,
  // then sealed-Episode errors whose missing facts can be supplied. Repair
  // fetch uses this order to prefer donor evidence before a local bundle that
  // merely repeats the broken payload/ref claim.
  for (const auto &issue : result.fsck.issues) {
    if (issue.severity == "error")
      continue;
    const auto candidate = repair_candidate_from_issue(issue);
    if (candidate.has_value())
      result.candidates.push_back(*candidate);
    else
      result.unsupported.push_back(issue);
  }
  for (const auto &issue : result.fsck.issues) {
    if (issue.severity != "error")
      continue;
    const auto candidate = repair_candidate_from_issue(issue);
    if (candidate.has_value())
      result.candidates.push_back(*candidate);
  }
  result.ok = result.fsck.ok;
  result.status = result.fsck.status;
  result.degraded = result.fsck.degraded;
  result.notes = {
      "Repair plan v1 is read-only and never fetches, deletes, compacts, or mutates storage.",
      "Candidates describe missing facts that a future importer or remote sync source may provide.",
  };
  return result;
}

nlohmann::json repair_plan_impl(const storage_service_options &options) {
  return render_storage_repair_plan_result(
      default_storage_service().repair_plan(parse_storage_repair_plan_request(options)));
}

yy_storage::episode_manifest_record parse_episode_bundle_record(const nlohmann::json &value) {
  yy_storage::episode_manifest_record parsed{};
  parsed.manifest_frame_uid = uint64_or(value, "manifest_frame_uid");
  parsed.manifest_gen_time = int64_or(value, "manifest_gen_time");
  const auto kind = text_or(value, "record_kind");
  const auto schema_version = uint32_or(value, "schema_version", 1);
  if (kind == "episode_open") {
    const auto options = parse_episode_begin_options(value);
    yijinjing::types::EpisodeOpen record{};
    record.schema_version = schema_version;
    record.episode_id = options.episode_id;
    record.parent_episode_id = options.parent_episode_id;
    record.root_trigger_frame_uid = options.root_trigger_frame_uid;
    record.location_uid = options.location_uid;
    record.begin_time = options.begin_time;
    assign_fixed(record.title, options.title);
    assign_fixed(record.actor, options.actor);
    assign_fixed(record.source, options.source);
    parsed.body = record;
  } else if (kind == "episode_heartbeat") {
    const auto options = parse_episode_heartbeat_options(value);
    yijinjing::types::EpisodeHeartbeat record{};
    record.schema_version = schema_version;
    record.episode_id = options.episode_id;
    record.location_uid = options.location_uid;
    record.update_time = options.update_time;
    record.last_frame_uid = options.last_frame_uid;
    record.frame_count = options.frame_count;
    assign_fixed(record.note, options.note);
    parsed.body = record;
  } else if (kind == "episode_frame_attached") {
    const auto options = parse_episode_frame_attach_options(value);
    yijinjing::types::EpisodeFrameAttached record{};
    record.schema_version = schema_version;
    record.episode_id = options.episode_id;
    record.location_uid = options.location_uid;
    record.frame_uid = options.frame_uid;
    record.trigger_frame_uid = options.trigger_frame_uid;
    record.stream_id = options.stream_id;
    record.gen_time = options.gen_time;
    record.trigger_time = options.trigger_time;
    record.carrier_type = options.carrier_type;
    record.source = options.source;
    record.dest = options.dest;
    record.data_length = options.data_length;
    record.integrity_version = options.integrity_version;
    record.payload_checksum = options.payload_checksum;
    record.frame_checksum = options.frame_checksum;
    parsed.body = record;
  } else if (kind == "episode_ref_attached") {
    const auto options = parse_episode_ref_attach_options(value);
    yijinjing::types::EpisodeRefAttached record{};
    record.schema_version = schema_version;
    record.episode_id = options.episode_id;
    record.location_uid = options.location_uid;
    record.ref_kind = options.ref_kind;
    record.ref_uid = options.ref_uid;
    record.update_time = options.update_time;
    assign_fixed(record.ref_id, options.ref_id);
    assign_fixed(record.ref_hash, options.ref_hash);
    parsed.body = record;
  } else if (kind == "episode_closed") {
    const auto options = parse_episode_close_options(value, yy_enums::EpisodeStatus::Ended);
    yijinjing::types::EpisodeClosed record{};
    record.schema_version = schema_version;
    record.episode_id = options.episode_id;
    record.location_uid = options.location_uid;
    record.status = options.status;
    record.end_time = options.end_time;
    record.last_frame_uid = options.last_frame_uid;
    record.frame_count = options.frame_count;
    assign_fixed(record.reason, options.reason);
    parsed.body = record;
  } else if (kind == "episode_root_committed") {
    yijinjing::types::EpisodeRootCommitted record{};
    record.schema_version = schema_version;
    record.episode_id = uint64_or(value, "episode_id");
    record.location_uid = uint32_or(value, "location_uid");
    record.commit_time = int64_or(value, "commit_time");
    record.covered_record_count = uint32_or(value, "covered_record_count");
    assign_fixed(record.algorithm, text_or(value, "algorithm"));
    assign_fixed(record.root_value, text_or(value, "root_value"));
    parsed.body = record;
  } else {
    throw std::invalid_argument("unsupported episode record kind: " + kind);
  }
  return parsed;
}

storage_episode_bundle_result parse_storage_episode_bundle(const nlohmann::json &bundle) {
  storage_episode_bundle_result parsed{};
  parsed.bundle_id = text_or(bundle, "bundle_id");
  parsed.episode_id = uint64_or(bundle, "episode_id", uint64_or(object_or_empty(bundle, "manifest"), "episode_id"));
  parsed.manifest.episode_id = parsed.episode_id;
  for (const auto &value : array_or_empty(bundle, "records")) {
    auto record = parse_episode_bundle_record(value);
    const auto index = parsed.manifest.records.size();
    if (std::holds_alternative<yijinjing::types::EpisodeFrameAttached>(record.body))
      parsed.manifest.frame_indices.push_back(index);
    if (std::holds_alternative<yijinjing::types::EpisodeRefAttached>(record.body))
      parsed.manifest.ref_indices.push_back(index);
    parsed.manifest.records.push_back(std::move(record));
  }
  const auto graph = object_or_empty(bundle, "causal_graph");
  parsed.causal_graph.schema = text_or(graph, "schema", "kungfu.episode.causal-graph/v1");
  parsed.causal_graph.episode_id = uint64_or(graph, "episode_id", parsed.episode_id);
  parsed.causal_graph.frame_count = uint64_or(graph, "frame_count", parsed.manifest.frame_indices.size());
  parsed.causal_graph.degraded = bool_or(graph, "degraded", bool_or(bundle, "degraded", false));
  for (const auto &edge : array_or_empty(graph, "edges")) {
    parsed.causal_graph.edges.push_back({uint64_or(edge, "from_frame_uid"), uint64_or(edge, "to_frame_uid")});
  }
  for (const auto &value : array_or_empty(bundle, "dependencies")) {
    yy_storage::episode_dependency dependency{};
    dependency.kind = text_or(value, "kind");
    dependency.role = text_or(value, "role");
    dependency.status = text_or(value, "status");
    if (value.contains("episode_id"))
      dependency.episode_id = uint64_or(value, "episode_id");
    if (value.contains("frame_uid"))
      dependency.frame_uid = uint64_or(value, "frame_uid");
    if (value.contains("dependent_frame_uid"))
      dependency.dependent_frame_uid = uint64_or(value, "dependent_frame_uid");
    if (value.contains("ref_uid"))
      dependency.ref_uid = uint64_or(value, "ref_uid");
    if (value.contains("ref_id"))
      dependency.ref_id = text_or(value, "ref_id");
    if (value.contains("ref_hash"))
      dependency.ref_hash = text_or(value, "ref_hash");
    parsed.causal_graph.dependencies.push_back(std::move(dependency));
  }
  // ADR-0053 material sections. Decoded frame bytes are validated against
  // their own header here, so a malformed or truncated bundle fails at the
  // edge instead of reaching a journal writer.
  parsed.self_contained = bool_or(bundle, "self_contained", false);
  for (const auto &value : array_or_empty(bundle, "journals")) {
    episode_journal_material journal{};
    const auto location = object_or_empty(value, "location");
    journal.role = text_or(location, "role");
    journal.namespace_ = text_or(location, "namespace");
    journal.name = text_or(location, "name");
    journal.mode = text_or(location, "mode", "live");
    journal.seed = uint32_or(location, "seed");
    journal.location_uid = uint32_or(location, "uid");
    journal.dest = uint32_or(value, "dest");
    for (const auto &row : array_or_empty(value, "frames")) {
      episode_frame_material frame{};
      frame.frame_uid = uint64_or(row, "frame_uid");
      frame.gen_time = int64_or(row, "gen_time");
      frame.carrier_type = static_cast<int32_t>(int64_or(row, "carrier_type"));
      frame.frame_length = uint32_or(row, "frame_length");
      frame.data_length = uint32_or(row, "data_length");
      frame.bytes = base64_decode(text_or(row, "bytes"));
      if (frame.bytes.size() != frame.frame_length ||
          frame.bytes.size() < sizeof(kungfu::yijinjing::types::frame_header)) {
        throw std::invalid_argument("episode_bundle_frame_bytes_malformed");
      }
      const auto &header = *reinterpret_cast<const kungfu::yijinjing::types::frame_header *>(frame.bytes.data());
      if (header.length != frame.frame_length || header.journal_frame_uid != frame.frame_uid ||
          header.gen_time != frame.gen_time || header.carrier_type != frame.carrier_type ||
          header.length < header.header_length ||
          static_cast<uint32_t>(header.length - header.header_length) != frame.data_length) {
        throw std::invalid_argument("episode_bundle_frame_header_mismatch");
      }
      journal.frames.push_back(std::move(frame));
    }
    parsed.journals.push_back(std::move(journal));
  }
  for (const auto &value : array_or_empty(bundle, "ref_payloads")) {
    episode_ref_payload_material payload{};
    payload.content_namespace = text_or(value, "content_namespace", "payloads");
    payload.ref_hash = text_or(value, "ref_hash");
    payload.bytes = base64_decode(text_or(value, "bytes"));
    payload.byte_len = payload.bytes.size();
    if (uint64_or(value, "byte_len", payload.byte_len) != payload.byte_len) {
      throw std::invalid_argument("episode_bundle_ref_payload_malformed");
    }
    parsed.ref_payloads.push_back(std::move(payload));
  }
  std::unordered_map<std::string, std::string> expected_ref_namespaces;
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (text_or(record, "record_kind") != "episode_ref_attached")
      continue;
    const auto ref_kind = text_or(record, "ref_kind");
    if (ref_kind == "schema") {
      expected_ref_namespaces[text_or(record, "ref_hash")] = "schemas";
    } else if (ref_kind == "payload") {
      expected_ref_namespaces[text_or(record, "ref_hash")] = "payloads";
    }
  }
  for (const auto &payload : parsed.ref_payloads) {
    const auto expected = expected_ref_namespaces.find(payload.ref_hash);
    if (expected == expected_ref_namespaces.end() || expected->second != payload.content_namespace) {
      throw std::invalid_argument("episode_bundle_ref_payload_namespace_mismatch");
    }
  }
  const auto material = object_or_empty(bundle, "material");
  parsed.material_missing_frame_count = uint64_or(material, "missing_frame_count");
  parsed.material_missing_ref_payload_count = uint64_or(material, "missing_ref_payload_count");
  return parsed;
}

bool episode_record_kind_supported(const std::string &kind) {
  return kind == "episode_open" || kind == "episode_heartbeat" || kind == "episode_frame_attached" ||
         kind == "episode_ref_attached" || kind == "episode_closed" || kind == "episode_root_committed";
}

std::string episode_record_kind(const yy_storage::episode_manifest_record &record) {
  return std::visit(
      [](const auto &body) -> std::string {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeOpen>)
          return "episode_open";
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeHeartbeat>)
          return "episode_heartbeat";
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeFrameAttached>)
          return "episode_frame_attached";
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRefAttached>)
          return "episode_ref_attached";
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeClosed>)
          return "episode_closed";
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRootCommitted>)
          return "episode_root_committed";
        return "unknown";
      },
      record.body);
}

std::string episode_record_identity_key(const yy_storage::episode_manifest_record &record) {
  return std::visit(
      [](const auto &body) -> std::string {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeOpen>) {
          return "episode_open:" + std::to_string(body.episode_id);
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeHeartbeat>) {
          return "episode_heartbeat:" + std::to_string(body.episode_id) + ":" + std::to_string(body.update_time);
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeFrameAttached>) {
          return "episode_frame_attached:" + std::to_string(body.episode_id) + ":" + std::to_string(body.frame_uid);
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRefAttached>) {
          return "episode_ref_attached:" + std::to_string(body.episode_id) + ":" +
                 std::to_string(static_cast<int32_t>(body.ref_kind)) + ":" + std::to_string(body.ref_uid) + ":" +
                 fixed_string(body.ref_id) + ":" + fixed_string(body.ref_hash);
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeClosed>) {
          return "episode_closed:" + std::to_string(body.episode_id);
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRootCommitted>) {
          return "episode_root_committed:" + std::to_string(body.episode_id);
        } else {
          return "unknown:" + std::to_string(body.carrier_type) + ":" + std::to_string(body.schema_version);
        }
      },
      record.body);
}

nlohmann::json episode_apply_record(const storage_service_options &options,
                                    const yy_storage::episode_manifest_record &record) {
  return std::visit(
      [&options](const auto &body) -> nlohmann::json {
        using body_t = std::decay_t<decltype(body)>;
        const auto store = episode_store(options);
        if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeOpen>) {
          return episode_record_body_json(store.begin(
              {body.episode_id, body.parent_episode_id, body.root_trigger_frame_uid, body.location_uid, body.begin_time,
               fixed_string(body.title), fixed_string(body.actor), fixed_string(body.source)}));
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeHeartbeat>) {
          return episode_record_body_json(
              store.heartbeat({body.episode_id, body.location_uid, body.update_time, body.last_frame_uid,
                               body.frame_count, fixed_string(body.note)}));
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeFrameAttached>) {
          return episode_record_body_json(store.attach_frame(
              {body.episode_id, body.location_uid, body.frame_uid, body.trigger_frame_uid, body.stream_id,
               body.gen_time, body.trigger_time, body.carrier_type, body.source, body.dest, body.data_length,
               body.integrity_version, body.payload_checksum, body.frame_checksum}));
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRefAttached>) {
          return episode_record_body_json(
              store.attach_ref({body.episode_id, body.location_uid, body.ref_kind, body.ref_uid, body.update_time,
                                fixed_string(body.ref_id), fixed_string(body.ref_hash)}));
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeClosed>) {
          const yy_storage::episode_close_options close{
              body.episode_id,  body.location_uid,        body.status, body.end_time, body.last_frame_uid,
              body.frame_count, fixed_string(body.reason)};
          return render_episode_close_write_result(body.status == yy_enums::EpisodeStatus::Aborted ? store.abort(close)
                                                                                                   : store.end(close));
        } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRootCommitted>) {
          auto row = episode_record_body_json(body);
          row["applied"] = "source_identity_claim";
          return row;
        }
        return nullptr;
      },
      record.body);
}

// ADR-0053 shared materializer: land the bundle's owned bytes in the
// destination data root. Frames append verbatim (the existing copy_frame
// primitive preserves the whole header, frame_uid included, and publishes
// last per ADR-0001); payloads write through the hash-addressed content
// store. Only missing facts are added — an existing frame with different
// bytes, or an append that would break journal time order, is an honest
// conflict, never an overwrite.
nlohmann::json materialize_episode_bundle_material(const storage_service_options &options,
                                                   const storage_episode_bundle_result &bundle, bool write) {
  namespace yjj = kungfu::yijinjing;
  nlohmann::json applied = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json rejected = nlohmann::json::array();

  auto locator = std::make_shared<yjj::data::locator>(options.runtime_dir, yy_enums::mode::LIVE);
  for (const auto &journal : bundle.journals) {
    const auto seed = journal.seed == 0 ? KUNGFU_HASH_SEED : journal.seed;
    const auto location = yjj::data::location::make_shared(yy_enums::get_mode_by_name(journal.mode),
                                                           yy_enums::get_location_role_by_name(journal.role),
                                                           journal.namespace_, journal.name, locator, seed);
    if (location->uid != journal.location_uid) {
      rejected.push_back({{"kind", "frame_bytes"},
                          {"reason", "episode_bundle_location_uid_mismatch"},
                          {"location", location->uname},
                          {"claimed_uid", journal.location_uid},
                          {"actual_uid", location->uid}});
      continue;
    }

    std::unordered_map<uint64_t, const episode_frame_material *> material_by_uid;
    for (const auto &frame : journal.frames) {
      material_by_uid.emplace(frame.frame_uid, &frame);
    }
    std::unordered_map<uint64_t, bool> existing_identical;
    int64_t last_gen_time = 0;
    bool journal_has_frames = false;
    if (!locator->list_page_id(location, journal.dest).empty()) {
      auto reader = std::make_shared<yjj::journal::reader>(true, false, std::make_shared<yjj::journal::bus>(false));
      reader->join(location, journal.dest, 0);
      while (reader->data_available()) {
        const auto frame = reader->current_frame();
        journal_has_frames = true;
        last_gen_time = frame->gen_time();
        const auto material_iter = material_by_uid.find(frame->frame_uid());
        if (material_iter != material_by_uid.end() && existing_identical.count(frame->frame_uid()) == 0) {
          const auto &material = *material_iter->second;
          const bool identical = material.bytes.size() == static_cast<size_t>(frame->frame_length()) &&
                                 std::memcmp(material.bytes.data(), reinterpret_cast<const void *>(frame->address()),
                                             material.bytes.size()) == 0;
          existing_identical.emplace(frame->frame_uid(), identical);
        }
        reader->next();
      }
    }

    std::vector<const episode_frame_material *> to_append;
    bool journal_rejected = false;
    int64_t previous_gen_time = 0;
    for (const auto &frame : journal.frames) {
      const auto existing_iter = existing_identical.find(frame.frame_uid);
      if (existing_iter != existing_identical.end()) {
        if (existing_iter->second) {
          skipped.push_back({{"kind", "frame_bytes"}, {"reason", "already_present"}, {"frame_uid", frame.frame_uid}});
        } else {
          rejected.push_back({{"kind", "frame_bytes"},
                              {"reason", "episode_frame_conflict"},
                              {"frame_uid", frame.frame_uid},
                              {"location", location->uname},
                              {"dest", journal.dest}});
          journal_rejected = true;
        }
        continue;
      }
      if (!to_append.empty() && frame.gen_time < previous_gen_time) {
        rejected.push_back({{"kind", "frame_bytes"},
                            {"reason", "episode_bundle_frames_unordered"},
                            {"frame_uid", frame.frame_uid},
                            {"location", location->uname},
                            {"dest", journal.dest}});
        journal_rejected = true;
        continue;
      }
      to_append.push_back(&frame);
      previous_gen_time = frame.gen_time;
    }
    if (journal_has_frames && !to_append.empty() && last_gen_time > to_append.front()->gen_time) {
      for (const auto *frame : to_append) {
        rejected.push_back({{"kind", "frame_bytes"},
                            {"reason", "episode_frame_order_conflict"},
                            {"frame_uid", frame->frame_uid},
                            {"location", location->uname},
                            {"dest", journal.dest},
                            {"journal_last_gen_time", last_gen_time},
                            {"frame_gen_time", frame->gen_time}});
      }
      continue;
    }
    if (journal_rejected) {
      // The journal-level facts are already reported; still land the clean
      // missing frames only when nothing in this journal conflicts.
      continue;
    }
    if (to_append.empty()) {
      continue;
    }
    if (!write) {
      for (const auto *frame : to_append) {
        applied.push_back({{"kind", "frame_bytes"},
                           {"frame_uid", frame->frame_uid},
                           {"location", location->uname},
                           {"dest", journal.dest},
                           {"dry_run", true}});
      }
      continue;
    }
    try {
      const auto page_size = yjj::journal::page::find_page_size(location, journal.dest);
      auto writer = yjj::journal::writer(location, journal.dest, std::make_shared<yjj::journal::noop_publisher>(),
                                         false, std::make_shared<yjj::journal::bus>(false));
      for (const auto *frame : to_append) {
        if (frame->bytes.size() + 2 * sizeof(yjj::types::frame_header) > page_size) {
          rejected.push_back({{"kind", "frame_bytes"},
                              {"reason", "episode_frame_exceeds_page_size"},
                              {"frame_uid", frame->frame_uid},
                              {"location", location->uname},
                              {"dest", journal.dest}});
          continue;
        }
        auto overlay = std::make_shared<yjj::journal::frame>();
        overlay->set_address(reinterpret_cast<uintptr_t>(frame->bytes.data()));
        writer.copy_frame(overlay);
        applied.push_back({{"kind", "frame_bytes"},
                           {"frame_uid", frame->frame_uid},
                           {"location", location->uname},
                           {"dest", journal.dest}});
      }
    } catch (const std::exception &error) {
      rejected.push_back(
          {{"kind", "frame_bytes"}, {"reason", error.what()}, {"location", location->uname}, {"dest", journal.dest}});
    }
  }

  const auto provider = shared_provider(options);
  for (const auto &payload : bundle.ref_payloads) {
    const auto separator = payload.ref_hash.find(':');
    const auto algorithm = separator == std::string::npos ? std::string(yy_storage::CONTENT_HASH_ALGORITHM_SHA256)
                                                          : payload.ref_hash.substr(0, separator);
    const auto digest = separator == std::string::npos ? payload.ref_hash : payload.ref_hash.substr(separator + 1);
    const auto error = yy_storage::verify_payload_ref(payload.bytes, digest, payload.bytes.size(), algorithm);
    if (!error.empty()) {
      rejected.push_back({{"kind", "ref_payload"}, {"reason", error}, {"ref_hash", payload.ref_hash}});
      continue;
    }
    const auto expected = yy_storage::content_hash{algorithm, digest};
    if (provider->content_store().has(payload.content_namespace, expected)) {
      skipped.push_back({{"kind", "ref_payload"},
                         {"content_namespace", payload.content_namespace},
                         {"reason", "already_present"},
                         {"ref_hash", payload.ref_hash}});
      continue;
    }
    if (write) {
      const auto stored = provider->content_store().put_if_absent(payload.content_namespace, payload.bytes, expected);
      if (!stored.ok()) {
        rejected.push_back({{"kind", "ref_payload"},
                            {"content_namespace", payload.content_namespace},
                            {"reason", stored.message},
                            {"ref_hash", payload.ref_hash}});
        continue;
      }
      applied.push_back(
          {{"kind", "ref_payload"}, {"content_namespace", payload.content_namespace}, {"ref_hash", payload.ref_hash}});
    } else {
      applied.push_back({{"kind", "ref_payload"},
                         {"content_namespace", payload.content_namespace},
                         {"ref_hash", payload.ref_hash},
                         {"dry_run", true}});
    }
  }

  return {{"applied", std::move(applied)}, {"skipped", std::move(skipped)}, {"rejected", std::move(rejected)}};
}

nlohmann::json apply_episode_bundle_material(const storage_service_options &options, const nlohmann::json &bundle,
                                             bool write) {
  auto validation_options = options;
  validation_options.scope = "episode";
  validation_options.dry_run = true;
  validation_options.bundle = bundle;
  const auto validated = episode_import_bundle_impl(validation_options);
  const auto bundle_episode_id =
      uint64_or(bundle, "episode_id", uint64_or(object_or_empty(bundle, "manifest"), "episode_id"));
  nlohmann::json existing_keys = nlohmann::json::array();
  std::vector<std::string> seen;
  if (bundle_episode_id != 0) {
    const auto scoped = episode_ref_store(options);
    const auto fold = scoped.store.fold_typed_records();
    const auto iter = fold.episodes.find(bundle_episode_id);
    if (iter != fold.episodes.end()) {
      for (const auto &existing : iter->second.records) {
        const auto key = episode_record_identity_key(existing);
        seen.push_back(key);
        existing_keys.push_back(key);
      }
    }
  }
  nlohmann::json applied = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json rejected = nlohmann::json::array();
  for (const auto &record : array_or_empty(bundle, "records")) {
    const auto kind = text_or(record, "record_kind");
    if (kind.empty()) {
      rejected.push_back({{"kind", "episode_record"}, {"reason", "record_kind_missing"}, {"record", record}});
    } else if (!episode_record_kind_supported(kind)) {
      rejected.push_back({{"kind", "episode_record"}, {"reason", "unsupported_record_kind"}, {"record_kind", kind}});
    }
  }
  if (!rejected.empty()) {
    return {{"kind", "episode_bundle"},
            {"schema", text_or(bundle, "schema")},
            {"episode_id", bundle_episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(bundle_episode_id)},
            {"validated", validated},
            {"existing_record_keys", existing_keys},
            {"applied", applied},
            {"skipped", skipped},
            {"rejected", rejected}};
  }
  const auto typed_bundle = parse_storage_episode_bundle(bundle);
  // ADR-0053: the bundle's owned bytes land before the manifest records
  // replay, so the seal replay closes over frames that already exist and the
  // receipt's fsck can go green in one pass.
  const auto material = materialize_episode_bundle_material(options, typed_bundle, write);
  for (const auto &row : array_or_empty(material, "applied")) {
    applied.push_back(row);
  }
  for (const auto &row : array_or_empty(material, "skipped")) {
    skipped.push_back(row);
  }
  for (const auto &row : array_or_empty(material, "rejected")) {
    rejected.push_back(row);
  }
  if (write && !array_or_empty(material, "rejected").empty()) {
    // Materialization conflicts stop the replay: sealing manifest claims over
    // frames that did not land would fabricate a failing Episode.
    return {{"kind", "episode_bundle"},
            {"schema", text_or(bundle, "schema")},
            {"episode_id", bundle_episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(bundle_episode_id)},
            {"validated", validated},
            {"existing_record_keys", existing_keys},
            {"applied", applied},
            {"skipped", skipped},
            {"rejected", rejected}};
  }
  for (const auto &record : typed_bundle.manifest.records) {
    const auto key = episode_record_identity_key(record);
    const auto rendered_record = episode_record_row_json(record);
    if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
      skipped.push_back({{"kind", "episode_record"}, {"reason", "already_present"}, {"record", rendered_record}});
      continue;
    }
    const auto kind = episode_record_kind(record);
    if (write) {
      const auto written = episode_apply_record(options, record);
      if (written.is_null()) {
        rejected.push_back({{"kind", "episode_record"}, {"reason", "unsupported_record_kind"}, {"record_kind", kind}});
        continue;
      }
      applied.push_back({{"kind", "episode_record"}, {"record_kind", kind}, {"record", written}});
    } else {
      applied.push_back(
          {{"kind", "episode_record"}, {"record_kind", kind}, {"record", rendered_record}, {"dry_run", true}});
    }
  }
  return {{"kind", "episode_bundle"},
          {"schema", text_or(bundle, "schema")},
          {"episode_id", bundle_episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(bundle_episode_id)},
          {"validated", validated},
          {"existing_record_keys", existing_keys},
          {"applied", applied},
          {"skipped", skipped},
          {"rejected", rejected}};
}

nlohmann::json apply_source_bundle_material(const storage_service_options &options,
                                            const storage_export_bundle_result &bundle, bool write) {
  const auto source_id = options.source_id.empty() ? bundle.source_id : options.source_id;
  if (source_id.empty()) {
    throw std::invalid_argument("repair_apply_source_id_required");
  }
  const auto provider = provider_cache::instance().acquire(options.runtime_dir, options.provider);
  auto manifest = catalog_store(options.runtime_dir).latest_manifest_typed(source_id, provider->content_store());
  if (!manifest.has_value()) {
    throw std::runtime_error("manifest not found: " + source_id);
  }
  nlohmann::json applied = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json rejected = nlohmann::json::array();
  bool manifest_changed = false;
  for (const auto &record : bundle.records) {
    if (!record.payload_json.has_value()) {
      skipped.push_back({{"kind", "payload"},
                         {"reason", "payload_missing_in_material"},
                         {"record", render_manifest_entry_view(record.entry)}});
      continue;
    }
    const auto &raw = *record.payload_json;
    auto digest = record.entry.payload_hash;
    if (digest.empty()) {
      digest = yy_storage::compute_content_hash_value(raw, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    }
    const auto error =
        yy_storage::verify_payload_ref(raw, digest, raw.size(), yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    if (!error.empty()) {
      rejected.push_back({{"kind", "payload"}, {"reason", error}, {"payload_hash", digest}});
      continue;
    }
    bool matched = false;
    for (auto &entry : manifest->entries) {
      if (entry.payload_hash != digest) {
        continue;
      }
      matched = true;
      if (entry.payload_state == yy_enums::PayloadState::Present && provider->payload_exists(digest)) {
        skipped.push_back({{"kind", "payload"}, {"reason", "already_present"}, {"payload_hash", digest}});
        continue;
      }
      if (entry.payload_state == yy_enums::PayloadState::Redacted ||
          entry.payload_state == yy_enums::PayloadState::Absent) {
        skipped.push_back({{"kind", "payload"}, {"reason", "intentional_non_present_state"}, {"payload_hash", digest}});
        continue;
      }
      if (write) {
        provider->write_payload(digest, raw);
      }
      entry.payload_state = yy_enums::PayloadState::Present;
      entry.byte_len = raw.size();
      if (entry.content_type.empty()) {
        entry.content_type = CONTENT_TYPE_JSON;
      }
      manifest_changed = true;
      applied.push_back({{"kind", "payload"},
                         {"payload_hash", digest},
                         {"subject", entry.kind + ":" + entry.source_id},
                         {"dry_run", !write}});
    }
    if (!matched) {
      rejected.push_back({{"kind", "payload"}, {"reason", "manifest_entry_missing"}, {"payload_hash", digest}});
    }
  }
  nlohmann::json accepted = nullptr;
  if (write && manifest_changed) {
    manifest->manifest_id += ".repair";
    manifest->sync_root = {};
    const auto accepted_view =
        catalog_store(options.runtime_dir).accept_manifest_typed(*manifest, provider->content_store());
    accepted = render_manifest_document(accepted_view);
    const auto registry = registry_store(options.runtime_dir);
    yy_storage::source_head_update_options head{};
    head.source_id = accepted_view.source_id;
    head.head = accepted_view.source_head;
    head.inventory_hash_algo = accepted_view.sync_root.algorithm;
    head.inventory_hash = accepted_view.sync_root.value;
    (void)registry.update_head(head);
    yy_storage::accepted_range_options range{};
    range.source_id = accepted_view.source_id;
    range.manifest_id = accepted_view.manifest_id;
    (void)registry.record_accepted_range(range);
  }
  return {{"kind", "source_bundle"},
          {"schema", yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1},
          {"source_id", source_id},
          {"manifest_changed", manifest_changed},
          {"accepted_manifest", accepted},
          {"applied", applied},
          {"skipped", skipped},
          {"rejected", rejected}};
}

nlohmann::json repair_apply_impl(const storage_service_options &options) {
  const auto write = !options.dry_run;
  auto plan_options = options;
  plan_options.dry_run = true;
  const auto plan = repair_plan_impl(plan_options);
  auto material = options.bundle;
  if (material.empty()) {
    material = object_or_empty(options.operation_options, "repair_input");
  }
  if (material.empty()) {
    material = object_or_empty(options.operation_options, "material");
  }
  if (material.empty()) {
    throw std::invalid_argument("repair_apply_material_required");
  }
  nlohmann::json groups = nlohmann::json::array();
  const auto apply_one = [&](const nlohmann::json &item) {
    const auto schema = text_or(item, "schema");
    if (schema == "kungfu.storage.episode-bundle/v1") {
      return apply_episode_bundle_material(options, item, write);
    }
    if (schema == yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1) {
      return apply_source_bundle_material(options, parse_storage_export_bundle(item), write);
    }
    return nlohmann::json{{"kind", "unknown"},
                          {"schema", schema},
                          {"rejected", nlohmann::json::array({{{"reason", "unsupported_material_schema"}}})}};
  };
  if (material.contains("episode_bundles") || material.contains("source_bundles")) {
    for (const auto &bundle : array_or_empty(material, "episode_bundles")) {
      groups.push_back(apply_one(bundle));
    }
    for (const auto &bundle : array_or_empty(material, "source_bundles")) {
      groups.push_back(apply_one(bundle));
    }
  } else {
    groups.push_back(apply_one(material));
  }
  size_t applied_count = 0;
  size_t skipped_count = 0;
  size_t rejected_count = 0;
  for (const auto &group : groups) {
    applied_count += array_or_empty(group, "applied").size();
    skipped_count += array_or_empty(group, "skipped").size();
    rejected_count += array_or_empty(group, "rejected").size();
  }
  return {{"ok", rejected_count == 0},
          {"schema", "kungfu.storage.repair-apply/v1"},
          {"scope", options.scope.empty() ? "all" : options.scope},
          {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
          {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
          {"dry_run", options.dry_run},
          {"applied", write},
          {"status", rejected_count == 0 ? (write ? "applied" : "validated") : "rejected"},
          {"plan", plan},
          {"groups", groups},
          {"applied_count", applied_count},
          {"skipped_count", skipped_count},
          {"rejected_count", rejected_count},
          {"notes", nlohmann::json::array({
                        "Repair apply v1 only consumes locally supplied material.",
                        "It never fetches remote data, deletes, compacts, or garbage-collects storage.",
                    })}};
}

struct repair_evidence_runtime {
  std::string source = {};
  fs::path runtime_dir = {};
};

std::string normalized_runtime_key(const fs::path &path) {
  std::error_code ec;
  auto normalized = fs::weakly_canonical(path, ec);
  if (ec) {
    normalized = fs::absolute(path, ec);
  }
  return normalized.lexically_normal().string();
}

void push_evidence_runtime(std::vector<repair_evidence_runtime> &runtimes, const std::string &source,
                           const fs::path &runtime_dir) {
  if (runtime_dir.empty()) {
    return;
  }
  const auto key = normalized_runtime_key(runtime_dir);
  for (const auto &existing : runtimes) {
    if (normalized_runtime_key(existing.runtime_dir) == key) {
      return;
    }
  }
  runtimes.push_back({source, runtime_dir});
}

std::vector<repair_evidence_runtime> repair_evidence_runtimes(const storage_service_options &options) {
  std::vector<repair_evidence_runtime> runtimes;
  push_evidence_runtime(runtimes, "local-runtime", options.runtime_dir);
  const auto remotes_dir = fs::path(options.runtime_dir) / "remotes";
  std::error_code ec;
  if (fs::exists(remotes_dir, ec) && fs::is_directory(remotes_dir, ec)) {
    for (const auto &entry : fs::directory_iterator(remotes_dir, ec)) {
      if (ec) {
        break;
      }
      if (!entry.is_directory(ec)) {
        continue;
      }
      const auto runtime_dir = entry.path() / "runtime";
      if (fs::exists(runtime_dir, ec) && fs::is_directory(runtime_dir, ec)) {
        push_evidence_runtime(runtimes, "remote-mirror:" + entry.path().filename().string(), runtime_dir);
      }
    }
  }
  for (const auto &extra : array_or_empty(options.operation_options, "candidate_runtime_dirs")) {
    if (extra.is_string()) {
      push_evidence_runtime(runtimes, "explicit-runtime", extra.get<std::string>());
    }
  }
  return runtimes;
}

bool source_bundle_has_payload(const storage_export_bundle_result &bundle, const std::string &payload_hash) {
  if (payload_hash.empty()) {
    return !bundle.records.empty();
  }
  return std::any_of(bundle.records.begin(), bundle.records.end(), [&payload_hash](const auto &record) {
    return record.entry.payload_hash == payload_hash && record.payload_json.has_value();
  });
}

bool episode_bundle_has_frame(const storage_episode_bundle_result &bundle, uint64_t frame_uid) {
  if (frame_uid == 0) {
    return !bundle.manifest.records.empty();
  }
  for (size_t position = 0; position < bundle.manifest.frame_indices.size(); ++position) {
    if (bundle.manifest.frame_at(position).frame_uid == frame_uid) {
      return true;
    }
  }
  return false;
}

bool episode_bundle_has_ref_hash(const storage_episode_bundle_result &bundle, const std::string &ref_hash) {
  if (ref_hash.empty()) {
    return !bundle.manifest.records.empty();
  }
  for (size_t position = 0; position < bundle.manifest.ref_indices.size(); ++position) {
    if (fixed_string(bundle.manifest.ref_at(position).ref_hash) == ref_hash) {
      return true;
    }
  }
  return false;
}

bool episode_bundle_satisfies_candidate(const storage_repair_candidate_view &candidate,
                                        const storage_episode_bundle_result &bundle) {
  if (candidate.code == "repair_episode_root_trigger_frame" || candidate.code == "repair_episode_trigger_frame") {
    return episode_bundle_has_frame(bundle, candidate.subject.frame_uid.value_or(0));
  }
  if (candidate.code == "repair_episode_payload_ref") {
    return episode_bundle_has_ref_hash(bundle, candidate.subject.ref_hash.value_or(""));
  }
  if (candidate.code == "repair_episode_dependency") {
    const auto dependency_episode_id = candidate.subject.dependency_episode_id.value_or(0);
    return dependency_episode_id == 0 || bundle.episode_id == dependency_episode_id;
  }
  return false;
}

void push_unique_bundle(nlohmann::json &bundles, std::vector<std::string> &seen, const nlohmann::json &bundle) {
  const auto key = text_or(bundle, "schema") + ":" + text_or(bundle, "bundle_id", canonical_json(bundle));
  if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
    return;
  }
  seen.push_back(key);
  bundles.push_back(bundle);
}

nlohmann::json repair_fetch_impl(const storage_service_options &options) {
  if (!options.dry_run) {
    throw std::invalid_argument("storage_repair_fetch_is_read_only");
  }
  auto plan_options = options;
  plan_options.dry_run = true;
  const auto typed_plan = repair_plan_typed_impl(parse_storage_repair_plan_request(plan_options));
  const auto plan = render_storage_repair_plan_result(typed_plan);
  const auto runtimes = repair_evidence_runtimes(options);
  nlohmann::json material = {
      {"schema", "kungfu.storage.repair-material/v1"},
      {"generated_by", "kungfu.storage.repair-fetch/v1"},
      {"episode_bundles", nlohmann::json::array()},
      {"source_bundles", nlohmann::json::array()},
  };
  std::vector<std::string> seen_episode_bundles;
  std::vector<std::string> seen_source_bundles;
  nlohmann::json matched = nlohmann::json::array();
  nlohmann::json skipped = nlohmann::json::array();
  nlohmann::json missing = nlohmann::json::array();

  const auto rendered_candidates = array_or_empty(plan, "candidates");
  for (size_t candidate_index = 0; candidate_index < typed_plan.candidates.size(); ++candidate_index) {
    const auto &candidate = typed_plan.candidates[candidate_index];
    const auto &rendered_candidate = rendered_candidates.at(candidate_index);
    bool found = false;
    if (candidate.code == "repair_source_payload") {
      const auto source_id = candidate.subject.source_id.value_or(options.source_id);
      const auto payload_hash = candidate.subject.payload_hash.value_or("");
      for (const auto &runtime : runtimes) {
        try {
          auto candidate_options = options;
          candidate_options.runtime_dir = runtime.runtime_dir.string();
          candidate_options.scope = "source";
          candidate_options.source_id = source_id;
          const auto bundle = default_storage_service().export_bundle(
              {candidate_options.runtime_dir, candidate_options.provider, candidate_options.source_id, {}, false});
          if (!source_bundle_has_payload(bundle, payload_hash)) {
            skipped.push_back({{"candidate", rendered_candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"reason", "payload_not_in_bundle"}});
            continue;
          }
          push_unique_bundle(material["source_bundles"], seen_source_bundles,
                             render_storage_export_bundle_result(bundle));
          matched.push_back({{"candidate", rendered_candidate},
                             {"evidence_source", runtime.source},
                             {"runtime_dir", runtime.runtime_dir.string()},
                             {"material", "source_bundle"}});
          found = true;
          break;
        } catch (const std::exception &e) {
          skipped.push_back({{"candidate", rendered_candidate},
                             {"evidence_source", runtime.source},
                             {"runtime_dir", runtime.runtime_dir.string()},
                             {"reason", e.what()}});
        }
      }
    } else if (candidate.kind == "episode" || candidate.kind == "frame" ||
               candidate.code == "repair_episode_payload_ref") {
      std::vector<uint64_t> episode_ids;
      const auto requested_episode_id = candidate.subject.episode_id.value_or(options.episode_id);
      if (requested_episode_id != 0) {
        episode_ids.push_back(requested_episode_id);
      }
      const auto dependency_episode_id = candidate.subject.dependency_episode_id.value_or(0);
      if (dependency_episode_id != 0 &&
          std::find(episode_ids.begin(), episode_ids.end(), dependency_episode_id) == episode_ids.end()) {
        episode_ids.push_back(dependency_episode_id);
      }
      for (const auto &runtime : runtimes) {
        for (const auto episode_id : episode_ids) {
          try {
            auto candidate_options = options;
            candidate_options.runtime_dir = runtime.runtime_dir.string();
            candidate_options.scope = "episode";
            candidate_options.episode_id = episode_id;
            const auto bundle = episode_export_bundle_typed_impl(candidate_options);
            if (!episode_bundle_satisfies_candidate(candidate, bundle)) {
              skipped.push_back({{"candidate", rendered_candidate},
                                 {"evidence_source", runtime.source},
                                 {"runtime_dir", runtime.runtime_dir.string()},
                                 {"episode_id", episode_id},
                                 {"reason", "episode_evidence_not_in_bundle"}});
              continue;
            }
            push_unique_bundle(material["episode_bundles"], seen_episode_bundles,
                               render_storage_episode_bundle_result(bundle));
            matched.push_back({{"candidate", rendered_candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"episode_id", episode_id},
                               {"material", "episode_bundle"}});
            found = true;
            break;
          } catch (const std::exception &e) {
            skipped.push_back({{"candidate", rendered_candidate},
                               {"evidence_source", runtime.source},
                               {"runtime_dir", runtime.runtime_dir.string()},
                               {"episode_id", episode_id},
                               {"reason", e.what()}});
          }
        }
        if (found) {
          break;
        }
      }
    }
    if (!found) {
      missing.push_back(rendered_candidate);
    }
  }

  const auto written = !options.artifact_uri.empty();
  if (written) {
    write_json_file(options.artifact_uri, material);
  }
  return {
      {"ok", missing.empty()},
      {"schema", "kungfu.storage.repair-fetch/v1"},
      {"scope", options.scope.empty() ? "all" : options.scope},
      {"source_id", options.source_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.source_id)},
      {"episode_id", options.episode_id == 0 ? nlohmann::json(nullptr) : nlohmann::json(options.episode_id)},
      {"dry_run", true},
      {"read_only", true},
      {"artifact_uri", options.artifact_uri.empty() ? nlohmann::json(nullptr) : nlohmann::json(options.artifact_uri)},
      {"written", written},
      {"plan", plan},
      {"evidence_runtimes",
       [&] {
         nlohmann::json rows = nlohmann::json::array();
         for (const auto &runtime : runtimes) {
           rows.push_back({{"source", runtime.source}, {"runtime_dir", runtime.runtime_dir.string()}});
         }
         return rows;
       }()},
      {"material", material},
      {"matched", matched},
      {"matched_count", matched.size()},
      {"skipped", skipped},
      {"missing", missing},
      {"missing_count", missing.size()},
      {"notes", nlohmann::json::array({
                    "Repair fetch v1 only searches local runtime evidence and registered remote mirror runtimes.",
                    "It writes a local material artifact only when artifact_uri/--out is explicitly supplied.",
                    "It never applies material, deletes, compacts, garbage-collects, or performs network fetch.",
                })}};
}

// ADR-0053 import --execute: land a sealed Episode bundle in this data root.
// Gates run in proof order — bundle self-consistency, destination identity,
// materialization + replay, destination root against the bundle claim, and a
// scoped verify-frames fsck — so a failed receipt names the exact broken
// step. Writes are append-only; nothing is rolled back or overwritten.
nlohmann::json episode_import_bundle_execute_impl(const storage_service_options &options) {
  const auto parsed = parse_storage_episode_bundle(options.bundle);
  if (parsed.episode_id == 0) {
    throw std::invalid_argument("episode_bundle_episode_id_missing");
  }
  const auto receipt_base = [&parsed](const std::string &status, bool ok, bool accepted) {
    return nlohmann::json{{"ok", ok},
                          {"schema", "kungfu.storage.episode-import/v1"},
                          {"scope", "episode"},
                          {"episode_id", parsed.episode_id},
                          {"dry_run", false},
                          {"accepted", accepted},
                          {"status", status},
                          {"authority", "yijinjing-journal"},
                          {"self_contained", parsed.self_contained}};
  };
  const auto root_json = [](const yy_storage::episode_content_root &root) {
    return nlohmann::json{
        {"algorithm", root.algorithm}, {"root_value", root.value}, {"covered_record_count", root.covered_record_count}};
  };

  std::optional<yijinjing::types::EpisodeRootCommitted> root_claim;
  bool terminal_close = false;
  for (const auto &record : parsed.manifest.records) {
    if (const auto *close = std::get_if<yijinjing::types::EpisodeClosed>(&record.body)) {
      if (close->status == yy_enums::EpisodeStatus::Ended || close->status == yy_enums::EpisodeStatus::Aborted) {
        terminal_close = true;
      }
    } else if (const auto *root = std::get_if<yijinjing::types::EpisodeRootCommitted>(&record.body)) {
      if (!root_claim.has_value()) {
        root_claim = *root;
      }
    }
  }
  if (!terminal_close) {
    auto receipt = receipt_base("failed", false, false);
    receipt["errors"] =
        nlohmann::json::array({{{"code", "episode_bundle_not_sealed"}, {"episode_id", parsed.episode_id}}});
    return receipt;
  }

  // Gate 1 — the bundle proves itself: the ADR-0043 chain over its own
  // records must reproduce the root it claims.
  const auto bundle_computed = yy_storage::compute_episode_content_root(parsed.manifest);
  nlohmann::json preflight = {{"computed", root_json(bundle_computed)}, {"claimed", nullptr}, {"match", nullptr}};
  if (root_claim.has_value()) {
    preflight["claimed"] = {{"algorithm", fixed_string(root_claim->algorithm)},
                            {"root_value", fixed_string(root_claim->root_value)},
                            {"covered_record_count", root_claim->covered_record_count}};
    if (fixed_string(root_claim->algorithm) == bundle_computed.algorithm) {
      const bool match = fixed_string(root_claim->root_value) == bundle_computed.value;
      preflight["match"] = match;
      if (!match) {
        auto receipt = receipt_base("failed", false, false);
        receipt["preflight"] = preflight;
        receipt["errors"] =
            nlohmann::json::array({{{"code", "episode_bundle_root_mismatch"}, {"episode_id", parsed.episode_id}}});
        return receipt;
      }
    }
  }

  // Gate 2 — destination identity: same root is already-present, a different
  // root with the same id is a refusal, never a merge (ADR-0043 equality).
  {
    const auto scoped = episode_ref_store(options);
    const auto fold = scoped.store.fold_typed_records();
    const auto iter = fold.episodes.find(parsed.episode_id);
    if (iter != fold.episodes.end()) {
      const auto &destination = iter->second;
      if (!destination.closed) {
        auto receipt = receipt_base("failed", false, false);
        receipt["preflight"] = preflight;
        receipt["errors"] =
            nlohmann::json::array({{{"code", "episode_conflict_open"}, {"episode_id", parsed.episode_id}}});
        return receipt;
      }
      const auto destination_computed = yy_storage::compute_episode_content_root(destination);
      if (destination_computed.algorithm == bundle_computed.algorithm &&
          destination_computed.value == bundle_computed.value) {
        auto receipt = receipt_base("already_present", true, false);
        receipt["preflight"] = preflight;
        receipt["root"] = {{"destination_computed", root_json(destination_computed)},
                           {"bundle_computed", root_json(bundle_computed)},
                           {"match", true}};
        return receipt;
      }
      auto receipt = receipt_base("failed", false, false);
      receipt["preflight"] = preflight;
      receipt["root"] = {{"destination_computed", root_json(destination_computed)},
                         {"bundle_computed", root_json(bundle_computed)},
                         {"match", false}};
      receipt["errors"] =
          nlohmann::json::array({{{"code", "episode_root_mismatch"}, {"episode_id", parsed.episode_id}}});
      return receipt;
    }
  }

  // Gate 3 — coverage: execute refuses to seal claims whose frame bytes do
  // not travel with the bundle. Replaying the records anyway would fabricate
  // a sealed Episode that fails its own fsck; a thin or incomplete bundle
  // fails here, before anything is written.
  {
    std::unordered_set<uint64_t> carried;
    for (const auto &journal : parsed.journals) {
      for (const auto &frame : journal.frames) {
        carried.insert(frame.frame_uid);
      }
    }
    nlohmann::json uncovered = nlohmann::json::array();
    for (const auto index : parsed.manifest.frame_indices) {
      const auto &claim = std::get<yijinjing::types::EpisodeFrameAttached>(parsed.manifest.records.at(index).body);
      if (claim.frame_uid != 0 && carried.count(claim.frame_uid) == 0) {
        uncovered.push_back(claim.frame_uid);
      }
    }
    if (!uncovered.empty()) {
      auto receipt = receipt_base("failed", false, false);
      receipt["preflight"] = preflight;
      receipt["errors"] = nlohmann::json::array({{{"code", "episode_bundle_not_self_contained"},
                                                  {"episode_id", parsed.episode_id},
                                                  {"uncovered_frame_uids", uncovered}}});
      return receipt;
    }
  }

  // Gate 4 — land the material and replay the manifest records; the replayed
  // seal commits the destination's own root.
  const auto apply = apply_episode_bundle_material(options, options.bundle, /*write=*/true);
  const bool apply_ok = array_or_empty(apply, "rejected").empty();

  // Gate 5 — the destination root must reproduce the bundle's identity.
  nlohmann::json root_report = {{"bundle_computed", root_json(bundle_computed)}};
  bool root_ok = false;
  {
    const auto scoped = episode_ref_store(options);
    const auto fold = scoped.store.fold_typed_records();
    const auto iter = fold.episodes.find(parsed.episode_id);
    if (iter != fold.episodes.end()) {
      const auto &destination = iter->second;
      const auto destination_computed = yy_storage::compute_episode_content_root(destination);
      root_report["destination_computed"] = root_json(destination_computed);
      if (destination.root_seen) {
        root_report["destination_recorded"] = {{"algorithm", fixed_string(destination.root.algorithm)},
                                               {"root_value", fixed_string(destination.root.root_value)}};
      }
      root_ok = destination_computed.algorithm == bundle_computed.algorithm &&
                destination_computed.value == bundle_computed.value;
      root_report["match"] = root_ok;
    } else {
      root_report["match"] = false;
    }
  }

  // Gate 6 — scoped deep verification over what actually landed.
  const auto fsck =
      default_storage_service().fsck({options.runtime_dir, options.provider, options.provider_config_source,
                                      storage_fsck_scope::Episode, "", parsed.episode_id, /*verify_frames=*/true});
  const bool ok = apply_ok && root_ok && fsck.ok;
  auto receipt = receipt_base(ok ? "applied" : "failed", ok, ok);
  receipt["preflight"] = preflight;
  receipt["apply"] = apply;
  receipt["root"] = root_report;
  receipt["fsck"] = render_storage_fsck_result(fsck);
  receipt["notes"] = nlohmann::json::array({
      "Episode bundle import --execute materializes owned frames and payloads, then replays manifest records.",
      "Writes are append-only; conflicts are reported and never overwritten.",
  });
  return receipt;
}

nlohmann::json episode_import_bundle_impl(const storage_service_options &options) {
  if (!options.bundle.is_object() || text_or(options.bundle, "schema") != "kungfu.storage.episode-bundle/v1") {
    throw std::invalid_argument("episode_bundle_invalid");
  }
  if (!options.dry_run) {
    return episode_import_bundle_execute_impl(options);
  }
  // Dry-run is the import gate, not a shape-only preview. Decode the complete
  // typed bundle so frame headers, byte lengths, and ref namespaces are
  // checked before any multi-Episode caller is allowed to start writing.
  const auto parsed = parse_storage_episode_bundle(options.bundle);
  const auto manifest = object_or_empty(options.bundle, "manifest");
  if (manifest.empty()) {
    throw std::invalid_argument("episode_bundle_manifest_missing");
  }
  const auto causal_graph = object_or_empty(options.bundle, "causal_graph");
  if (causal_graph.empty()) {
    throw std::invalid_argument("episode_bundle_causal_graph_missing");
  }
  const auto records = array_or_empty(options.bundle, "records");
  const auto frames = array_or_empty(options.bundle, "frames");
  const auto refs = array_or_empty(options.bundle, "refs");
  const auto dependencies = array_or_empty(options.bundle, "dependencies");
  return {
      {"ok", true},
      {"schema", "kungfu.storage.episode-import/v1"},
      {"scope", "episode"},
      {"episode_id", parsed.episode_id},
      {"dry_run", true},
      {"accepted", false},
      {"status", "validated"},
      {"authority", "yijinjing-journal"},
      {"degraded", bool_or(options.bundle, "degraded", bool_or(causal_graph, "degraded", false))},
      {"manifest", manifest},
      {"causal_graph", causal_graph},
      {"dependencies", dependencies},
      {"records", records.size()},
      {"frames", frames.size()},
      {"refs", refs.size()},
      {"dependency_count", dependencies.size()},
      {"self_contained", bool_or(options.bundle, "self_contained", false)},
      {"material_journals", array_or_empty(options.bundle, "journals").size()},
      {"material_ref_payloads", array_or_empty(options.bundle, "ref_payloads").size()},
      {"notes", nlohmann::json::array({
                    "Episode bundle import validates by default and preserves causal evidence without writing.",
                    "Import with dry_run=false materializes owned frames and payloads, then replays manifest records.",
                })}};
}

} // namespace detail

} // namespace kungfu::runtime::storage_service_api
