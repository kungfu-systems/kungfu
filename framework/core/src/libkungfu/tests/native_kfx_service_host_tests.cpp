// SPDX-License-Identifier: Apache-2.0

#include <algorithm>
#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <functional>
#include <stdexcept>
#include <string>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>

namespace kfx = kungfu::runtime::kfx;
namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

fs::path registry_root() {
  return fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_registry" / "roots" / "workspace";
}

json load_fixture(const std::string &name) {
  const auto path = fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_contract" / name;
  std::ifstream input(path);
  if (!input)
    throw std::runtime_error("cannot open fixture: " + path.string());
  return json::parse(input);
}

fs::path temp_root(const std::string &name) {
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::temp_directory_path() / ("kungfu-native-kfx-" + name + "-" + std::to_string(nonce));
  fs::create_directories(root);
  return root;
}

std::string fixture_root(char value) { return "sha256:" + std::string(64, value); }

void require_refusal(const std::string &code, const std::function<void()> &operation) {
  std::string detail = "no exception";
  try {
    operation();
  } catch (const std::invalid_argument &error) {
    detail = error.what();
    if (detail.rfind(code, 0) == 0)
      return;
  }
  throw std::runtime_error("operation did not fail with stable code " + code + ": " + detail);
}

json passport_authorized_request(json request, const std::string &package_key, const std::string &operation) {
  auto inspect = request;
  inspect["packageKey"] = package_key;
  const auto package = kfx::query_native_kfx_registry("inspect", inspect).at("package");
  const auto fixture = load_fixture("buildchain-2.13.0-alpha.0-envelope.json");
  const auto &projection = fixture.at("projection");
  request.update(fixture.at("admission"));
  request["packageKey"] = package_key;
  request["operation"] = operation;
  request["assessmentTime"] = fixture.at("assessmentTime");
  request["authorizationTime"] = fixture.at("assessmentTime");
  request["attestation"] = projection.at("attestation");
  request["trustInputs"] = projection.at("trustInputs");
  request["kfdAssessment"] = projection.at("kfdAssessment");
  request["attestation"]["bindings"]["packageRoot"] = package.at("packageRoot");
  request["trustInputs"]["packageRoot"] = package.at("packageRoot");
  request["requestedCapabilities"] = package.at("declaredCapabilities");
  request["policy"]["autoOperations"] = json::array({"install", "update", "enable", "activate", "qualify"});
  request["approvalRoots"] = json::array();
  return request;
}

json mutation_request(const json &request, const json &plan, const std::string &package_key,
                      const std::string &operation) {
  auto mutation = request;
  mutation["packageKey"] = package_key;
  mutation["operation"] = operation;
  mutation["expectedCutRoot"] = plan.at("cutRoot");
  mutation["expectedRevision"] = plan.at("revision");
  mutation["expectedRegistryRoot"] = plan.at("registryRoot");
  mutation["expectedGraphRoot"] = plan.at("graphRoot");
  mutation["expectedPlanRoot"] = plan.at("planRoot");
  mutation["expectedAuthorizationPlanRoot"] = plan.at("authorizationPlanRoot");
  mutation["expectedCapabilityGrantRoot"] = plan.at("capabilityGrantRoot");
  mutation["expectedWarrantRoot"] = plan.at("warrantRoot");
  for (const auto &package : plan.at("packages")) {
    if (package.at("key") == package_key) {
      mutation["expectedTrustRoot"] = package.at("trustRoot");
      mutation["expectedPackageRoot"] = package.at("packageRoot");
      break;
    }
  }
  mutation["actor"] = "native-kfx-test";
  mutation["systemTime"] = 100 + plan.at("revision").get<uint64_t>();
  return mutation;
}

json service_host_manifest() {
  auto manifest = json{{"schema", "kungfu.kfx.manifest/v1"},
                       {"version", "1.0.0"},
                       {"name", "@example/webhook"},
                       {"kungfuConfig", {{"key", "example-webhook"}}}};
  auto &service = manifest["kungfuConfig"]["config"]["service"];
  service["runtimes"] = json::array({"node"});
  service["entry"] = {{"node", "service.mjs"}};
  service["capabilities"] = json::array({"network.listen", "credential.verify"});
  auto &host = service["host"];
  host["schema"] = "kungfu.kfx.service-host/v1";
  host["contractVersion"] = 1;
  host["lifecycle"] = {{"restartPolicy", "on-failure"},
                       {"readinessTimeoutMs", 5000},
                       {"drainTimeoutMs", 5000},
                       {"shutdownTimeoutMs", 5000}};
  host["webhook"]["listener"] = {{"mode", "disabled"}, {"path", "/hook"}, {"methods", json::array({"POST"})}};
  host["webhook"]["credentials"] = json::array({{{"handle", "credential:webhook/signing"},
                                                 {"purpose", "webhook-signature-verification"},
                                                 {"algorithms", json::array({"hmac-sha256"})}}});
  host["webhook"]["intake"] = {{"maxPayloadBytes", 1048576},  {"maxQueueDepth", 64},   {"maxInflight", 8},
                               {"maxRequestsPerWindow", 120}, {"rateWindowMs", 60000}, {"handlerTimeoutMs", 5000},
                               {"replayWindowMs", 300000}};
  return manifest;
}

void test_service_host_contract_and_native_validation() {
  const auto contract = kfx::native_kfx_contract();
  require(contract.at("serviceHost").at("schema") == "kungfu.kfx.service-host/v1",
          "native contract omitted service host v1");
  require(contract.at("serviceHost").at("authority").at("identityPrivilege") == false,
          "service host gained identity privilege");
  require(contract.at("serviceHost").at("capabilities").at("nonLoopbackListener") ==
              json::array({"network.listen", "network.listen.non-loopback", "credential.verify"}),
          "non-loopback listener grants drifted");

  const auto manifest = service_host_manifest();
  require(kfx::normalize_native_kfx_manifest(manifest) == manifest,
          "valid service host declaration did not cross the native seam");

  auto secret_bearing = manifest;
  secret_bearing["kungfuConfig"]["config"]["service"]["host"]["webhook"]["credentials"][0]["secret"] =
      "must-never-cross";
  try {
    (void)kfx::normalize_native_kfx_manifest(secret_bearing);
  } catch (const std::exception &error) {
    require(std::string(error.what()).find("KF_KFX_SCHEMA_INVALID") != std::string::npos,
            "secret-bearing declaration failed with the wrong diagnostic");
    return;
  }
  throw std::runtime_error("secret-bearing declaration crossed the native seam");
}

void test_runtime_warrant_contract() {
  const auto home = temp_root("runtime-warrant");
  const auto source_root = home / "sources";
  fs::create_directories(source_root);
  fs::copy(registry_root() / "example-suite" / "members" / "optional-view", source_root / "optional-view",
           fs::copy_options::recursive);
  const auto runtime_dir = home / "runtime";
  const auto source_request = passport_authorized_request(
      {{"roots", json::array({{{"kind", "user"}, {"path", source_root.string()}}})}}, "optional-view", "install");
  const auto install_plan = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  const auto installed = kfx::query_native_kfx_registry(
      "apply", mutation_request(source_request, install_plan, "optional-view", "install"), runtime_dir.string());
  const auto plan = kfx::query_native_kfx_registry("plan", json::object(), runtime_dir.string());
  const auto &descriptor = plan.at("hostContract");
  const auto authorization =
      *std::find_if(descriptor.at("runtimeAuthorizations").begin(), descriptor.at("runtimeAuthorizations").end(),
                    [](const auto &candidate) { return candidate.at("packageKey") == "optional-view"; });
  json issue_request = {{"packageKey", "optional-view"},
                        {"host", authorization.at("host")},
                        {"expectedCutRoot", descriptor.at("cutRoot")},
                        {"expectedRevision", descriptor.at("revision")},
                        {"expectedGenerationRoot", descriptor.at("generationRoot")},
                        {"expectedPackageRoot", authorization.at("packageRoot")},
                        {"expectedCapabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                        {"expectedAuthorizationRoot", authorization.at("authorizationRoot")},
                        {"expectedGrantedCapabilities", authorization.at("grantedCapabilities")},
                        {"holder", "worker-a"},
                        {"purpose", "run optional KFX view"},
                        {"leaseNonce", "generation-1"},
                        {"issuedAt", 10},
                        {"expiresAt", 50},
                        {"heartbeatTtl", 10},
                        {"residualResponsibility", "kungfu-core retains recovery and terminal settlement"},
                        {"requestedCapabilities", json::array({"domain"})}};
  auto amplified = issue_request;
  amplified["requestedCapabilities"].push_back("process");
  require_refusal("KF_KFX_RUNTIME_AUTHORITY_AMPLIFICATION", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-issue", amplified, runtime_dir.string());
  });
  const auto issued = kfx::query_native_kfx_registry("runtime-warrant-issue", issue_request, runtime_dir.string());
  const auto &warrant = issued.at("runtimeWarrant");
  const auto &lease = issued.at("leaseState");
  require(issued.at("executionAllowed").get<bool>() && lease.at("generation") == 1 && lease.at("state") == "active" &&
              lease.at("heartbeatDeadline") == 20 && warrant.at("warrantClass") == "leased-runtime" &&
              warrant.at("warrantRoot") != warrant.at("capabilityGrantRoot") &&
              warrant.at("warrantRoot") != warrant.at("mutationWarrantRoot") &&
              installed.at("receipt").at("warrantRoot") == warrant.at("mutationWarrantRoot"),
          "Runtime Warrant did not remain separate from capability and one-shot Mutation authority");
  require_refusal("KF_KFX_RUNTIME_WARRANT_ACTIVE", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-issue", issue_request, runtime_dir.string());
  });

  json transition = {{"packageKey", "optional-view"},
                     {"host", authorization.at("host")},
                     {"holder", "worker-a"},
                     {"expectedWarrantRoot", warrant.at("warrantRoot")},
                     {"expectedGeneration", lease.at("generation")},
                     {"expectedFencingToken", lease.at("fencingToken")},
                     {"recordedAt", 15}};
  auto substituted = transition;
  substituted["expectedWarrantRoot"] = fixture_root('0');
  require_refusal("KF_KFX_RUNTIME_FENCE_STALE", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-heartbeat", substituted, runtime_dir.string());
  });
  auto stale_holder = transition;
  stale_holder["holder"] = "worker-b";
  require_refusal("KF_KFX_RUNTIME_HOLDER_STALE", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-heartbeat", stale_holder, runtime_dir.string());
  });
  const auto heartbeat = kfx::query_native_kfx_registry("runtime-warrant-heartbeat", transition, runtime_dir.string());
  require(heartbeat.at("leaseState").at("heartbeatAt") == 15 &&
              heartbeat.at("leaseState").at("heartbeatDeadline") == 25,
          "Runtime Warrant heartbeat did not renew the bounded freshness window");
  require_refusal("KF_KFX_RUNTIME_HEARTBEAT_DUPLICATE", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-heartbeat", transition, runtime_dir.string());
  });
  auto stale_heartbeat = transition;
  stale_heartbeat["recordedAt"] = 26;
  require_refusal("KF_KFX_RUNTIME_HEARTBEAT_STALE", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-heartbeat", stale_heartbeat, runtime_dir.string());
  });

  auto recover = transition;
  recover.erase("holder");
  recover["recordedAt"] = 26;
  const auto recovered = kfx::query_native_kfx_registry("runtime-warrant-recover", recover, runtime_dir.string());
  require(recovered.at("leaseState").at("state") == "recovered" &&
              recovered.at("receipt").at("settlementBodyRoot").is_string(),
          "fresh-process Core recovery did not settle a missed heartbeat with retained responsibility");
  require_refusal("KF_KFX_RUNTIME_WARRANT_TERMINAL", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-recover", recover, runtime_dir.string());
  });

  auto issue_two = issue_request;
  issue_two["leaseNonce"] = "generation-2";
  issue_two["issuedAt"] = 30;
  issue_two["expiresAt"] = 60;
  const auto issued_two = kfx::query_native_kfx_registry("runtime-warrant-issue", issue_two, runtime_dir.string());
  require(issued_two.at("leaseState").at("generation") == 2 &&
              issued_two.at("leaseState").at("fencingToken") != lease.at("fencingToken"),
          "successor Runtime Warrant did not advance generation and fencing");
  auto revoke = transition;
  revoke["expectedWarrantRoot"] = issued_two.at("runtimeWarrant").at("warrantRoot");
  revoke["expectedGeneration"] = issued_two.at("leaseState").at("generation");
  revoke["expectedFencingToken"] = issued_two.at("leaseState").at("fencingToken");
  revoke.erase("holder");
  revoke["recordedAt"] = 31;
  revoke["reason"] = "operator stop";
  revoke["revocationAuthorityRoot"] = "not-a-root";
  require_refusal("KF_KFX_RUNTIME_REVOCATION_INVALID", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-revoke", revoke, runtime_dir.string());
  });
  revoke["revocationAuthorityRoot"] = fixture_root('a');
  const auto revoked = kfx::query_native_kfx_registry("runtime-warrant-revoke", revoke, runtime_dir.string());
  require(revoked.at("leaseState").at("state") == "revoked" &&
              revoked.at("leaseState").at("revocationRoot").is_string() &&
              revoked.at("leaseState").at("settlementRoot").is_string() &&
              revoked.at("receipt").at("settlementBodyRoot").is_string(),
          "independent revocation did not terminally fence and settle the Runtime Warrant");

  auto issue_three = issue_request;
  issue_three["leaseNonce"] = "generation-3";
  issue_three["issuedAt"] = 40;
  issue_three["expiresAt"] = 70;
  const auto issued_three = kfx::query_native_kfx_registry("runtime-warrant-issue", issue_three, runtime_dir.string());
  auto settle = transition;
  settle["expectedWarrantRoot"] = issued_three.at("runtimeWarrant").at("warrantRoot");
  settle["expectedGeneration"] = issued_three.at("leaseState").at("generation");
  settle["expectedFencingToken"] = issued_three.at("leaseState").at("fencingToken");
  settle["recordedAt"] = 45;
  settle["outcome"] = "completed";
  settle["residualResponsibilityDisposition"] = "retained-by-kungfu-core";
  const auto settled = kfx::query_native_kfx_registry("runtime-warrant-settle", settle, runtime_dir.string());
  require(settled.at("leaseState").at("state") == "settled" &&
              settled.at("leaseState").at("settlementRoot").is_string(),
          "terminal Runtime Warrant settlement was not retained as a distinct Fact");
  require_refusal("KF_KFX_RUNTIME_WARRANT_TERMINAL", [&] {
    (void)kfx::query_native_kfx_registry("runtime-warrant-settle", settle, runtime_dir.string());
  });

  auto issue_four = issue_request;
  issue_four["leaseNonce"] = "generation-4";
  issue_four["issuedAt"] = 50;
  issue_four["expiresAt"] = 55;
  const auto issued_four = kfx::query_native_kfx_registry("runtime-warrant-issue", issue_four, runtime_dir.string());
  auto expire = transition;
  expire["expectedWarrantRoot"] = issued_four.at("runtimeWarrant").at("warrantRoot");
  expire["expectedGeneration"] = issued_four.at("leaseState").at("generation");
  expire["expectedFencingToken"] = issued_four.at("leaseState").at("fencingToken");
  expire.erase("holder");
  expire["recordedAt"] = 55;
  const auto expired = kfx::query_native_kfx_registry("runtime-warrant-recover", expire, runtime_dir.string());
  require(expired.at("event") == "lease-expired" && expired.at("leaseState").at("state") == "recovered",
          "Core did not fail closed and settle the exact lease-expiry boundary");

  const json witness_request = {{"packageKey", "optional-view"}, {"host", authorization.at("host")}};
  const auto witness_a = kfx::query_native_kfx_registry("kfd-10-witness", witness_request, runtime_dir.string());
  const auto witness_b = kfx::query_native_kfx_registry("kfd-10-witness", witness_request, runtime_dir.string());
  require(witness_a == witness_b && witness_a.at("standard") == "KFD-10" &&
              witness_a.at("claimClass") == "draft-adopter-evidence" &&
              witness_a.at("authoritySeparation").at("kfdEvidenceIsNotRuntimePrivilege").get<bool>() &&
              witness_a.at("mutationLifecycleRoot").is_string() && witness_a.at("runtimeLifecycleRoot").is_string() &&
              witness_a.at("witnessRoot").is_string(),
          "KFX did not produce a deterministic authority-separated KFD-10 specialized witness");
  fs::remove_all(home);
}

} // namespace

void test_native_kfx_service_host_contract() { test_service_host_contract_and_native_validation(); }

void test_kfx_runtime_warrant_is_leased_fenced_recoverable_and_witnessed() { test_runtime_warrant_contract(); }
