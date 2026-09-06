// SPDX-License-Identifier: Apache-2.0

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <stdexcept>
#include <string>

#include <kungfu/runtime/kfx/native_registry.h>

namespace fs = std::filesystem;
namespace kfx = kungfu::runtime::kfx;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
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

fs::path temp_root() {
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::temp_directory_path() / ("kungfu-native-kfx-development-bootstrap-" + std::to_string(nonce));
  fs::create_directories(root);
  return root;
}

fs::path control_suite_source() {
  return fs::weakly_canonical(fs::path(KUNGFU_NATIVE_KFX_TEST_SOURCE_DIR) / ".." / ".." / ".." / ".." / ".." /
                              "extensions" / "system" / "kfx-manager");
}

fs::path copy_development_control_source(const fs::path &home,
                                         const fs::path &control_source = control_suite_source()) {
  const auto source_root = home / "source";
  fs::create_directories(source_root / ".git");
  std::ofstream(source_root / "shifu") << "#!/bin/sh\n";
  fs::create_directories(source_root / "framework" / "kfx");
  std::ofstream(source_root / "framework" / "kfx" / "kungfu-kfx.contract.json") << "{}\n";
  fs::create_directories(source_root / "extensions" / "system");
  const auto candidate = source_root / "extensions" / "system" / "kfx-manager";
  fs::create_directories(candidate);
  fs::copy_file(control_source / "package.json", candidate / "package.json");
  fs::copy_file(control_source / "kungfu.kfx.json", candidate / "kungfu.kfx.json");
  fs::copy(control_source / "src", candidate / "src", fs::copy_options::recursive);
  fs::create_directories(source_root / ".kungfu" / "runtime");
  return source_root;
}

nlohmann::json development_control_request(const fs::path &source_root) {
  return {{"controller", "kungfu-kfx-control-suite"},
          {"packageKey", "kfx-manager"},
          {"operation", "install"},
          {"roots",
           nlohmann::json::array(
               {{{"kind", "product"}, {"path", (source_root / "extensions" / "system" / "kfx-manager").string()}}})},
          {"developmentSourceBootstrap",
           {{"schema", "kungfu.kfx-development-source-bootstrap/v1"},
            {"sourceRoot", source_root.string()},
            {"workspaceRoot", source_root.string()}}},
          {"requestedCapabilities", nlohmann::json::array({"kfxControl"})},
          {"authorizationTime", 100}};
}

nlohmann::json control_mutation(const nlohmann::json &request, const nlohmann::json &plan) {
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
  mutation["actor"] = "development-test";
  mutation["systemTime"] = 100;
  return mutation;
}

} // namespace

void test_development_source_bootstrap_is_local_and_confined() {
  const auto home = temp_root();
  const auto installed_source = copy_development_control_source(home / "installed");
  const auto installed_candidate = installed_source / "extensions" / "system" / "kfx-manager";
  fs::create_directories(installed_candidate / "node_modules");
  fs::create_directory_symlink(installed_candidate, installed_candidate / "node_modules" / "workspace-cycle");
  const auto source_root = copy_development_control_source(home, installed_candidate);
  require(!fs::exists(source_root / "extensions" / "system" / "kfx-manager" / "node_modules"),
          "development fixture copied installed workspace dependencies");
  const auto workspace_root = home / "workspace";
  const auto workspace_git_dir = source_root / ".git" / "worktrees" / "workspace";
  fs::create_directories(workspace_root / ".kungfu" / "runtime");
  fs::create_directories(workspace_git_dir);
  std::ofstream(workspace_root / ".git") << "gitdir: " << workspace_git_dir.string() << '\n';
  std::ofstream(workspace_git_dir / "commondir") << "../..\n";
  const auto runtime_dir = workspace_root / ".kungfu" / "runtime";
  auto request = development_control_request(source_root);
  request.at("developmentSourceBootstrap")["workspaceRoot"] = workspace_root.string();
  const auto plan = kfx::query_native_kfx_registry("plan", request, runtime_dir.string());
  require(plan.at("authority") == "development-source-local-only" &&
              plan.at("mutationAuthorization").at("mode") == "development-source-bootstrap" &&
              plan.at("mutationAuthorization").at("assessment").is_null(),
          "development source bootstrap did not remain local and Passport-free");
  const auto applied = kfx::query_native_kfx_registry("apply", control_mutation(request, plan), runtime_dir.string());
  require(applied.at("verified").get<bool>() && applied.at("status").at("mode") == "active",
          "development source bootstrap did not activate the local Control Suite");

  auto broadened = request;
  broadened.at("requestedCapabilities").push_back("profile");
  require_refusal("KF_KFX_DEVELOPMENT_BOOTSTRAP_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", broadened, runtime_dir.string()); });
  const auto outside_runtime = home / "outside" / "runtime";
  fs::create_directories(outside_runtime);
  require_refusal("KF_KFX_DEVELOPMENT_BOOTSTRAP_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", request, outside_runtime.string()); });
  auto escaped_candidate = request;
  const auto elsewhere = home / "elsewhere";
  fs::copy(source_root / "extensions" / "system" / "kfx-manager", elsewhere, fs::copy_options::recursive);
  escaped_candidate.at("roots").front()["path"] = elsewhere.string();
  require_refusal("KF_KFX_DEVELOPMENT_BOOTSTRAP_FORBIDDEN",
                  [&] { (void)kfx::query_native_kfx_registry("plan", escaped_candidate, runtime_dir.string()); });
  const auto foreign_workspace = home / "foreign-workspace";
  fs::create_directories(foreign_workspace / ".git");
  fs::create_directories(foreign_workspace / ".kungfu" / "runtime");
  auto foreign_request = request;
  foreign_request.at("developmentSourceBootstrap")["workspaceRoot"] = foreign_workspace.string();
  require_refusal("KF_KFX_DEVELOPMENT_BOOTSTRAP_FORBIDDEN", [&] {
    (void)kfx::query_native_kfx_registry("plan", foreign_request, (foreign_workspace / ".kungfu" / "runtime").string());
  });
  fs::remove_all(home);
}
