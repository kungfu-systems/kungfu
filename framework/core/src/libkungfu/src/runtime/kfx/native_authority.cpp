// SPDX-License-Identifier: Apache-2.0

#include "native_authority.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <stdexcept>
#include <vector>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::kfx::authority {

namespace {

using json = nlohmann::json;

[[noreturn]] void refuse(const std::string &code, const std::string &message) {
  throw std::invalid_argument(code + ": " + message);
}

std::string sha256(const std::string &value) {
  return yijinjing::storage::compute_content_hash_value(value, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
}

std::string root_of(const json &value) { return "sha256:" + sha256(value.dump()); }

std::string required_text(const json &value, const char *field, const std::string &path) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty())
    refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must be a non-empty string");
  return value.at(field).get<std::string>();
}

json object_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return json::object();
  if (!value.at(field).is_object())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an object");
  return value.at(field);
}

std::vector<std::string> string_array_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return {};
  if (!value.at(field).is_array())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an array");
  std::vector<std::string> result;
  for (const auto &entry : value.at(field)) {
    if (!entry.is_string() || entry.get<std::string>().empty())
      refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must contain non-empty strings");
    result.push_back(entry.get<std::string>());
  }
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must not contain duplicates");
  return result;
}

void require_exact_fields(const json &value, const std::set<std::string> &fields, const std::string &label) {
  if (!value.is_object())
    refuse("KF_KFX_SCHEMA_INVALID", label + " must be an object");
  for (const auto &field : fields)
    if (!value.contains(field))
      refuse("KF_KFX_SCHEMA_INVALID", label + " is missing required field " + field);
  for (const auto &[field, ignored] : value.items()) {
    (void)ignored;
    if (!fields.contains(field))
      refuse("KF_KFX_SCHEMA_INVALID", label + " contains unknown field " + field);
  }
}

bool is_content_root(const std::string &value) {
  return value.size() == 71 && value.starts_with("sha256:") &&
         std::all_of(value.begin() + 7, value.end(),
                     [](unsigned char ch) { return std::isdigit(ch) != 0 || (ch >= 'a' && ch <= 'f'); });
}

json find_package(const json &packages, const std::string &key) {
  for (const auto &package : packages)
    if (package.at("key") == key)
      return package;
  return nullptr;
}

bool contains_text(const json &values, const std::string &expected) {
  return values.is_array() && std::any_of(values.begin(), values.end(),
                                          [&](const auto &value) { return value.is_string() && value == expected; });
}

void validate_enum(const std::string &value, const std::set<std::string> &allowed, const std::string &label) {
  if (!allowed.contains(value))
    refuse("KF_KFX_SCHEMA_INVALID", label + " has unsupported value " + value);
}

json canonical_approval_roots(const json &request) {
  const auto roots = string_array_or_empty(request, "approvalRoots");
  json result = json::array();
  for (const auto &root : roots) {
    if (!is_content_root(root))
      refuse("KF_KFX_APPROVAL_INVALID", "approval roots must be canonical sha256 content roots");
    result.push_back(root);
  }
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}

std::string fact_id(const std::string &kind, const std::string &identity) {
  return "fact:" + sha256("kungfu-kfx-domain-profile:" + kind + ":" + identity).substr(0, 32);
}

} // namespace

json assess(const json &package, const std::string &registry_root, const json &request) {
  const auto operation = required_text(request, "operation", "request");
  const auto purpose = required_text(request, "purpose", "request");
  const auto cut = required_text(request, "cut", "request");
  static const std::set<std::string> operations = {"inspect",   "install",    "update",         "enable",
                                                   "activate",  "qualify",    "host-placement", "capability",
                                                   "migration", "system-role"};
  validate_enum(operation, operations, "admission operation");

  const auto policy = object_or_empty(request, "policy");
  if (policy.empty() || policy.value("schema", "") != "kungfu.kfx-admission-policy/v1")
    refuse("KF_KFX_SCHEMA_INVALID", "assessment requires kungfu.kfx-admission-policy/v1");
  require_exact_fields(policy,
                       {"schema", "allowedIssuers", "allowedPublishers", "allowedContracts", "allowedVerifierRoots",
                        "allowedCapabilities", "autoOperations", "highConsequenceCapabilities", "systemCapabilities",
                        "productSystemRoots", "residualRisk"},
                       "admission policy");
  if (!request.contains("assessmentTime") || !request.at("assessmentTime").is_number_integer())
    refuse("KF_KFX_SCHEMA_INVALID", "assessmentTime must be a non-negative integer");
  const auto assessment_time = request.at("assessmentTime").get<int64_t>();
  if (assessment_time < 0)
    refuse("KF_KFX_SCHEMA_INVALID", "assessmentTime must be a non-negative integer");
  const auto allowed_issuers = string_array_or_empty(policy, "allowedIssuers");
  const auto allowed_publishers = string_array_or_empty(policy, "allowedPublishers");
  const auto allowed_contracts = string_array_or_empty(policy, "allowedContracts");
  const auto allowed_verifier_roots = string_array_or_empty(policy, "allowedVerifierRoots");
  const auto allowed_capabilities = string_array_or_empty(policy, "allowedCapabilities");
  const auto requested_auto_operations = string_array_or_empty(policy, "autoOperations");
  const auto requested_high_consequence_capabilities = string_array_or_empty(policy, "highConsequenceCapabilities");
  (void)string_array_or_empty(policy, "systemCapabilities");
  (void)string_array_or_empty(policy, "productSystemRoots");
  const auto residual_risk = string_array_or_empty(policy, "residualRisk");
  if (allowed_issuers.empty() || allowed_publishers.empty() || allowed_contracts.empty() ||
      allowed_verifier_roots.empty())
    refuse("KF_KFX_SCHEMA_INVALID",
           "admission policy requires non-empty issuer, publisher, contract, and verifier allowlists");
  const auto native_contract = native_kfx_contract();
  const auto core_policy = object_or_empty(native_contract, "coreCapabilityPolicy");
  if (core_policy.value("schema", "") != "kungfu.kfx-core-capability-policy/v1")
    refuse("KF_KFX_SCHEMA_INVALID", "native contract does not contain the Core capability policy");
  const auto core_allowed_capabilities = string_array_or_empty(core_policy, "allowedCapabilities");
  const auto core_auto_operations = string_array_or_empty(core_policy, "autoOperations");
  const auto core_high_consequence_capabilities = string_array_or_empty(core_policy, "highConsequenceCapabilities");
  const auto require_core_subset = [](const std::vector<std::string> &requested,
                                      const std::vector<std::string> &ceiling, const char *label) {
    for (const auto &value : requested) {
      if (std::find(ceiling.begin(), ceiling.end(), value) == ceiling.end())
        refuse("KF_KFX_CAPABILITY_POLICY_REJECTED",
               std::string(label) + " is outside the embedded Core policy ceiling: " + value);
    }
  };
  require_core_subset(allowed_capabilities, core_allowed_capabilities, "allowed capability");
  require_core_subset(requested_auto_operations, core_auto_operations, "automatic operation");

  json reasons = json::array();
  json evidence_dependencies = json::array();
  json trust_input = json::object();
  json kfd_assessment_key = nullptr;
  json kfd_report_root = nullptr;
  std::string supply_chain_grade = "unverified";
  const auto package_root = package.at("packageRoot").get<std::string>();
  const auto attestation = object_or_empty(request, "attestation");
  const auto identity = object_or_empty(request, "identity");
  if (!attestation.empty() && !identity.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "assessment must choose attestation or identity evidence, not both");
  if (attestation.empty() && (request.contains("trustInputs") || request.contains("kfdAssessment")))
    refuse("KF_KFX_SCHEMA_INVALID", "trust inputs and KFD assessment require Buildchain attestation evidence");
  if (!attestation.empty()) {
    trust_input = object_or_empty(request, "trustInputs");
    if (trust_input.empty() || trust_input.value("schema", "") != "kungfu.kfx-trust-inputs/v1")
      refuse("KF_KFX_SCHEMA_INVALID", "Buildchain assessment requires kungfu.kfx-trust-inputs/v1");
    require_exact_fields(trust_input,
                         {"schema", "packageRoot", "sourceRoot", "dependencyRoot", "buildPlanRoot", "toolchainRoot",
                          "artifactRoot", "qualificationRoot", "verifierRoot", "issuer", "publisher",
                          "contractVersion"},
                         "KFX trust inputs");
    const auto bindings = object_or_empty(attestation, "bindings");
    const auto subject = object_or_empty(attestation, "subject");
    const auto passport = object_or_empty(attestation, "passport");
    const auto verification = object_or_empty(passport, "verification");
    const auto match = object_or_empty(attestation, "match");
    const auto artifact = object_or_empty(match, "artifact");
    const auto kfd_assessment = object_or_empty(request, "kfdAssessment");
    const auto kfd_report = object_or_empty(kfd_assessment, "report");
    const bool verifier_ok = attestation.value("contract", "") == "kungfu-buildchain-artifact-verification" &&
                             attestation.value("schemaVersion", 0) == 1 && attestation.value("outcome", "") == "pass" &&
                             attestation.value("ok", false) && attestation.value("trust", "") == "pass" &&
                             verification.value("ok", false) && verification.value("trust", "") == "pass";
    if (!verifier_ok)
      reasons.push_back("KF_KFX_ATTESTATION_INVALID");

    static const std::vector<std::string> root_fields = {"packageRoot",       "sourceRoot",    "dependencyRoot",
                                                         "buildPlanRoot",     "toolchainRoot", "artifactRoot",
                                                         "qualificationRoot", "verifierRoot"};
    bool roots_ok = true;
    for (const auto &field : root_fields) {
      if (!bindings.contains(field) || !bindings.at(field).is_string() || !trust_input.contains(field) ||
          !trust_input.at(field).is_string() || !is_content_root(bindings.at(field).get<std::string>()) ||
          bindings.at(field) != trust_input.at(field)) {
        roots_ok = false;
        break;
      }
      evidence_dependencies.push_back(trust_input.at(field));
    }
    const auto subject_digest = subject.value("digest", "");
    const auto matched_digest = artifact.value("digest", "");
    if (!roots_ok || trust_input.value("packageRoot", "") != package_root ||
        bindings.value("artifactRoot", "") != subject_digest || subject_digest != matched_digest)
      reasons.push_back("KF_KFX_ATTESTATION_ROOT_MISMATCH");

    const auto assessment_key = kfd_assessment.value("assessment_key", "");
    const auto report_hash = kfd_report.value("report_hash", "");
    const auto query_proof_root = kfd_report.value("query_proof_root", "");
    const auto contract_world = object_or_empty(kfd_report, "contract_world");
    const auto assessment_policy = object_or_empty(kfd_report, "policy");
    bool kfd_assessment_ok = kfd_assessment.value("schema", "") == "kungfu.trust.assessment/v1" &&
                             kfd_assessment.value("state", "") == "fresh" && kfd_report.value("state", "") == "fresh" &&
                             kfd_report.value("purpose", "") == purpose && is_content_root(assessment_key) &&
                             is_content_root(report_hash) && is_content_root(query_proof_root) &&
                             is_content_root(contract_world.value("root", "")) &&
                             is_content_root(assessment_policy.value("root", "")) &&
                             trust_input.value("qualificationRoot", "") == report_hash;
    if (kfd_report.contains("fact_surfaces") && kfd_report.at("fact_surfaces").is_array()) {
      for (const auto &surface : kfd_report.at("fact_surfaces")) {
        if (!surface.is_object() || !is_content_root(surface.value("root", ""))) {
          kfd_assessment_ok = false;
          break;
        }
        evidence_dependencies.push_back(surface.at("root"));
      }
    } else {
      kfd_assessment_ok = false;
    }
    if (!kfd_assessment_ok) {
      reasons.push_back("KF_KFX_KFD_ASSESSMENT_INVALID");
    } else {
      kfd_assessment_key = assessment_key;
      kfd_report_root = report_hash;
      evidence_dependencies.push_back(assessment_key);
      evidence_dependencies.push_back(report_hash);
      evidence_dependencies.push_back(query_proof_root);
      evidence_dependencies.push_back(contract_world.at("root"));
      evidence_dependencies.push_back(assessment_policy.at("root"));
    }

    const auto issuer = bindings.value("issuer", "");
    const auto publisher = bindings.value("publisher", "");
    const auto contract_version = bindings.value("contractVersion", "");
    const auto verifier_root = bindings.value("verifierRoot", "");
    if (issuer.empty() || publisher.empty() || contract_version.empty() || verifier_root.empty() ||
        trust_input.value("issuer", "") != issuer || trust_input.value("publisher", "") != publisher ||
        trust_input.value("contractVersion", "") != contract_version ||
        !contains_text(policy.value("allowedIssuers", json::array()), issuer) ||
        !contains_text(policy.value("allowedPublishers", json::array()), publisher) ||
        !contains_text(policy.value("allowedContracts", json::array()), contract_version) ||
        !contains_text(policy.value("allowedVerifierRoots", json::array()), verifier_root))
      reasons.push_back("KF_KFX_ATTESTATION_PRINCIPAL_REJECTED");

    const bool time_shape_ok = attestation.contains("issuedAt") && attestation.at("issuedAt").is_number_integer() &&
                               attestation.contains("expiresAt") && attestation.at("expiresAt").is_number_integer() &&
                               attestation.contains("revoked") && attestation.at("revoked").is_boolean();
    const auto issued_at = time_shape_ok ? attestation.at("issuedAt").get<int64_t>() : int64_t{-1};
    const auto expires_at = time_shape_ok ? attestation.at("expiresAt").get<int64_t>() : int64_t{-1};
    if (time_shape_ok && attestation.at("revoked").get<bool>())
      reasons.push_back("KF_KFX_ATTESTATION_REVOKED");
    if (!time_shape_ok || issued_at < 0 || expires_at < issued_at || assessment_time < issued_at ||
        assessment_time >= expires_at)
      reasons.push_back("KF_KFX_ATTESTATION_EXPIRED");
    if (reasons.empty())
      supply_chain_grade = "kfd-attested";
    evidence_dependencies.push_back(root_of(attestation));
  } else {
    if (!identity.empty() && identity.value("verified", false) && identity.value("artifactRoot", "") == package_root &&
        contains_text(policy.value("allowedPublishers", json::array()), identity.value("publisher", ""))) {
      supply_chain_grade = "identity-verified";
      trust_input = identity;
      evidence_dependencies.push_back(root_of(identity));
    } else {
      reasons.push_back("KF_KFX_ATTESTATION_MISSING");
    }
  }

  std::string admission_grade = supply_chain_grade;
  if (supply_chain_grade == "kfd-attested" &&
      contains_text(policy.value("productSystemRoots", json::array()), package_root))
    admission_grade = "product-system";

  const auto requested_capabilities = string_array_or_empty(request, "requestedCapabilities");
  const auto declared_capabilities = package.at("declaredCapabilities").get<std::vector<std::string>>();
  json constraints = json::array();
  json required_approvals = json::array();
  for (const auto &capability : requested_capabilities) {
    if (std::find(declared_capabilities.begin(), declared_capabilities.end(), capability) ==
        declared_capabilities.end())
      reasons.push_back("KF_KFX_CAPABILITY_BROADENING");
    if (std::find(allowed_capabilities.begin(), allowed_capabilities.end(), capability) == allowed_capabilities.end())
      reasons.push_back("KF_KFX_CAPABILITY_POLICY_REJECTED");
    if (contains_text(policy.value("highConsequenceCapabilities", json::array()), capability) ||
        std::find(core_high_consequence_capabilities.begin(), core_high_consequence_capabilities.end(), capability) !=
            core_high_consequence_capabilities.end()) {
      constraints.push_back("high-consequence-capability:" + capability);
      required_approvals.push_back("capability:" + capability);
    }
  }

  bool allowed = operation == "inspect";
  if (std::find(requested_auto_operations.begin(), requested_auto_operations.end(), operation) !=
          requested_auto_operations.end() &&
      std::find(core_auto_operations.begin(), core_auto_operations.end(), operation) != core_auto_operations.end() &&
      (admission_grade == "kfd-attested" || admission_grade == "product-system"))
    allowed = true;
  if (operation == "update" && request.value("capabilityExpansion", false)) {
    allowed = false;
    required_approvals.push_back("capability-expansion");
  }
  if (operation == "migration") {
    allowed = false;
    required_approvals.push_back("irreversible-migration");
  }
  if (operation == "system-role" && admission_grade != "product-system") {
    allowed = false;
    required_approvals.push_back("product-system-assignment");
  }
  if (operation == "capability" && !required_approvals.empty())
    allowed = false;

  const auto runtime = object_or_empty(request, "runtimeEvidence");
  const bool runtime_degraded = runtime.value("degraded", false) || runtime.value("receiptViolation", false);
  if (runtime_degraded && (operation == "enable" || operation == "activate" || operation == "host-placement" ||
                           operation == "capability" || operation == "system-role")) {
    allowed = false;
    constraints.push_back("runtime-assessment-degraded");
    required_approvals.push_back("runtime-reassessment");
  }
  const auto core_policy_root = root_of(core_policy);
  const auto requested_policy_root = root_of(policy);
  const auto policy_root = root_of({{"schema", "kungfu.kfx-effective-capability-policy/v1"},
                                    {"corePolicyRoot", core_policy_root},
                                    {"requestedPolicyRoot", requested_policy_root},
                                    {"allowedCapabilities", allowed_capabilities},
                                    {"autoOperations", requested_auto_operations},
                                    {"highConsequenceCapabilities", core_high_consequence_capabilities}});
  evidence_dependencies.push_back(core_policy_root);
  evidence_dependencies.push_back(requested_policy_root);
  evidence_dependencies.push_back(policy_root);
  if (!runtime.empty())
    evidence_dependencies.push_back(root_of(runtime));
  const auto trust_input_root = trust_input.empty() ? nullptr : json(root_of(trust_input));
  std::sort(evidence_dependencies.begin(), evidence_dependencies.end());
  evidence_dependencies.erase(std::unique(evidence_dependencies.begin(), evidence_dependencies.end()),
                              evidence_dependencies.end());
  const auto dependency_root = root_of({{"packageRoot", package.at("packageRoot")},
                                        {"registryRoot", registry_root},
                                        {"operation", operation},
                                        {"purpose", purpose},
                                        {"cut", cut},
                                        {"assessmentTime", assessment_time},
                                        {"requestedCapabilities", requested_capabilities},
                                        {"policyRoot", policy_root},
                                        {"trustInputRoot", trust_input_root},
                                        {"evidenceDependencies", evidence_dependencies}});
  bool stale = false;
  if (request.contains("cachedDependencyRoot")) {
    if (!request.at("cachedDependencyRoot").is_string() ||
        !is_content_root(request.at("cachedDependencyRoot").get<std::string>()))
      refuse("KF_KFX_SCHEMA_INVALID", "cachedDependencyRoot must be a canonical sha256 root");
    stale = request.at("cachedDependencyRoot") != dependency_root;
    if (stale)
      reasons.push_back("KF_KFX_ASSESSMENT_STALE");
  }
  if (!reasons.empty() && operation != "inspect")
    allowed = false;
  if (!allowed && required_approvals.empty())
    required_approvals.push_back("workspace-owner");

  std::vector<std::string> recovery_guidance;
  if (stale)
    recovery_guidance.push_back("discard-cached-assessment-and-reassess");
  if (!reasons.empty())
    recovery_guidance.push_back("refresh-exact-evidence-and-reassess");
  if (runtime_degraded)
    recovery_guidance.push_back("repair-runtime-and-reassess");
  if (!required_approvals.empty())
    recovery_guidance.push_back("obtain-required-approval-and-replan");
  if (allowed)
    recovery_guidance.push_back("bind-report-and-plan-roots-into-operation-receipt");
  std::sort(reasons.begin(), reasons.end());
  std::sort(constraints.begin(), constraints.end());
  std::sort(required_approvals.begin(), required_approvals.end());
  std::sort(recovery_guidance.begin(), recovery_guidance.end());
  json report_identity = {{"schema", "kungfu.kfx-trust-report/v1"},
                          {"packageKey", package.at("key")},
                          {"packageRoot", package.at("packageRoot")},
                          {"registryRoot", registry_root},
                          {"purpose", purpose},
                          {"cut", cut},
                          {"operation", operation},
                          {"supplyChainGrade", supply_chain_grade},
                          {"admissionGrade", admission_grade},
                          {"runtimeAssessment", runtime_degraded ? "degraded" : "eligible"},
                          {"fresh", !stale},
                          {"corePolicyRoot", core_policy_root},
                          {"requestedPolicyRoot", requested_policy_root},
                          {"policyRoot", policy_root},
                          {"trustInputRoot", trust_input_root},
                          {"kfdAssessmentKey", kfd_assessment_key},
                          {"kfdReportRoot", kfd_report_root},
                          {"dependencyRoot", dependency_root},
                          {"evidenceDependencies", evidence_dependencies},
                          {"reasons", reasons},
                          {"constraints", constraints},
                          {"recoveryGuidance", recovery_guidance},
                          {"residualRisk", residual_risk}};
  const auto report_root = root_of(report_identity);
  json plan_identity = {{"schema", "kungfu.kfx-admission-plan/v1"},
                        {"reportRoot", report_root},
                        {"packageRoot", package.at("packageRoot")},
                        {"dependencyRoot", dependency_root},
                        {"operation", operation},
                        {"allowed", allowed},
                        {"requiredApprovals", required_approvals},
                        {"constraints", constraints}};
  const auto plan_root = root_of(plan_identity);
  auto report = report_identity;
  report["reportRoot"] = report_root;
  auto admission_plan = plan_identity;
  admission_plan["planRoot"] = plan_root;
  admission_plan["receiptDependencyRoot"] = root_of({{"reportRoot", report_root},
                                                     {"planRoot", plan_root},
                                                     {"packageRoot", package.at("packageRoot")},
                                                     {"dependencyRoot", dependency_root}});
  return {{"schema", "kungfu.kfx-admission-assessment/v1"},
          {"registryRoot", registry_root},
          {"trustReport", report},
          {"admissionPlan", admission_plan}};
}

json plan(const json &packages, const std::string &registry_root, const std::string &graph_root, const json &prior_cut,
          uint64_t revision, const json &request, const json &load_plan, const assessment_fn &assess) {
  const auto operation = required_text(request, "operation", "request");
  static const std::set<std::string> operations = {"install", "update",   "remove", "enable",
                                                   "disable", "activate", "qualify"};
  if (!operations.contains(operation))
    refuse("KF_KFX_SCHEMA_INVALID", "lifecycle operation is not supported: " + operation);
  const auto package_key = required_text(request, "packageKey", "request");
  const auto package = find_package(packages, package_key);
  if (package.is_null())
    refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + package_key);
  if (!request.contains("authorizationTime") || !request.at("authorizationTime").is_number_integer() ||
      request.at("authorizationTime").get<int64_t>() < 0)
    refuse("KF_KFX_AUTHORIZATION_REQUIRED", "mutation planning requires a non-negative authorizationTime");
  const auto authorization_time = request.at("authorizationTime").get<int64_t>();
  const auto approval_roots = canonical_approval_roots(request);

  json assessment = nullptr;
  json report_root = nullptr;
  json admission_plan_root = nullptr;
  json receipt_dependency_root = nullptr;
  json core_policy_root = nullptr;
  json requested_policy_root = nullptr;
  json policy_root = nullptr;
  json dependency_root = nullptr;
  json required_approvals = json::array();
  std::string mode = "release-passport";

  if (operation == "remove" || operation == "disable") {
    mode = "owner-system-recovery";
    const auto recovery = object_or_empty(request, "recoveryWarrant");
    if (recovery.empty() || recovery.value("schema", "") != "kungfu.kfx-recovery-warrant/v1")
      refuse("KF_KFX_RECOVERY_WARRANT_REQUIRED",
             "disable/remove requires an explicit owner or system recovery Warrant");
    require_exact_fields(recovery,
                         {"schema", "issuerClass", "operation", "packageRoot", "expectedCutRoot", "expectedRevision",
                          "approvalRoots", "issuedAt", "expiresAt", "nonce"},
                         "recovery Warrant");
    const auto issuer_class = recovery.value("issuerClass", "");
    if (issuer_class != "workspace-owner" && issuer_class != "core-system")
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant issuer must be workspace-owner or core-system");
    if (recovery.value("operation", "") != operation ||
        recovery.value("packageRoot", "") != package.at("packageRoot").get<std::string>() ||
        recovery.at("expectedCutRoot") != prior_cut || !recovery.at("expectedRevision").is_number_unsigned() ||
        recovery.at("expectedRevision").get<uint64_t>() != revision)
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant does not bind the exact package and prior Cut");
    if (!recovery.at("issuedAt").is_number_integer() || !recovery.at("expiresAt").is_number_integer() ||
        recovery.at("issuedAt").get<int64_t>() < 0 ||
        recovery.at("expiresAt").get<int64_t>() <= recovery.at("issuedAt").get<int64_t>() ||
        authorization_time < recovery.at("issuedAt").get<int64_t>() ||
        authorization_time >= recovery.at("expiresAt").get<int64_t>())
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant is not fresh at authorizationTime");
    if (!recovery.at("approvalRoots").is_array() || recovery.at("approvalRoots") != approval_roots ||
        approval_roots.empty())
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant requires the exact non-empty approval roots");
    policy_root = root_of({{"schema", "kungfu.kfx-recovery-policy/v1"},
                           {"issuerClasses", json::array({"core-system", "workspace-owner"})},
                           {"operations", json::array({"disable", "remove"})},
                           {"packageCooperationRequired", false}});
    core_policy_root = policy_root;
    dependency_root = root_of(recovery);
    receipt_dependency_root = root_of({{"recoveryWarrantRoot", dependency_root},
                                       {"policyRoot", policy_root},
                                       {"packageRoot", package.at("packageRoot")},
                                       {"priorCutRoot", prior_cut},
                                       {"priorRevision", revision}});
    required_approvals = json::array({issuer_class});
  } else {
    auto assessment_request = request;
    assessment_request["cut"] = prior_cut.is_null() ? "unborn" : prior_cut;
    assessment_request["operation"] = operation;
    assessment = assess(package, registry_root, assessment_request);
    const auto &report = assessment.at("trustReport");
    const auto &admission = assessment.at("admissionPlan");
    if (!admission.value("allowed", false) || !report.value("fresh", false))
      refuse("KF_KFX_ADMISSION_REQUIRED",
             "mutation requires a fresh, exact-root, allowed Release Passport AdmissionPlan");
    report_root = report.at("reportRoot");
    admission_plan_root = admission.at("planRoot");
    receipt_dependency_root = admission.at("receiptDependencyRoot");
    policy_root = report.at("policyRoot");
    core_policy_root = report.at("corePolicyRoot");
    requested_policy_root = report.at("requestedPolicyRoot");
    dependency_root = admission.at("dependencyRoot");
    required_approvals = admission.at("requiredApprovals");
    if (!required_approvals.empty() && approval_roots.empty())
      refuse("KF_KFX_APPROVAL_REQUIRED", "AdmissionPlan requires explicit approval roots");
  }

  const json basis = {{"cutRoot", prior_cut},
                      {"revision", revision},
                      {"registryRoot", registry_root},
                      {"graphRoot", graph_root},
                      {"loadPlanRoot", load_plan.at("planRoot")},
                      {"packageRoot", package.at("packageRoot")},
                      {"dependencyRoot", dependency_root}};
  const json authority_roots = {{"reportRoot", report_root},
                                {"admissionPlanRoot", admission_plan_root},
                                {"receiptDependencyRoot", receipt_dependency_root},
                                {"corePolicyRoot", core_policy_root},
                                {"requestedPolicyRoot", requested_policy_root},
                                {"policyRoot", policy_root},
                                {"packageRoot", package.at("packageRoot")},
                                {"dependencyRoot", dependency_root},
                                {"requiredApprovals", required_approvals},
                                {"approvalRoots", approval_roots}};
  const auto requested_capabilities = string_array_or_empty(request, "requestedCapabilities");
  const auto declared_capabilities = package.at("declaredCapabilities").get<std::vector<std::string>>();
  for (const auto &capability : requested_capabilities) {
    if (std::find(declared_capabilities.begin(), declared_capabilities.end(), capability) ==
        declared_capabilities.end())
      refuse("KF_KFX_CAPABILITY_BROADENING",
             "capability grant contains a capability absent from the exact package declaration");
  }
  const auto authority_basis_root = root_of({{"schema", "kungfu.kfx-mutation-authority-basis/v1"},
                                             {"mode", mode},
                                             {"operation", operation},
                                             {"packageKey", package_key},
                                             {"basis", basis},
                                             {"authorityRoots", authority_roots},
                                             {"requestedCapabilities", requested_capabilities},
                                             {"authorizationTime", authorization_time}});
  const json capability_declaration = {{"schema", "kungfu.kfx-capability-declaration/v1"},
                                       {"packageKey", package_key},
                                       {"packageRoot", package.at("packageRoot")},
                                       {"capabilities", declared_capabilities}};
  const auto capability_declaration_root = root_of(capability_declaration);
  const json capability_grant_identity = {{"schema", "kungfu.kfx-capability-grant/v1"},
                                          {"mode", mode},
                                          {"operation", operation},
                                          {"packageKey", package_key},
                                          {"packageRoot", package.at("packageRoot")},
                                          {"capabilityDeclarationRoot", capability_declaration_root},
                                          {"corePolicyRoot", core_policy_root},
                                          {"requestedPolicyRoot", requested_policy_root},
                                          {"policyRoot", policy_root},
                                          {"reportRoot", report_root},
                                          {"admissionPlanRoot", admission_plan_root},
                                          {"receiptDependencyRoot", receipt_dependency_root},
                                          {"authorityBasisRoot", authority_basis_root},
                                          {"requiredApprovals", required_approvals},
                                          {"approvalRoots", approval_roots},
                                          {"grantedCapabilities", requested_capabilities},
                                          {"priorCutRoot", prior_cut},
                                          {"priorRevision", revision},
                                          {"issuedAt", authorization_time}};
  const auto capability_grant_root = root_of(capability_grant_identity);
  const auto warrant_root = root_of({{"schema", "kungfu.kfx.warrant-fact/v2"},
                                     {"mode", mode},
                                     {"operation", operation},
                                     {"packageKey", package_key},
                                     {"authorityBasisRoot", authority_basis_root},
                                     {"capabilityGrantRoot", capability_grant_root},
                                     {"basis", basis},
                                     {"authorityRoots", authority_roots},
                                     {"state", "issued"},
                                     {"issuedAt", authorization_time}});
  json identity = {{"schema", "kungfu.kfx-mutation-authorization-plan/v1"},
                   {"mode", mode},
                   {"operation", operation},
                   {"packageKey", package_key},
                   {"basis", basis},
                   {"authorityRoots", authority_roots},
                   {"requestedCapabilities", requested_capabilities},
                   {"grantedCapabilities", requested_capabilities},
                   {"capabilityDeclaration", capability_declaration},
                   {"capabilityDeclarationRoot", capability_declaration_root},
                   {"capabilityGrant", capability_grant_identity},
                   {"capabilityGrantRoot", capability_grant_root},
                   {"authorizationTime", authorization_time},
                   {"warrantRoot", warrant_root},
                   {"warrantObjectId", fact_id("warrant", warrant_root)},
                   {"workObjectId", fact_id("work", authority_basis_root)}};
  const auto authorization_plan_root = root_of(identity);
  auto result = identity;
  result["authorizationPlanRoot"] = authorization_plan_root;
  result["actionId"] = "kfx-action:" + sha256(authorization_plan_root).substr(0, 32);
  result["assessment"] = assessment;
  return result;
}

} // namespace kungfu::runtime::kfx::authority
