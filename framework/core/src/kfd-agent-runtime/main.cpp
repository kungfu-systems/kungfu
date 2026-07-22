// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <set>
#include <string>
#include <string_view>

namespace {

using json = nlohmann::json;

constexpr std::string_view REQUEST_CONTRACT = "kfd.agent-runtime-adapter-request/v1";
constexpr std::string_view RESPONSE_CONTRACT = "kfd.agent-runtime-adapter-response/v1";
constexpr std::string_view PROFILE = "kfd-agent-runtime@0.1.0-alpha.1";
constexpr uint64_t REQUIRED_CAPABILITIES =
    KF_CAP_STREAM | KF_CAP_LEDGER_ACTION | KF_CAP_MAINTENANCE | KF_CAP_CANCELLATION | KF_CAP_EXPLICIT_PROTOCOL_CURRENCY;

struct decision {
  std::string status;
  std::string code;
};

decision accept(std::string code) { return {"accepted", std::move(code)}; }
decision reject(std::string code) { return {"rejected", std::move(code)}; }

bool is_root(const json &value) {
  if (!value.is_string()) {
    return false;
  }
  const auto &text = value.get_ref<const std::string &>();
  if (text.size() != 71 || !text.starts_with("sha256:")) {
    return false;
  }
  return std::all_of(text.begin() + 7, text.end(),
                     [](unsigned char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); });
}

bool string_array_contains(const json &values, const json &candidate) {
  return values.is_array() &&
         std::any_of(values.begin(), values.end(), [&](const json &value) { return value == candidate; });
}

bool is_subset(const json &subset, const json &superset) {
  return subset.is_array() && superset.is_array() && std::all_of(subset.begin(), subset.end(), [&](const json &value) {
           return string_array_contains(superset, value);
         });
}

bool has_duplicates(const json &values) {
  if (!values.is_array()) {
    return false;
  }
  std::set<std::string> unique;
  for (const auto &value : values) {
    if (!value.is_string() || !unique.insert(value.get<std::string>()).second) {
      return true;
    }
  }
  return false;
}

bool is_contiguous(const json &values) {
  if (!values.is_array()) {
    return false;
  }
  for (size_t index = 0; index < values.size(); ++index) {
    if (!values[index].is_number_integer() || values[index].get<int64_t>() != static_cast<int64_t>(index)) {
      return false;
    }
  }
  return true;
}

uint64_t episode_id_for_request(std::string_view request_id) {
  uint64_t value = UINT64_C(14695981039346656037);
  for (const auto ch : request_id) {
    value ^= static_cast<unsigned char>(ch);
    value *= UINT64_C(1099511628211);
  }
  return UINT64_C(0x4b00000000000000) | (value & UINT64_C(0x00ffffffffffffff));
}

decision pursuit(const std::string &operation, const json &input) {
  const auto state = input.value("state", json{});
  if (operation == "pursuit.create") {
    if (!state.is_null() && !state.empty()) {
      return reject("pursuit-already-exists");
    }
    return input.value("target", json::object()).value("version", 0) == 1 ? accept("pursuit-created")
                                                                          : reject("pursuit-version-gap");
  }
  if (!state.is_object() || state.value("status", "") != "active") {
    return reject("pursuit-not-active");
  }
  if (input.value("baseVersion", -1) != state.value("version", -2)) {
    return reject("pursuit-stale-version");
  }
  if (operation == "pursuit.revise") {
    return input.value("targetVersion", -1) == state.value("version", -2) + 1 ? accept("pursuit-revised")
                                                                              : reject("pursuit-version-gap");
  }
  if (operation == "pursuit.fork") {
    const auto fork = input.value("fork", json::object());
    if (fork.value("id", "") == state.value("id", "")) {
      return reject("pursuit-identity-reuse");
    }
    return fork.value("version", 0) == 1 ? accept("pursuit-forked") : reject("pursuit-version-gap");
  }
  if (operation == "pursuit.settle") {
    if (!input.contains("completionVerdict") || input.value("completionVerdict", "").empty()) {
      return reject("completion-verdict-missing");
    }
    return input.value("completionVerdict", "") == "admitted" ? accept("pursuit-settled")
                                                              : reject("completion-verdict-not-admitted");
  }
  return reject("operation-unsupported");
}

decision atlas(const std::string &operation, const json &input) {
  const auto state = input.value("state", json{});
  if (operation == "atlas.cut") {
    const auto roots = input.value("sourceRoots", json::array());
    if (!roots.is_array() || roots.empty()) {
      return reject("atlas-source-roots-missing");
    }
    return has_duplicates(roots) ? reject("atlas-source-root-duplicate") : accept("atlas-cut-created");
  }
  if (!state.is_object()) {
    return reject("atlas-cut-missing");
  }
  if (operation == "atlas.mark-stale") {
    if (state.value("status", "") == "stale") {
      return reject("atlas-already-stale");
    }
    return input.value("reason", "").empty() ? reject("atlas-stale-reason-missing") : accept("atlas-marked-stale");
  }
  if (state.value("status", "") == "stale") {
    return reject("atlas-cut-stale");
  }
  if (input.value("baseCutRoot", "") != state.value("cutRoot", "")) {
    return reject("atlas-cut-mismatch");
  }
  if (operation == "atlas.derive") {
    return is_root(input.value("derivedRoot", json{})) ? accept("atlas-derived") : reject("atlas-derived-root-missing");
  }
  if (operation == "atlas.refresh") {
    if (input.value("sourceRoot", "") != state.value("sourceRoot", "")) {
      return reject("atlas-source-root-mismatch");
    }
    return is_root(input.value("nextCutRoot", json{})) ? accept("atlas-refreshed") : reject("atlas-next-cut-missing");
  }
  return reject("operation-unsupported");
}

decision warrant(const std::string &operation, const json &input) {
  const auto state = input.value("state", json{});
  if (operation == "warrant.issue") {
    return is_root(input.value("grant", json::object()).value("authorityRoot", json{}))
               ? accept("warrant-issued")
               : reject("warrant-authority-root-missing");
  }
  if (!state.is_object() || !is_root(state.value("authorityRoot", json{}))) {
    return reject("warrant-authority-root-missing");
  }
  if (operation == "warrant.revoke") {
    return input.value("authorityRoot", "") == state.value("authorityRoot", "")
               ? accept("warrant-revoked")
               : reject("warrant-revoker-unauthorized");
  }
  if (operation == "warrant.use") {
    if (state.value("status", "") == "revoked") {
      return reject("warrant-revoked");
    }
    if (!string_array_contains(state.value("allowedActions", json::array()), input.value("action", json{}))) {
      return reject("warrant-action-forbidden");
    }
    if (state.value("scope", "") != input.value("scope", "")) {
      return reject("warrant-scope-mismatch");
    }
    return input.value("now", INT64_C(0)) > state.value("expiresAt", INT64_C(0)) ? reject("warrant-expired")
                                                                                 : accept("warrant-authorized");
  }
  if (state.value("status", "") != "active") {
    return reject("warrant-not-active");
  }
  const auto grant = input.value("grant", json::object());
  const auto actions = grant.value("allowedActions", json::array());
  if (!actions.is_array() || actions.empty()) {
    return reject("warrant-actions-missing");
  }
  if (!is_subset(actions, state.value("allowedActions", json::array()))) {
    return reject("warrant-authority-amplification");
  }
  if (grant.value("scope", "") != state.value("scope", "")) {
    return reject("warrant-scope-amplification");
  }
  if (grant.value("expiresAt", INT64_C(0)) > state.value("expiresAt", INT64_C(0))) {
    return reject("warrant-expiry-amplification");
  }
  if (operation == "warrant.attenuate") {
    return accept("warrant-attenuated");
  }
  if (operation == "warrant.delegate") {
    return accept("warrant-delegated");
  }
  return reject("operation-unsupported");
}

decision action(const std::string &operation, const json &input) {
  if (operation == "action.bind") {
    const auto binding = input.value("binding", json::object());
    for (const auto &[field, code] :
         {std::pair{"pursuitRoot", "action-pursuit-root-missing"}, std::pair{"atlasRoot", "action-atlas-root-missing"},
          std::pair{"warrantRoot", "action-warrant-root-missing"}, std::pair{"actionRoot", "action-root-missing"}}) {
      if (!is_root(binding.value(field, json{}))) {
        return reject(code);
      }
    }
    if (!binding.value("preconditionsSatisfied", false)) {
      return reject("action-precondition-failed");
    }
    return binding.value("warrantActive", false) ? accept("action-bound") : reject("action-warrant-inactive");
  }
  if (operation != "action.assess") {
    return reject("operation-unsupported");
  }
  if (input.value("receiverVerdict", "") == "inferred-from-delivery") {
    return reject("delivery-is-not-admission");
  }
  if (input.value("completionVerdict", "") == "inferred-from-seal") {
    return reject("episode-is-not-completion");
  }
  if (input.value("factVerdict", "") == "inferred-from-call") {
    return reject("call-is-not-admission");
  }
  if (input.value("factVerdict", "") == "admitted" && input.value("verdictAuthority", "") == "producer") {
    return reject("producer-cannot-self-admit");
  }
  if (input.value("factVerdict", "") == "admitted") {
    return accept("receiver-verdict-retained");
  }
  if (input.value("transportDelivered", false)) {
    return accept("delivery-kept-separate");
  }
  if (input.value("episodeSealed", false)) {
    return accept("occurrence-kept-separate");
  }
  return input.value("callSucceeded", false) ? accept("call-kept-separate") : reject("action-assessment-empty");
}

decision episode_fact(const std::string &operation, const json &input) {
  const auto state = input.value("state", json{});
  if (operation == "episode.open") {
    return !state.is_null() && !state.empty() ? reject("episode-already-exists") : accept("episode-opened");
  }
  if (operation == "episode.append") {
    if (input.value("index", -1) != state.value("nextIndex", -2)) {
      return reject("episode-index-gap");
    }
    return is_root(input.value("claimRoot", json{})) ? accept("episode-appended")
                                                     : reject("episode-claim-root-missing");
  }
  if (operation == "episode.commit") {
    return is_root(input.value("contentRoot", json{})) ? accept("episode-committed")
                                                       : reject("episode-content-root-missing");
  }
  if (operation == "episode.interrupt") {
    return accept("episode-interrupted");
  }
  if (operation == "episode.seal") {
    return state.value("status", "") == "committed" ? accept("episode-sealed") : reject("episode-not-committed");
  }
  if (operation == "episode.replay") {
    return input.value("semanticRoot", "") == input.value("observedRoot", "") ? accept("episode-replayed")
                                                                              : reject("episode-root-mismatch");
  }
  if (operation == "fact.propose") {
    return accept("fact-proposed");
  }
  if (operation == "fact.admit") {
    return input.value("verdictAuthority", "") == "receiver" ? accept("fact-admitted")
                                                             : reject("fact-admitter-unauthorized");
  }
  if (operation == "fact.reject") {
    return accept("fact-rejected");
  }
  if (operation == "fact.conflict") {
    const auto roots = input.value("roots", json::array());
    std::set<std::string> distinct;
    for (const auto &root : roots) {
      if (root.is_string()) {
        distinct.insert(root.get<std::string>());
      }
    }
    return distinct.size() >= 2 ? accept("fact-conflicted") : reject("fact-conflict-roots-incomplete");
  }
  if (operation == "fact.supersede") {
    const auto status = state.value("status", "");
    return status == "admitted" || status == "conflicted" ? accept("fact-superseded") : reject("fact-not-admitted");
  }
  return reject("operation-unsupported");
}

decision recovery(const std::string &operation, const json &input) {
  const auto state = input.value("state", json::object());
  if (operation == "runtime.crash") {
    return state.value("acknowledgedSeq", INT64_C(0)) <= state.value("durableSeq", INT64_C(0))
               ? accept("runtime-crash-bounded")
               : reject("runtime-ack-ahead-of-durability");
  }
  if (operation == "runtime.reopen") {
    return input.value("observedProviderRoot", "") == state.value("providerRoot", "")
               ? accept("runtime-reopened")
               : reject("runtime-provider-root-mismatch");
  }
  if (operation == "runtime.fsck") {
    return state.value("expectedRoot", "") == state.value("observedRoot", "") ? accept("runtime-fsck-clean")
                                                                              : reject("runtime-root-mismatch");
  }
  if (operation == "runtime.export") {
    return is_root(input.value("exportedRoot", json{})) ? accept("runtime-exported")
                                                        : reject("runtime-export-root-missing");
  }
  if (operation == "runtime.import") {
    return input.value("declaredRoot", "") == input.value("observedRoot", "") ? accept("runtime-imported")
                                                                              : reject("runtime-import-root-mismatch");
  }
  if (operation == "runtime.replay") {
    return is_contiguous(input.value("indexes", json::array())) ? accept("runtime-replayed")
                                                                : reject("runtime-replay-gap");
  }
  if (operation == "runtime.retry") {
    const auto previous = input.value("previous", json::object());
    const auto next = input.value("next", json::object());
    return previous.value("key", "") == next.value("key", "") &&
                   previous.value("exchangeRoot", "") == next.value("exchangeRoot", "")
               ? accept("runtime-retry-idempotent")
               : reject("runtime-idempotency-reuse");
  }
  if (operation == "runtime.reconnect") {
    const auto roots = input.value("conflictRoots", json::array());
    return string_array_contains(roots, input.value("localRoot", json{})) &&
                   string_array_contains(roots, input.value("remoteRoot", json{}))
               ? accept("runtime-conflict-retained")
               : reject("runtime-conflict-hidden");
  }
  return reject("operation-unsupported");
}

decision evaluate(const json &request) {
  if (!request.is_object() || !request.contains("input") || !request["input"].is_object()) {
    return reject("adapter-input-invalid");
  }
  const auto &input = request["input"];
  const auto category = input.value("category", "");
  const auto operation = input.value("operation", "");
  const auto transition = input.value("input", json::object());
  if (category == "pursuit") {
    return pursuit(operation, transition);
  }
  if (category == "atlas") {
    return atlas(operation, transition);
  }
  if (category == "warrant") {
    return warrant(operation, transition);
  }
  if (category == "action") {
    return action(operation, transition);
  }
  if (category == "episode-fact") {
    return episode_fact(operation, transition);
  }
  if (category == "recovery") {
    return recovery(operation, transition);
  }
  return reject("category-unsupported");
}

class runtime_boundary {
public:
  runtime_boundary() = default;
  runtime_boundary(const runtime_boundary &) = delete;
  runtime_boundary &operator=(const runtime_boundary &) = delete;
  ~runtime_boundary() {
    if (context_ != nullptr) {
      api_.context_close(context_);
    }
  }

  bool open(std::string &code) {
    const auto *configured = std::getenv("KUNGFU_KFD_RUNTIME_DIR");
    if (configured == nullptr || configured[0] == '\0') {
      code = "runtime-dir-required";
      return false;
    }
    runtime_dir_ = std::filesystem::absolute(configured).lexically_normal().string();
    embedding_root_ = runtime_dir_ + ".embedding";
    std::error_code error;
    std::filesystem::create_directories(std::filesystem::path(runtime_dir_).parent_path(), error);
    if (error) {
      code = "runtime-parent-unavailable";
      return false;
    }

    if (kungfu_get_api(KF_ABI_V1, sizeof(api_), &api_) != KF_OK) {
      code = "standard-abi-unavailable";
      return false;
    }
    kf_context_config_v1 config{};
    config.struct_size = sizeof(config);
    config.runtime_dir = runtime_dir_.c_str();
    config.stream_root = embedding_root_.c_str();
    config.host_namespace = "kungfu.kfd";
    config.host_name = "agent-runtime-adapter";
    if (api_.context_open(&config, &context_) != KF_OK) {
      code = "standard-context-unavailable";
      return false;
    }
    if (api_.context_capabilities(context_, &capabilities_) != KF_OK ||
        (capabilities_ & REQUIRED_CAPABILITIES) != REQUIRED_CAPABILITIES) {
      code = "standard-capability-missing";
      return false;
    }
    if (api_.interface_get(context_, KF_INTERFACE_STREAM, KF_STREAM_ABI_V1, sizeof(stream_api_), &stream_api_) !=
        KF_OK) {
      code = "stream-interface-unavailable";
      return false;
    }
    if (api_.interface_get(context_, KF_INTERFACE_LEDGER_ACTION, KF_LEDGER_ACTION_ABI_V1, sizeof(ledger_api_),
                           &ledger_api_) != KF_OK) {
      code = "ledger-interface-unavailable";
      return false;
    }
    if (api_.interface_get(context_, KF_INTERFACE_MAINTENANCE, KF_MAINTENANCE_ABI_V1, sizeof(maintenance_api_),
                           &maintenance_api_) != KF_OK) {
      code = "maintenance-interface-unavailable";
      return false;
    }
    return true;
  }

  bool retain_accepted_transition(const std::string &request_id, const std::string &operation, const json &binding,
                                  std::string &code) {
    if (!binding.is_object()) {
      code = "action-binding-required";
      return false;
    }
    const auto read_root = [&](const char *name) -> std::string {
      const auto value = binding.value(name, std::string{});
      return is_root(value) ? value : std::string{};
    };
    const auto fact_cut_root = read_root("factCutRoot");
    const auto pursuit_root = read_root("pursuitRoot");
    const auto atlas_root = read_root("atlasRoot");
    const auto warrant_root = read_root("warrantRoot");
    const auto candidate_action_root = read_root("candidateActionRoot");
    const auto preconditions_root = read_root("preconditionsRoot");
    const auto resources_root = read_root("resourcesRoot");
    if (fact_cut_root.empty() || pursuit_root.empty() || atlas_root.empty() || warrant_root.empty() ||
        candidate_action_root.empty() || preconditions_root.empty() || resources_root.empty()) {
      code = "action-binding-invalid";
      return false;
    }
    kf_action_binding_config_v1 binding_config{};
    binding_config.struct_size = sizeof(binding_config);
    binding_config.fact_cut_root = fact_cut_root.c_str();
    binding_config.pursuit_root = pursuit_root.c_str();
    binding_config.atlas_root = atlas_root.c_str();
    binding_config.warrant_root = warrant_root.c_str();
    binding_config.candidate_action_root = candidate_action_root.c_str();
    binding_config.preconditions_root = preconditions_root.c_str();
    binding_config.resources_root = resources_root.c_str();
    kf_action_binding *action_binding = nullptr;
    if (ledger_api_.binding_open(context_, &binding_config, &action_binding) != KF_OK) {
      code = "action-binding-rejected";
      return false;
    }
    const auto episode_id = episode_id_for_request(request_id);
    ++accepted_count_;
    const auto begin = json{{"episode_id", episode_id},
                            {"begin_time", static_cast<int64_t>(accepted_count_ * 2)},
                            {"title", "KFD Agent Runtime accepted transition"},
                            {"actor", "kungfu-kfd-agent-runtime"},
                            {"source", operation}};
    if (!execute(action_binding, KF_LEDGER_ACTION_EPISODE_BEGIN, begin)) {
      ledger_api_.binding_close(action_binding);
      code = "runtime-episode-begin-failed";
      return false;
    }
    const auto end = json{{"episode_id", episode_id},
                          {"end_time", static_cast<int64_t>(accepted_count_ * 2 + 1)},
                          {"frame_count", 0},
                          {"reason", "KFD transition accepted"}};
    if (!execute(action_binding, KF_LEDGER_ACTION_EPISODE_END, end)) {
      ledger_api_.binding_close(action_binding);
      code = "runtime-episode-end-failed";
      return false;
    }
    return ledger_api_.binding_close(action_binding) == KF_OK;
  }

  json observations() const {
    return {{"semanticBoundary", "preserved"},
            {"runtimeBoundary", "libkungfu-public-c-abi"},
            {"bootstrap", "kungfu_get_api"},
            {"abi", api_.abi_version},
            {"capabilities", capabilities_},
            {"streamAbi", stream_api_.abi_version},
            {"ledgerActionAbi", ledger_api_.abi_version},
            {"maintenanceAbi", maintenance_api_.abi_version}};
  }

private:
  bool execute(kf_action_binding *binding, uint32_t operation, const json &request) {
    const auto payload = request.dump();
    kf_semantic_message_v1 message{};
    message.struct_size = sizeof(message);
    message.protocol_id = KF_PROTOCOL_STORAGE_SERVICE;
    message.protocol_version = 1;
    message.schema_ref = KF_SCHEMA_LEDGER_ACTION_REQUEST_V1;
    message.encoding = KF_ENCODING_JSON;
    message.bytes = reinterpret_cast<const uint8_t *>(payload.data());
    message.byte_size = payload.size();
    kf_owned_message_v1 result{};
    result.struct_size = sizeof(result);
    if (ledger_api_.execute(context_, binding, operation, &message, &result) != KF_OK || result.token == 0 ||
        result.message.bytes == nullptr) {
      return false;
    }
    return ledger_api_.result_release(context_, result.token) == KF_OK;
  }

  std::string runtime_dir_;
  std::string embedding_root_;
  kf_api_v1 api_{};
  kf_context *context_ = nullptr;
  kf_stream_api_v1 stream_api_{};
  kf_ledger_action_api_v1 ledger_api_{};
  kf_maintenance_api_v1 maintenance_api_{};
  uint64_t capabilities_ = 0;
  uint64_t accepted_count_ = 0;
};

json response(const std::string &request_id, const decision &result, const json &observations) {
  return {{"schemaVersion", 1},
          {"contract", RESPONSE_CONTRACT},
          {"requestId", request_id},
          {"adapter",
           {{"id", "kungfu-libkungfu-kfd-agent-runtime"},
            {"version", "0.1.0"},
            {"topology", "in-process-libkungfu-public-c-abi"}}},
          {"status", result.status},
          {"code", result.code},
          {"observations", observations}};
}

} // namespace

int main() {
  runtime_boundary boundary;
  bool ready = false;
  std::string readiness_code = "handshake-required";
  for (std::string line; std::getline(std::cin, line);) {
    json envelope;
    std::string request_id = "invalid";
    try {
      envelope = json::parse(line);
      request_id = envelope.value("requestId", "invalid");
      if (envelope.value("schemaVersion", 0) != 1 || envelope.value("contract", "") != REQUEST_CONTRACT ||
          request_id == "invalid") {
        throw std::runtime_error("invalid request envelope");
      }
      const auto operation = envelope.value("operation", "");
      if (operation == "handshake") {
        if (!ready) {
          ready = boundary.open(readiness_code);
        }
        const decision result = ready ? accept("adapter-ready") : decision{"error", readiness_code};
        auto observations = ready ? boundary.observations() : json{{"failClosed", true}};
        observations["profile"] = PROFILE;
        observations["protocol"] = "jsonl-stdio/v1";
        observations["topology"] = "in-process-libkungfu-public-c-abi";
        std::cout << response(request_id, result, observations).dump() << '\n';
        continue;
      }
      if (operation != "evaluate") {
        std::cout << response(request_id, reject("adapter-operation-unsupported"), {{"failClosed", true}}).dump()
                  << '\n';
        continue;
      }
      if (!ready) {
        std::cout << response(request_id, {"error", readiness_code}, {{"failClosed", true}}).dump() << '\n';
        continue;
      }
      auto result = evaluate(envelope);
      std::string storage_retention = "not-applicable";
      if (result.status == "accepted") {
        const auto input = envelope.value("input", json::object());
        if (input.contains("actionBinding")) {
          std::string storage_code;
          const auto kfd_operation = input.value("operation", "");
          if (!boundary.retain_accepted_transition(request_id, kfd_operation, input["actionBinding"], storage_code)) {
            result = {"error", storage_code};
          } else {
            storage_retention = "retained";
          }
        } else {
          storage_retention = "not-requested";
        }
      }
      auto observations = result.status == "accepted" ? boundary.observations() : json{{"failClosed", true}};
      if (result.status == "accepted") {
        observations["storageRetention"] = storage_retention;
      }
      std::cout << response(request_id, result, observations).dump() << '\n';
    } catch (const std::exception &) {
      std::cout << response(request_id, {"error", "adapter-request-invalid"}, {{"failClosed", true}}).dump() << '\n';
    }
  }
  return 0;
}
