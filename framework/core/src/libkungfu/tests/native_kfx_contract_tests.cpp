// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
namespace kfx = kungfu::runtime::kfx;

void test_native_kfx_service_host_contract();

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

nlohmann::json load_fixture(const std::string &name) {
  const auto path = fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_contract" / name;
  std::ifstream input(path);
  if (!input)
    throw std::runtime_error("cannot open fixture: " + path.string());
  return nlohmann::json::parse(input);
}

fs::path registry_root() {
  return fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_registry" / "roots" / "workspace";
}

fs::path semantic_registry_root() {
  return fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_registry" / "semantic";
}

fs::path control_suite_source() {
  return fs::weakly_canonical(fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / ".." / ".." / ".." / ".." / ".." /
                              "extensions" / "system" / "kfx-manager");
}

void copy_control_suite_candidate(const fs::path &destination) {
  const auto source = control_suite_source();
  fs::create_directories(destination);
  fs::copy_file(source / "kungfu.kfx.json", destination / "kungfu.kfx.json");
  fs::copy_file(source / "package.json", destination / "package.json");
  fs::copy(source / "src", destination / "src", fs::copy_options::recursive);
}

nlohmann::json expected_registry_roots() {
  const auto path =
      fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / "fixtures" / "native_kfx_registry" / "expected-roots.json";
  std::ifstream input(path);
  if (!input)
    throw std::runtime_error("cannot open expected registry roots: " + path.string());
  return nlohmann::json::parse(input);
}

nlohmann::json registry_request() {
  return {{"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", registry_root().string()}}})}};
}

void require_refusal(const std::string &code, const std::function<void()> &operation) {
  bool refused = false;
  std::string detail = "no exception";
  try {
    operation();
  } catch (const std::invalid_argument &error) {
    detail = error.what();
    refused = detail.rfind(code, 0) == 0;
  }
  require(refused, "operation did not fail with stable code " + code + ": " + detail);
}

void write_json(const fs::path &path, const nlohmann::json &value) {
  fs::create_directories(path.parent_path());
  std::ofstream output(path);
  output << value.dump(2) << '\n';
}

fs::path temp_root(const std::string &name) {
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::temp_directory_path() / ("kungfu-native-kfx-" + name + "-" + std::to_string(nonce));
  fs::create_directories(root);
  return root;
}

bool contains_text(const nlohmann::json &values, const std::string &expected) {
  return values.is_array() && std::any_of(values.begin(), values.end(),
                                          [&](const auto &value) { return value.is_string() && value == expected; });
}

void test_contract_is_versioned_and_core_owned() {
  const auto first = kfx::native_kfx_contract();
  const auto second = kfx::native_kfx_contract();
  require(first.at("schema") == kfx::NATIVE_KFX_CONTRACT_V3, "native contract schema drifted");
  require(first.at("contractVersion") == 3, "native contract version drifted");
  require(first.at("versionNegotiation").at("supported") == nlohmann::json::array({3}),
          "native contract retained pre-cutover authority documents");
  require(first.at("sourceContractVersion") == 14, "native contract did not expose its source compatibility version");
  require(contains_text(first.at("coreCapabilityPolicy").at("allowedCapabilities"), "projects"),
          "native Core capability policy omitted the Projects application service");
  require(first.at("runtimeTiers") == nlohmann::json::array({"isolated", "integrated-explicit", "metadata-only"}),
          "native contract exposed an origin-derived runtime tier");
  require(first.at("admissionGrades") == nlohmann::json::array({"unverified", "identity-verified", "kfd-attested"}),
          "native contract exposed an origin-derived admission grade");
  require(first.at("runtimeTiers") != first.at("admissionGrades"),
          "runtime tier and admission grade were collapsed into one authority field");
  require(first.at("authority").at("owner") == "libkungfu", "native contract did not assign Core authority");
  require(first.at("authority").at("profileLifecycle") == "existing-kungfu.profile-lifecycle/v1",
          "native seam created a parallel Profile lifecycle");
  const auto &assessment = first.at("admissionAssessment");
  require(assessment.at("verifierContract").at("contract") == "kungfu-buildchain-artifact-verification",
          "native admission did not freeze the exact Buildchain verifier contract");
  require(contains_text(assessment.at("trustReport").at("required"), "registryRoot") &&
              contains_text(assessment.at("admissionPlan").at("required"), "receiptDependencyRoot"),
          "native admission did not freeze its report and receipt dependency shapes");
  require(assessment.at("receiptDependency").at("mutationRule") == "future-mutation-must-bind-exact-root",
          "native admission contract did not bind future mutation receipts");
  require(assessment.at("mutationAuthorization").at("authority") == "libkungfu-recomputed-before-side-effects" &&
              assessment.at("mutationAuthorization").at("warrantLifecycle").at(1) == "issued-in-fact-cut",
          "native admission contract did not freeze pre-side-effect Warrant authority");
  require(assessment.at("kfdAssessment").at("lifecycleOwner") == "KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302",
          "native KFX admission created a second KFD assessment lifecycle");
  require(first.at("semanticGraph").at("dependencyModes") == nlohmann::json::array({"required", "uses-if-present"}),
          "native contract did not freeze required and optional semantic dependency modes");
  require(first.at("semanticGraph").at("compositionRule") == "contributes-to-never-transfers-extension-point-ownership",
          "native contract allowed contribution composition to become ownership");
  require(first.at("lifecycle").at("authority") == "one-libkungfu-writer-per-runtime-directory",
          "native contract did not freeze one runtime-directory writer");
  require(first.at("lifecycle").at("fences").front() == "expectedCutRoot" &&
              first.at("lifecycle").at("fences").at(1) == "expectedRevision" &&
              contains_text(first.at("lifecycle").at("fences"), "expectedAuthorizationPlanRoot") &&
              contains_text(first.at("lifecycle").at("fences"), "expectedCapabilityGrantRoot") &&
              contains_text(first.at("lifecycle").at("fences"), "expectedWarrantRoot"),
          "native lifecycle did not freeze Cut plus authorization/Warrant fences");
  require(first.at("experienceFlowHost").at("renderingAuthority") == "host-native",
          "native contract claimed host rendering authority");
  require(first.at("experienceFlowHost").at("authorizationSchema") == "kungfu.kfx.host-authorization/v2",
          "native contract did not freeze exact-root host launch authorization");
  const auto &bootstrap = first.at("controlSuiteBootstrap");
  require(
      bootstrap.at("authority").at("selfGrant") == false && bootstrap.at("authority").at("originAuthority") == false &&
          bootstrap.at("authority").at("productAssemblyAuthority") == false &&
          bootstrap.at("recovery").at("automaticActivation") == false &&
          bootstrap.at("bootstrapTcb") ==
              nlohmann::json::array({"manifest-and-closure-verifier", "release-passport-verifier",
                                     "core-policy-interpreter", "fact-work-warrant-settlement",
                                     "last-known-good-selector", "safe-mode", "owner-authorized-emergency-removal"}) &&
          bootstrap.at("policyRoot").get<std::string>().starts_with("sha256:"),
      "native contract did not embed the bounded Control Suite bootstrap ceiling");
  const auto profile = kfx::native_kfx_domain_profile();
  require(profile.at("authority").at("namedCutRef") == "profiles/kfx/registry" &&
              profile.at("authority").at("factKernel") == "yijinjing-hana-pod-journal" &&
              profile.at("domainProfileRoot").get<std::string>().starts_with("sha256:"),
          "KFX Domain Profile did not bind the native Fact/Cut authority");
  require(first.at("nativeContractRoot") == second.at("nativeContractRoot"), "native contract root was unstable");
  require(first.at("sourceContractRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "source contract root was not content-addressed");
}

void test_positive_and_negative_fixtures() {
  for (const auto &fixture : load_fixture("positive-cases.json")) {
    const auto result = kfx::validate_native_kfx_document(fixture.at("kind"), fixture.at("document"));
    require(result.at("valid").get<bool>(), "positive fixture was refused: " + fixture.at("name").get<std::string>());
  }
  for (const auto &fixture : load_fixture("negative-cases.json")) {
    bool refused = false;
    try {
      (void)kfx::validate_native_kfx_document(fixture.at("kind"), fixture.at("document"));
    } catch (const std::invalid_argument &error) {
      refused = std::string(error.what()).rfind(fixture.at("expectedCode").get<std::string>(), 0) == 0;
    }
    require(refused, "negative fixture did not fail with its stable code: " + fixture.at("name").get<std::string>());
  }
}

void test_manifest_normalization_uses_the_embedded_source_contract() {
  const nlohmann::json manifest = {
      {"schema", "kungfu.kfx.manifest/v1"},
      {"version", "1.0.0"},
      {"name", "@example/view"},
      {"kungfuConfig",
       {{"key", "example-view"}, {"config", {{"view", {{"capabilities", nlohmann::json::array({"domain"})}}}}}}}};
  const auto normalized = kfx::normalize_native_kfx_manifest(manifest);
  require(normalized == manifest, "valid manifest normalization changed semantic content");
  auto invalid = manifest;
  invalid["kungfuConfig"]["unexpectedAuthority"] = true;
  require_refusal("KF_KFX_SCHEMA_INVALID", [&] { (void)kfx::normalize_native_kfx_manifest(invalid); });
}

class recording_service final : public kfx::native_kfx_service {
public:
  nlohmann::json list(const nlohmann::json &) override { return {{"operation", "list"}}; }
  nlohmann::json inspect(const nlohmann::json &) override { return {{"operation", "inspect"}}; }
  nlohmann::json resolve(const nlohmann::json &) override { return {{"operation", "resolve"}}; }
  nlohmann::json plan(const nlohmann::json &) override { return {{"operation", "plan"}}; }
  nlohmann::json apply(const nlohmann::json &) override { return {{"operation", "apply"}}; }
  nlohmann::json status(const nlohmann::json &) override { return {{"operation", "status"}}; }
  nlohmann::json history(const nlohmann::json &) override { return {{"operation", "history"}}; }
};

void test_service_interface_routes_only_validated_requests() {
  recording_service service;
  for (const auto *operation : {"list", "inspect", "resolve", "plan", "apply", "status", "history"}) {
    const nlohmann::json request = {{"schema", "kungfu.kfx.native-request/v3"},
                                    {"contractVersion", 3},
                                    {"operation", operation},
                                    {"packagePath", "extensions/example-kfx"},
                                    {"requestedCapabilities", nlohmann::json::array()}};
    require(kfx::invoke_native_kfx_service(service, request).at("operation") == operation,
            std::string("native service did not route ") + operation);
  }
  const nlohmann::json pre_cutover_request = {{"schema", "kungfu.kfx.native-request/v1"},
                                              {"contractVersion", 1},
                                              {"operation", "inspect"},
                                              {"packagePath", "extensions/example-kfx"},
                                              {"requestedCapabilities", nlohmann::json::array()}};
  require_refusal("KF_KFX_CONTRACT_VERSION_UNSUPPORTED",
                  [&] { (void)kfx::invoke_native_kfx_service(service, pre_cutover_request); });
}

void test_registry_produces_one_deterministic_cross_surface_plan() {
  const auto request = registry_request();
  const auto listed = kfx::query_native_kfx_registry("list", request);
  auto inspect_request = request;
  inspect_request["packageKey"] = "optional-view";
  const auto inspected = kfx::query_native_kfx_registry("inspect", inspect_request);
  auto resolve_request = request;
  resolve_request["suiteKey"] = "example-suite";
  const auto resolved = kfx::query_native_kfx_registry("resolve", resolve_request);
  const auto first_plan = kfx::query_native_kfx_registry("plan", request);
  const auto second_plan = kfx::query_native_kfx_registry("plan", request);
  const auto status = kfx::query_native_kfx_registry("status", request);

  require(listed.at("packages").size() == 3, "native registry did not find the Suite closure");
  require(inspected.at("package").at("runtimeTier") == "isolated",
          "native registry did not derive its safe observation placement");
  require(inspected.at("package").at("admissionGrade") == "unverified",
          "native registry collapsed admission grade into runtime tier");
  require(resolved.at("suite").at("memberRoots").size() == 2, "native Suite closure is incomplete");
  require(resolved.at("suite").at("profileRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "native registry did not reuse the Profile lifecycle root");
  require(first_plan == second_plan, "native load plan is not deterministic");
  auto product_labeled_request = request;
  product_labeled_request.at("roots").front()["kind"] = "product";
  auto user_labeled_request = request;
  user_labeled_request.at("roots").front()["kind"] = "user";
  require(kfx::query_native_kfx_registry("plan", product_labeled_request) ==
              kfx::query_native_kfx_registry("plan", user_labeled_request),
          "discovery-root labels changed the KFX plan or host authorization inputs");
  require(first_plan.at("planRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "native load plan is not content-addressed");
  require(status.at("registryRoot") == first_plan.at("registryRoot"), "status and plan read different snapshots");
  require(!status.at("readOnly") && !status.at("cacheAuthority"), "registry did not expose its single writer seam");
  require(status.at("graphRoot") == first_plan.at("graphRoot"), "status and plan read different semantic graphs");
}

void test_registry_negative_and_concurrent_reads() {
  const auto request = registry_request();
  auto collision = request;
  collision.at("roots").push_back(collision.at("roots").front());
  require_refusal("KF_KFX_ROOT_COLLISION", [&] { (void)kfx::query_native_kfx_registry("list", collision); });

  auto caller_placement = request;
  caller_placement["hostPlacements"] = {{"optional-view", nlohmann::json::array({"gui"})}};
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", caller_placement); });
  auto caller_tier = request;
  caller_tier["runtimeTiers"] = {{"optional-view", "integrated-explicit"}};
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", caller_tier); });

  auto stale = request;
  stale["expectedRegistryRoot"] = "sha256:stale";
  require_refusal("KF_KFX_REGISTRY_STALE", [&] { (void)kfx::query_native_kfx_registry("status", stale); });
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", [&] { (void)kfx::query_native_kfx_registry("apply", request); });
  auto forged_admission = request;
  forged_admission["firstParty"] = {{"optional-view", true}};
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", forged_admission); });

  const auto degraded_root = temp_root("optional");
  fs::copy(registry_root(), degraded_root, fs::copy_options::recursive | fs::copy_options::overwrite_existing);
  fs::remove_all(degraded_root / "example-suite" / "members" / "optional-view");
  const nlohmann::json degraded_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", degraded_root.string()}}})}};
  const auto degraded = kfx::query_native_kfx_registry("plan", degraded_request);
  require(degraded.at("suites").front().at("missingOptional") == nlohmann::json::array({"optional-view"}),
          "missing optional Suite member did not produce a degraded closure");
  require(degraded.at("suites").front().at("profileRoot").is_null(),
          "incomplete optional Suite closure incorrectly claimed a Profile root");
  require(degraded.at("diagnostics").front().at("code") == "KF_KFX_OPTIONAL_MEMBER_MISSING",
          "missing optional Suite member did not emit the stable diagnostic");
  fs::remove_all(degraded_root);

  const auto duplicate_root = temp_root("duplicate");
  const nlohmann::json duplicate_manifest = {{"schema", "kungfu.kfx.manifest/v1"},
                                             {"name", "duplicate"},
                                             {"version", "1.0.0"},
                                             {"kungfuConfig", {{"key", "duplicate-key"}}}};
  write_json(duplicate_root / "one" / "kungfu.kfx.json", duplicate_manifest);
  write_json(duplicate_root / "two" / "kungfu.kfx.json", duplicate_manifest);
  const nlohmann::json duplicate_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", duplicate_root.string()}}})}};
  require_refusal("KF_KFX_PACKAGE_DUPLICATE", [&] { (void)kfx::query_native_kfx_registry("list", duplicate_request); });
  fs::remove_all(duplicate_root);

  const auto legacy_root = temp_root("legacy-manifest");
  const nlohmann::json legacy_manifest = {
      {"name", "legacy"}, {"version", "1.0.0"}, {"kungfuConfig", {{"key", "legacy"}}}};
  write_json(legacy_root / "legacy" / "package.json", legacy_manifest);
  const nlohmann::json legacy_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", legacy_root.string()}}})}};
  require_refusal("KF_KFX_MANIFEST_MISSING", [&] { (void)kfx::query_native_kfx_registry("list", legacy_request); });
  write_json(legacy_root / "legacy" / "kungfu.kfx.json", {{"schema", "kungfu.kfx.manifest/v1"},
                                                          {"name", "legacy"},
                                                          {"version", "1.0.0"},
                                                          {"kungfuConfig", {{"key", "legacy"}}}});
  require_refusal("KF_KFX_MANIFEST_CONFLICT", [&] { (void)kfx::query_native_kfx_registry("list", legacy_request); });
  fs::remove_all(legacy_root);

  const auto missing_root = temp_root("missing");
  write_json(missing_root / "suite" / "kungfu.kfx.json",
             {{"schema", "kungfu.kfx.manifest/v1"},
              {"name", "missing-suite"},
              {"version", "1.0.0"},
              {"kungfuConfig",
               {{"key", "missing-suite"},
                {"suite", {{"title", "Missing"}, {"members", nlohmann::json::array({"absent-member"})}}}}}});
  const nlohmann::json missing_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", missing_root.string()}}})}};
  require_refusal("KF_KFX_MEMBER_MISSING", [&] { (void)kfx::query_native_kfx_registry("resolve", missing_request); });
  fs::remove_all(missing_root);

  const auto cycle_root = temp_root("cycle");
  write_json(
      cycle_root / "a" / "kungfu.kfx.json",
      {{"schema", "kungfu.kfx.manifest/v1"},
       {"name", "a"},
       {"version", "1.0.0"},
       {"kungfuConfig", {{"key", "a"}, {"suite", {{"title", "A"}, {"members", nlohmann::json::array({"b"})}}}}}});
  write_json(
      cycle_root / "b" / "kungfu.kfx.json",
      {{"schema", "kungfu.kfx.manifest/v1"},
       {"name", "b"},
       {"version", "1.0.0"},
       {"kungfuConfig", {{"key", "b"}, {"suite", {{"title", "B"}, {"members", nlohmann::json::array({"a"})}}}}}});
  const nlohmann::json cycle_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", cycle_root.string()}}})}};
  require_refusal("KF_KFX_SUITE_CYCLE", [&] { (void)kfx::query_native_kfx_registry("plan", cycle_request); });
  fs::remove_all(cycle_root);

  std::vector<std::future<nlohmann::json>> reads;
  for (size_t index = 0; index < 8; ++index)
    reads.push_back(
        std::async(std::launch::async, [request] { return kfx::query_native_kfx_registry("plan", request); }));
  const auto expected = reads.front().get();
  for (size_t index = 1; index < reads.size(); ++index)
    require(reads[index].get() == expected, "concurrent registry readers observed different roots");
}

std::string fixture_root(char value) { return "sha256:" + std::string(64, value); }

nlohmann::json assessment_request() {
  auto request = registry_request();
  auto inspect = request;
  inspect["packageKey"] = "optional-view";
  const auto package_root =
      kfx::query_native_kfx_registry("inspect", inspect).at("package").at("packageRoot").get<std::string>();
  const auto fixture = load_fixture("buildchain-2.13.0-alpha.0-envelope.json");
  require(fixture.at("producer").at("version") == "2.13.0-alpha.0",
          "round-trip fixture did not come from the published Buildchain alpha");
  const auto &projection = fixture.at("projection");
  require(projection.at("contract") == "kungfu-buildchain-kfx-admission-inputs",
          "round-trip fixture is not the public Buildchain KFX projection");
  require(projection.at("envelopeRoot") == fixture.at("expected").at("envelopeRoot"),
          "round-trip fixture envelope root drifted");
  request.update(fixture.at("admission"));
  request["assessmentTime"] = fixture.at("assessmentTime");
  request["attestation"] = projection.at("attestation");
  request["trustInputs"] = projection.at("trustInputs");
  request["kfdAssessment"] = projection.at("kfdAssessment");
  request["attestation"]["bindings"]["packageRoot"] = package_root;
  request["trustInputs"]["packageRoot"] = package_root;
  return request;
}

nlohmann::json passport_authorized_request(nlohmann::json request, const std::string &package_key,
                                           const std::string &operation, const std::string &runtime_dir = "") {
  auto inspect = request;
  inspect.erase("controller");
  inspect["packageKey"] = package_key;
  const auto package = kfx::query_native_kfx_registry("inspect", inspect, runtime_dir).at("package");
  const auto package_root = package.at("packageRoot").get<std::string>();
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
  request["attestation"]["bindings"]["packageRoot"] = package_root;
  request["trustInputs"]["packageRoot"] = package_root;
  request["requestedCapabilities"] = package.at("declaredCapabilities");
  request["policy"]["autoOperations"] = nlohmann::json::array({"install", "update", "enable", "activate", "qualify"});
  request["approvalRoots"] = nlohmann::json::array();
  for (const auto &capability : request.at("requestedCapabilities")) {
    if (capability == "agentRuntime" || capability == "kfxControl" || capability == "process" ||
        capability == "storage") {
      request["approvalRoots"].push_back(fixture_root('a'));
      break;
    }
  }
  return request;
}

nlohmann::json recovery_authorized_request(nlohmann::json request, const std::string &package_key,
                                           const std::string &operation, const fs::path &runtime_dir) {
  auto inspect = request;
  inspect["packageKey"] = package_key;
  const auto package = kfx::query_native_kfx_registry("inspect", inspect, runtime_dir.string()).at("package");
  const auto status = kfx::query_native_kfx_registry("status", request, runtime_dir.string());
  const auto authorization_time = 1'000 + status.at("revision").get<uint64_t>();
  const auto approval_root = fixture_root('a');
  request["packageKey"] = package_key;
  request["operation"] = operation;
  request["authorizationTime"] = authorization_time;
  request["approvalRoots"] = nlohmann::json::array({approval_root});
  request["recoveryWarrant"] = {{"schema", "kungfu.kfx-recovery-warrant/v1"},
                                {"issuerClass", "workspace-owner"},
                                {"operation", operation},
                                {"packageRoot", package.at("packageRoot")},
                                {"expectedCutRoot", status.at("cutRoot")},
                                {"expectedRevision", status.at("revision").get<int64_t>()},
                                {"approvalRoots", request.at("approvalRoots")},
                                {"issuedAt", authorization_time - 1},
                                {"expiresAt", authorization_time + 100},
                                {"nonce", "native-kfx-recovery-test"}};
  return request;
}

void test_exact_buildchain_attestation_and_operation_admission() {
  const auto request = assessment_request();
  const auto first = kfx::query_native_kfx_registry("assess", request);
  const auto second = kfx::query_native_kfx_registry("assess", request);
  require(first == second, "KFX TrustReport and admission plan are not deterministic");
  require(first.at("registryRoot") == first.at("trustReport").at("registryRoot"),
          "KFX TrustReport did not bind the assessed registry snapshot");
  require(first.at("trustReport").at("supplyChainGrade") == "kfd-attested",
          "exact Buildchain evidence did not produce the KFD-attested supply-chain grade");
  require(first.at("trustReport").at("admissionGrade") == "kfd-attested",
          "KFD attestation was collapsed into Product System authority");
  require(first.at("admissionPlan").at("allowed"), "policy did not reduce friction for an exact attestation");
  require(first.at("trustReport").at("reportRoot").get<std::string>().starts_with("sha256:"),
          "TrustReport is not content-addressed");
  require(first.at("trustReport").at("corePolicyRoot").get<std::string>().starts_with("sha256:") &&
              first.at("trustReport").at("requestedPolicyRoot").get<std::string>().starts_with("sha256:") &&
              first.at("trustReport").at("policyRoot") != first.at("trustReport").at("corePolicyRoot") &&
              first.at("trustReport").at("policyRoot") != first.at("trustReport").at("requestedPolicyRoot"),
          "effective admission policy did not bind distinct Core and requested policy roots");
  const auto actual_report_root = first.at("trustReport").at("reportRoot").get<std::string>();
  const auto expected_report_root =
      load_fixture("buildchain-2.13.0-alpha.0-envelope.json").at("expected").at("coreReportRoot").get<std::string>();
  require(actual_report_root == expected_report_root,
          "Core report root drifted from the published Buildchain round-trip fixture: actual=" + actual_report_root +
              " expected=" + expected_report_root);
  require(first.at("admissionPlan").at("receiptDependencyRoot").get<std::string>().starts_with("sha256:"),
          "admission plan did not bind the future receipt dependency");
  require(!first.at("trustReport").at("recoveryGuidance").empty(),
          "admission did not expose deterministic recovery guidance");

  auto sibling = request;
  sibling["attestation"]["bindings"]["packageRoot"] = fixture_root('8');
  const auto rejected = kfx::query_native_kfx_registry("assess", sibling);
  require(rejected.at("trustReport").at("supplyChainGrade") == "unverified",
          "sibling artifact evidence incorrectly retained its trust grade");
  require(!rejected.at("admissionPlan").at("allowed"), "sibling artifact evidence did not fail closed");

  auto incomplete_policy = request;
  incomplete_policy["policy"].erase("residualRisk");
  require_refusal("KF_KFX_SCHEMA_INVALID", [&] { (void)kfx::query_native_kfx_registry("assess", incomplete_policy); });

  auto authority_expansion = request;
  authority_expansion["policy"]["allowedCapabilities"].push_back("filesystem.write");
  require_refusal("KF_KFX_CAPABILITY_POLICY_REJECTED",
                  [&] { (void)kfx::query_native_kfx_registry("assess", authority_expansion); });

  auto automatic_operation_expansion = request;
  automatic_operation_expansion["policy"]["autoOperations"].push_back("migration");
  require_refusal("KF_KFX_CAPABILITY_POLICY_REJECTED",
                  [&] { (void)kfx::query_native_kfx_registry("assess", automatic_operation_expansion); });

  auto ambiguous_inputs = request;
  ambiguous_inputs["trustInputs"]["unversionedHint"] = true;
  require_refusal("KF_KFX_SCHEMA_INVALID", [&] { (void)kfx::query_native_kfx_registry("assess", ambiguous_inputs); });

  auto dependency_mismatch = request;
  dependency_mismatch["attestation"]["bindings"]["dependencyRoot"] = fixture_root('9');
  require(kfx::query_native_kfx_registry("assess", dependency_mismatch).at("trustReport").at("supplyChainGrade") ==
              "unverified",
          "mismatched dependency closure retained its trust grade");

  auto publisher_mismatch = request;
  publisher_mismatch["attestation"]["bindings"]["publisher"] = "sibling-publisher";
  const auto publisher_rejected = kfx::query_native_kfx_registry("assess", publisher_mismatch);
  require(publisher_rejected.at("trustReport").at("supplyChainGrade") == "unverified",
          "mismatched publisher retained its trust grade");
  require(contains_text(publisher_rejected.at("trustReport").at("reasons"), "KF_KFX_ATTESTATION_PRINCIPAL_REJECTED"),
          "mismatched publisher did not emit the stable principal rejection reason");

  auto issuer_mismatch = request;
  issuer_mismatch["attestation"]["bindings"]["issuer"] = "unknown-issuer";
  issuer_mismatch["trustInputs"]["issuer"] = "unknown-issuer";
  require(kfx::query_native_kfx_registry("assess", issuer_mismatch).at("trustReport").at("supplyChainGrade") ==
              "unverified",
          "unaccepted issuer retained its trust grade");

  auto contract_mismatch = request;
  contract_mismatch["attestation"]["bindings"]["contractVersion"] = "buildchain.release/v2";
  contract_mismatch["trustInputs"]["contractVersion"] = "buildchain.release/v2";
  require(kfx::query_native_kfx_registry("assess", contract_mismatch).at("trustReport").at("supplyChainGrade") ==
              "unverified",
          "unaccepted verifier contract retained its trust grade");

  auto verifier_mismatch = request;
  verifier_mismatch["attestation"]["bindings"]["verifierRoot"] = fixture_root('9');
  verifier_mismatch["trustInputs"]["verifierRoot"] = fixture_root('9');
  require(kfx::query_native_kfx_registry("assess", verifier_mismatch).at("trustReport").at("supplyChainGrade") ==
              "unverified",
          "unaccepted verifier root retained its trust grade");

  auto expired = request;
  expired["assessmentTime"] = 200;
  require(kfx::query_native_kfx_registry("assess", expired).at("trustReport").at("supplyChainGrade") == "unverified",
          "expired Buildchain evidence remained trusted");

  auto revoked = request;
  revoked["attestation"]["revoked"] = true;
  require(kfx::query_native_kfx_registry("assess", revoked).at("trustReport").at("supplyChainGrade") == "unverified",
          "revoked Buildchain evidence remained trusted");

  auto stale_kfd = request;
  stale_kfd["kfdAssessment"]["state"] = "stale";
  const auto stale_kfd_report = kfx::query_native_kfx_registry("assess", stale_kfd);
  require(stale_kfd_report.at("trustReport").at("supplyChainGrade") == "unverified",
          "stale KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment retained the KFD-attested grade");
  require(contains_text(stale_kfd_report.at("trustReport").at("reasons"), "KF_KFX_KFD_ASSESSMENT_INVALID"),
          "stale KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment did not expose its stable refusal reason");

  auto broadened = request;
  broadened["operation"] = "update";
  broadened["capabilityExpansion"] = true;
  require(!kfx::query_native_kfx_registry("assess", broadened).at("admissionPlan").at("allowed"),
          "capability expansion inherited an old approval");

  auto same_capability_update = request;
  same_capability_update["operation"] = "update";
  require(kfx::query_native_kfx_registry("assess", same_capability_update).at("admissionPlan").at("allowed"),
          "same-capability update did not receive the policy-defined reduced-friction path");

  auto high_consequence = request;
  high_consequence["operation"] = "capability";
  high_consequence["policy"]["highConsequenceCapabilities"] = nlohmann::json::array({"domain"});
  const auto high_consequence_report = kfx::query_native_kfx_registry("assess", high_consequence);
  require(!high_consequence_report.at("admissionPlan").at("allowed") &&
              contains_text(high_consequence_report.at("admissionPlan").at("requiredApprovals"), "capability:domain"),
          "high-consequence capability inherited automatic approval");

  auto migration = request;
  migration["operation"] = "migration";
  require(!kfx::query_native_kfx_registry("assess", migration).at("admissionPlan").at("allowed"),
          "irreversible migration inherited automatic admission");

  auto degraded = request;
  degraded["operation"] = "activate";
  degraded["runtimeEvidence"] = {{"degraded", true}};
  const auto degraded_report = kfx::query_native_kfx_registry("assess", degraded);
  require(degraded_report.at("trustReport").at("supplyChainGrade") == "kfd-attested",
          "runtime degradation rewrote the Buildchain supply-chain fact");
  require(!degraded_report.at("admissionPlan").at("allowed"),
          "runtime degradation did not suspend local activation admission");

  auto changed_policy = request;
  changed_policy["cachedDependencyRoot"] = first.at("trustReport").at("dependencyRoot");
  changed_policy["policy"]["residualRisk"].push_back("policy changed");
  const auto stale_report = kfx::query_native_kfx_registry("assess", changed_policy);
  require(!stale_report.at("trustReport").at("fresh") && !stale_report.at("admissionPlan").at("allowed"),
          "changed dependency root did not invalidate the cached assessment");

  auto forged_system = request;
  forged_system["system"] = true;
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("assess", forged_system); });
  auto forged_trusted = request;
  forged_trusted["trusted"] = true;
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("assess", forged_trusted); });

  auto identity = request;
  identity.erase("attestation");
  identity.erase("trustInputs");
  identity.erase("kfdAssessment");
  identity["identity"] = {{"verified", true},
                          {"artifactRoot", request["attestation"]["bindings"]["packageRoot"]},
                          {"publisher", "kungfu-systems"}};
  const auto identity_report = kfx::query_native_kfx_registry("assess", identity);
  require(identity_report.at("trustReport").at("supplyChainGrade") == "identity-verified",
          "exact publisher identity did not produce the identity-verified grade");
  require(!identity_report.at("admissionPlan").at("allowed"),
          "identity verification incorrectly inherited KFD-attested operation admission");
}

void test_semantic_graph_and_host_contract_are_canonical() {
  const nlohmann::json request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", semantic_registry_root().string()}}})}};
  const auto first = kfx::query_native_kfx_registry("plan", request);
  const auto second = kfx::query_native_kfx_registry("plan", request);
  const auto expected = expected_registry_roots();
  require(first == second, "semantic graph and plan roots are not deterministic");
  require(
      first.at("graphRoot") == expected.at("semanticGraphRoot"),
      "C++ semantic graph drifted from the cross-language fixture: actual=" + first.at("graphRoot").get<std::string>() +
          " expected=" + expected.at("semanticGraphRoot").get<std::string>());
  require(first.at("authorityMode") == "observation-preview" && first.at("cutRoot").is_null() &&
              first.at("revision") == 0 && first.at("planRoot").get<std::string>().starts_with("sha256:") &&
              first.at("hostContract").at("receiptDependencyRoot").get<std::string>().starts_with("sha256:"),
          "uncommitted scan was presented as authority or lost its rooted plan");
  require(first.at("graph").at("providers").size() == 2, "semantic graph lost a provider");
  require(first.at("graphRoot").get<std::string>().starts_with("sha256:"), "semantic graph is not rooted");
  const auto &dependencies = first.at("graph").at("dependencies");
  require(dependencies.size() == 2, "semantic graph lost dependency edges");
  require(std::any_of(dependencies.begin(), dependencies.end(),
                      [](const auto &edge) {
                        return edge.at("providerId") == "optional-support" && edge.at("mode") == "uses-if-present" &&
                               edge.at("state") == "dormant";
                      }),
          "missing optional provider did not become a typed dormant edge");
  const auto &contribution = first.at("graph").at("contributions").front();
  require(contribution.at("ownerProviderId") == "contributor" &&
              contribution.at("targetOwnerProviderId") == "provider-host",
          "contributes-to composition transferred extension-point ownership");
  require(contribution.at("state") == "active", "optional provider loss hid an active semantic contribution");
  const auto &host = first.at("hostContract");
  require(host.at("schema") == "kungfu.kfx.experience-flow-host/v3" && host.at("planRoot") == first.at("planRoot") &&
              host.at("graphRoot") == first.at("graphRoot"),
          "Experience/Flow descriptor did not bind the exact graph and plan");
  require(host.at("admission").at("state") == "preview-only" && host.at("cutRoot").is_null() &&
              host.at("generation").at("revision") == 0 &&
              host.at("contributions").front().at("authorization").at("cutRoot").is_null(),
          "observation-only host descriptor claimed executable admission");
  require(host.at("contributions").front().at("surface") == "experience",
          "host descriptor lost the surface-neutral Experience contribution");

  const auto fault_root = temp_root("semantic-faults");
  fs::copy(semantic_registry_root(), fault_root, fs::copy_options::recursive | fs::copy_options::overwrite_existing);
  const auto contributor_path = fault_root / "contributor" / "kungfu.kfx.json";
  auto contributor = nlohmann::json::parse([&] {
    std::ifstream input(contributor_path);
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  }());
  contributor["kungfuConfig"]["registry"]["dependencies"][0]["version"] = "^9.0.0";
  write_json(contributor_path, contributor);
  const nlohmann::json fault_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", fault_root.string()}}})}};
  const auto mismatch = kfx::query_native_kfx_registry("plan", fault_request);
  require(std::any_of(mismatch.at("diagnostics").begin(), mismatch.at("diagnostics").end(),
                      [](const auto &item) {
                        return item.at("code") == "KF_KFX_PROVIDER_VERSION_MISMATCH" &&
                               item.at("severity") == "degraded";
                      }),
          "provider version mismatch did not fail closed with a typed diagnostic");

  contributor["kungfuConfig"]["registry"]["dependencies"][0]["version"] = "^1.0.0";
  contributor["kungfuConfig"]["registry"]["contributions"][0]["capabilities"].push_back("shell");
  write_json(contributor_path, contributor);
  const auto broadened = kfx::query_native_kfx_registry("plan", fault_request);
  require(std::any_of(broadened.at("diagnostics").begin(), broadened.at("diagnostics").end(),
                      [](const auto &item) { return item.at("code") == "KF_KFX_CAPABILITY_BROADENING"; }),
          "contribution capability broadening was hidden by the graph projection");

  contributor["kungfuConfig"]["registry"]["contributions"][0]["capabilities"] = nlohmann::json::array({"domain"});
  contributor["kungfuConfig"]["registry"]["dependencies"][0]["admissionGrades"] =
      nlohmann::json::array({"kfd-attested"});
  write_json(contributor_path, contributor);
  const auto trust_rejected = kfx::query_native_kfx_registry("plan", fault_request);
  require(std::any_of(trust_rejected.at("diagnostics").begin(), trust_rejected.at("diagnostics").end(),
                      [](const auto &item) { return item.at("code") == "KF_KFX_TRUST_CONSTRAINT_REJECTED"; }),
          "dependency trust mismatch did not fail closed with a typed diagnostic");

  contributor["kungfuConfig"]["registry"]["dependencies"][0]["admissionGrades"] = nlohmann::json::array({"unverified"});
  contributor["kungfuConfig"]["registry"]["dependencies"][1] = {
      {"provider", "provider-host"}, {"version", "^1.0.0"}, {"mode", "required"}};
  write_json(contributor_path, contributor);
  const auto provider_path = fault_root / "provider-host" / "kungfu.kfx.json";
  auto provider = nlohmann::json::parse([&] {
    std::ifstream input(provider_path);
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  }());
  provider["kungfuConfig"]["registry"]["dependencies"] =
      nlohmann::json::array({{{"provider", "contributor"}, {"version", "^2.0.0"}, {"mode", "required"}}});
  write_json(provider_path, provider);
  const auto cyclic = kfx::query_native_kfx_registry("plan", fault_request);
  require(std::any_of(cyclic.at("diagnostics").begin(), cyclic.at("diagnostics").end(),
                      [](const auto &item) { return item.at("code") == "KF_KFX_DEPENDENCY_CYCLE"; }),
          "semantic provider cycle did not degrade the typed dependency graph");
  fs::remove_all(fault_root);

  const auto restored_root = temp_root("semantic-restored");
  fs::copy(semantic_registry_root(), restored_root, fs::copy_options::recursive | fs::copy_options::overwrite_existing);
  write_json(restored_root / "optional-support" / "kungfu.kfx.json", {{"schema", "kungfu.kfx.manifest/v1"},
                                                                      {"name", "@kungfu-test/optional-support"},
                                                                      {"version", "1.0.0"},
                                                                      {"kungfuConfig", {{"key", "optional-support"}}}});
  const nlohmann::json restored_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", restored_root.string()}}})}};
  const auto restored = kfx::query_native_kfx_registry("plan", restored_request);
  require(std::any_of(restored.at("graph").at("dependencies").begin(), restored.at("graph").at("dependencies").end(),
                      [](const auto &edge) {
                        return edge.at("providerId") == "optional-support" && edge.at("mode") == "uses-if-present" &&
                               edge.at("state") == "active";
                      }),
          "late optional provider restoration did not reactivate the typed dependency edge");
  require(restored.at("graphRoot") != first.at("graphRoot"),
          "late optional provider restoration did not create a complete next graph state");
  fs::remove_all(restored_root);
}

nlohmann::json mutation_request(const nlohmann::json &request, const nlohmann::json &plan,
                                const std::string &package_key, const std::string &operation) {
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
    if (package.at("key") != package_key)
      continue;
    mutation["expectedTrustRoot"] = package.at("trustRoot");
    mutation["expectedPackageRoot"] = package.at("packageRoot");
    break;
  }
  mutation["actor"] = "native-kfx-test";
  mutation["systemTime"] = 100 + plan.at("revision").get<uint64_t>();
  return mutation;
}

nlohmann::json control_request(const fs::path &candidate, const std::string &operation) {
  return passport_authorized_request(
      {{"controller", "kungfu-kfx-control-suite"},
       {"packageKey", "kfx-manager"},
       {"operation", operation},
       {"roots", nlohmann::json::array({{{"kind", "product"}, {"path", candidate.string()}}})}},
      "kfx-manager", operation);
}

nlohmann::json control_mutation(const nlohmann::json &request, const nlohmann::json &plan,
                                const std::string &authorization_id) {
  auto mutation = request;
  const auto &load_plan = plan.at("loadPlan");
  const auto package = *std::find_if(load_plan.at("packages").begin(), load_plan.at("packages").end(),
                                     [](const auto &row) { return row.at("key") == "kfx-manager"; });
  mutation["expectedCutRoot"] = load_plan.at("cutRoot");
  mutation["expectedRevision"] = load_plan.at("revision");
  mutation["expectedRegistryRoot"] = load_plan.at("registryRoot");
  mutation["expectedGraphRoot"] = load_plan.at("graphRoot");
  mutation["expectedPlanRoot"] = load_plan.at("planRoot");
  mutation["expectedTrustRoot"] = package.at("trustRoot");
  mutation["expectedPackageRoot"] = package.at("packageRoot");
  mutation["expectedControlPlanRoot"] = plan.at("controlPlanRoot");
  mutation["expectedBootstrapPolicyRoot"] = plan.at("bootstrapPolicyRoot");
  mutation["expectedAuthorizationPlanRoot"] = plan.at("authorizationPlanRoot");
  mutation["expectedCapabilityGrantRoot"] = plan.at("capabilityGrantRoot");
  mutation["expectedWarrantRoot"] = plan.at("warrantRoot");
  mutation["actor"] = authorization_id;
  return mutation;
}

size_t count_schema(const nlohmann::json &events, const std::string &schema) {
  return static_cast<size_t>(std::count_if(events.begin(), events.end(),
                                           [&](const auto &event) { return event.value("schema", "") == schema; }));
}

void test_native_lifecycle_uses_fact_work_and_named_cut_authority() {
  const auto home = temp_root("lifecycle");
  const auto source_root = home / "sources";
  const auto package_source = source_root / "optional-view";
  fs::create_directories(source_root);
  fs::copy(registry_root() / "example-suite" / "members" / "optional-view", package_source,
           fs::copy_options::recursive);
  const auto runtime_dir = home / "runtime";
  const auto source_request = passport_authorized_request(
      {{"roots", nlohmann::json::array({{{"kind", "user"}, {"path", source_root.string()}}})}}, "optional-view",
      "install");
  const auto install_plan = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  auto missing_authorization = mutation_request(source_request, install_plan, "optional-view", "install");
  missing_authorization.erase("authorizationTime");
  require_refusal("KF_KFX_AUTHORIZATION_REQUIRED",
                  [&] { (void)kfx::query_native_kfx_registry("apply", missing_authorization, runtime_dir.string()); });
  auto missing_warrant_fence = mutation_request(source_request, install_plan, "optional-view", "install");
  missing_warrant_fence.erase("expectedAuthorizationPlanRoot");
  missing_warrant_fence.erase("expectedWarrantRoot");
  require_refusal("KF_KFX_AUTHORIZATION_STALE",
                  [&] { (void)kfx::query_native_kfx_registry("apply", missing_warrant_fence, runtime_dir.string()); });
  auto changed_policy = mutation_request(source_request, install_plan, "optional-view", "install");
  changed_policy["policy"]["residualRisk"].push_back("changed-after-plan");
  require_refusal("KF_KFX_AUTHORIZATION_STALE",
                  [&] { (void)kfx::query_native_kfx_registry("apply", changed_policy, runtime_dir.string()); });
  auto broadened_capabilities = mutation_request(source_request, install_plan, "optional-view", "install");
  broadened_capabilities["requestedCapabilities"].push_back("not-declared");
  require_refusal("KF_KFX_ADMISSION_REQUIRED",
                  [&] { (void)kfx::query_native_kfx_registry("apply", broadened_capabilities, runtime_dir.string()); });
  for (const auto &evidence_case : {"revoked", "expired", "sibling", "publisher", "verifier"}) {
    auto invalid = source_request;
    if (evidence_case == std::string("revoked"))
      invalid["attestation"]["revoked"] = true;
    else if (evidence_case == std::string("expired"))
      invalid["assessmentTime"] = 200;
    else if (evidence_case == std::string("sibling"))
      invalid["attestation"]["bindings"]["packageRoot"] = fixture_root('8');
    else if (evidence_case == std::string("publisher"))
      invalid["attestation"]["bindings"]["publisher"] = "sibling-publisher";
    else {
      invalid["attestation"]["bindings"]["verifierRoot"] = fixture_root('9');
      invalid["trustInputs"]["verifierRoot"] = fixture_root('9');
    }
    require_refusal("KF_KFX_ADMISSION_REQUIRED",
                    [&] { (void)kfx::query_native_kfx_registry("plan", invalid, runtime_dir.string()); });
  }
  const auto install = kfx::query_native_kfx_registry(
      "apply", mutation_request(source_request, install_plan, "optional-view", "install"), runtime_dir.string());
  const auto expected = expected_registry_roots();
  require(install_plan.at("registryRoot") == expected.at("lifecycleRegistryRoot") &&
              install_plan.at("graphRoot") == expected.at("lifecycleGraphRoot"),
          "C++ observation snapshot drifted before Fact admission: registry=" +
              install_plan.at("registryRoot").get<std::string>() +
              " graph=" + install_plan.at("graphRoot").get<std::string>());
  require(install.at("revision") == 2 && install.at("cutRoot").get<std::string>().starts_with("sha256:") &&
              install.at("receipt").at("schema") == "kungfu.kfx.work-settlement-receipt/v1" &&
              install.at("receipt").at("outcome") == "applied" && install.at("receipt").at("authorityRevision") == 1 &&
              install.at("receipt").at("authorizationPlanRoot") == install_plan.at("authorizationPlanRoot") &&
              install.at("receipt").at("capabilityGrantRoot") == install_plan.at("capabilityGrantRoot") &&
              install.at("receipt").at("warrantRoot") == install_plan.at("warrantRoot") &&
              install.at("receipt").at("authorityRoots").contains("reportRoot") &&
              install.at("receipt").at("authorityRoots").contains("admissionPlanRoot") &&
              install.at("receipt").at("authorityRoots").contains("receiptDependencyRoot") &&
              install.at("receipt").at("authorityRoots").contains("policyRoot") &&
              install.at("receipt").at("authorityRoots").contains("packageRoot") &&
              install.at("receipt").at("authorityRoots").contains("dependencyRoot") &&
              install.at("receipt").at("authorityRoots").contains("requiredApprovals") &&
              install.at("receipt").at("authorityRoots").contains("approvalRoots") &&
              install.at("receipt").at("priorCutRoot").is_null() &&
              install.at("receipt").at("authorityCutRoot").get<std::string>().starts_with("sha256:") &&
              install.at("receipt").at("cutRoot") == install.at("cutRoot"),
          "late install did not issue Warrant before settling Work into the named Fact Cut");
  require(fs::is_regular_file(home / "extensions" / "optional-view" / "kungfu.kfx.json"),
          "native lifecycle did not atomically materialize the package");
  require(!fs::exists(runtime_dir / "kfx" / "registry-history.jsonl"),
          "native lifecycle recreated a KFX-specific authority journal");
  const auto admitted_plan = kfx::query_native_kfx_registry("plan", nlohmann::json::object(), runtime_dir.string());
  require(admitted_plan.at("hostContract").at("admission").at("state") == "admitted" &&
              admitted_plan.at("hostContract").at("cutRoot") == install.at("cutRoot") &&
              admitted_plan.at("hostContract").at("generation").at("revision") == 2 &&
              admitted_plan.at("hostContract").at("runtimeAuthorizations").front().at("executionAllowed"),
          "settled Fact Cut did not produce one exact admitted host generation");
  const auto &host_contract = admitted_plan.at("hostContract");
  const auto &host_authorization = host_contract.at("runtimeAuthorizations").front();
  const nlohmann::json host_request = {{"packageKey", "optional-view"},
                                       {"host", host_authorization.at("host")},
                                       {"expectedCutRoot", host_contract.at("cutRoot")},
                                       {"expectedRevision", host_contract.at("revision")},
                                       {"expectedGenerationRoot", host_contract.at("generationRoot")},
                                       {"expectedPackageRoot", host_authorization.at("packageRoot")},
                                       {"expectedCapabilityGrantRoot", host_authorization.at("capabilityGrantRoot")},
                                       {"expectedAuthorizationRoot", host_authorization.at("authorizationRoot")},
                                       {"expectedGrantedCapabilities", host_authorization.at("grantedCapabilities")}};
  const auto launch = kfx::query_native_kfx_registry("authorize-host", host_request, runtime_dir.string());
  require(launch.at("executionAllowed") && launch.at("authorization").at("placement") == "sandboxed-ipc",
          "host launch did not retain the exact grant and physical confinement");
  auto replayed_grant = host_request;
  replayed_grant["expectedCapabilityGrantRoot"] = fixture_root('f');
  require_refusal("KF_KFX_CAPABILITY_GRANT_STALE", [&] {
    (void)kfx::query_native_kfx_registry("authorize-host", replayed_grant, runtime_dir.string());
  });
  auto stale_generation = host_request;
  stale_generation["expectedGenerationRoot"] = fixture_root('e');
  require_refusal("KF_KFX_GENERATION_MISMATCH", [&] {
    (void)kfx::query_native_kfx_registry("authorize-host", stale_generation, runtime_dir.string());
  });

  require_refusal("KF_KFX_CUT_STALE", [&] {
    (void)kfx::query_native_kfx_registry(
        "apply", mutation_request(source_request, install_plan, "optional-view", "install"), runtime_dir.string());
  });
  auto history = kfx::query_native_kfx_registry("history", nlohmann::json::object(), runtime_dir.string());
  require(history.at("schema") == "kungfu.kfx.lifecycle-history/v2" &&
              history.at("authority") == "yijinjing-hana-pod-journal" && history.at("revision") == 2 &&
              count_schema(history.at("events"), "kungfu.kfx.work-fact/v2") == 2 &&
              count_schema(history.at("events"), "kungfu.kfx.warrant-fact/v2") == 2 &&
              count_schema(history.at("events"), "kungfu.kfx.episode-fact/v2") == 1 &&
              count_schema(history.at("events"), "kungfu.kfx.settlement-fact/v2") == 1,
          "Fact inventory did not reconstruct the settled Work/Warrant/Episode/Settlement");

  fs::remove_all(source_root);
  const auto fact_list = kfx::query_native_kfx_registry("list", nlohmann::json::object(), runtime_dir.string());
  const auto fact_status = kfx::query_native_kfx_registry("status", nlohmann::json::object(), runtime_dir.string());
  require(fact_list.at("authority") == "pinned-fact-cut" && fact_list.at("packages").size() == 1 &&
              fact_list.at("cutRoot") == install.at("cutRoot") && fact_status.at("revision") == 2 &&
              fact_list.at("packages").front().at("desiredState") == "active" &&
              fact_list.at("packages").front().at("observedState") == "applied" &&
              fact_list.at("packages").front().at("verdict") == "active",
          "named Fact Cut could not rebuild desired, observed, and derived registry views without scanning");

  const auto installed_request =
      recovery_authorized_request(nlohmann::json::object(), "optional-view", "remove", runtime_dir);
  auto spoofed_recovery = installed_request;
  spoofed_recovery["recoveryWarrant"]["issuerClass"] = "package-self";
  require_refusal("KF_KFX_RECOVERY_WARRANT_INVALID",
                  [&] { (void)kfx::query_native_kfx_registry("plan", spoofed_recovery, runtime_dir.string()); });
  auto mismatched_recovery = installed_request;
  mismatched_recovery["recoveryWarrant"]["expectedRevision"] = 0;
  require_refusal("KF_KFX_RECOVERY_WARRANT_INVALID",
                  [&] { (void)kfx::query_native_kfx_registry("plan", mismatched_recovery, runtime_dir.string()); });
  const auto remove_plan = kfx::query_native_kfx_registry("plan", installed_request, runtime_dir.string());
  const auto removed = kfx::query_native_kfx_registry(
      "apply", mutation_request(installed_request, remove_plan, "optional-view", "remove"), runtime_dir.string());
  require(removed.at("revision") == 4 && !fs::exists(home / "extensions" / "optional-view"),
          "native lifecycle did not apply the bounded remove transition");
  require(fs::exists(removed.at("receipt").at("materialization").at("retainedPath").get<std::string>()),
          "remove discarded referenced package bytes");

  fs::create_directories(source_root);
  fs::copy(registry_root() / "example-suite" / "members" / "optional-view", package_source,
           fs::copy_options::recursive);
  const auto restore_plan = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  const auto restored = kfx::query_native_kfx_registry(
      "apply", mutation_request(source_request, restore_plan, "optional-view", "install"), runtime_dir.string());
  require(restored.at("revision") == 6 && fs::exists(home / "extensions" / "optional-view"),
          "late restoration did not produce a complete next state");
  history = kfx::query_native_kfx_registry("history", {{"packageKey", "optional-view"}}, runtime_dir.string());
  require(history.at("revision") == 6 && history.at("events").size() == 18 &&
              history.at("historyRoot").get<std::string>().starts_with("sha256:"),
          "lifecycle history did not reconstruct all immutable Fact versions");

  const auto duplicate_plan = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  require_refusal("KF_KFX_PACKAGE_DUPLICATE", [&] {
    (void)kfx::query_native_kfx_registry(
        "apply", mutation_request(source_request, duplicate_plan, "optional-view", "install"), runtime_dir.string());
  });
  history = kfx::query_native_kfx_registry("history", {{"packageKey", "optional-view"}}, runtime_dir.string());
  require(history.at("revision") == 6 && history.at("events").size() == 18,
          "refused precondition incorrectly advanced Fact/Work authority");
  require(!fs::exists(home / "extensions" / ".kfx-stage-optional-view-7"),
          "failed materialization left a staged package behind");

  const auto enable_request =
      passport_authorized_request(nlohmann::json::object(), "optional-view", "enable", runtime_dir.string());
  const auto enable_plan = kfx::query_native_kfx_registry("plan", enable_request, runtime_dir.string());
  const auto enable_mutation = mutation_request(enable_request, enable_plan, "optional-view", "enable");
  auto invoke_enable = [enable_mutation, runtime_dir]() {
    try {
      const auto result = kfx::query_native_kfx_registry("apply", enable_mutation, runtime_dir.string());
      return result.at("receipt").at("outcome").get<std::string>();
    } catch (const std::invalid_argument &error) {
      return std::string(error.what());
    }
  };
  auto first_writer = std::async(std::launch::async, invoke_enable);
  auto second_writer = std::async(std::launch::async, invoke_enable);
  const auto first_outcome = first_writer.get();
  const auto second_outcome = second_writer.get();
  const auto applied_count =
      static_cast<int>(first_outcome == "applied") + static_cast<int>(second_outcome == "applied");
  const auto refused_outcome = first_outcome == "applied" ? second_outcome : first_outcome;
  require(applied_count == 1 &&
              (refused_outcome.starts_with("KF_KFX_WRITER_BUSY") || refused_outcome.starts_with("KF_KFX_CUT_STALE")),
          "concurrent lifecycle writers did not serialize behind the Core-owned runtime fence");
  history = kfx::query_native_kfx_registry("history", {{"packageKey", "optional-view"}}, runtime_dir.string());
  require(history.at("revision") == 8 && history.at("events").size() == 24,
          "serialized lifecycle mutation did not preserve complete Fact/Work history");
  fs::remove_all(home);
}

void test_kfx_runtime_warrant_is_leased_fenced_recoverable_and_witnessed() {
  const auto home = temp_root("runtime-warrant");
  const auto source_root = home / "sources";
  const auto package_source = source_root / "optional-view";
  fs::create_directories(source_root);
  fs::copy(registry_root() / "example-suite" / "members" / "optional-view", package_source,
           fs::copy_options::recursive);
  const auto runtime_dir = home / "runtime";
  const auto source_request = passport_authorized_request(
      {{"roots", nlohmann::json::array({{{"kind", "user"}, {"path", source_root.string()}}})}}, "optional-view",
      "install");
  const auto install_plan = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  const auto installed = kfx::query_native_kfx_registry(
      "apply", mutation_request(source_request, install_plan, "optional-view", "install"), runtime_dir.string());
  const auto plan = kfx::query_native_kfx_registry("plan", nlohmann::json::object(), runtime_dir.string());
  const auto &descriptor = plan.at("hostContract");
  const auto authorization =
      *std::find_if(descriptor.at("runtimeAuthorizations").begin(), descriptor.at("runtimeAuthorizations").end(),
                    [](const auto &candidate) { return candidate.at("packageKey") == "optional-view"; });
  nlohmann::json issue_request = {{"packageKey", "optional-view"},
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
                                  {"requestedCapabilities", nlohmann::json::array({"domain"})}};
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

  nlohmann::json transition = {{"packageKey", "optional-view"},
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

  const nlohmann::json witness_request = {{"packageKey", "optional-view"}, {"host", authorization.at("host")}};
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

void test_native_adapter_authority_requires_the_current_fact_cut() {
  const auto home = temp_root("adapter-authority");
  const auto source_root = home / "sources";
  const auto package_source = source_root / "trace-adapter";
  const auto runtime_dir = home / "runtime";
  fs::create_directories(package_source);
  auto manifest = nlohmann::json::object();
  manifest["schema"] = "kungfu.kfx.manifest/v1";
  manifest["name"] = "@kungfu-test/trace-adapter";
  manifest["version"] = "1.0.0";
  manifest["kungfuConfig"]["key"] = "trace-adapter";
  manifest["kungfuConfig"]["config"]["adapter"]["runtimes"] = nlohmann::json::array({"python"});
  manifest["kungfuConfig"]["config"]["adapter"]["entry"] = {{"python", "index.py"}};
  manifest["kungfuConfig"]["config"]["adapter"]["capabilities"] = nlohmann::json::array();
  write_json(package_source / "kungfu.kfx.json", manifest);
  std::ofstream(package_source / "index.py") << "# qualification adapter\n";

  const auto source_request = passport_authorized_request(
      {{"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", source_root.string()}}})}}, "trace-adapter",
      "install", runtime_dir.string());
  const auto preview = kfx::query_native_kfx_registry("plan", source_request, runtime_dir.string());
  const auto &preview_authorization = preview.at("hostContract").at("runtimeAuthorizations").front();
  require(preview.at("packages").front().at("runtimeTier") == "isolated" &&
              preview_authorization.at("placement") == "integrated-explicit" &&
              !preview_authorization.at("executionAllowed").get<bool>(),
          "adapter preview either gained authority or lost its Core-derived integrated placement");

  const auto installed = kfx::query_native_kfx_registry(
      "apply", mutation_request(source_request, preview, "trace-adapter", "install"), runtime_dir.string());
  const auto admitted = kfx::query_native_kfx_registry("plan", nlohmann::json::object(), runtime_dir.string());
  const auto &descriptor = admitted.at("hostContract");
  const auto &authorization = descriptor.at("runtimeAuthorizations").front();
  require(installed.at("receipt").at("outcome") == "applied" && authorization.at("host") == "adapter-python" &&
              authorization.at("runtimeTier") == "isolated" && authorization.at("placement") == "integrated-explicit" &&
              authorization.at("executionAllowed").get<bool>(),
          "settled adapter did not receive one exact native integrated authorization");

  const nlohmann::json launch_request = {{"packageKey", "trace-adapter"},
                                         {"host", "adapter-python"},
                                         {"expectedCutRoot", descriptor.at("cutRoot")},
                                         {"expectedRevision", descriptor.at("revision")},
                                         {"expectedGenerationRoot", descriptor.at("generationRoot")},
                                         {"expectedPackageRoot", authorization.at("packageRoot")},
                                         {"expectedCapabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                         {"expectedAuthorizationRoot", authorization.at("authorizationRoot")},
                                         {"expectedGrantedCapabilities", authorization.at("grantedCapabilities")}};
  const auto launch = kfx::query_native_kfx_registry("authorize-host", launch_request, runtime_dir.string());
  require(launch.at("executionAllowed").get<bool>() &&
              launch.at("authorization").at("authorizationRoot") == authorization.at("authorizationRoot"),
          "native adapter launch did not revalidate the current Fact Cut authorization");

  auto replayed = launch_request;
  replayed["expectedAuthorizationRoot"] = fixture_root('f');
  require_refusal("KF_KFX_AUTHORIZATION_STALE",
                  [&] { (void)kfx::query_native_kfx_registry("authorize-host", replayed, runtime_dir.string()); });
  fs::remove_all(home);
}

void test_control_suite_recursively_dogfoods_public_fact_work() {
  const auto home = temp_root("control-suite");
  const auto runtime_dir = home / "runtime";
  const auto v1 = home / "candidates" / "v1";
  copy_control_suite_candidate(v1);

  const auto bootstrap =
      kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string());
  require(bootstrap.at("mode") == "safe-mode" && !bootstrap.at("executionAllowed").get<bool>() &&
              bootstrap.at("revision") == 0 && bootstrap.at("active").is_null(),
          "absent Control Suite did not fail closed into deterministic safe mode");

  const auto install_request = control_request(v1, "install");
  const auto install_plan = kfx::query_native_kfx_registry("plan", install_request, runtime_dir.string());
  auto ecosystem_request = install_request;
  ecosystem_request.at("roots").front()["kind"] = "user";
  const auto ecosystem_plan = kfx::query_native_kfx_registry("plan", ecosystem_request, runtime_dir.string());
  require(install_plan.at("schema") == "kungfu.kfx.control-suite-plan/v1" &&
              install_plan.at("bootstrapVerification").at("valid").get<bool>() &&
              install_plan.at("authority") == "public-kfx-plan-plus-fact-work-settlement",
          "Control Suite bootstrap did not independently validate the identity-neutral candidate");
  require(install_plan == ecosystem_plan,
          "Product-bundled and ecosystem-equivalent Control Suite evidence produced different authority roots");
  require(contains_text(
              install_plan.at("mutationAuthorization").at("assessment").at("admissionPlan").at("requiredApprovals"),
              "capability:kfxControl"),
          "high-consequence Control Suite capability did not require an explicit approval");

  auto kfd_only_request = install_request;
  kfd_only_request["approvalRoots"] = nlohmann::json::array();
  require_refusal("KF_KFX_APPROVAL_REQUIRED",
                  [&] { (void)kfx::query_native_kfx_registry("plan", kfd_only_request, runtime_dir.string()); });

  for (const auto *claim : {"firstParty", "system", "productSystem"}) {
    auto forged_request = install_request;
    forged_request[claim] = true;
    require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
                    [&] { (void)kfx::query_native_kfx_registry("plan", forged_request, runtime_dir.string()); });
  }

  auto self_signed_request = install_request;
  self_signed_request["attestation"]["bindings"]["issuer"] = "package-self";
  self_signed_request["trustInputs"]["issuer"] = "package-self";
  require_refusal("KF_KFX_ADMISSION_REQUIRED",
                  [&] { (void)kfx::query_native_kfx_registry("plan", self_signed_request, runtime_dir.string()); });

  const auto installed = kfx::query_native_kfx_registry(
      "apply", control_mutation(install_request, install_plan, "control-test"), runtime_dir.string());
  require(installed.at("verified").get<bool>() && installed.at("status").at("mode") == "active" &&
              installed.at("status").at("revision") == 2 &&
              installed.at("authorizationPlanRoot") == install_plan.at("authorizationPlanRoot") &&
              installed.at("warrantRoot") == install_plan.at("warrantRoot"),
          "Control Suite install did not settle through public Fact/Work authority");
  const auto v1_root = installed.at("status").at("active").at("packageRoot");

  const auto v2 = home / "candidates" / "v2";
  copy_control_suite_candidate(v2);
  auto v2_manifest = nlohmann::json::parse([&] {
    std::ifstream input(v2 / "kungfu.kfx.json");
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  }());
  v2_manifest["version"] = "4.0.0-alpha.2";
  write_json(v2 / "kungfu.kfx.json", v2_manifest);
  const auto update_request = control_request(v2, "update");
  const auto update_plan = kfx::query_native_kfx_registry("plan", update_request, runtime_dir.string());
  require(update_plan.at("basis").at("activePackageRoot") == v1_root &&
              update_plan.at("candidate").at("version") == "4.0.0-alpha.2",
          "v1 Control Suite did not produce the independently verified v2 plan");

  auto broadened_manifest = v2_manifest;
  broadened_manifest["kungfuConfig"]["config"]["view"]["capabilities"].push_back("storage");
  write_json(v2 / "kungfu.kfx.json", broadened_manifest);
  require_refusal("KF_KFX_CONTROL_SELF_GRANT",
                  [&] { (void)kfx::query_native_kfx_registry("plan", update_request, runtime_dir.string()); });
  write_json(v2 / "kungfu.kfx.json", v2_manifest);

  auto stale_mutation = control_mutation(update_request, update_plan, "control-test");
  write_json(v2 / "interrupted-after-plan.json", {{"not", "part-of-the-authorized-closure"}});
  require_refusal("KF_KFX_CONTROL_PLAN_STALE",
                  [&] { (void)kfx::query_native_kfx_registry("apply", stale_mutation, runtime_dir.string()); });
  require(kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string())
                  .at("active")
                  .at("packageRoot") == v1_root,
          "interrupted or changed candidate replaced the prior active Control Suite");
  fs::remove(v2 / "interrupted-after-plan.json");

  const auto refreshed_plan = kfx::query_native_kfx_registry("plan", update_request, runtime_dir.string());
  const auto updated = kfx::query_native_kfx_registry(
      "apply", control_mutation(update_request, refreshed_plan, "control-test"), runtime_dir.string());
  const auto v2_root = updated.at("status").at("active").at("packageRoot");
  require(v2_root != v1_root && updated.at("status").at("revision") == 4 &&
              updated.at("status").at("lastKnownGood").at("packageRoot") == v1_root,
          "v2 activation did not retain the prior package as last known good");

  const auto restart_a =
      kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string());
  const auto restart_b =
      kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string());
  require(restart_a.at("statusRoot") == restart_b.at("statusRoot") &&
              restart_a.at("active").at("packageRoot") == v2_root,
          "restart reconstruction did not preserve the exact Control Suite status root");
  require_refusal("KF_KFX_CONTROL_PLAN_STALE", [&] {
    (void)kfx::query_native_kfx_registry("apply", control_mutation(update_request, refreshed_plan, "control-test"),
                                         runtime_dir.string());
  });

  write_json(home / "extensions" / "kfx-manager" / "kungfu.kfx.json", {{"corrupt", true}});
  const auto safe_a =
      kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string());
  const auto safe_b =
      kfx::query_native_kfx_registry("status", {{"controller", "kungfu-kfx-control-suite"}}, runtime_dir.string());
  require(safe_a.at("mode") == "safe-mode" && !safe_a.at("executionAllowed").get<bool>() &&
              safe_a.at("statusRoot") == safe_b.at("statusRoot") &&
              safe_a.at("lastKnownGood").at("packageRoot") == v1_root,
          "corrupt active Control Suite did not enter deterministic safe mode with exact LKG");

  const auto lkg_path = safe_a.at("lastKnownGood").at("sourcePath").get<std::string>();
  const auto rollback_request = control_request(lkg_path, "update");
  const auto rollback_plan = kfx::query_native_kfx_registry("plan", rollback_request, runtime_dir.string());
  const auto rolled_back = kfx::query_native_kfx_registry(
      "apply", control_mutation(rollback_request, rollback_plan, "control-test"), runtime_dir.string());
  require(rolled_back.at("status").at("mode") == "active" &&
              rolled_back.at("status").at("active").at("packageRoot") == v1_root &&
              rolled_back.at("status").at("revision") == 6,
          "explicit last-known-good rollback did not settle through the same public lifecycle");
  require(!fs::exists(runtime_dir / "kfx" / "registry-history.jsonl"),
          "Control Suite recursive dogfood recreated a private registry history");
  fs::remove_all(home);
}

} // namespace

int main() {
  try {
    test_contract_is_versioned_and_core_owned();
    test_native_kfx_service_host_contract();
    test_positive_and_negative_fixtures();
    test_manifest_normalization_uses_the_embedded_source_contract();
    test_service_interface_routes_only_validated_requests();
    test_registry_produces_one_deterministic_cross_surface_plan();
    test_registry_negative_and_concurrent_reads();
    test_exact_buildchain_attestation_and_operation_admission();
    test_semantic_graph_and_host_contract_are_canonical();
    test_native_lifecycle_uses_fact_work_and_named_cut_authority();
    test_kfx_runtime_warrant_is_leased_fenced_recoverable_and_witnessed();
    test_native_adapter_authority_requires_the_current_fact_cut();
    test_control_suite_recursively_dogfoods_public_fact_work();
    std::cout << "native KFX contract tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "native KFX contract tests failed: " << error.what() << '\n';
    return 1;
  }
}
