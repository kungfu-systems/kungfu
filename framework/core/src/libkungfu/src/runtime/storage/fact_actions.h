// SPDX-License-Identifier: Apache-2.0
#pragma once

#include "fact_domain.h"

#include <string>
#include <variant>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

struct kernel_state;

using mutation_record =
    std::variant<kungfu::yijinjing::types::FactObjectRecorded, kungfu::yijinjing::types::FactVersionRecorded,
                 kungfu::yijinjing::types::FactRelationAdded, kungfu::yijinjing::types::FactRelationRevoked,
                 kungfu::yijinjing::types::FactCutCommitted, kungfu::yijinjing::types::FactRefTransition>;

struct action_failure {
  std::string code;
  std::string message;
  nlohmann::json details = nlohmann::json::object();
};

struct mutation_noop {
  std::string status;
  mutation_result result;
};

struct mutation_commit {
  std::string record_root;
  mutation_result result;
  mutation_record record;
};

using parsed_mutation = std::variant<mutation_request, action_failure>;
using mutation_outcome = std::variant<mutation_noop, mutation_commit, action_failure>;

std::string action_name(const mutation_request &request);
parsed_mutation parse_mutation_request(const nlohmann::json &input, const std::string &action);
mutation_outcome handle_mutation(const std::string &runtime_dir, const kernel_state &state,
                                 const mutation_request &request, const std::string &root_protocol);
nlohmann::json result_json(const mutation_result &result);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
