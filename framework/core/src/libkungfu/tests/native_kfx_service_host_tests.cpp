// SPDX-License-Identifier: Apache-2.0

#include <exception>
#include <stdexcept>
#include <string>

#include <kungfu/runtime/kfx/native_contract.h>

namespace kfx = kungfu::runtime::kfx;
using json = nlohmann::json;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
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

} // namespace

void test_native_kfx_service_host_contract() { test_service_host_contract_and_native_validation(); }
