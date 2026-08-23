// SPDX-License-Identifier: Apache-2.0

#include "native_authority.h"

#include <algorithm>
#include <cctype>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>
#include <vector>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>
#include <kungfu/runtime/storage/fact_kernel.h>
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
  static const std::set<std::string> operations = {"inspect", "install",        "update",     "enable",   "activate",
                                                   "qualify", "host-placement", "capability", "migration"};
  validate_enum(operation, operations, "admission operation");

  const auto policy = object_or_empty(request, "policy");
  if (policy.empty() || policy.value("schema", "") != "kungfu.kfx-admission-policy/v1")
    refuse("KF_KFX_SCHEMA_INVALID", "assessment requires kungfu.kfx-admission-policy/v1");
  require_exact_fields(policy,
                       {"schema", "allowedIssuers", "allowedPublishers", "allowedContracts", "allowedVerifierRoots",
                        "allowedCapabilities", "autoOperations", "highConsequenceCapabilities", "residualRisk"},
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

  const std::string admission_grade = supply_chain_grade;

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
      admission_grade == "kfd-attested")
    allowed = true;
  if (operation == "update" && request.value("capabilityExpansion", false)) {
    allowed = false;
    required_approvals.push_back("capability-expansion");
  }
  if (operation == "migration") {
    allowed = false;
    required_approvals.push_back("irreversible-migration");
  }
  if (operation == "capability" && !required_approvals.empty())
    allowed = false;

  const auto runtime = object_or_empty(request, "runtimeEvidence");
  const bool runtime_degraded = runtime.value("degraded", false) || runtime.value("receiptViolation", false);
  if (runtime_degraded && (operation == "enable" || operation == "activate" || operation == "host-placement" ||
                           operation == "capability")) {
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
        recovery.at("expectedCutRoot") != prior_cut || !recovery.at("expectedRevision").is_number_integer() ||
        recovery.at("expectedRevision").get<int64_t>() < 0 ||
        static_cast<uint64_t>(recovery.at("expectedRevision").get<int64_t>()) != revision)
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

inline constexpr const char *KFX_PROFILE_ID = "kungfu-kfx-domain-profile";

json fact_call(const std::string &runtime_dir, const std::string &action, json request) {
  request["action"] = action;
  auto response = storage_service_api::run_fact_kernel_operation(runtime_dir, request);
  if (!response.value("ok", false)) {
    refuse(action == "ref-cas" && response.value("failure_code", "") == "stale-ref" ? "KF_KFX_CUT_STALE"
                                                                                    : "KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact kernel rejected KFX"));
  }
  return response;
}

std::string relation_id(const std::string &kind, const std::string &source, const std::string &target) {
  return fact_id("relation", kind + ":" + source + ":" + target);
}

json parse_fact_body(const json &member) {
  if (!member.is_object() || member.value("body_status", "") != "present" || !member.contains("body") ||
      !member.at("body").is_string())
    return nullptr;
  try {
    return json::parse(member.at("body").get<std::string>());
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "KFX Fact body is not canonical JSON: " + std::string(error.what()));
  }
}

std::string runtime_warrant_ref(const std::string &package_key, const std::string &host) {
  return "profiles/kfx/runtime/" + sha256(package_key + "\n" + host);
}

struct runtime_warrant_view {
  bool present = false;
  std::string ref_name;
  std::string cut_root;
  uint64_t revision = 0;
  std::map<std::string, std::string> current_versions;
  std::set<std::string> relation_roots;
  json warrant = nullptr;
  json state = nullptr;
  json events = json::array();
};

runtime_warrant_view load_runtime_warrant(const std::string &runtime_dir, const std::string &package_key,
                                          const std::string &host) {
  runtime_warrant_view result;
  result.ref_name = runtime_warrant_ref(package_key, host);
  const auto response = storage_service_api::run_fact_kernel_operation(
      runtime_dir,
      {{"action", "query"}, {"ref_name", result.ref_name}, {"include_inventory", true}, {"include_bodies", true}});
  if (!response.value("ok", false)) {
    if (response.value("failure_code", "") == "unknown-cut")
      return result;
    refuse("KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact query failed"));
  }
  result.present = true;
  result.cut_root = response.at("cut_root").get<std::string>();
  const auto &resolution = response.at("ref_resolution");
  result.revision = resolution.at("revision").get<uint64_t>();
  const auto &cut = response.at("cut");
  for (const auto &member : cut.at("objectVersions"))
    result.current_versions[member.at(0).get<std::string>()] = member.at(1).get<std::string>();
  for (const auto &root : cut.at("activeRelationRoots"))
    result.relation_roots.insert(root.get<std::string>());
  json warrants = json::array();
  for (const auto &member : response.at("objects")) {
    const auto body = parse_fact_body(member);
    if (body.is_null())
      continue;
    const auto schema = body.value("schema", "");
    if (schema == "kungfu.kfx.runtime-warrant/v1")
      warrants.push_back(body);
    else if (schema == "kungfu.kfx.runtime-lease-state-fact/v1")
      result.state = body;
    else if (schema == "kungfu.kfx.runtime-warrant-episode-fact/v1" ||
             schema == "kungfu.kfx.runtime-warrant-settlement/v1")
      result.events.push_back(body);
  }
  if (!result.state.is_null()) {
    for (const auto &candidate : warrants) {
      if (candidate.value("warrantRoot", "") == result.state.value("warrantRoot", "")) {
        result.warrant = candidate;
        break;
      }
    }
  }
  if (result.warrant.is_null() || result.state.is_null())
    refuse("KF_KFX_SCHEMA_INVALID", "runtime Warrant Cut is missing its Warrant or lease state Fact");
  std::sort(result.events.begin(), result.events.end(), [](const auto &left, const auto &right) {
    if (left.value("recordedAt", int64_t{0}) != right.value("recordedAt", int64_t{0}))
      return left.value("recordedAt", int64_t{0}) < right.value("recordedAt", int64_t{0});
    return left.value("eventRoot", left.value("settlementRoot", "")) <
           right.value("eventRoot", right.value("settlementRoot", ""));
  });
  return result;
}

struct fact_work_builder {
  std::string runtime_dir;
  std::map<std::string, std::string> versions;
  std::set<std::string> relations;
  json steps = json::array();
  std::string profile_root;
  std::string admission_root;

  fact_work_builder(std::string runtime, const runtime_warrant_view &current)
      : runtime_dir(std::move(runtime)), versions(current.current_versions), relations(current.relation_roots),
        profile_root(native_kfx_domain_profile().at("domainProfileRoot").get<std::string>()),
        admission_root(
            root_of({{"schema", "kungfu.kfx-domain-profile-admission/v1"}, {"domainProfileRoot", profile_root}})) {}

  json invoke(const std::string &action, const json &request) {
    auto response = fact_call(runtime_dir, action, request);
    if (response.value("status", "") == "idempotent-replay" && response.contains("result") &&
        response.at("result").contains("record_root")) {
      static const std::map<std::string, std::string> replay_root_fields = {{"object-put", "object_root"},
                                                                            {"version-put", "version_root"},
                                                                            {"relation-add", "relation_root"},
                                                                            {"cut-put", "cut_root"}};
      if (replay_root_fields.contains(action))
        response["result"][replay_root_fields.at(action)] = response.at("result").at("record_root");
    }
    steps.push_back({{"action", action},
                     {"status", response.value("status", "accepted")},
                     {"writeOccurred", response.value("write_occurred", false)},
                     {"receiptRoot", response.contains("receipt_root") ? response.at("receipt_root") : json(nullptr)}});
    return response;
  }

  json put(const std::string &object_id, const std::string &object_type, const json &body) {
    const auto created_by = root_of({{"schema", "kungfu.kfx-object-declaration/v1"},
                                     {"domainProfileRoot", profile_root},
                                     {"objectId", object_id},
                                     {"objectType", object_type}});
    invoke("object-put",
           {{"object_id", object_id}, {"object_type", object_type}, {"created_by_receipt_root", created_by}});
    json parents = json::array();
    if (versions.contains(object_id))
      parents.push_back(versions.at(object_id));
    const auto response = invoke(
        "version-put",
        {{"object_id", object_id},
         {"body", body.dump()},
         {"schema_root", root_of({{"schema", "kungfu.kfx-fact-body-schema/v1"}, {"bodySchema", body.at("schema")}})},
         {"parent_version_roots", parents},
         {"declaration_roots", json::array({profile_root})},
         {"admission_roots", json::array({admission_root})}});
    versions[object_id] = response.at("result").at("version_root").get<std::string>();
    return response.at("result");
  }

  void relate(const std::string &type, const std::string &source, const std::string &target, const json &attributes) {
    const auto attributes_root = root_of(attributes);
    const auto response = invoke("relation-add", {{"relation_id", relation_id(type, source, target)},
                                                  {"relation_type", type},
                                                  {"source", {{"kind", "logical-object"}, {"id", source}}},
                                                  {"target", {{"kind", "logical-object"}, {"id", target}}},
                                                  {"attributes_root", attributes_root},
                                                  {"admission_roots", json::array({admission_root})}});
    relations.insert(response.at("result").at("relation_root").get<std::string>());
  }
};

int64_t runtime_time(const json &request, const char *field) {
  if (!request.contains(field) || !request.at(field).is_number_integer() || request.at(field).get<int64_t>() < 0)
    refuse("KF_KFX_RUNTIME_WARRANT_INVALID", std::string(field) + " must be a non-negative integer");
  return request.at(field).get<int64_t>();
}

int64_t bounded_runtime_deadline(int64_t start, int64_t ttl, int64_t expires_at) {
  const auto remaining = expires_at - start;
  return ttl >= remaining ? expires_at : start + ttl;
}

json commit_runtime_warrant_transition(const std::string &runtime_dir, const runtime_warrant_view &current,
                                       const json &warrant, const json &state, json event, json settlement,
                                       const std::string &action_id) {
  fact_work_builder builder(runtime_dir, current);
  const auto profile_root = native_kfx_domain_profile().at("domainProfileRoot");
  const auto warrant_id = fact_id("runtime-warrant", warrant.at("warrantRoot").get<std::string>());
  const auto state_id = fact_id("runtime-lease-state", current.ref_name);
  builder.put(warrant_id, "kungfu.kfx.runtime-warrant", warrant);
  const auto state_result = builder.put(state_id, "kungfu.kfx.runtime-lease-state", state);

  const auto event_identity_root = root_of(event);
  event["eventRoot"] = event_identity_root;
  const auto event_id = fact_id("runtime-warrant-event", event_identity_root);
  const auto event_result = builder.put(event_id, "kungfu.kfx.runtime-warrant-episode", event);
  builder.relate("kfx-runtime-warrant-observed-in", warrant_id, event_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  builder.relate("kfx-runtime-warrant-authorizes-lease", warrant_id, state_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"},
                  {"generation", state.at("generation")},
                  {"fencingToken", state.at("fencingToken")}});

  json settlement_result = nullptr;
  if (!settlement.is_null()) {
    const auto settlement_identity_root = root_of(settlement);
    settlement["settlementRoot"] = settlement_identity_root;
    const auto settlement_id = fact_id("runtime-warrant-settlement", settlement_identity_root);
    settlement_result = builder.put(settlement_id, "kungfu.kfx.runtime-warrant-settlement", settlement);
    builder.relate("kfx-runtime-warrant-settled-by", warrant_id, settlement_id,
                   {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  }

  json object_versions = json::array();
  for (const auto &[object_id, version_root] : builder.versions)
    object_versions.push_back({{"object_id", object_id}, {"version_root", version_root}});
  json relation_roots = json::array();
  for (const auto &root : builder.relations)
    relation_roots.push_back(root);
  json parent_cuts = json::array();
  if (current.present)
    parent_cuts.push_back(current.cut_root);
  const auto episode_number = std::stoull(sha256(action_id).substr(0, 16), nullptr, 16);
  const auto cut_response = builder.invoke(
      "cut-put",
      {{"parent_cut_roots", parent_cuts},
       {"object_versions", object_versions},
       {"active_relation_roots", relation_roots},
       {"declaration_roots", json::array({builder.profile_root})},
       {"admission_roots", json::array({builder.admission_root, warrant.at("warrantRoot"),
                                        warrant.at("capabilityGrantRoot"), warrant.at("hostAuthorizationRoot")})},
       {"episode_frontier", json::array({{{"episode_id", episode_number},
                                          {"sealed_content_root", event_result.at("body_root")},
                                          {"accepted_manifest_frame_uid", "kfx-runtime:" + action_id}}})},
       {"omission_roots", json::array()},
       {"conflict_roots", json::array()}});
  const auto ref_response =
      builder.invoke("ref-cas", {{"transition_id", action_id},
                                 {"ref_name", current.ref_name},
                                 {"expected_old_cut_root", current.present ? json(current.cut_root) : json(nullptr)},
                                 {"expected_old_revision", current.revision},
                                 {"new_cut_root", cut_response.at("result").at("cut_root")},
                                 {"kind", current.present ? "advance" : "create"},
                                 {"reason_root", root_of({{"schema", "kungfu.kfx.runtime-warrant-transition-reason/v1"},
                                                          {"eventRoot", event_identity_root},
                                                          {"state", state.at("state")}})}});
  const auto result = ref_response.at("result");
  const json receipt_identity = {
      {"schema", "kungfu.kfx.runtime-warrant-transition-receipt/v1"},
      {"actionId", action_id},
      {"event", event.at("event")},
      {"packageKey", warrant.at("packageKey")},
      {"host", warrant.at("host")},
      {"warrantRoot", warrant.at("warrantRoot")},
      {"generation", state.at("generation")},
      {"fencingToken", state.at("fencingToken")},
      {"state", state.at("state")},
      {"eventRoot", event_identity_root},
      {"stateBodyRoot", state_result.at("body_root")},
      {"settlementBodyRoot", settlement_result.is_null() ? json(nullptr) : settlement_result.at("body_root")},
      {"priorCutRoot", current.present ? json(current.cut_root) : json(nullptr)},
      {"cutRoot", result.at("current_cut_root")},
      {"priorRevision", current.revision},
      {"revision", result.at("current_revision")},
      {"kernelReceiptRoot", ref_response.at("receipt_root")},
      {"recordedAt", event.at("recordedAt")}};
  auto receipt = receipt_identity;
  receipt["receiptRoot"] = root_of(receipt_identity);
  receipt["steps"] = builder.steps;
  return receipt;
}

json issue_runtime_warrant(const json &descriptor, const json &launch, const json &request,
                           const std::string &runtime_dir) {
  const auto &authorization = launch.at("authorization");
  const auto package_key = authorization.at("packageKey").get<std::string>();
  const auto host = authorization.at("host").get<std::string>();
  auto current = load_runtime_warrant(runtime_dir, package_key, host);
  const auto issued_at = runtime_time(request, "issuedAt");
  const auto expires_at = runtime_time(request, "expiresAt");
  const auto heartbeat_ttl = runtime_time(request, "heartbeatTtl");
  if (expires_at <= issued_at || heartbeat_ttl <= 0)
    refuse("KF_KFX_RUNTIME_WARRANT_INVALID", "runtime Warrant expiry and heartbeat TTL must be positive");
  if (current.present && current.state.value("state", "") == "active")
    refuse("KF_KFX_RUNTIME_WARRANT_ACTIVE", "the package and host already have an unsettled Runtime Warrant");
  const auto holder = required_text(request, "holder", "request");
  const auto purpose = required_text(request, "purpose", "request");
  const auto nonce = required_text(request, "leaseNonce", "request");
  const auto residual = required_text(request, "residualResponsibility", "request");
  const auto requested_capabilities = string_array_or_empty(request, "requestedCapabilities");
  if (requested_capabilities.empty())
    refuse("KF_KFX_RUNTIME_WARRANT_INVALID", "Runtime Warrant requires a non-empty attenuated capability scope");
  for (const auto &capability : requested_capabilities) {
    if (std::find(authorization.at("grantedCapabilities").begin(), authorization.at("grantedCapabilities").end(),
                  capability) == authorization.at("grantedCapabilities").end())
      refuse("KF_KFX_RUNTIME_AUTHORITY_AMPLIFICATION",
             "Runtime Warrant capability scope exceeds the exact Core capability grant");
  }
  const auto prior_generation = current.present ? current.state.at("generation").get<uint64_t>() : uint64_t{0};
  if (prior_generation == std::numeric_limits<uint64_t>::max())
    refuse("KF_KFX_RUNTIME_WARRANT_INVALID", "Runtime Warrant generation space is exhausted");
  const auto generation = prior_generation + 1;
  const auto target_roots = json{{"registryRoot", descriptor.at("registryRoot")},
                                 {"graphRoot", descriptor.at("graphRoot")},
                                 {"cutRoot", descriptor.at("cutRoot")},
                                 {"hostGenerationRoot", descriptor.at("generationRoot")},
                                 {"packageRoot", authorization.at("packageRoot")}};
  const json warrant_identity = {{"schema", "kungfu.kfx.runtime-warrant/v1"},
                                 {"warrantClass", "leased-runtime"},
                                 {"issuer", "kungfu-core/kfx-control"},
                                 {"holder", holder},
                                 {"purpose", purpose},
                                 {"packageKey", package_key},
                                 {"host", host},
                                 {"generation", generation},
                                 {"actionScope", json::array({"heartbeat", "run", "settle"})},
                                 {"capabilityScope", requested_capabilities},
                                 {"targetRoots", target_roots},
                                 {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                 {"hostAuthorizationRoot", authorization.at("authorizationRoot")},
                                 {"mutationWarrantRoot", authorization.at("warrantRoot")},
                                 {"issuedAt", issued_at},
                                 {"expiresAt", expires_at},
                                 {"heartbeatTtl", heartbeat_ttl},
                                 {"revocationChannel", current.ref_name},
                                 {"residualResponsibility", residual},
                                 {"delegation", "forbidden-without-new-core-source"}};
  const auto warrant_root = root_of(warrant_identity);
  const auto fencing_token = root_of({{"schema", "kungfu.kfx.runtime-fence/v1"},
                                      {"warrantRoot", warrant_root},
                                      {"generation", generation},
                                      {"holder", holder},
                                      {"leaseNonce", nonce}});
  auto warrant = warrant_identity;
  warrant["profile"] = KFX_PROFILE_ID;
  warrant["domainProfileRoot"] = native_kfx_domain_profile().at("domainProfileRoot");
  warrant["warrantRoot"] = warrant_root;
  const auto heartbeat_deadline = bounded_runtime_deadline(issued_at, heartbeat_ttl, expires_at);
  const json state = {{"schema", "kungfu.kfx.runtime-lease-state-fact/v1"},
                      {"profile", KFX_PROFILE_ID},
                      {"domainProfileRoot", native_kfx_domain_profile().at("domainProfileRoot")},
                      {"warrantRoot", warrant_root},
                      {"packageKey", package_key},
                      {"host", host},
                      {"holder", holder},
                      {"generation", generation},
                      {"fencingToken", fencing_token},
                      {"state", "active"},
                      {"heartbeatAt", issued_at},
                      {"heartbeatDeadline", heartbeat_deadline},
                      {"expiresAt", expires_at},
                      {"revocationRoot", nullptr},
                      {"settlementRoot", nullptr},
                      {"residualResponsibility", residual},
                      {"recordedAt", issued_at}};
  const auto action_id = "kfx-runtime-issue:" + sha256(warrant_root + fencing_token).substr(0, 32);
  const json event = {{"schema", "kungfu.kfx.runtime-warrant-episode-fact/v1"},
                      {"profile", KFX_PROFILE_ID},
                      {"domainProfileRoot", native_kfx_domain_profile().at("domainProfileRoot")},
                      {"actionId", action_id},
                      {"event", "issued"},
                      {"warrantRoot", warrant_root},
                      {"packageKey", package_key},
                      {"host", host},
                      {"holder", holder},
                      {"generation", generation},
                      {"fencingToken", fencing_token},
                      {"targetRoots", target_roots},
                      {"recordedAt", issued_at}};
  const auto receipt =
      commit_runtime_warrant_transition(runtime_dir, current, warrant, state, event, nullptr, action_id);
  return {{"schema", "kungfu.kfx.runtime-warrant-authorization/v1"},
          {"executionAllowed", true},
          {"hostLaunch", launch},
          {"runtimeWarrant", warrant},
          {"leaseState", state},
          {"receipt", receipt}};
}

void require_runtime_fence(const runtime_warrant_view &current, const json &request, bool require_holder) {
  if (!current.present)
    refuse("KF_KFX_RUNTIME_WARRANT_MISSING", "no Runtime Warrant exists for the requested package and host");
  uint64_t expected_generation = 0;
  if (request.contains("expectedGeneration") && request.at("expectedGeneration").is_number_unsigned()) {
    expected_generation = request.at("expectedGeneration").get<uint64_t>();
  } else if (request.contains("expectedGeneration") && request.at("expectedGeneration").is_number_integer() &&
             request.at("expectedGeneration").get<int64_t>() >= 0) {
    expected_generation = static_cast<uint64_t>(request.at("expectedGeneration").get<int64_t>());
  } else {
    refuse("KF_KFX_RUNTIME_FENCE_STALE", "Runtime Warrant generation is missing or invalid");
  }
  if (request.value("expectedWarrantRoot", "") != current.warrant.value("warrantRoot", "") ||
      expected_generation != current.state.at("generation").get<uint64_t>() ||
      request.value("expectedFencingToken", "") != current.state.value("fencingToken", ""))
    refuse("KF_KFX_RUNTIME_FENCE_STALE", "Runtime Warrant root, generation, or fencing token is stale");
  if (require_holder && request.value("holder", "") != current.state.value("holder", ""))
    refuse("KF_KFX_RUNTIME_HOLDER_STALE", "Runtime Warrant holder does not match the active lease");
  if (current.state.value("state", "") != "active")
    refuse("KF_KFX_RUNTIME_WARRANT_TERMINAL", "Runtime Warrant is already terminal");
}

struct runtime_transition_result {
  json state;
  json settlement = nullptr;
  std::string event_name;
};

runtime_transition_result heartbeat_runtime_warrant(json state, const runtime_warrant_view &current,
                                                    int64_t recorded_at) {
  if (recorded_at <= state.at("heartbeatAt").get<int64_t>())
    refuse("KF_KFX_RUNTIME_HEARTBEAT_DUPLICATE", "heartbeat time must advance monotonically");
  if (recorded_at >= state.at("expiresAt").get<int64_t>())
    refuse("KF_KFX_RUNTIME_WARRANT_EXPIRED", "Runtime Warrant lease has expired");
  if (recorded_at > state.at("heartbeatDeadline").get<int64_t>())
    refuse("KF_KFX_RUNTIME_HEARTBEAT_STALE", "Runtime Warrant heartbeat deadline was missed");
  state["heartbeatAt"] = recorded_at;
  state["heartbeatDeadline"] = bounded_runtime_deadline(recorded_at, current.warrant.at("heartbeatTtl").get<int64_t>(),
                                                        state.at("expiresAt").get<int64_t>());
  return {std::move(state), nullptr, "heartbeat"};
}

runtime_transition_result revoke_runtime_warrant(json state, const runtime_warrant_view &current, const json &request,
                                                 int64_t recorded_at) {
  const auto authority_root = required_text(request, "revocationAuthorityRoot", "request");
  if (!is_content_root(authority_root))
    refuse("KF_KFX_RUNTIME_REVOCATION_INVALID", "revocation authority must be an exact content root");
  const auto reason = required_text(request, "reason", "request");
  state["state"] = "revoked";
  state["revocationRoot"] = root_of({{"schema", "kungfu.kfx.runtime-revocation/v1"},
                                     {"warrantRoot", current.warrant.at("warrantRoot")},
                                     {"authorityRoot", authority_root},
                                     {"reason", reason},
                                     {"recordedAt", recorded_at}});
  json settlement = {{"schema", "kungfu.kfx.runtime-warrant-settlement/v1"},
                     {"warrantRoot", current.warrant.at("warrantRoot")},
                     {"generation", state.at("generation")},
                     {"fencingToken", state.at("fencingToken")},
                     {"outcome", "revoked"},
                     {"terminalReason", reason},
                     {"residualResponsibility", state.at("residualResponsibility")},
                     {"residualResponsibilityDisposition", "retained-by-kungfu-core"},
                     {"settledBy", authority_root},
                     {"recordedAt", recorded_at}};
  state["settlementRoot"] = root_of(settlement);
  return {std::move(state), std::move(settlement), "revoked"};
}

runtime_transition_result settle_runtime_warrant(json state, const runtime_warrant_view &current, const json &request,
                                                 int64_t recorded_at) {
  if (recorded_at >= state.at("expiresAt").get<int64_t>() || recorded_at > state.at("heartbeatDeadline").get<int64_t>())
    refuse("KF_KFX_RUNTIME_WARRANT_EXPIRED", "expired or heartbeat-stale authority cannot settle as live use");
  const auto outcome = required_text(request, "outcome", "request");
  const auto disposition = required_text(request, "residualResponsibilityDisposition", "request");
  json settlement = {{"schema", "kungfu.kfx.runtime-warrant-settlement/v1"},
                     {"warrantRoot", current.warrant.at("warrantRoot")},
                     {"generation", state.at("generation")},
                     {"fencingToken", state.at("fencingToken")},
                     {"outcome", outcome},
                     {"residualResponsibility", state.at("residualResponsibility")},
                     {"residualResponsibilityDisposition", disposition},
                     {"settledBy", state.at("holder")},
                     {"recordedAt", recorded_at}};
  state["state"] = "settled";
  state["settlementRoot"] = root_of(settlement);
  return {std::move(state), std::move(settlement), "settled"};
}

runtime_transition_result recover_runtime_warrant(json state, const runtime_warrant_view &current,
                                                  int64_t recorded_at) {
  const bool lease_expired = recorded_at >= state.at("expiresAt").get<int64_t>();
  const bool heartbeat_expired = recorded_at > state.at("heartbeatDeadline").get<int64_t>();
  if (!lease_expired && !heartbeat_expired)
    refuse("KF_KFX_RUNTIME_RECOVERY_NOT_DUE", "Core recovery requires an expired lease or missed heartbeat");
  const auto terminal_reason = lease_expired ? "lease-expired" : "heartbeat-expired";
  json settlement = {{"schema", "kungfu.kfx.runtime-warrant-settlement/v1"},
                     {"warrantRoot", current.warrant.at("warrantRoot")},
                     {"generation", state.at("generation")},
                     {"fencingToken", state.at("fencingToken")},
                     {"outcome", "recovered"},
                     {"terminalReason", terminal_reason},
                     {"residualResponsibility", state.at("residualResponsibility")},
                     {"residualResponsibilityDisposition", "retained-by-kungfu-core"},
                     {"settledBy", "kungfu-core/kfx-recovery"},
                     {"recordedAt", recorded_at}};
  state["state"] = "recovered";
  state["settlementRoot"] = root_of(settlement);
  return {std::move(state), std::move(settlement), terminal_reason};
}

runtime_transition_result prepare_runtime_warrant_transition(const std::string &action,
                                                             const runtime_warrant_view &current, const json &request,
                                                             int64_t recorded_at) {
  if (action == "runtime-warrant-heartbeat")
    return heartbeat_runtime_warrant(current.state, current, recorded_at);
  if (action == "runtime-warrant-revoke")
    return revoke_runtime_warrant(current.state, current, request, recorded_at);
  if (action == "runtime-warrant-settle")
    return settle_runtime_warrant(current.state, current, request, recorded_at);
  if (action == "runtime-warrant-recover")
    return recover_runtime_warrant(current.state, current, recorded_at);
  refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "unsupported Runtime Warrant transition");
}

json transition_runtime_warrant(const std::string &action, const json &request, const std::string &runtime_dir) {
  const auto package_key = required_text(request, "packageKey", "request");
  const auto host = required_text(request, "host", "request");
  auto current = load_runtime_warrant(runtime_dir, package_key, host);
  const bool holder_action = action == "runtime-warrant-heartbeat" || action == "runtime-warrant-settle";
  require_runtime_fence(current, request, holder_action);
  const auto recorded_at = runtime_time(request, "recordedAt");
  auto transition = prepare_runtime_warrant_transition(action, current, request, recorded_at);
  auto &state = transition.state;
  const auto &settlement = transition.settlement;
  const auto &event_name = transition.event_name;
  state["recordedAt"] = recorded_at;
  const auto action_id = "kfx-runtime-" + event_name + ":" +
                         sha256(current.warrant.at("warrantRoot").get<std::string>() + std::to_string(recorded_at) +
                                state.at("fencingToken").get<std::string>())
                             .substr(0, 32);
  const json event = {{"schema", "kungfu.kfx.runtime-warrant-episode-fact/v1"},
                      {"profile", KFX_PROFILE_ID},
                      {"domainProfileRoot", native_kfx_domain_profile().at("domainProfileRoot")},
                      {"actionId", action_id},
                      {"event", event_name},
                      {"warrantRoot", current.warrant.at("warrantRoot")},
                      {"packageKey", package_key},
                      {"host", host},
                      {"holder", state.at("holder")},
                      {"generation", state.at("generation")},
                      {"fencingToken", state.at("fencingToken")},
                      {"state", state.at("state")},
                      {"recordedAt", recorded_at}};
  const auto receipt =
      commit_runtime_warrant_transition(runtime_dir, current, current.warrant, state, event, settlement, action_id);
  return {{"schema", "kungfu.kfx.runtime-warrant-transition/v1"},
          {"event", event_name},
          {"leaseState", state},
          {"receipt", receipt}};
}

json kfd10_runtime_witness(const json &request, const std::string &runtime_dir, const json &mutation) {
  const auto package_key = required_text(request, "packageKey", "request");
  const auto host = required_text(request, "host", "request");
  const auto current = load_runtime_warrant(runtime_dir, package_key, host);
  if (!current.present)
    refuse("KF_KFX_RUNTIME_WARRANT_MISSING", "KFD-10 witness requires retained Runtime Warrant facts");
  const auto profile = native_kfx_domain_profile();
  const auto kfd = profile.at("kfd10AdopterWitness");
  const json identity = {
      {"schema", "kungfu.kfx.kfd-10-adopter-witness/v1"},
      {"standard", "KFD-10"},
      {"claimClass", "draft-adopter-evidence"},
      {"adopter", "kungfu-kfx-control-and-runtime"},
      {"normative",
       {{"status", kfd.at("status")}, {"revision", kfd.at("revision")}, {"documentRoot", kfd.at("documentRoot")}}},
      {"domainProfileRoot", profile.at("domainProfileRoot")},
      {"packageKey", package_key},
      {"host", host},
      {"mutationLifecycleRoot", mutation.at("historyRoot")},
      {"runtimeLifecycleRoot", root_of(current.events)},
      {"runtimeWarrantRoot", current.warrant.at("warrantRoot")},
      {"runtimeCutRef", current.ref_name},
      {"runtimeCutRoot", current.cut_root},
      {"runtimeRevision", current.revision},
      {"leaseState", current.state},
      {"authoritySeparation",
       {{"capabilityGrantIsNotWarrant", true},
        {"kfdEvidenceIsNotRuntimePrivilege", true},
        {"episodeIsNotRetroactiveAuthority", true},
        {"settlementIsNotWarrant", true},
        {"recoveryOwnedByCore", true}}},
      {"faultCodes", json::array({"KF_KFX_RUNTIME_AUTHORITY_AMPLIFICATION", "KF_KFX_RUNTIME_FENCE_STALE",
                                  "KF_KFX_RUNTIME_HEARTBEAT_DUPLICATE", "KF_KFX_RUNTIME_HEARTBEAT_STALE",
                                  "KF_KFX_RUNTIME_HOLDER_STALE", "KF_KFX_RUNTIME_REVOCATION_INVALID",
                                  "KF_KFX_RUNTIME_WARRANT_EXPIRED", "KF_KFX_RUNTIME_WARRANT_TERMINAL"})},
      {"boundary", "first-party specialized witness; KFD remains draft and grants no runtime permission"},
      {"nonClaims", json::array({"KFD-10 conformance", "KFD-10 activation", "shipped KFD-10 support",
                                 "independent certification", "authority from package identity or support claims"})}};
  auto witness = identity;
  witness["witnessRoot"] = root_of(identity);
  return witness;
}

} // namespace kungfu::runtime::kfx::authority
