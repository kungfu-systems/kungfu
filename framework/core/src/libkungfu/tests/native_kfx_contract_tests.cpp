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

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

nlohmann::json load_fixture(const std::string &name) {
  const auto path = fs::path(__FILE__).parent_path() / "fixtures" / "native_kfx_contract" / name;
  std::ifstream input(path);
  if (!input)
    throw std::runtime_error("cannot open fixture: " + path.string());
  return nlohmann::json::parse(input);
}

fs::path registry_root() {
  return fs::path(__FILE__).parent_path() / "fixtures" / "native_kfx_registry" / "roots" / "workspace";
}

nlohmann::json registry_request() {
  return {{"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", registry_root().string()}}})},
          {"runtimeTiers", {{"optional-view", "verified-third-party"}}}};
}

void require_refusal(const std::string &code, const std::function<void()> &operation) {
  bool refused = false;
  try {
    operation();
  } catch (const std::invalid_argument &error) {
    refused = std::string(error.what()).rfind(code, 0) == 0;
  }
  require(refused, "operation did not fail with stable code " + code);
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
  require(first.at("schema") == kfx::NATIVE_KFX_CONTRACT_V2, "native contract schema drifted");
  require(first.at("contractVersion") == 2, "native contract version drifted");
  require(first.at("versionNegotiation").at("supported") == nlohmann::json::array({1, 2}),
          "native contract stopped accepting frozen v1 documents");
  require(first.at("sourceContractVersion") == 8, "native contract did not expose its source compatibility version");
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
  require(assessment.at("kfdAssessment").at("lifecycleOwner") == "ADR-0052",
          "native KFX admission created a second KFD assessment lifecycle");
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
      {"version", "1.0.0"},
      {"name", "@example/view"},
      {"kungfuConfig",
       {{"key", "example-view"},
        {"config", {{"view", {{"runtime", "sandboxed-ipc"}, {"capabilities", nlohmann::json::array({"domain"})}}}}}}}};
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
    const nlohmann::json request = {{"schema", "kungfu.kfx.native-request/v2"},
                                    {"contractVersion", 2},
                                    {"operation", operation},
                                    {"packagePath", "extensions/example-kfx"},
                                    {"requestedCapabilities", nlohmann::json::array()}};
    require(kfx::invoke_native_kfx_service(service, request).at("operation") == operation,
            std::string("native service did not route ") + operation);
  }
  const nlohmann::json legacy_request = {{"schema", "kungfu.kfx.native-request/v1"},
                                         {"contractVersion", 1},
                                         {"operation", "inspect"},
                                         {"packagePath", "extensions/example-kfx"},
                                         {"requestedCapabilities", nlohmann::json::array()}};
  require(kfx::invoke_native_kfx_service(service, legacy_request).at("operation") == "inspect",
          "frozen v1 request compatibility was lost");
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
  require(inspected.at("package").at("runtimeTier") == "verified-third-party",
          "native registry lost the explicit runtime tier input");
  require(inspected.at("package").at("admissionGrade") == "unverified",
          "native registry collapsed admission grade into runtime tier");
  require(resolved.at("suite").at("memberRoots").size() == 2, "native Suite closure is incomplete");
  require(resolved.at("suite").at("profileRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "native registry did not reuse the Profile lifecycle root");
  require(first_plan == second_plan, "native load plan is not deterministic");
  require(first_plan.at("planRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "native load plan is not content-addressed");
  require(status.at("registryRoot") == first_plan.at("registryRoot"), "status and plan read different snapshots");
  require(status.at("readOnly") && !status.at("cacheAuthority"), "registry claimed mutation or cache authority");
}

void test_registry_negative_and_concurrent_reads() {
  const auto request = registry_request();
  auto collision = request;
  collision.at("roots").push_back(collision.at("roots").front());
  require_refusal("KF_KFX_ROOT_COLLISION", [&] { (void)kfx::query_native_kfx_registry("list", collision); });

  auto unknown_host = request;
  unknown_host["hostPlacements"] = {{"optional-view", nlohmann::json::array({"unknown-host"})}};
  require_refusal("KF_KFX_HOST_UNKNOWN", [&] { (void)kfx::query_native_kfx_registry("plan", unknown_host); });

  auto stale = request;
  stale["expectedRegistryRoot"] = "sha256:stale";
  require_refusal("KF_KFX_REGISTRY_STALE", [&] { (void)kfx::query_native_kfx_registry("status", stale); });
  require_refusal("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", [&] { (void)kfx::query_native_kfx_registry("apply", request); });
  auto forged_admission = request;
  forged_admission["admissionGrades"] = {{"optional-view", "product-system"}};
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
  const nlohmann::json duplicate_manifest = {
      {"name", "duplicate"}, {"version", "1.0.0"}, {"kungfuConfig", {{"key", "duplicate-key"}}}};
  write_json(duplicate_root / "one" / "package.json", duplicate_manifest);
  write_json(duplicate_root / "two" / "package.json", duplicate_manifest);
  const nlohmann::json duplicate_request = {
      {"roots", nlohmann::json::array({{{"kind", "workspace"}, {"path", duplicate_root.string()}}})}};
  require_refusal("KF_KFX_PACKAGE_DUPLICATE", [&] { (void)kfx::query_native_kfx_registry("list", duplicate_request); });
  fs::remove_all(duplicate_root);

  const auto missing_root = temp_root("missing");
  write_json(missing_root / "suite" / "package.json",
             {{"name", "missing-suite"},
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
      cycle_root / "a" / "package.json",
      {{"name", "a"},
       {"version", "1.0.0"},
       {"kungfuConfig", {{"key", "a"}, {"suite", {{"title", "A"}, {"members", nlohmann::json::array({"b"})}}}}}});
  write_json(
      cycle_root / "b" / "package.json",
      {{"name", "b"},
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
  nlohmann::json trust_inputs = {
      {"schema", "kungfu.kfx-trust-inputs/v1"}, {"packageRoot", package_root},
      {"sourceRoot", fixture_root('1')},        {"dependencyRoot", fixture_root('2')},
      {"buildPlanRoot", fixture_root('3')},     {"toolchainRoot", fixture_root('4')},
      {"artifactRoot", fixture_root('5')},      {"qualificationRoot", fixture_root('6')},
      {"verifierRoot", fixture_root('7')},      {"issuer", "buildchain.libkungfu.dev"},
      {"publisher", "kungfu-systems"},          {"contractVersion", "buildchain.release/v1"}};
  request["packageKey"] = "optional-view";
  request["operation"] = "install";
  request["purpose"] = "workspace-install";
  request["cut"] = "cut:fixture";
  request["assessmentTime"] = 150;
  request["requestedCapabilities"] = nlohmann::json::array({"domain"});
  request["policy"] = {{"schema", "kungfu.kfx-admission-policy/v1"},
                       {"allowedIssuers", nlohmann::json::array({"buildchain.libkungfu.dev"})},
                       {"allowedPublishers", nlohmann::json::array({"kungfu-systems"})},
                       {"allowedContracts", nlohmann::json::array({"buildchain.release/v1"})},
                       {"allowedVerifierRoots", nlohmann::json::array({fixture_root('7')})},
                       {"autoOperations", nlohmann::json::array({"install", "update", "activate", "system-role"})},
                       {"highConsequenceCapabilities", nlohmann::json::array({"process"})},
                       {"systemCapabilities", nlohmann::json::array({"domain"})},
                       {"productSystemRoots", nlohmann::json::array()},
                       {"residualRisk", nlohmann::json::array({"native guest code remains outside provenance proof"})}};
  request["trustInputs"] = trust_inputs;
  request["kfdAssessment"] = {{"schema", "kungfu.trust.assessment/v1"},
                              {"state", "fresh"},
                              {"assessment_key", fixture_root('a')},
                              {"report",
                               {{"report_hash", fixture_root('6')},
                                {"state", "fresh"},
                                {"purpose", "workspace-install"},
                                {"query_proof_root", fixture_root('b')},
                                {"contract_world", {{"root", fixture_root('c')}}},
                                {"policy", {{"root", fixture_root('d')}}},
                                {"fact_surfaces", nlohmann::json::array({{{"root", fixture_root('e')}}})}}}};
  request["attestation"] = {{"contract", "kungfu-buildchain-artifact-verification"},
                            {"schemaVersion", 1},
                            {"outcome", "pass"},
                            {"ok", true},
                            {"trust", "pass"},
                            {"issuedAt", 100},
                            {"expiresAt", 200},
                            {"revoked", false},
                            {"subject", {{"digest", fixture_root('5')}}},
                            {"passport", {{"verification", {{"ok", true}, {"trust", "pass"}}}}},
                            {"match", {{"artifact", {{"digest", fixture_root('5')}}}}},
                            {"bindings", trust_inputs}};
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
          "stale ADR-0052 assessment retained the KFD-attested grade");
  require(contains_text(stale_kfd_report.at("trustReport").at("reasons"), "KF_KFX_KFD_ASSESSMENT_INVALID"),
          "stale ADR-0052 assessment did not expose its stable refusal reason");

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

  auto system = request;
  system["operation"] = "system-role";
  system["policy"]["productSystemRoots"].push_back(system["attestation"]["bindings"]["packageRoot"]);
  const auto system_report = kfx::query_native_kfx_registry("assess", system);
  require(system_report.at("trustReport").at("admissionGrade") == "product-system",
          "Product assembly did not assign System authority to its exact eligible root");
  require(system_report.at("admissionPlan").at("allowed"), "eligible Product System assignment was refused");

  auto identity = request;
  identity.erase("attestation");
  identity.erase("trustInputs");
  identity.erase("kfdAssessment");
  identity["identity"] = {{"verified", true},
                          {"artifactRoot", system["attestation"]["bindings"]["packageRoot"]},
                          {"publisher", "kungfu-systems"}};
  const auto identity_report = kfx::query_native_kfx_registry("assess", identity);
  require(identity_report.at("trustReport").at("supplyChainGrade") == "identity-verified",
          "exact publisher identity did not produce the identity-verified grade");
  require(!identity_report.at("admissionPlan").at("allowed"),
          "identity verification incorrectly inherited KFD-attested operation admission");
}

} // namespace

int main() {
  try {
    test_contract_is_versioned_and_core_owned();
    test_positive_and_negative_fixtures();
    test_manifest_normalization_uses_the_embedded_source_contract();
    test_service_interface_routes_only_validated_requests();
    test_registry_produces_one_deterministic_cross_surface_plan();
    test_registry_negative_and_concurrent_reads();
    test_exact_buildchain_attestation_and_operation_admission();
    std::cout << "native KFX contract tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "native KFX contract tests failed: " << error.what() << '\n';
    return 1;
  }
}
