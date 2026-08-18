// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.h>
#include <kungfu/initiative_assignment_api.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace profile = kungfu::runtime::profile;
namespace storage = kungfu::yijinjing::storage;
using nlohmann::json;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

std::string read_file(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  require(static_cast<bool>(stream), "cannot open fixture: " + path);
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

void require_evidence(const json &actual, const json &expected, const std::string &id) {
  require(actual == expected, id + " evidence mismatch");
}

std::string fixture_root(const std::string &label) {
  return storage::format_content_hash(storage::compute_content_hash(label));
}

class temporary_runtime {
public:
  temporary_runtime()
      : path_(std::filesystem::temp_directory_path() /
              ("kungfu-initiative-assignment-native-" +
               std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))) {
    std::filesystem::create_directories(path_);
  }
  ~temporary_runtime() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  [[nodiscard]] const std::filesystem::path &path() const { return path_; }

private:
  std::filesystem::path path_;
};

nlohmann::json execute(kf_initiative_assignment_api_v1 &service, kf_context *context, uint32_t operation,
                       const nlohmann::json &input) {
  const auto bytes = input.dump();
  kf_semantic_message_v1 request{};
  request.struct_size = sizeof(request);
  request.protocol_id = KF_PROTOCOL_INITIATIVE_ASSIGNMENT_NATIVE;
  request.protocol_version = 1;
  request.schema_ref = KF_SCHEMA_INITIATIVE_ASSIGNMENT_REQUEST_V1;
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(bytes.data());
  request.byte_size = bytes.size();
  kf_owned_message_v1 result{};
  result.struct_size = sizeof(result);
  require(service.execute(context, operation, &request, &result) == KF_OK, "native service execution failed");
  const auto response =
      nlohmann::json::parse(reinterpret_cast<const char *>(result.message.bytes),
                            reinterpret_cast<const char *>(result.message.bytes) + result.message.byte_size);
  require(service.result_release(context, result.token) == KF_OK, "native service result release failed");
  return response.at("result");
}

} // namespace

void check_initiative_assignment_root_vectors() {
  const auto fixture =
      std::filesystem::path(KUNGFU_REPO_ROOT) / "tests/fixtures/initiative-assignment-root/vectors.json";
  const auto corpus = json::parse(read_file(fixture.string()));
  std::map<std::string, json> accepted;
  for (const auto &vector : corpus.at("accepted")) {
    const auto id = vector.at("id").get<std::string>();
    const auto evidence = profile::compute_initiative_assignment_root(vector.at("input"));
    require_evidence(evidence, vector.at("expected"), id);
    require_evidence(profile::verify_initiative_assignment_root(
                         vector.at("input"), vector.at("expected").at("canonicalHex").get<std::string>(),
                         vector.at("expected").at("preimageHex").get<std::string>(),
                         vector.at("expected").at("root").get<std::string>()),
                     vector.at("expected"), id + " verification");
    accepted.emplace(id, vector);
  }

  for (const auto &vector : corpus.at("rejected")) {
    const auto id = vector.at("id").get<std::string>();
    try {
      if (vector.contains("acceptedId")) {
        const auto &basis = accepted.at(vector.at("acceptedId").get<std::string>());
        auto claim = basis.at("expected");
        const auto &override = vector.at("claimOverride");
        claim[override.at("field").get<std::string>()] = override.at("value");
        (void)profile::verify_initiative_assignment_root(basis.at("input"), claim.at("canonicalHex").get<std::string>(),
                                                         claim.at("preimageHex").get<std::string>(),
                                                         claim.at("root").get<std::string>());
      } else {
        (void)profile::compute_initiative_assignment_root(vector.at("input"));
      }
      throw std::runtime_error("rejected vector was accepted: " + id);
    } catch (const profile::initiative_assignment_root_error &error) {
      require(error.code() == vector.at("failureCode").get<std::string>(), id + " failure code mismatch");
    }
  }
}

void check_initiative_assignment_native_admission() {
  const auto fixture =
      std::filesystem::path(KUNGFU_REPO_ROOT) / "tests/fixtures/initiative-assignment-root/vectors.json";
  const auto vector = json::parse(read_file(fixture.string())).at("accepted").at(0);
  temporary_runtime runtime;

  kf_api_v1 api{};
  require(kungfu_get_api(KF_ABI_V1, sizeof(api), &api) == KF_OK, "native API bootstrap failed");
  const auto runtime_text = runtime.path().string();
  kf_context_config_v1 config{};
  config.struct_size = sizeof(config);
  config.runtime_dir = runtime_text.c_str();
  config.stream_root = runtime_text.c_str();
  config.host_namespace = "initiative-assignment-test";
  config.host_name = "restartable-consumer";
  kf_context *context = nullptr;
  require(api.context_open(&config, &context) == KF_OK, "native admission context open failed");
  kf_initiative_assignment_api_v1 service{};
  require(api.interface_get(context, KF_INTERFACE_INITIATIVE_ASSIGNMENT, KF_INITIATIVE_ASSIGNMENT_ABI_V1,
                            sizeof(service), &service) == KF_OK,
          "Initiative/Assignment responsibility interface missing");

  const auto contract = execute(service, context, KF_INITIATIVE_ASSIGNMENT_CONTRACT, json::object());
  const auto admission = json{{"schema", "kungfu.initiative-assignment.native-admission/v1"},
                              {"assignmentId", "native-admission-fixture"},
                              {"rootInput", vector.at("input")},
                              {"expectedRoot", vector.at("expected").at("root")},
                              {"serviceContractRoot", contract.at("contractRoot")},
                              {"source", {{"head", std::string(40, 'a')}, {"tree", std::string(40, 'b')}}},
                              {"evidence",
                               {{"rootProtocolContractRoot", fixture_root("root-contract")},
                                {"vectorRoot", fixture_root(read_file(fixture.string()))},
                                {"pythonImplementationRoot", fixture_root("python-implementation")},
                                {"nativeImplementationRoot", fixture_root("native-cpp-implementation")},
                                {"platformEvidenceRoot", fixture_root("platform-evidence")},
                                {"historicalNoRewriteRoot", fixture_root("historical-no-rewrite")}}}};

  const auto empty_request_bytes = json::object().dump();
  kf_semantic_message_v1 empty_request{};
  empty_request.struct_size = sizeof(empty_request);
  empty_request.protocol_id = KF_PROTOCOL_INITIATIVE_ASSIGNMENT_NATIVE;
  empty_request.protocol_version = 1;
  empty_request.schema_ref = KF_SCHEMA_INITIATIVE_ASSIGNMENT_REQUEST_V1;
  empty_request.encoding = KF_ENCODING_JSON;
  empty_request.bytes = reinterpret_cast<const uint8_t *>(empty_request_bytes.data());
  empty_request.byte_size = empty_request_bytes.size();
  kf_owned_message_v1 held_result{};
  held_result.struct_size = sizeof(held_result);
  require(service.execute(context, KF_INITIATIVE_ASSIGNMENT_CONTRACT, &empty_request, &held_result) == KF_OK,
          "native service did not retain the caller-owned result slot");
  const auto admission_bytes = admission.dump();
  kf_semantic_message_v1 blocked_request{};
  blocked_request.struct_size = sizeof(blocked_request);
  blocked_request.protocol_id = KF_PROTOCOL_INITIATIVE_ASSIGNMENT_NATIVE;
  blocked_request.protocol_version = 1;
  blocked_request.schema_ref = KF_SCHEMA_INITIATIVE_ASSIGNMENT_REQUEST_V1;
  blocked_request.encoding = KF_ENCODING_JSON;
  blocked_request.bytes = reinterpret_cast<const uint8_t *>(admission_bytes.data());
  blocked_request.byte_size = admission_bytes.size();
  kf_owned_message_v1 blocked_result{};
  blocked_result.struct_size = sizeof(blocked_result);
  require(service.execute(context, KF_INITIATIVE_ASSIGNMENT_ADMIT, &blocked_request, &blocked_result) == KF_BUSY,
          "native admission mutated the journal while the result slot was busy");
  require(service.result_release(context, held_result.token) == KF_OK, "held native service result release failed");

  const auto recorded = execute(service, context, KF_INITIATIVE_ASSIGNMENT_ADMIT, admission);
  require(recorded.at("status") == "recorded-awaiting-restart-replay" && recorded.at("receiptIssued") == false,
          "journal write claimed a receipt before restart replay");
  require(api.context_close(context) == KF_OK, "pre-restart context close failed");

  context = nullptr;
  require(api.context_open(&config, &context) == KF_OK, "post-restart context open failed");
  service = {};
  require(api.interface_get(context, KF_INTERFACE_INITIATIVE_ASSIGNMENT, KF_INITIATIVE_ASSIGNMENT_ABI_V1,
                            sizeof(service), &service) == KF_OK,
          "post-restart Initiative/Assignment interface missing");
  const auto replay_request = json{{"schema", "kungfu.initiative-assignment.native-replay-request/v1"},
                                   {"assignmentId", "native-admission-fixture"},
                                   {"expectedBindingRoot", recorded.at("bindingRoot")},
                                   {"expectedEventRoot", recorded.at("eventRoot")}};
  const auto replayed = execute(service, context, KF_INITIATIVE_ASSIGNMENT_REPLAY, replay_request);
  const auto &receipt = replayed.at("receipt");
  require(replayed.at("status") == "replayed-and-receipt-issued" &&
              receipt.at("schema") == "kungfu.incubation-passport.admission-receipt/v1" &&
              receipt.at("rootProtocol").at("root") == vector.at("expected").at("root") &&
              receipt.at("journal").at("eventRoot") == recorded.at("eventRoot") &&
              receipt.at("journal").at("replayEvidenceRoot") ==
                  replayed.at("replayEvidence").at("replayEvidenceRoot") &&
              replayed.at("replayEvidence").at("matchedEventCount") == 1 &&
              receipt.at("implementations").at("languages") == json::array({"c++", "python"}),
          "restart replay receipt omitted an exact admission binding");

  auto mismatched = replay_request;
  mismatched["expectedEventRoot"] = fixture_root("wrong-event");
  const auto bytes = mismatched.dump();
  kf_semantic_message_v1 request{};
  request.struct_size = sizeof(request);
  request.protocol_id = KF_PROTOCOL_INITIATIVE_ASSIGNMENT_NATIVE;
  request.protocol_version = 1;
  request.schema_ref = KF_SCHEMA_INITIATIVE_ASSIGNMENT_REQUEST_V1;
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(bytes.data());
  request.byte_size = bytes.size();
  kf_owned_message_v1 rejected{};
  rejected.struct_size = sizeof(rejected);
  require(service.execute(context, KF_INITIATIVE_ASSIGNMENT_REPLAY, &request, &rejected) == KF_INVALID_ARGUMENT,
          "replay accepted a substituted event Root");
  require(api.context_close(context) == KF_OK, "post-replay context close failed");
}
