// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_OWNERSHIP_H
#define KUNGFU_YIJINJING_OWNERSHIP_H

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

namespace kungfu::yijinjing::ownership {

inline constexpr const char *OWNERSHIP_EVIDENCE_SCHEMA_V1 = "kungfu.ownership.evidence/v1";

enum class scope : uint8_t { DataRootService, StreamWriter };

struct evidence {
  std::string schema = OWNERSHIP_EVIDENCE_SCHEMA_V1;
  scope ownership_scope = scope::DataRootService;
  std::string data_root = {};
  std::string resource_id = {};
  uint64_t generation = 0;
  std::string fence_token = {};
  uint64_t owner_pid = 0;
  int64_t acquired_at = 0;
  bool recovered_stale_owner = false;
  bool owned = false;
};

class busy_error : public std::runtime_error {
public:
  explicit busy_error(const std::string &message) : std::runtime_error(message) {}
};

class lease {
public:
  lease() noexcept;
  lease(lease &&other) noexcept;
  lease &operator=(lease &&other) noexcept;
  lease(const lease &) = delete;
  lease &operator=(const lease &) = delete;
  ~lease();

  [[nodiscard]] static lease acquire_data_root_service(const std::string &data_root,
                                                       const std::string &owner_id = "state-service");
  [[nodiscard]] static lease acquire_stream_writer(const std::string &data_root, const std::string &resource_id);

  [[nodiscard]] bool owns() const noexcept;
  [[nodiscard]] const evidence &status() const;

private:
  struct impl;
  explicit lease(std::unique_ptr<impl> impl) noexcept;
  std::unique_ptr<impl> impl_;
};

[[nodiscard]] const char *scope_name(scope value) noexcept;

// Diagnostic attestation for a trusted single-host service. The caller
// supplies the generation/token carried out-of-band with a frame; this probe
// verifies that the matching writer lock is live when the frame is admitted.
// It is not an authentication boundary against a malicious local process.
[[nodiscard]] evidence inspect_active_stream_writer(const std::string &data_root, const std::string &resource_id);

} // namespace kungfu::yijinjing::ownership

#endif // KUNGFU_YIJINJING_OWNERSHIP_H
