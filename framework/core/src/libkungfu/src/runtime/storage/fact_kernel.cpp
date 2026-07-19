// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/fact_kernel.h>

#include "fact_kernel_internal.h"

namespace kungfu::runtime::storage_service_api {

using namespace fact_kernel_internal;

nlohmann::json fact_kernel_capabilities() { return capabilities_document(); }

nlohmann::json run_fact_kernel_operation(const std::string &runtime_dir, const nlohmann::json &input) {
  if (!input.is_object()) {
    return failure("unknown", "invalid-request", "Fact kernel request must be an object");
  }
  if (input.contains("action") && !input.at("action").is_string()) {
    return failure("unknown", "invalid-field", "action must be a string", {{"field", "action"}});
  }
  const auto action = text_or(input, "action", "capabilities");
  try {
    reject_environment_identity(input);
    switch (resolve_action_route(action)) {
    case action_route::capabilities:
      return capabilities_document();
    case action_route::canonical_root:
      return canonical_root_result(input);
    case action_route::query:
      return query_kernel(runtime_dir, fold_kernel(runtime_dir), input);
    case action_route::authority_export:
      return export_authority(runtime_dir);
    case action_route::authority_import:
      return import_authority(runtime_dir, input);
    case action_route::mutation:
      return execute_mutation(runtime_dir, input);
    case action_route::unknown:
      return failure(action, "invalid-action", "unknown Fact kernel action", {{"requested_action", action}});
    }
  } catch (const fact_request_error &error) {
    return failure(action, error.code(), error.what());
  } catch (const std::invalid_argument &error) {
    return failure(action, "invalid-request", error.what());
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api
