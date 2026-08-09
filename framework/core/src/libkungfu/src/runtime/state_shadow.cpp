// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/state_shadow.h>

#include <stdexcept>
#include <utility>

#include <fmt/format.h>

namespace kungfu::runtime::state_service {
namespace {

nlohmann::json render_position(const durability::stream_position &position) {
  return {{"stream_id", position.stream_id},
          {"container_epoch", position.container_epoch},
          {"sequence", position.sequence},
          {"frame_uid", position.frame_uid}};
}

durability::stream_position parse_position(const nlohmann::json &value) {
  return {value.at("stream_id").get<uint64_t>(), value.at("container_epoch").get<uint64_t>(),
          value.at("sequence").get<uint64_t>(), value.at("frame_uid").get<uint64_t>()};
}

} // namespace

std::string shadow_comparator::key(const durability::stream_position &position) {
  return fmt::format("{}:{}:{}:{}", position.stream_id, position.container_epoch, position.sequence,
                     position.frame_uid);
}

void shadow_comparator::observe(shadow_lane lane, const durability::stream_position &position,
                                std::string state_digest) {
  auto &entry = observations_[key(position)];
  entry.position = position;
  auto &slot = lane == shadow_lane::Compatibility ? entry.compatibility : entry.split;
  auto &duplicates = lane == shadow_lane::Compatibility ? entry.duplicate_compatibility : entry.duplicate_split;
  if (slot.has_value()) {
    ++duplicates;
  }
  slot = std::move(state_digest);
}

shadow_report shadow_comparator::report() const noexcept {
  shadow_report result;
  for (const auto &[_, entry] : observations_) {
    result.duplicate_compatibility += entry.duplicate_compatibility;
    result.duplicate_split += entry.duplicate_split;
    if (!entry.compatibility.has_value()) {
      ++result.missing_compatibility;
    } else if (!entry.split.has_value()) {
      ++result.missing_split;
    } else if (*entry.compatibility == *entry.split) {
      ++result.equal;
    } else {
      ++result.mismatched;
    }
  }
  return result;
}

nlohmann::json shadow_comparator::snapshot() const {
  nlohmann::json entries = nlohmann::json::array();
  for (const auto &[_, entry] : observations_) {
    nlohmann::json value = {{"position", render_position(entry.position)},
                            {"compatibility", nullptr},
                            {"split", nullptr},
                            {"duplicate_compatibility", entry.duplicate_compatibility},
                            {"duplicate_split", entry.duplicate_split}};
    if (entry.compatibility.has_value()) {
      value["compatibility"] = *entry.compatibility;
    }
    if (entry.split.has_value()) {
      value["split"] = *entry.split;
    }
    entries.push_back(std::move(value));
  }
  return {{"schema", "kungfu.state-shadow/v1"}, {"entries", std::move(entries)}};
}

shadow_comparator shadow_comparator::restore(const nlohmann::json &snapshot) {
  if (snapshot.value("schema", "") != "kungfu.state-shadow/v1") {
    throw std::invalid_argument("unsupported state-shadow snapshot schema");
  }
  shadow_comparator comparator;
  for (const auto &value : snapshot.at("entries")) {
    observation entry;
    entry.position = parse_position(value.at("position"));
    if (!value.at("compatibility").is_null()) {
      entry.compatibility = value.at("compatibility").get<std::string>();
    }
    if (!value.at("split").is_null()) {
      entry.split = value.at("split").get<std::string>();
    }
    entry.duplicate_compatibility = value.value("duplicate_compatibility", uint64_t{0});
    entry.duplicate_split = value.value("duplicate_split", uint64_t{0});
    comparator.observations_.emplace(key(entry.position), std::move(entry));
  }
  return comparator;
}

} // namespace kungfu::runtime::state_service
