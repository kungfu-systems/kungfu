// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>

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

void test_contract_is_versioned_and_core_owned() {
  const auto first = kfx::native_kfx_contract();
  const auto second = kfx::native_kfx_contract();
  require(first.at("schema") == kfx::NATIVE_KFX_CONTRACT_V2, "native contract schema drifted");
  require(first.at("contractVersion") == 2, "native contract version drifted");
  require(first.at("versionNegotiation").at("supported") == nlohmann::json::array({1, 2}),
          "native contract stopped accepting frozen v1 documents");
  require(first.at("sourceContractVersion") == 7, "native contract did not expose its source compatibility version");
  require(first.at("runtimeTiers") != first.at("admissionGrades"),
          "runtime tier and admission grade were collapsed into one authority field");
  require(first.at("authority").at("owner") == "libkungfu", "native contract did not assign Core authority");
  require(first.at("authority").at("profileLifecycle") == "existing-kungfu.profile-lifecycle/v1",
          "native seam created a parallel Profile lifecycle");
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

} // namespace

int main() {
  try {
    test_contract_is_versioned_and_core_owned();
    test_positive_and_negative_fixtures();
    test_manifest_normalization_uses_the_embedded_source_contract();
    test_service_interface_routes_only_validated_requests();
    test_registry_produces_one_deterministic_cross_surface_plan();
    test_registry_negative_and_concurrent_reads();
    std::cout << "native KFX contract tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "native KFX contract tests failed: " << error.what() << '\n';
    return 1;
  }
}
