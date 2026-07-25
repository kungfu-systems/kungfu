// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_WORK_JOURNAL_H
#define KUNGFU_RUNTIME_ACTION_WORK_JOURNAL_H

#include <nlohmann/json.hpp>

#include <string>

namespace kungfu::runtime::action {

inline constexpr const char *WORK_JOURNAL_PROTOCOL_V1 = "kungfu.work-journal/v1";
inline constexpr const char *WORK_RECORD_ROOT_PROTOCOL_V1 = "kungfu.work.record-root/v1";
inline constexpr const char *WORK_JOURNAL_ROOT_PROTOCOL_V1 = "kungfu.work.journal-root/v1";
inline constexpr const char *WORK_ITEM_ROOT_PROTOCOL_V1 = "kungfu.work.item-root/v1";
inline constexpr const char *WORK_REQUEST_ROOT_PROTOCOL_V1 = "kungfu.work.lifecycle-request-root/v1";
inline constexpr const char *WORK_EXPORT_BUNDLE_PROTOCOL_V1 = "kungfu.work.export-bundle/v1";

[[nodiscard]] nlohmann::json work_journal_capabilities();
[[nodiscard]] nlohmann::json run_work_journal_operation(const std::string &runtime_dir, const nlohmann::json &request);
[[nodiscard]] nlohmann::json run_work_lifecycle_operation(const std::string &runtime_dir,
                                                          const std::string &operation_id, const nlohmann::json &input,
                                                          bool execute);

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_WORK_JOURNAL_H
