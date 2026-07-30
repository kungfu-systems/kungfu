// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_QUERY_SAVED_QUERY_CATALOG_H
#define KUNGFU_RUNTIME_QUERY_SAVED_QUERY_CATALOG_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::query {

inline constexpr const char *SAVED_QUERY_CATALOG_SCHEMA_V1 = "kungfu.query.saved-query-catalog/v1";
inline constexpr const char *SAVED_QUERY_EVENT_SCHEMA_V1 = "kungfu.query.saved-query-event/v1";

[[nodiscard]] nlohmann::json saved_query_catalog_contract();
[[nodiscard]] nlohmann::json saved_query_put(const std::string &runtime_dir, const nlohmann::json &saved_view,
                                             const std::string &query_id = {}, uint64_t expected_revision = 0,
                                             int64_t system_time = 0);
[[nodiscard]] nlohmann::json saved_query_get(const std::string &runtime_dir, const std::string &query_id,
                                             bool include_deleted = false);
[[nodiscard]] nlohmann::json saved_query_list(const std::string &runtime_dir, bool include_deleted = false);
[[nodiscard]] nlohmann::json saved_query_history(const std::string &runtime_dir, const std::string &query_id);
[[nodiscard]] nlohmann::json saved_query_delete(const std::string &runtime_dir, const std::string &query_id,
                                                uint64_t expected_revision = 0, int64_t system_time = 0);
[[nodiscard]] nlohmann::json saved_query_rebuild(const std::string &runtime_dir);

} // namespace kungfu::runtime::query

#endif // KUNGFU_RUNTIME_QUERY_SAVED_QUERY_CATALOG_H
