// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fs = std::filesystem;
namespace profile = kungfu::runtime::profile;
namespace storage = kungfu::yijinjing::storage;

void check_initiative_assignment_root_vectors();
void check_initiative_assignment_native_admission();

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <typename Callable> void require_invalid(Callable callable, const std::string &message) {
  bool refused = false;
  try {
    callable();
  } catch (const std::invalid_argument &) {
    refused = true;
  }
  require(refused, message);
}

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-profile-lifecycle-test-" + std::to_string(nonce));
    fs::create_directories(root_);
  }
  ~temp_tree() {
    std::error_code ignored;
    fs::remove_all(root_, ignored);
  }
  [[nodiscard]] const fs::path &root() const { return root_; }

private:
  fs::path root_;
};

void write_text(const fs::path &path, const std::string &value) {
  fs::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output)
    throw std::runtime_error("cannot write fixture: " + path.string());
  output << value;
}

std::string sha256(const std::string &value) {
  return storage::compute_content_hash_value(value, storage::CONTENT_HASH_ALGORITHM_SHA256);
}

nlohmann::json member_roots(const std::string &suffix = {}) {
  auto roots = nlohmann::json::object();
  for (const auto *member : {"week-day-contract", "week-day-actions", "week-day-assessment", "week-day-dashboard"}) {
    roots[member] = "sha256:" + sha256(std::string("member:") + member + suffix);
  }
  return roots;
}

std::string fixture_root(const std::string &label) { return "sha256:" + sha256("work-conformance:" + label); }

nlohmann::json work_conformance_declaration() {
  nlohmann::json role_roots = nlohmann::json::object();
  for (const auto *role : {"fact", "episode", "pursuit", "atlas", "warrant"})
    role_roots[role] = fixture_root(std::string("role:") + role);
  nlohmann::json human = nlohmann::json::object();
  for (const auto *field : {"domainIdentity", "legitimateAuthorization", "successMeaning", "privacyBoundary",
                            "evidenceStrength", "consequenceMeaning"})
    human[field] = {{"status", "human-declared"},
                    {"statement", std::string("fixture ") + field},
                    {"authorityRoot", fixture_root(std::string("human:") + field)}};
  nlohmann::json behavior = nlohmann::json::array();
  for (const auto *case_id : {"repeat", "crash", "interrupted", "stale", "warrant-revoked", "provider-switch",
                              "projection-rebuild", "external-effect", "recovery"})
    behavior.push_back({{"case", case_id}, {"status", "passed"}, {"evidenceRoot", fixture_root(case_id)}});
  nlohmann::json platforms = nlohmann::json::array();
  for (const auto *platform : {"cpp", "python", "node", "rust"})
    platforms.push_back({{"platform", platform}, {"status", "passed"}, {"evidenceRoot", fixture_root(platform)}});
  return {
      {"schema", "kungfu.work-profile-conformance-declaration/v1"},
      {"scenarioId", "test"},
      {"bindings",
       {{"actionGeometryRoot", fixture_root("action-geometry")},
        {"domainProfileRoot", fixture_root("domain-profile")},
        {"abstractionAuthorityRoot", fixture_root("work-lifecycle")},
        {"sourceRoot", fixture_root("source")},
        {"roleSchemaRoots", role_roots}}},
      {"humanAuthority", human},
      {"behaviorEvidence", behavior},
      {"platformAdapters", platforms},
      {"buildchain", {{"status", "passed"}, {"evidenceRoot", fixture_root("buildchain")}}},
      {"workOperationModel", {{"authorityRoot", fixture_root("work-api")}}},
  };
}

struct package_fixture {
  fs::path profile_path;
  fs::path mutable_artifact;
};

package_fixture write_package(const fs::path &root, const std::string &version, const std::string &suffix = {},
                              const std::string &profile_id = "example.week-day") {
  const auto conformance_declaration = work_conformance_declaration().dump();
  const std::vector<std::pair<std::string, std::string>> artifacts = {
      {"contracts/world.json", R"({"schema":"example.world/v1"})"},
      {"contracts/week.json", R"({"schema":"example.week/v1"})"},
      {"contracts/day.json", R"({"schema":"example.day/v1"})"},
      {"reducers/current-plan.json", R"({"schema":"example.reducer/v1"})"},
      {"compatibility/v1.json",
       R"({"schema":"kungfu.profile-compatibility/v1","runtimeContracts":["kungfu.profile-lifecycle/v1"]})"},
      {"claims/action-completed.json", R"({"schema":"example.claim/v1"})"},
      {"assessments/action-completed.json", R"({"schema":"example.policy/v1"})"},
      {"actions/registry.json", R"({"schema":"example.actions/v1"})"},
      {"views/registry.json", R"({"schema":"example.views/v1"})"},
      {"migrations/registry.json", R"({"schema":"example.migrations/v1"})"},
      {"permissions.json", R"({"schema":"kungfu.profile-permissions/v1","permissions":["fact.read","fact.write"]})"},
      {"qualification/profile.json",
       R"({"schema":"kungfu.profile-qualification/v1","checks":["content-closure","runtime-contract"]})"},
      {"qualification/work-conformance.json", conformance_declaration},
  };
  std::map<std::string, std::string> hashes;
  for (const auto &[path, base] : artifacts) {
    const auto value = base + (path == "contracts/world.json" ? suffix : "");
    write_text(root / path, value);
    hashes[path] = sha256(value);
  }
  auto ref = [&](const std::string &path) { return nlohmann::json{{"path", path}, {"sha256", hashes.at(path)}}; };
  nlohmann::json document = {
      {"schema", "kungfu.profile-suite/v1"},
      {"id", profile_id},
      {"title", "Week / Day"},
      {"version", version},
      {"members",
       {{"required", {"week-day-contract", "week-day-actions", "week-day-assessment"}},
        {"optional", {"week-day-dashboard"}}}},
      {"kfd1",
       {{"contractWorld", ref("contracts/world.json")},
        {"factSurfaces", {ref("contracts/week.json"), ref("contracts/day.json")}},
        {"reducers", {ref("reducers/current-plan.json")}},
        {"compatibility", ref("compatibility/v1.json")}}},
      {"kfd2",
       {{"claims", {ref("claims/action-completed.json")}},
        {"purposes", {"operator-review", "handoff"}},
        {"policies", {ref("assessments/action-completed.json")}}}},
      {"actions", {{"registry", ref("actions/registry.json")}}},
      {"views", {{"registry", ref("views/registry.json")}}},
      {"migrations", {{"registry", ref("migrations/registry.json")}}},
      {"permissions", {{"registry", ref("permissions.json")}}},
      {"qualification", {{"profile", ref("qualification/profile.json")}}},
      {"work", {{"conformance", ref("qualification/work-conformance.json")}}},
      {"experience", {{"homeView", "week-day-dashboard"}}},
  };
  const auto profile_path = root / "profile.json";
  write_text(profile_path, document.dump(2));
  return {profile_path, root / "contracts" / "world.json"};
}

void rewrite_bound_artifact(const fs::path &profile_path, const std::string &relative, const std::string &value) {
  write_text(profile_path.parent_path() / relative, value);
  std::ifstream input(profile_path);
  auto document = nlohmann::json::parse(input);
  if (relative == "compatibility/v1.json") {
    document["kfd1"]["compatibility"]["sha256"] = sha256(value);
  } else if (relative == "qualification/profile.json") {
    document["qualification"]["profile"]["sha256"] = sha256(value);
  } else if (relative == "actions/registry.json") {
    document["actions"]["registry"]["sha256"] = sha256(value);
  } else {
    throw std::runtime_error("test helper received an unsupported bound artifact");
  }
  write_text(profile_path, document.dump(2));
}

void make_work_capable(const fs::path &profile_path) {
  rewrite_bound_artifact(
      profile_path, "actions/registry.json",
      R"({"schema":"kungfu.profile-actions/v1","actions":[{"id":"claim-completion","runtimeOperation":"episode.append"},{"id":"review-completion","runtimeOperation":"episode.append"},{"id":"decide-continuation","runtimeOperation":"episode.append"}]})");
}

nlohmann::json work_conformance_receipt(const fs::path &profile_path, const std::string &surface) {
  std::ifstream profile_input(profile_path);
  const auto profile = nlohmann::json::parse(profile_input);
  const auto declaration_path =
      profile_path.parent_path() / profile.at("work").at("conformance").at("path").get<std::string>();
  std::ifstream declaration_input(declaration_path);
  const auto declaration = nlohmann::json::parse(declaration_input);
  nlohmann::json checks = nlohmann::json::array();
  const auto add_check = [&checks](const std::string &id, const std::string &status,
                                   const nlohmann::json &evidence_root = nullptr) {
    checks.push_back({{"id", id}, {"status", status}, {"evidenceRoot", evidence_root}});
  };
  const auto &bindings = declaration.at("bindings");
  add_check("exact-action-geometry-root", "passed", bindings.at("actionGeometryRoot"));
  add_check("exact-work-abstraction-authority-root", "passed", bindings.at("abstractionAuthorityRoot"));
  for (const auto *field : {"actionGeometryRoot", "domainProfileRoot", "abstractionAuthorityRoot", "sourceRoot"})
    add_check(std::string("binding-") + field, "passed", bindings.at(field));
  for (const auto *role : {"fact", "episode", "pursuit", "atlas", "warrant"})
    add_check(std::string("binding-role-") + role, "passed", bindings.at("roleSchemaRoots").at(role));
  add_check("responsibility-role-root-separation", "passed");
  add_check("generic-authority-reuse", "passed");
  for (const auto &judgment : declaration.at("humanAuthority").items())
    add_check("human-authority-" + judgment.key(), "declared", judgment.value().at("authorityRoot"));
  for (const auto &evidence : declaration.at("behaviorEvidence"))
    add_check("behavior-" + evidence.at("case").get<std::string>(), evidence.at("status").get<std::string>(),
              evidence.at("evidenceRoot"));
  for (const auto &adapter : declaration.at("platformAdapters"))
    add_check("platform-" + adapter.at("platform").get<std::string>(), adapter.at("status").get<std::string>(),
              adapter.at("evidenceRoot"));
  add_check("buildchain-admission", declaration.at("buildchain").at("status").get<std::string>(),
            declaration.at("buildchain").at("evidenceRoot"));
  add_check("generic-work-operation-model", "passed", declaration.at("workOperationModel").at("authorityRoot"));
  std::sort(checks.begin(), checks.end(), [](const auto &left, const auto &right) {
    return left.at("id").template get<std::string>() < right.at("id").template get<std::string>();
  });
  nlohmann::json stable = {
      {"schema", "kungfu.work-profile-conformance-result/v1"},
      {"scenarioId", "test"},
      {"verdict", "compatible"},
      {"declarationRoot", "sha256:" + sha256(declaration.dump())},
      {"authorityBindings", declaration.at("bindings")},
      {"machineChecks", checks},
      {"humanAuthority", declaration.at("humanAuthority")},
      {"diagnostics", nlohmann::json::array()},
      {"constraints", nlohmann::json::array()},
      {"residualRisk", nlohmann::json::array()},
      {"nonClaims", {"test fixture only"}},
      {"lifecycleMutation", false},
  };
  const auto conformance_root = "sha256:" + sha256(stable.dump());
  stable["conformanceRoot"] = conformance_root;
  stable["surfaceRoots"] = {{"qualify", conformance_root}, {"installed-runtime", conformance_root}};
  stable["publicSurface"] = surface;
  return stable;
}

void attach_kfd3_collaboration(const fs::path &profile_path, const std::string &value) {
  const auto relative = std::string("collaboration/interface.json");
  write_text(profile_path.parent_path() / relative, value);
  std::ifstream input(profile_path);
  auto document = nlohmann::json::parse(input);
  document["kfd3"] = {{"collaboration", {{"path", relative}, {"sha256", sha256(value)}}}};
  write_text(profile_path, document.dump(2));
}

nlohmann::json plan(const fs::path &runtime, const nlohmann::json &request) {
  return profile::plan_profile_lifecycle(runtime.string(), request);
}

nlohmann::json apply(const fs::path &runtime, const nlohmann::json &value, int64_t time) {
  return profile::apply_profile_lifecycle(runtime.string(), value, "auth-test", time);
}

void test_inspection_is_content_bound_and_confined() {
  temp_tree tree;
  const auto fixture = write_package(tree.root() / "package", "1.0.0");
  const auto first = profile::inspect_profile(fixture.profile_path.string(), member_roots());
  const auto second = profile::inspect_profile(fixture.profile_path.string(), member_roots());
  require(first.at("profile_suite_root") == second.at("profile_suite_root"), "Profile root was not deterministic");
  require(first.at("artifacts").size() == 13, "complete Profile content closure was not verified");
  require(first.at("closure").at("source_contract").at("root") ==
              profile::profile_lifecycle_contract().at("source_contract_root"),
          "Profile root did not bind the exact KFX source contract");
  require(first.at("profile").at("experience").at("homeView") == "week-day-dashboard",
          "Profile authority did not preserve the declared home view");
  require_invalid([&] { (void)profile::inspect_profile(fixture.profile_path.string(), nlohmann::json::object()); },
                  "unbound Suite member roots were accepted");
  auto changed_members = member_roots();
  changed_members["week-day-dashboard"] = "sha256:" + sha256("changed-member-root");
  const auto changed = profile::inspect_profile(fixture.profile_path.string(), changed_members);
  require(changed.at("profile_suite_root") != first.at("profile_suite_root"),
          "Profile root ignored member content root drift");

  write_text(fixture.mutable_artifact, "changed");
  require_invalid([&] { (void)profile::inspect_profile(fixture.profile_path.string(), member_roots()); },
                  "artifact hash drift was accepted");

  const auto escape_root = tree.root() / "escape";
  const auto escaped = write_package(escape_root, "1.0.0");
  std::ifstream input(escaped.profile_path);
  auto document = nlohmann::json::parse(input);
  document["kfd1"]["contractWorld"]["path"] = "../outside.json";
  write_text(escaped.profile_path, document.dump(2));
  require_invalid([&] { (void)profile::inspect_profile(escaped.profile_path.string(), member_roots()); },
                  "parent traversal was accepted");

  const auto invalid_experience = write_package(tree.root() / "invalid-experience", "1.0.0");
  std::ifstream invalid_input(invalid_experience.profile_path);
  auto invalid_document = nlohmann::json::parse(invalid_input);
  invalid_document["experience"]["homeView"] = "unrelated-dashboard";
  write_text(invalid_experience.profile_path, invalid_document.dump(2));
  require_invalid([&] { (void)profile::inspect_profile(invalid_experience.profile_path.string(), member_roots()); },
                  "home view outside the Profile Suite was accepted");
}

void test_optional_kfd3_collaboration_is_content_bound() {
  temp_tree tree;
  const auto fixture = write_package(tree.root() / "package", "1.0.0");
  const auto collaboration = R"({"schema":"kungfu.profile-collaboration/v1"})";
  attach_kfd3_collaboration(fixture.profile_path, collaboration);

  const auto inspection = profile::inspect_profile(fixture.profile_path.string(), member_roots());
  require(inspection.at("profile").at("kfd3").at("collaboration").at("path") == "collaboration/interface.json",
          "KFD-3 collaboration authority was not preserved");
  require(inspection.at("artifacts").size() == 14, "KFD-3 collaboration artifact was not in content closure");

  write_text(fixture.profile_path.parent_path() / "collaboration" / "interface.json", "drift");
  require_invalid([&] { (void)profile::inspect_profile(fixture.profile_path.string(), member_roots()); },
                  "KFD-3 collaboration artifact hash drift was accepted");
}

void test_lifecycle_plan_apply_fold_and_history() {
  temp_tree tree;
  const auto runtime = tree.root() / "runtime";
  fs::create_directories(runtime);
  const auto v1 = write_package(tree.root() / "v1", "1.0.0");

  const auto roots_v1 = member_roots("-v1");
  const auto install_plan =
      plan(runtime, {{"action", "install"}, {"profile_path", v1.profile_path.string()}, {"member_roots", roots_v1}});
  require(install_plan.at("effects").at(0).at("kind") == "Installed", "install preview omitted typed effect");
  const auto install_receipt = apply(runtime, install_plan, 100);
  require(install_receipt.at("verified").get<bool>(), "install receipt was not verified");
  require(profile::get_profile(runtime.string(), "example.week-day").at("state") == "installed",
          "installed state did not fold");

  const auto qualify_plan =
      plan(runtime, {{"action", "qualify"}, {"profile_path", v1.profile_path.string()}, {"member_roots", roots_v1}});
  apply(runtime, qualify_plan, 200);
  require(profile::get_profile(runtime.string(), "example.week-day").at("state") == "qualified",
          "qualified state did not fold");

  require_invalid(
      [&] {
        (void)plan(runtime, {{"action", "activate"},
                             {"profile_path", v1.profile_path.string()},
                             {"member_roots", roots_v1},
                             {"granted_permissions", {"host.root"}}});
      },
      "permission broadening was accepted");
  const auto activate_plan = plan(runtime, {{"action", "activate"},
                                            {"profile_path", v1.profile_path.string()},
                                            {"member_roots", roots_v1},
                                            {"granted_permissions", {"fact.read"}}});
  apply(runtime, activate_plan, 300);
  require(profile::get_profile(runtime.string(), "example.week-day").at("state") == "activated",
          "activated state did not fold");

  const auto active_root = profile::get_profile(runtime.string(), "example.week-day").at("profile_suite_root");
  const nlohmann::json kfd3_receipt = {{"schema", "kungfu.profile-kfd3-qualification-receipt/v1"},
                                       {"receiptId", "sha256:kfd3"},
                                       {"profileId", "example.week-day"},
                                       {"profileSuiteRoot", active_root},
                                       {"qualified", true}};
  const auto kfd3_plan = plan(runtime, {{"action", "kfd3-qualify"},
                                        {"profile_path", v1.profile_path.string()},
                                        {"member_roots", roots_v1},
                                        {"qualification", kfd3_receipt}});
  require(kfd3_plan.at("effects").at(0).at("kind") == "Kfd3Qualified",
          "KFD-3 qualification preview omitted its typed effect");
  apply(runtime, kfd3_plan, 325);
  require(profile::get_profile(runtime.string(), "example.week-day").at("kfd3_qualification") == kfd3_receipt,
          "KFD-3 qualification receipt did not fold for the exact root");

  const auto second_profile = write_package(tree.root() / "second", "1.0.0", "-second", "example.task-job");
  apply(runtime,
        plan(runtime, {{"action", "install"},
                       {"profile_path", second_profile.profile_path.string()},
                       {"member_roots", member_roots("-second")}}),
        350);
  require(profile::list_profiles(runtime.string()).at("count") == 2,
          "compatible Profiles did not coexist in one workspace");

  const auto v1_root = profile::get_profile(runtime.string(), "example.week-day").at("profile_suite_root");
  const auto v2 = write_package(tree.root() / "v2", "2.0.0", "-v2");
  const auto roots_v2 = member_roots("-v2");
  const auto upgrade_plan =
      plan(runtime, {{"action", "upgrade"}, {"profile_path", v2.profile_path.string()}, {"member_roots", roots_v2}});
  require(upgrade_plan.at("effects").size() == 2 && upgrade_plan.at("effects").at(0).at("kind") == "Superseded",
          "upgrade did not preview supersession plus installation");
  apply(runtime, upgrade_plan, 400);
  const auto v2_root = profile::get_profile(runtime.string(), "example.week-day").at("profile_suite_root");
  require(v1_root != v2_root, "upgrade did not change the Core-computed root");
  apply(runtime,
        plan(runtime, {{"action", "qualify"}, {"profile_path", v2.profile_path.string()}, {"member_roots", roots_v2}}),
        500);

  const auto rollback_plan =
      plan(runtime, {{"action", "rollback"}, {"profile_id", "example.week-day"}, {"target_root", v1_root}});
  apply(runtime, rollback_plan, 600);
  require(profile::get_profile(runtime.string(), "example.week-day").at("profile_suite_root") == v1_root,
          "rollback did not restore the historical root");
  require(profile::get_profile(runtime.string(), "example.week-day", false, 350).at("profile_suite_root") == v1_root,
          "historical cut changed after upgrade and rollback");

  apply(runtime, plan(runtime, {{"action", "remove"}, {"profile_id", "example.week-day"}}), 700);
  require_invalid([&] { (void)profile::get_profile(runtime.string(), "example.week-day"); },
                  "removed Profile remained in the default current catalog");
  const auto removed = profile::get_profile(runtime.string(), "example.week-day", true);
  require(removed.at("state") == "removed", "removal fact did not fold");
  const auto history = profile::profile_history(runtime.string(), "example.week-day");
  require(history.at("events").size() == 9, "append-only lifecycle history lost facts");
}

void test_stale_plan_and_wrong_runtime_fail_closed() {
  temp_tree tree;
  const auto runtime = tree.root() / "runtime";
  const auto other_runtime = tree.root() / "other-runtime";
  fs::create_directories(runtime);
  fs::create_directories(other_runtime);
  const auto fixture = write_package(tree.root() / "package", "1.0.0");
  const auto install_plan =
      plan(runtime,
           {{"action", "install"}, {"profile_path", fixture.profile_path.string()}, {"member_roots", member_roots()}});
  write_text(fixture.mutable_artifact, "drift-after-preview");
  require_invalid([&] { (void)apply(runtime, install_plan, 100); }, "stale content plan was applied");
  require_invalid([&] { (void)apply(other_runtime, install_plan, 100); }, "plan was applied to another runtime");
  require_invalid([&] { (void)profile::apply_profile_lifecycle(runtime.string(), install_plan, "", 100); },
                  "mutation without authorization was accepted");
}

void test_incompatible_runtime_and_unsupported_qualification_fail_closed() {
  temp_tree tree;
  const auto incompatible_runtime = tree.root() / "incompatible-runtime";
  fs::create_directories(incompatible_runtime);
  const auto incompatible = write_package(tree.root() / "incompatible", "1.0.0");
  rewrite_bound_artifact(
      incompatible.profile_path, "compatibility/v1.json",
      R"({"schema":"kungfu.profile-compatibility/v1","runtimeContracts":["kungfu.profile-lifecycle/v0"]})");
  apply(incompatible_runtime,
        plan(incompatible_runtime, {{"action", "install"},
                                    {"profile_path", incompatible.profile_path.string()},
                                    {"member_roots", member_roots("-incompatible")}}),
        100);
  require_invalid(
      [&] {
        (void)plan(incompatible_runtime, {{"action", "qualify"},
                                          {"profile_path", incompatible.profile_path.string()},
                                          {"member_roots", member_roots("-incompatible")}});
      },
      "incompatible runtime contract was qualified");

  const auto unsupported_runtime = tree.root() / "unsupported-runtime";
  fs::create_directories(unsupported_runtime);
  const auto unsupported = write_package(tree.root() / "unsupported", "1.0.0");
  rewrite_bound_artifact(
      unsupported.profile_path, "qualification/profile.json",
      R"({"schema":"kungfu.profile-qualification/v1","checks":["content-closure","domain-fixtures","runtime-contract"]})");
  apply(unsupported_runtime,
        plan(unsupported_runtime, {{"action", "install"},
                                   {"profile_path", unsupported.profile_path.string()},
                                   {"member_roots", member_roots("-unsupported")}}),
        100);
  require_invalid(
      [&] {
        (void)plan(unsupported_runtime, {{"action", "qualify"},
                                         {"profile_path", unsupported.profile_path.string()},
                                         {"member_roots", member_roots("-unsupported")}});
      },
      "unsupported qualification check was reported as passed");
}

void test_work_capable_profile_requires_native_conformance_receipt() {
  temp_tree tree;
  const auto missing = write_package(tree.root() / "missing", "1.0.0");
  make_work_capable(missing.profile_path);
  {
    std::ifstream input(missing.profile_path);
    auto document = nlohmann::json::parse(input);
    document.erase("work");
    write_text(missing.profile_path, document.dump(2));
  }
  const auto missing_inspection = profile::inspect_profile(missing.profile_path.string(), member_roots());
  require(missing_inspection.at("work_capable").get<bool>(),
          "native inspection did not identify a Work-capable Profile");
  require_invalid(
      [&] {
        (void)plan(
            tree.root() / "missing-runtime",
            {{"action", "qualify"}, {"profile_path", missing.profile_path.string()}, {"member_roots", member_roots()}});
      },
      "native qualification accepted a Work-capable Profile without work.conformance");

  const auto fixture = write_package(tree.root() / "bound", "1.0.0");
  make_work_capable(fixture.profile_path);
  const auto runtime = tree.root() / "runtime";
  fs::create_directories(runtime);
  const auto roots = member_roots("-work");
  apply(
      runtime,
      plan(runtime, {{"action", "install"}, {"profile_path", fixture.profile_path.string()}, {"member_roots", roots}}),
      100);

  require_invalid(
      [&] {
        (void)plan(runtime,
                   {{"action", "qualify"}, {"profile_path", fixture.profile_path.string()}, {"member_roots", roots}});
      },
      "native qualification bypassed the Work conformance result");

  const auto qualify_receipt = work_conformance_receipt(fixture.profile_path, "qualify");
  apply(runtime,
        plan(runtime, {{"action", "qualify"},
                       {"profile_path", fixture.profile_path.string()},
                       {"member_roots", roots},
                       {"work_conformance", qualify_receipt}}),
        200);

  require_invalid(
      [&] {
        (void)plan(runtime,
                   {{"action", "activate"}, {"profile_path", fixture.profile_path.string()}, {"member_roots", roots}});
      },
      "native activation bypassed the Work conformance result");

  auto forged = work_conformance_receipt(fixture.profile_path, "installed-runtime");
  forged["conformanceRoot"] = "sha256:" + sha256("forged");
  forged["surfaceRoots"]["installed-runtime"] = forged["conformanceRoot"];
  require_invalid(
      [&] {
        (void)plan(runtime, {{"action", "activate"},
                             {"profile_path", fixture.profile_path.string()},
                             {"member_roots", roots},
                             {"work_conformance", forged}});
      },
      "native activation accepted a forged Work conformance root");

  auto self_minted = work_conformance_receipt(fixture.profile_path, "installed-runtime");
  self_minted["machineChecks"][0] = {{"id", "self-minted"}, {"status", "passed"}, {"evidenceRoot", nullptr}};
  self_minted.erase("conformanceRoot");
  self_minted.erase("surfaceRoots");
  self_minted.erase("publicSurface");
  const auto self_minted_root = "sha256:" + sha256(self_minted.dump());
  self_minted["conformanceRoot"] = self_minted_root;
  self_minted["surfaceRoots"] = {{"qualify", self_minted_root}, {"installed-runtime", self_minted_root}};
  self_minted["publicSurface"] = "installed-runtime";
  require_invalid(
      [&] {
        (void)plan(runtime, {{"action", "activate"},
                             {"profile_path", fixture.profile_path.string()},
                             {"member_roots", roots},
                             {"work_conformance", self_minted}});
      },
      "native activation accepted a self-minted machine-check set");

  const auto activate_receipt = work_conformance_receipt(fixture.profile_path, "installed-runtime");
  apply(runtime,
        plan(runtime, {{"action", "activate"},
                       {"profile_path", fixture.profile_path.string()},
                       {"member_roots", roots},
                       {"work_conformance", activate_receipt},
                       {"granted_permissions", nlohmann::json::array()}}),
        300);
  require(profile::get_profile(runtime.string(), "example.week-day").at("state") == "activated",
          "Work-capable Profile did not activate with the exact conformance root");
}

int run_tests() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"inspection is deterministic, content-bound, and confined", test_inspection_is_content_bound_and_confined},
      {"optional KFD-3 collaboration is content-bound", test_optional_kfd3_collaboration_is_content_bound},
      {"lifecycle plans, receipts, folds, history, and cuts", test_lifecycle_plan_apply_fold_and_history},
      {"stale and cross-runtime plans fail closed", test_stale_plan_and_wrong_runtime_fail_closed},
      {"runtime and qualification inputs fail closed",
       test_incompatible_runtime_and_unsupported_qualification_fail_closed},
      {"Work-capable native lifecycle requires exact conformance",
       test_work_capable_profile_requires_native_conformance_receipt},
      {"Initiative and Assignment Roots match shared vectors", check_initiative_assignment_root_vectors},
      {"Initiative and Assignment admission survives native restart", check_initiative_assignment_native_admission},
  };
  int failed = 0;
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "ok - " << name << '\n';
    } catch (const std::exception &error) {
      ++failed;
      std::cerr << "not ok - " << name << ": " << error.what() << '\n';
    }
  }
  return failed == 0 ? 0 : 1;
}

} // namespace

int main() { return run_tests(); }
