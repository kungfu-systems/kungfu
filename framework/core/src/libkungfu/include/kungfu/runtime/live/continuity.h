// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_LIVE_CONTINUITY_H
#define KUNGFU_RUNTIME_LIVE_CONTINUITY_H

#include <cstdint>
#include <optional>
#include <string>

namespace kungfu::runtime::live {

inline constexpr const char *PEER_CONTINUITY_SCHEMA = "kungfu.runtime.peer-continuity/v1";
inline constexpr int64_t PEER_RECONNECT_BASE_BACKOFF_NS = 100'000'000;
inline constexpr int64_t PEER_RECONNECT_MAX_BACKOFF_NS = 5'000'000'000;
inline constexpr int64_t COORDINATOR_HEARTBEAT_INTERVAL_NS = 1'000'000'000;
inline constexpr int64_t COORDINATOR_HEARTBEAT_TIMEOUT_NS = 3'000'000'000;

struct coordinator_authority {
  uint64_t runtime_generation = 0;
  uint64_t coordinator_epoch = 0;

  [[nodiscard]] bool valid() const { return runtime_generation > 0 && coordinator_epoch > 0; }
};

struct peer_continuity_observation {
  std::optional<coordinator_authority> last_authority;
  uint64_t reconnect_attempt = 0;
};

enum class continuity_admission {
  Accepted,
  Invalid,
  StaleGeneration,
  StaleCoordinator,
  FutureGeneration,
  FutureCoordinator,
};

enum class peer_continuity_phase {
  Disconnected,
  Registering,
  Recovering,
  Ready,
};

struct continuity_decision {
  continuity_admission admission = continuity_admission::Invalid;
  std::string reason;

  [[nodiscard]] bool accepted() const { return admission == continuity_admission::Accepted; }
};

[[nodiscard]] continuity_decision admit_coordinator(const std::optional<coordinator_authority> &observed,
                                                    const coordinator_authority &candidate);

[[nodiscard]] continuity_decision admit_peer_observation(const peer_continuity_observation &peer,
                                                         const coordinator_authority &coordinator);

[[nodiscard]] peer_continuity_observation parse_peer_continuity_observation(const std::string &json_payload);

[[nodiscard]] coordinator_authority parse_coordinator_authority(const std::string &json_payload);

[[nodiscard]] std::string attach_peer_continuity_observation(const std::string &json_payload,
                                                             const peer_continuity_observation &observation);

[[nodiscard]] std::string attach_coordinator_authority(const std::string &json_payload,
                                                       const coordinator_authority &authority);

class peer_continuity_tracker {
public:
  [[nodiscard]] peer_continuity_phase phase() const { return phase_; }
  [[nodiscard]] const std::optional<coordinator_authority> &authority() const { return authority_; }
  [[nodiscard]] uint64_t reconnect_attempt() const { return reconnect_attempt_; }
  [[nodiscard]] int64_t next_attempt_at() const { return next_attempt_at_; }
  [[nodiscard]] bool retry_due(int64_t now) const;
  [[nodiscard]] peer_continuity_observation observation() const;

  void disconnect(int64_t now);
  void begin_attempt(int64_t now);
  [[nodiscard]] continuity_decision admit(const coordinator_authority &candidate, int64_t now);
  void mark_ready();

private:
  peer_continuity_phase phase_ = peer_continuity_phase::Disconnected;
  std::optional<coordinator_authority> authority_;
  uint64_t reconnect_attempt_ = 0;
  int64_t next_attempt_at_ = 0;
};

} // namespace kungfu::runtime::live

#endif // KUNGFU_RUNTIME_LIVE_CONTINUITY_H
