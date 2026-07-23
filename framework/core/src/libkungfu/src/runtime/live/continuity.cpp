// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/live/continuity.h>

#include <algorithm>
#include <limits>
#include <stdexcept>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::live {
namespace {

constexpr const char *PEER_KEY = "peer_continuity";
constexpr const char *COORDINATOR_KEY = "runtime_continuity";

uint64_t positive_integer(const nlohmann::json &value, const char *field) {
  if (!value.is_string()) {
    throw std::invalid_argument(std::string(field) + " must be a positive integer string");
  }
  const auto &text = value.get_ref<const std::string &>();
  if (text.empty() || text.front() == '0' || !std::all_of(text.begin(), text.end(), [](unsigned char character) {
        return character >= '0' && character <= '9';
      })) {
    throw std::invalid_argument(std::string(field) + " must be a positive integer string");
  }
  std::size_t consumed = 0;
  const auto result = std::stoull(text, &consumed, 10);
  if (consumed != text.size() || result == 0) {
    throw std::invalid_argument(std::string(field) + " must be a positive integer string");
  }
  return result;
}

nlohmann::json authority_json(const coordinator_authority &authority) {
  if (!authority.valid()) {
    throw std::invalid_argument("coordinator authority must contain positive generation and epoch values");
  }
  return {{"schema", PEER_CONTINUITY_SCHEMA},
          {"runtime_generation", std::to_string(authority.runtime_generation)},
          {"coordinator_epoch", std::to_string(authority.coordinator_epoch)}};
}

coordinator_authority parse_authority_object(const nlohmann::json &value) {
  if (!value.is_object() || value.value("schema", "") != PEER_CONTINUITY_SCHEMA) {
    throw std::invalid_argument("runtime continuity authority has an unsupported schema");
  }
  return {positive_integer(value.at("runtime_generation"), "runtime_generation"),
          positive_integer(value.at("coordinator_epoch"), "coordinator_epoch")};
}

int64_t bounded_backoff(uint64_t attempt) {
  const auto shift = std::min<uint64_t>(attempt > 0 ? attempt - 1 : 0, 6);
  return std::min<int64_t>(PEER_RECONNECT_BASE_BACKOFF_NS * (int64_t{1} << shift), PEER_RECONNECT_MAX_BACKOFF_NS);
}

} // namespace

continuity_decision admit_coordinator(const std::optional<coordinator_authority> &observed,
                                      const coordinator_authority &candidate) {
  if (!candidate.valid()) {
    return {continuity_admission::Invalid, "coordinator authority is incomplete"};
  }
  if (!observed.has_value()) {
    return {continuity_admission::Accepted, "initial coordinator authority accepted"};
  }
  if (candidate.runtime_generation < observed->runtime_generation) {
    return {continuity_admission::StaleGeneration, "runtime generation moved backwards"};
  }
  if (candidate.runtime_generation == observed->runtime_generation &&
      candidate.coordinator_epoch <= observed->coordinator_epoch) {
    return {continuity_admission::StaleCoordinator, "coordinator epoch did not advance"};
  }
  return {continuity_admission::Accepted, "coordinator authority advanced"};
}

continuity_decision admit_peer_observation(const peer_continuity_observation &peer,
                                           const coordinator_authority &coordinator) {
  if (!coordinator.valid()) {
    return {continuity_admission::Invalid, "coordinator authority is incomplete"};
  }
  if (!peer.last_authority.has_value()) {
    return {continuity_admission::Accepted, "new peer has no prior coordinator authority"};
  }
  if (peer.last_authority->runtime_generation > coordinator.runtime_generation) {
    return {continuity_admission::FutureGeneration, "peer has observed a newer runtime generation"};
  }
  if (peer.last_authority->runtime_generation == coordinator.runtime_generation &&
      peer.last_authority->coordinator_epoch > coordinator.coordinator_epoch) {
    return {continuity_admission::FutureCoordinator, "peer has observed a newer coordinator epoch"};
  }
  return {continuity_admission::Accepted, "peer observation is compatible"};
}

peer_continuity_observation parse_peer_continuity_observation(const std::string &json_payload) {
  const auto payload = nlohmann::json::parse(json_payload);
  peer_continuity_observation result;
  const auto it = payload.find(PEER_KEY);
  if (it == payload.end()) {
    return result;
  }
  if (!it->is_object() || it->value("schema", "") != PEER_CONTINUITY_SCHEMA) {
    throw std::invalid_argument("peer continuity observation has an unsupported schema");
  }
  result.reconnect_attempt = positive_integer(it->at("reconnect_attempt"), "reconnect_attempt");
  const auto authority = it->find("last_authority");
  if (authority != it->end() && !authority->is_null()) {
    result.last_authority = parse_authority_object(*authority);
  }
  return result;
}

coordinator_authority parse_coordinator_authority(const std::string &json_payload) {
  const auto payload = nlohmann::json::parse(json_payload);
  const auto it = payload.find(COORDINATOR_KEY);
  if (it == payload.end()) {
    throw std::invalid_argument("coordinator registration omitted runtime continuity authority");
  }
  return parse_authority_object(*it);
}

std::string attach_peer_continuity_observation(const std::string &json_payload,
                                               const peer_continuity_observation &observation) {
  auto payload = nlohmann::json::parse(json_payload);
  nlohmann::json value = {{"schema", PEER_CONTINUITY_SCHEMA},
                          {"reconnect_attempt", std::to_string(std::max<uint64_t>(observation.reconnect_attempt, 1))}};
  value["last_authority"] =
      observation.last_authority.has_value() ? authority_json(*observation.last_authority) : nlohmann::json(nullptr);
  payload[PEER_KEY] = std::move(value);
  return payload.dump();
}

std::string attach_coordinator_authority(const std::string &json_payload, const coordinator_authority &authority) {
  auto payload = nlohmann::json::parse(json_payload);
  payload[COORDINATOR_KEY] = authority_json(authority);
  return payload.dump();
}

bool peer_continuity_tracker::retry_due(int64_t now) const {
  return phase_ != peer_continuity_phase::Ready && now >= next_attempt_at_;
}

peer_continuity_observation peer_continuity_tracker::observation() const {
  return {authority_, std::max<uint64_t>(reconnect_attempt_, 1)};
}

void peer_continuity_tracker::disconnect(int64_t now) {
  phase_ = peer_continuity_phase::Disconnected;
  reconnect_attempt_ = 0;
  next_attempt_at_ = now;
}

void peer_continuity_tracker::begin_attempt(int64_t now) {
  if (!retry_due(now)) {
    return;
  }
  phase_ = peer_continuity_phase::Registering;
  ++reconnect_attempt_;
  const auto delay = bounded_backoff(reconnect_attempt_);
  next_attempt_at_ =
      now > std::numeric_limits<int64_t>::max() - delay ? std::numeric_limits<int64_t>::max() : now + delay;
}

continuity_decision peer_continuity_tracker::admit(const coordinator_authority &candidate, int64_t now) {
  const auto decision = admit_coordinator(authority_, candidate);
  if (decision.accepted()) {
    authority_ = candidate;
    phase_ = peer_continuity_phase::Recovering;
    reconnect_attempt_ = 0;
    next_attempt_at_ = now;
  }
  return decision;
}

void peer_continuity_tracker::mark_ready() {
  if (phase_ != peer_continuity_phase::Recovering) {
    throw std::logic_error("peer cannot become ready before continuity admission and bootstrap");
  }
  phase_ = peer_continuity_phase::Ready;
}

} // namespace kungfu::runtime::live
