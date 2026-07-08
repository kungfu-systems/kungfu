// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_FSCK_H
#define KUNGFU_YIJINJING_STORAGE_FSCK_H

#include <cstdint>
#include <string>
#include <vector>

#include <kungfu/yijinjing/storage/range.h>

namespace kungfu::yijinjing::storage {

enum class fsck_issue_code : uint8_t {
  Unknown,
  MissingPayload,
  HashMismatch,
  MalformedPayload,
  BrokenCausality,
  MissingSchema,
  ProjectionDrift,
  ManifestMismatch,
};

struct fsck_issue {
  issue_severity severity = issue_severity::Info;
  fsck_issue_code code = fsck_issue_code::Unknown;
  std::string code_text = {};
  std::string path = {};
  std::string message = {};
};

struct fsck_options {
  std::string scope = {};
  range_selector range = {};
};

struct fsck_report {
  std::string scope = {};
  verification_status status = verification_status::Ok;
  std::vector<fsck_issue> issues = {};

  [[nodiscard]] bool ok() const { return status == verification_status::Ok && issues.empty(); }
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_FSCK_H
