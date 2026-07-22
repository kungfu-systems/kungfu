// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <set>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace kungfu::runtime::storage_service_api::detail {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

inline constexpr const char *ADMISSION_CONTRACT_SCHEMA = "kungfu.episode-admission.contract/v1";
inline constexpr const char *ADMISSION_PLAN_SCHEMA = "kungfu.episode-admission.plan/v1";
inline constexpr const char *ADMISSION_STATE_SCHEMA = "kungfu.episode-admission.state/v1";
inline constexpr const char *ADMISSION_RECEIPT_SCHEMA = "kungfu.episode-admission.receipt/v1";
inline constexpr const char *WORKSPACE_IDENTITY_SCHEMA = "kungfu.workspace.identity/v1";
inline constexpr const char *WORKSPACE_FRONTIER_SCHEMA = "kungfu.workspace.episode-frontier/v1";

struct admission_candidate {
  uint64_t episode_id = 0;
  std::string root = {};
  nlohmann::json bundle = nlohmann::json::object();
  nlohmann::json qualification = nlohmann::json::object();
  std::string disposition = "missing";
  bool qualified = false;
};

[[nodiscard]] std::string rooted(const nlohmann::json &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(canonical_json(value)));
}

[[nodiscard]] uint64_t parse_u64(const nlohmann::json &value, const std::string &field) {
  if (value.is_number_unsigned())
    return value.get<uint64_t>();
  if (value.is_number_integer()) {
    const auto parsed = value.get<int64_t>();
    if (parsed > 0)
      return static_cast<uint64_t>(parsed);
  }
  if (value.is_string()) {
    const auto text = value.get<std::string>();
    if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
      throw std::invalid_argument(field + " must contain positive Episode ids");
    size_t consumed = 0;
    const auto parsed = std::stoull(text, &consumed);
    if (consumed == text.size() && parsed != 0)
      return parsed;
  }
  throw std::invalid_argument(field + " must contain positive Episode ids");
}

[[nodiscard]] std::string episode_root(const yy_storage::episode_current_view &episode) {
  const auto root = yy_storage::compute_episode_content_root(episode);
  return root.algorithm + ":" + root.value;
}

[[nodiscard]] bool bundle_is_sealed(const storage_episode_bundle_result &bundle) {
  bool closed = false;
  bool rooted = false;
  for (const auto &record : bundle.manifest.records) {
    closed = closed || std::holds_alternative<yijinjing::types::EpisodeClosed>(record.body);
    rooted = rooted || std::holds_alternative<yijinjing::types::EpisodeRootCommitted>(record.body);
  }
  return closed && rooted;
}

[[nodiscard]] nlohmann::json workspace_identity(const std::string &runtime_dir, const nlohmann::json &declared) {
  if (!declared.empty()) {
    if (text_or(declared, "schema") != WORKSPACE_IDENTITY_SCHEMA || text_or(declared, "id").empty())
      throw std::invalid_argument("workspace_identity_invalid");
    return declared;
  }
  const auto proof = nlohmann::json{{"schema", "kungfu.workspace.local-path-proof/v1"},
                                    {"normalized_path", absolute_normalized(runtime_dir).generic_string()}};
  return {{"schema", WORKSPACE_IDENTITY_SCHEMA}, {"kind", "local-runtime"}, {"id", rooted(proof)}};
}

[[nodiscard]] nlohmann::json frontier_for(const std::string &runtime_dir) {
  storage_service_options options{};
  options.runtime_dir = runtime_dir;
  const auto scoped = episode_ref_store(options);
  const auto fold = scoped.store.fold_typed_records();
  nlohmann::json sealed = nlohmann::json::array();
  nlohmann::json open = nlohmann::json::array();
  for (const auto &[episode_id, episode] : fold.episodes) {
    if (episode.closed) {
      sealed.push_back({{"episode_id", std::to_string(episode_id)}, {"root", episode_root(episode)}});
    } else {
      open.push_back(std::to_string(episode_id));
    }
  }
  auto preimage = nlohmann::json{{"schema", WORKSPACE_FRONTIER_SCHEMA}, {"sealed", sealed}, {"open", open}};
  preimage["frontier_root"] = rooted(preimage);
  return preimage;
}

[[nodiscard]] nlohmann::json frontier_for_candidates(const std::vector<admission_candidate> &candidates) {
  nlohmann::json sealed = nlohmann::json::array();
  for (const auto &candidate : candidates)
    sealed.push_back({{"episode_id", std::to_string(candidate.episode_id)}, {"root", candidate.root}});
  auto preimage = nlohmann::json{{"schema", WORKSPACE_FRONTIER_SCHEMA},
                                 {"scope", "declared-roots"},
                                 {"sealed", sealed},
                                 {"open", nlohmann::json::array()}};
  preimage["frontier_root"] = rooted(preimage);
  return preimage;
}

[[nodiscard]] std::string frontier_root(const nlohmann::json &frontier) {
  return required_text(frontier, "frontier_root");
}

[[nodiscard]] admission_candidate candidate_from_bundle(const nlohmann::json &bundle) {
  const auto parsed = parse_storage_episode_bundle(bundle);
  if (parsed.episode_id == 0)
    throw std::invalid_argument("episode_bundle_episode_id_missing");
  admission_candidate candidate{};
  candidate.episode_id = parsed.episode_id;
  candidate.bundle = bundle;
  candidate.root = episode_root(parsed.manifest);
  const auto sealed = bundle_is_sealed(parsed);
  candidate.qualified = sealed && parsed.self_contained && !parsed.causal_graph.degraded &&
                        parsed.material_missing_frame_count == 0 && parsed.material_missing_ref_payload_count == 0;
  candidate.qualification = {{"schema", "kungfu.episode-admission.qualification/v1"},
                             {"profile", "sealed-self-contained-fsck/v1"},
                             {"status", candidate.qualified ? "ok" : "failed"},
                             {"episode_root", candidate.root},
                             {"sealed", sealed},
                             {"self_contained", parsed.self_contained},
                             {"causal_degraded", parsed.causal_graph.degraded},
                             {"missing_frame_count", parsed.material_missing_frame_count},
                             {"missing_ref_payload_count", parsed.material_missing_ref_payload_count}};
  candidate.qualification["qualification_root"] = rooted(candidate.qualification);
  return candidate;
}

[[nodiscard]] std::vector<uint64_t> requested_episode_ids(const nlohmann::json &options) {
  std::set<uint64_t> selected;
  for (const auto &value : array_or_empty(options, "episode_ids"))
    selected.insert(parse_u64(value, "episode_ids"));
  if (selected.empty())
    throw std::invalid_argument("episode_ids requires at least one Episode id");
  return {selected.begin(), selected.end()};
}

[[nodiscard]] std::vector<admission_candidate> local_candidates(const storage_service_options &options,
                                                                const std::string &source_runtime_dir) {
  std::set<uint64_t> pending;
  for (const auto episode_id : requested_episode_ids(options.operation_options))
    pending.insert(episode_id);
  std::set<uint64_t> visited;
  std::vector<admission_candidate> candidates;
  while (!pending.empty()) {
    const auto episode_id = *pending.begin();
    pending.erase(pending.begin());
    if (!visited.insert(episode_id).second)
      continue;
    storage_service_options source_options = options;
    source_options.runtime_dir = source_runtime_dir;
    source_options.scope = "episode";
    source_options.episode_id = episode_id;
    source_options.operation_options["episode_id"] = episode_id;
    auto candidate =
        candidate_from_bundle(render_storage_episode_bundle_result(episode_export_bundle_typed_impl(source_options)));
    const auto fsck =
        default_storage_service().fsck({source_runtime_dir, options.provider, options.provider_config_source,
                                        storage_fsck_scope::Episode, "", episode_id, true});
    candidate.qualified = candidate.qualified && fsck.ok && !fsck.degraded;
    if (!fsck.ok || fsck.degraded) {
      candidate.qualification["source_fsck_ok"] = fsck.ok;
      candidate.qualification["source_fsck_degraded"] = fsck.degraded;
      candidate.qualification["status"] = "failed";
      candidate.qualification.erase("qualification_root");
      candidate.qualification["qualification_root"] = rooted(candidate.qualification);
    }
    const auto parsed = parse_storage_episode_bundle(candidate.bundle);
    for (const auto &dependency : parsed.causal_graph.dependencies) {
      if (dependency.episode_id.has_value() && *dependency.episode_id != 0 &&
          visited.count(*dependency.episode_id) == 0)
        pending.insert(*dependency.episode_id);
    }
    candidates.push_back(std::move(candidate));
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const auto &lhs, const auto &rhs) { return lhs.episode_id < rhs.episode_id; });
  return candidates;
}

[[nodiscard]] std::vector<admission_candidate> transport_candidates(const storage_service_options &options,
                                                                    const std::string &transport) {
  if (transport == "local-direct") {
    const auto source_runtime_dir = required_text(options.operation_options, "source_runtime_dir");
    return local_candidates(options, source_runtime_dir);
  }
  if (transport != "bundle" && transport != "remote-stream")
    throw std::invalid_argument("unsupported episode admission transport: " + transport);
  std::vector<admission_candidate> candidates;
  for (const auto &bundle : array_or_empty(options.operation_options, "episode_bundles"))
    candidates.push_back(candidate_from_bundle(bundle));
  if (candidates.empty())
    throw std::invalid_argument("episode_bundles requires at least one bundle");
  std::sort(candidates.begin(), candidates.end(),
            [](const auto &lhs, const auto &rhs) { return lhs.episode_id < rhs.episode_id; });
  std::vector<admission_candidate> normalized;
  for (auto &candidate : candidates) {
    if (!normalized.empty() && normalized.back().episode_id == candidate.episode_id) {
      if (normalized.back().root != candidate.root)
        throw std::invalid_argument("episode_bundle_duplicate_root_conflict");
      continue;
    }
    normalized.push_back(std::move(candidate));
  }
  return normalized;
}

void classify_destination(const storage_service_options &options, std::vector<admission_candidate> &candidates) {
  const auto scoped = episode_ref_store(options);
  const auto fold = scoped.store.fold_typed_records();
  for (auto &candidate : candidates) {
    if (!candidate.qualified) {
      candidate.disposition = "refused";
      continue;
    }
    const auto iter = fold.episodes.find(candidate.episode_id);
    if (iter == fold.episodes.end()) {
      candidate.disposition = "missing";
      continue;
    }
    if (!iter->second.closed) {
      candidate.disposition = "conflicted";
      continue;
    }
    if (episode_root(iter->second) != candidate.root) {
      candidate.disposition = "conflicted";
      continue;
    }
    const auto fsck =
        default_storage_service().fsck({options.runtime_dir, options.provider, options.provider_config_source,
                                        storage_fsck_scope::Episode, "", candidate.episode_id, true});
    candidate.disposition = fsck.ok && !fsck.degraded ? "already-present" : "refused";
  }
}

[[nodiscard]] nlohmann::json admission_contract() {
  return {{"schema", ADMISSION_CONTRACT_SCHEMA},
          {"owner", "libkungfu"},
          {"authority", "destination-yijinjing-journal"},
          {"actions", {"contract", "plan", "execute", "inspect", "resume", "reconcile", "cancel"}},
          {"transports", {"local-direct", "bundle", "remote-stream"}},
          {"initiators", {"destination-pull", "source-push"}},
          {"states",
           {"planned", "transferring", "transferred", "verifying", "admitted", "refused", "conflicted", "interrupted",
            "cancelled"}},
          {"dispositions", {"accepted", "already-present", "refused", "conflicted"}},
          {"invariants",
           {"source-read-only", "destination-decides", "sealed-qualified-only", "no-root-rewrite", "no-force",
            "no-git-side-effect", "no-source-cleanup"}},
          {"project_cut_boundary", "Admission receipts may be referenced by later settlement; admission never stages, "
                                   "commits, pushes, or deletes."}};
}

[[nodiscard]] nlohmann::json build_plan(const storage_service_options &options,
                                        std::vector<admission_candidate> *candidate_output = nullptr) {
  const auto transport = text_or(options.operation_options, "transport", "local-direct");
  auto candidates = transport_candidates(options, transport);
  classify_destination(options, candidates);
  const auto source_runtime_dir = text_or(options.operation_options, "source_runtime_dir");
  const auto declared_source_identity = object_or_empty(options.operation_options, "source_identity");
  if (transport != "local-direct" && declared_source_identity.empty())
    throw std::invalid_argument("source_identity is required for non-local Episode Admission transports");
  const auto source_identity = workspace_identity(source_runtime_dir, declared_source_identity);
  const auto destination_identity =
      workspace_identity(options.runtime_dir, object_or_empty(options.operation_options, "destination_identity"));
  const auto source_frontier =
      transport == "local-direct" ? frontier_for(source_runtime_dir) : frontier_for_candidates(candidates);
  const auto destination_frontier = frontier_for(options.runtime_dir);
  const auto policy = options.operation_options.contains("policy")
                          ? options.operation_options.at("policy")
                          : nlohmann::json{{"profile", "sealed-qualified-no-force/v1"}};
  nlohmann::json episodes = nlohmann::json::array();
  bool ok = true;
  for (const auto &candidate : candidates) {
    episodes.push_back({{"episode_id", std::to_string(candidate.episode_id)},
                        {"root", candidate.root},
                        {"qualification_root", candidate.qualification.at("qualification_root")},
                        {"disposition", candidate.disposition}});
    ok = ok && candidate.disposition != "refused" && candidate.disposition != "conflicted";
  }
  nlohmann::json preimage = {{"schema", ADMISSION_PLAN_SCHEMA},
                             {"protocol_version", 1},
                             {"initiator", text_or(options.operation_options, "initiator", "destination-pull")},
                             {"transport", transport},
                             {"source", source_identity},
                             {"destination", destination_identity},
                             {"source_frontier", source_frontier},
                             {"destination_frontier", destination_frontier},
                             {"episodes", episodes},
                             {"policy_root", rooted(policy)},
                             {"project_cut_roots", array_or_empty(options.operation_options, "project_cut_roots")}};
  auto plan = preimage;
  plan["ok"] = ok;
  plan["dry_run"] = true;
  plan["plan_root"] = rooted(preimage);
  plan["write_intent"] = {{"destination_only", true},
                          {"episodes", episodes.size()},
                          {"source_mutation", false},
                          {"git_mutation", false},
                          {"source_cleanup", false}};
  if (candidate_output != nullptr)
    *candidate_output = std::move(candidates);
  return plan;
}

[[nodiscard]] fs::path admission_dir(const std::string &runtime_dir) { return fs::path(runtime_dir) / "admission"; }

[[nodiscard]] std::string root_token(const std::string &root) {
  const auto delimiter = root.find(':');
  const auto token = delimiter == std::string::npos ? root : root.substr(delimiter + 1);
  if (token.empty() || token.find_first_not_of("0123456789abcdef") != std::string::npos)
    throw std::invalid_argument("admission_plan_root_invalid");
  return token;
}

[[nodiscard]] fs::path state_path(const std::string &runtime_dir, const std::string &plan_root) {
  return admission_dir(runtime_dir) / (root_token(plan_root) + ".state.json");
}

[[nodiscard]] fs::path receipt_path(const std::string &runtime_dir, const std::string &plan_root) {
  return admission_dir(runtime_dir) / (root_token(plan_root) + ".receipt.json");
}

[[nodiscard]] nlohmann::json read_json_file(const fs::path &path) {
  std::ifstream input(path);
  if (!input)
    throw std::invalid_argument("episode_admission_record_not_found");
  nlohmann::json value;
  input >> value;
  return value;
}

void write_state(const std::string &runtime_dir, const nlohmann::json &state) {
  write_json_file(state_path(runtime_dir, required_text(state, "plan_root")), state);
}

[[nodiscard]] nlohmann::json receipt_for_failure(const nlohmann::json &plan, const std::string &status,
                                                 const nlohmann::json &errors) {
  nlohmann::json already = nlohmann::json::array();
  nlohmann::json refused = nlohmann::json::array();
  nlohmann::json conflicted = nlohmann::json::array();
  for (const auto &episode : array_or_empty(plan, "episodes")) {
    const auto disposition = text_or(episode, "disposition");
    if (disposition == "already-present")
      already.push_back(episode.at("root"));
    else if (disposition == "refused")
      refused.push_back(episode.at("root"));
    else if (disposition == "conflicted")
      conflicted.push_back(episode.at("root"));
  }
  auto receipt = nlohmann::json{{"schema", ADMISSION_RECEIPT_SCHEMA},
                                {"ok", false},
                                {"status", status},
                                {"plan_root", plan.at("plan_root")},
                                {"destination", plan.at("destination")},
                                {"destination_before_frontier", plan.at("destination_frontier")},
                                {"accepted_roots", nlohmann::json::array()},
                                {"already_present_roots", already},
                                {"refused_roots", refused},
                                {"conflicted_roots", conflicted},
                                {"errors", errors}};
  receipt["destination_authority_proof"] = rooted(receipt);
  return receipt;
}

[[nodiscard]] nlohmann::json execute_plan(const storage_service_options &options, const nlohmann::json &plan,
                                          std::vector<admission_candidate> candidates, nlohmann::json state) {
  if (text_or(plan, "schema") != ADMISSION_PLAN_SCHEMA || text_or(plan, "plan_root").empty())
    throw std::invalid_argument("episode_admission_plan_invalid");
  nlohmann::json plan_preimage = plan;
  for (const auto *field : {"ok", "dry_run", "plan_root", "write_intent"})
    plan_preimage.erase(field);
  if (rooted(plan_preimage) != text_or(plan, "plan_root"))
    throw std::invalid_argument("episode_admission_plan_root_mismatch");
  if (!plan.value("ok", false)) {
    nlohmann::json errors = nlohmann::json::array();
    bool conflicted = false;
    for (const auto &episode : array_or_empty(plan, "episodes")) {
      const auto disposition = text_or(episode, "disposition");
      if (disposition == "refused" || disposition == "conflicted") {
        errors.push_back({{"code", "episode_" + disposition}, {"episode_id", episode.at("episode_id")}});
        conflicted = conflicted || disposition == "conflicted";
      }
    }
    return receipt_for_failure(plan, conflicted ? "conflicted" : "refused", errors);
  }
  const auto current_source = text_or(plan, "transport") == "local-direct"
                                  ? frontier_for(required_text(options.operation_options, "source_runtime_dir"))
                                  : frontier_for_candidates(candidates);
  if (frontier_root(current_source) != frontier_root(plan.at("source_frontier")))
    return receipt_for_failure(plan, "interrupted", nlohmann::json::array({{{"code", "source_frontier_drift"}}}));
  const auto current_destination = frontier_for(options.runtime_dir);
  const auto expected_destination = state.empty() ? plan.at("destination_frontier") : state.at("destination_frontier");
  if (frontier_root(current_destination) != frontier_root(expected_destination))
    return receipt_for_failure(plan, "interrupted", nlohmann::json::array({{{"code", "destination_frontier_drift"}}}));

  if (state.empty()) {
    state = {{"schema", ADMISSION_STATE_SCHEMA},
             {"plan_root", plan.at("plan_root")},
             {"status", "planned"},
             {"plan", plan},
             {"destination_frontier", current_destination},
             {"completed_roots", nlohmann::json::array()}};
    write_state(options.runtime_dir, state);
  }
  nlohmann::json accepted = state.empty() ? nlohmann::json::array() : array_or_empty(state, "completed_roots");
  std::set<std::string> completed;
  for (const auto &root : accepted)
    completed.insert(root.get<std::string>());
  nlohmann::json already = nlohmann::json::array();
  nlohmann::json errors = nlohmann::json::array();
  for (auto &candidate : candidates) {
    classify_destination(options, candidates);
    if (candidate.disposition == "already-present") {
      if (completed.count(candidate.root) == 0)
        already.push_back(candidate.root);
      continue;
    }
    if (candidate.disposition != "missing") {
      errors.push_back({{"code", "episode_" + candidate.disposition}, {"episode_id", candidate.episode_id}});
      break;
    }
    state["status"] = "transferring";
    state["current_episode_id"] = candidate.episode_id;
    write_state(options.runtime_dir, state);
    state["status"] = "transferred";
    write_state(options.runtime_dir, state);
    storage_service_options import_options = options;
    import_options.scope = "episode";
    import_options.episode_id = candidate.episode_id;
    import_options.bundle = candidate.bundle;
    import_options.dry_run = false;
    state["status"] = "verifying";
    write_state(options.runtime_dir, state);
    const auto import_receipt = episode_import_bundle_impl(import_options);
    if (!import_receipt.value("ok", false)) {
      errors.push_back({{"code", "episode_admission_failed"},
                        {"episode_id", candidate.episode_id},
                        {"import_receipt", import_receipt}});
      break;
    }
    if (text_or(import_receipt, "status") == "already_present")
      already.push_back(candidate.root);
    else
      accepted.push_back(candidate.root);
    completed.insert(candidate.root);
    state["completed_roots"].push_back(candidate.root);
    state["destination_frontier"] = frontier_for(options.runtime_dir);
    write_state(options.runtime_dir, state);
  }
  const auto after = frontier_for(options.runtime_dir);
  const bool ok = errors.empty();
  auto receipt = nlohmann::json{
      {"schema", ADMISSION_RECEIPT_SCHEMA},
      {"ok", ok},
      {"status", ok ? "admitted" : "interrupted"},
      {"plan_root", plan.at("plan_root")},
      {"destination", plan.at("destination")},
      {"destination_before_frontier", plan.at("destination_frontier")},
      {"destination_after_frontier", after},
      {"accepted_roots", accepted},
      {"already_present_roots", already},
      {"refused_roots", nlohmann::json::array()},
      {"conflicted_roots", nlohmann::json::array()},
      {"verification", {{"profile", "destination-root-and-scoped-fsck/v1"}, {"status", ok ? "ok" : "failed"}}},
      {"transport_observation", {{"kind", plan.at("transport")}, {"truth_effect", "none"}}},
      {"project_cut_roots", plan.at("project_cut_roots")},
      {"git_side_effect", false},
      {"source_cleanup", false},
      {"errors", errors}};
  receipt["destination_authority_proof"] = rooted(receipt);
  state["status"] = ok ? "admitted" : "interrupted";
  state["destination_frontier"] = after;
  state["receipt_ref"] = (root_token(text_or(plan, "plan_root")) + ".receipt.json");
  write_state(options.runtime_dir, state);
  write_json_file(receipt_path(options.runtime_dir, text_or(plan, "plan_root")), receipt);
  return receipt;
}

[[nodiscard]] bool frontier_is_reconcilable(const nlohmann::json &before, const nlohmann::json &current,
                                            const nlohmann::json &episodes) {
  std::unordered_map<uint64_t, std::string> required;
  std::unordered_map<uint64_t, std::string> allowed;
  for (const auto &row : array_or_empty(before, "sealed")) {
    const auto episode_id = parse_u64(row.at("episode_id"), "episode_id");
    required[episode_id] = text_or(row, "root");
    allowed[episode_id] = text_or(row, "root");
  }
  for (const auto &row : episodes)
    allowed[parse_u64(row.at("episode_id"), "episode_id")] = text_or(row, "root");
  if (canonical_json(array_or_empty(before, "open")) != canonical_json(array_or_empty(current, "open")))
    return false;
  std::set<uint64_t> observed;
  for (const auto &row : array_or_empty(current, "sealed")) {
    const auto episode_id = parse_u64(row.at("episode_id"), "episode_id");
    const auto iter = allowed.find(episode_id);
    if (iter == allowed.end() || iter->second != text_or(row, "root"))
      return false;
    observed.insert(episode_id);
  }
  for (const auto &[episode_id, root] : required) {
    (void)root;
    if (observed.count(episode_id) == 0)
      return false;
  }
  return true;
}

} // namespace

nlohmann::json episode_admission_impl(const storage_service_options &options) {
  const auto action = text_or(options.operation_options, "action", "plan");
  if (action == "contract")
    return admission_contract();
  if (action == "plan")
    return build_plan(options);
  if (action == "execute") {
    std::vector<admission_candidate> candidates;
    const auto current_plan = build_plan(options, &candidates);
    const auto supplied = object_or_empty(options.operation_options, "plan");
    const auto plan = supplied.empty() ? current_plan : supplied;
    if (text_or(plan, "plan_root") != text_or(current_plan, "plan_root"))
      return receipt_for_failure(plan, "interrupted", nlohmann::json::array({{{"code", "admission_plan_drift"}}}));
    return execute_plan(options, plan, std::move(candidates), nlohmann::json::object());
  }
  const auto plan_root = required_text(options.operation_options, "plan_root");
  const auto path = state_path(options.runtime_dir, plan_root);
  auto state = read_json_file(path);
  if (text_or(state, "schema") != ADMISSION_STATE_SCHEMA || text_or(state, "plan_root") != plan_root)
    throw std::invalid_argument("episode_admission_state_invalid");
  if (action == "inspect") {
    nlohmann::json result = {{"schema", "kungfu.episode-admission.inspect/v1"}, {"state", state}};
    const auto receipt = receipt_path(options.runtime_dir, plan_root);
    result["receipt"] = fs::exists(receipt) ? read_json_file(receipt) : nlohmann::json(nullptr);
    return result;
  }
  if (action == "cancel") {
    if (text_or(state, "status") == "admitted")
      throw std::invalid_argument("admitted episode admission cannot be cancelled");
    state["status"] = "cancelled";
    state["cancel_safe"] = true;
    state["cleanup_performed"] = false;
    write_state(options.runtime_dir, state);
    return state;
  }
  if (action == "reconcile") {
    const auto current = frontier_for(options.runtime_dir);
    const auto plan = state.at("plan");
    if (!frontier_is_reconcilable(plan.at("destination_frontier"), current, plan.at("episodes")))
      return {{"schema", "kungfu.episode-admission.reconcile/v1"},
              {"ok", false},
              {"status", "conflicted"},
              {"plan_root", plan_root},
              {"error", {{"code", "unrelated_destination_drift"}}}};
    state["destination_frontier"] = current;
    state["status"] = text_or(state, "status") == "admitted" ? "admitted" : "interrupted";
    state["reconciled"] = true;
    write_state(options.runtime_dir, state);
    return {{"schema", "kungfu.episode-admission.reconcile/v1"},
            {"ok", true},
            {"status", state.at("status")},
            {"plan_root", plan_root},
            {"destination_frontier", current}};
  }
  if (action == "resume") {
    if (text_or(state, "status") == "admitted")
      return read_json_file(receipt_path(options.runtime_dir, plan_root));
    auto candidates = transport_candidates(options, text_or(state.at("plan"), "transport"));
    classify_destination(options, candidates);
    return execute_plan(options, state.at("plan"), std::move(candidates), state);
  }
  throw std::invalid_argument("unsupported episode admission action: " + action);
}

} // namespace kungfu::runtime::storage_service_api::detail
