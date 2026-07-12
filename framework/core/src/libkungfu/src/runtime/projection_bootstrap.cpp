// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/projection_bootstrap.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/storage/content_hash.h>

#ifdef _WIN32
#include <windows.h>
#endif

namespace kungfu::runtime::state_service {
namespace {

namespace fs = std::filesystem;
using durability::compare_positions;
using durability::durable_record;
using durability::position_order;
using durability::stream_position;
using yijinjing::storage::compute_content_hash_value;

constexpr std::array<char, 8> SNAPSHOT_MAGIC{'K', 'F', 'P', 'R', 'O', 'J', '0', '1'};
constexpr uint32_t FORMAT_VERSION = 1;

void append_u32(std::string &out, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    out.push_back(static_cast<char>((value >> shift) & 0xffU));
  }
}

void append_u64(std::string &out, uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) {
    out.push_back(static_cast<char>((value >> shift) & 0xffU));
  }
}

uint32_t read_u32(const std::string &bytes, size_t &offset) {
  if (offset + 4 > bytes.size()) {
    throw std::runtime_error("projection_snapshot_truncated");
  }
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(static_cast<unsigned char>(bytes[offset++])) << shift;
  }
  return value;
}

uint64_t read_u64(const std::string &bytes, size_t &offset) {
  if (offset + 8 > bytes.size()) {
    throw std::runtime_error("projection_snapshot_truncated");
  }
  uint64_t value = 0;
  for (unsigned shift = 0; shift < 64; shift += 8) {
    value |= static_cast<uint64_t>(static_cast<unsigned char>(bytes[offset++])) << shift;
  }
  return value;
}

void append_string(std::string &out, const std::string &value) {
  if (value.size() > std::numeric_limits<uint32_t>::max()) {
    throw std::invalid_argument("projection_snapshot_string_too_large");
  }
  append_u32(out, static_cast<uint32_t>(value.size()));
  out.append(value);
}

std::string read_string(const std::string &bytes, size_t &offset) {
  const auto size = read_u32(bytes, offset);
  if (offset + size > bytes.size()) {
    throw std::runtime_error("projection_snapshot_truncated");
  }
  auto result = bytes.substr(offset, size);
  offset += size;
  return result;
}

std::string normalized_component(const std::string &value, const char *name) {
  if (value.empty() || value == "." || value == ".." || value.find('/') != std::string::npos ||
      value.find('\\') != std::string::npos) {
    throw std::invalid_argument(std::string("invalid_") + name);
  }
  return value;
}

std::string encode_snapshot_body(const projection_snapshot &snapshot) {
  std::string body;
  body.append(SNAPSHOT_MAGIC.data(), SNAPSHOT_MAGIC.size());
  append_u32(body, FORMAT_VERSION);
  append_string(body, snapshot.schema);
  append_string(body, snapshot.projection_name);
  append_string(body, snapshot.projection_schema);
  append_string(body, snapshot.source_qualification_profile);
  append_u64(body, snapshot.through_position.stream_id);
  append_u64(body, snapshot.through_position.container_epoch);
  append_u64(body, snapshot.through_position.sequence);
  append_u64(body, snapshot.through_position.frame_uid);
  append_u64(body, snapshot.state.size());
  for (const auto &[key, value] : snapshot.state) {
    append_string(body, key);
    append_string(body, value);
  }
  return body;
}

projection_snapshot decode_snapshot(const std::string &bytes) {
  if (bytes.size() < SNAPSHOT_MAGIC.size() + 4 + 64 ||
      !std::equal(SNAPSHOT_MAGIC.begin(), SNAPSHOT_MAGIC.end(), bytes.begin())) {
    throw std::runtime_error("projection_snapshot_magic_mismatch");
  }
  const auto body_size = bytes.size() - 64;
  const auto body = bytes.substr(0, body_size);
  const auto stored_hash = bytes.substr(body_size);
  if (compute_content_hash_value(body) != stored_hash) {
    throw std::runtime_error("projection_snapshot_integrity_mismatch");
  }
  size_t offset = SNAPSHOT_MAGIC.size();
  if (read_u32(body, offset) != FORMAT_VERSION) {
    throw std::runtime_error("projection_snapshot_version_mismatch");
  }
  projection_snapshot snapshot;
  snapshot.schema = read_string(body, offset);
  snapshot.projection_name = read_string(body, offset);
  snapshot.projection_schema = read_string(body, offset);
  snapshot.source_qualification_profile = read_string(body, offset);
  snapshot.through_position.stream_id = read_u64(body, offset);
  snapshot.through_position.container_epoch = read_u64(body, offset);
  snapshot.through_position.sequence = read_u64(body, offset);
  snapshot.through_position.frame_uid = read_u64(body, offset);
  const auto state_size = read_u64(body, offset);
  for (uint64_t index = 0; index < state_size; ++index) {
    auto key = read_string(body, offset);
    auto value = read_string(body, offset);
    if (!snapshot.state.emplace(std::move(key), std::move(value)).second) {
      throw std::runtime_error("projection_snapshot_duplicate_key");
    }
  }
  if (offset != body.size()) {
    throw std::runtime_error("projection_snapshot_trailing_bytes");
  }
  snapshot.integrity_sha256 = stored_hash;
  return snapshot;
}

void validate_record_chain(const std::vector<durable_record> &records, uint64_t stream_id, uint64_t epoch) {
  std::optional<stream_position> previous;
  for (const auto &record : records) {
    const auto &position = record.position;
    if (position.stream_id != stream_id || position.container_epoch != epoch) {
      throw std::invalid_argument("projection_record_stream_epoch_mismatch");
    }
    if (previous.has_value()) {
      if (position.sequence != previous->sequence + 1) {
        throw std::invalid_argument("projection_record_position_gap");
      }
      if (compare_positions(*previous, position) != position_order::Before) {
        throw std::invalid_argument("projection_record_order_mismatch");
      }
    }
    previous = position;
  }
}

void replace_snapshot(const fs::path &temp_path, const fs::path &target_path) {
#ifdef _WIN32
  if (MoveFileExW(temp_path.wstring().c_str(), target_path.wstring().c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "replace projection snapshot");
  }
#else
  std::error_code error;
  fs::rename(temp_path, target_path, error);
  if (error) {
    throw std::system_error(error, "replace projection snapshot");
  }
#endif
}

projection_error classify_snapshot_error(const std::string &message) {
  if (message == "projection_record_stream_epoch_mismatch" || message == "projection_snapshot_position_mismatch" ||
      message == "projection_snapshot_cut_not_in_durable_chain") {
    return projection_error::PositionMismatch;
  }
  if (message == "projection_record_position_gap" || message == "projection_record_order_mismatch" ||
      message == "projection_replay_position_gap") {
    return projection_error::PositionGap;
  }
  if (message == "projection_projector_failed") {
    return projection_error::ProjectorFailed;
  }
  if (message == "projection_snapshot_missing" || message == "projection_durable_chain_missing") {
    return projection_error::SnapshotMissing;
  }
  if (message == "projection_snapshot_schema_mismatch" || message == "projection_snapshot_version_mismatch") {
    return projection_error::SchemaMismatch;
  }
  return projection_error::SnapshotCorrupt;
}

} // namespace

struct projection_bootstrap_store::impl {
  impl(projection_options options, durable_projector projector)
      : options(std::move(options)), projector(std::move(projector)) {
    if (this->options.data_root.empty() || this->options.stream_id == 0 || this->options.container_epoch == 0 ||
        this->options.source_qualification_profile.empty() || !this->projector) {
      throw std::invalid_argument("invalid_projection_bootstrap_options");
    }
    this->options.data_root = fs::absolute(this->options.data_root).lexically_normal().string();
    this->options.projection_name = normalized_component(this->options.projection_name, "projection_name");
    this->options.projection_schema = normalized_component(this->options.projection_schema, "projection_schema");
  }

  fs::path path() const {
    return fs::path(options.data_root) / ".kungfu" / "durability" / "projections" /
           (options.projection_name + "-s" + std::to_string(options.stream_id) + "-e" +
            std::to_string(options.container_epoch) + ".kfproj");
  }

  void apply(std::map<std::string, std::string> &state, const durable_record &record) const {
    const auto mutation = projector(record);
    if (!mutation.has_value()) {
      return;
    }
    if (mutation->key.empty()) {
      throw std::invalid_argument("projection_mutation_key_empty");
    }
    if (mutation->erase) {
      state.erase(mutation->key);
    } else {
      state.insert_or_assign(mutation->key, mutation->value);
    }
  }

  projection_snapshot load_unlocked() const {
    std::ifstream input(path(), std::ios::binary);
    if (!input) {
      throw std::runtime_error("projection_snapshot_missing");
    }
    const std::string bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    auto snapshot = decode_snapshot(bytes);
    if (snapshot.schema != PROJECTION_SNAPSHOT_SCHEMA_V1 || snapshot.projection_name != options.projection_name ||
        snapshot.projection_schema != options.projection_schema ||
        snapshot.source_qualification_profile != options.source_qualification_profile) {
      throw std::runtime_error("projection_snapshot_schema_mismatch");
    }
    if (snapshot.through_position.stream_id != options.stream_id ||
        snapshot.through_position.container_epoch != options.container_epoch) {
      throw std::runtime_error("projection_snapshot_position_mismatch");
    }
    return snapshot;
  }

  projection_options options;
  durable_projector projector;
  mutable std::mutex mutex;
  projection_status current_status;
};

projection_bootstrap_store::projection_bootstrap_store(projection_options options, durable_projector projector)
    : impl_(std::make_unique<impl>(std::move(options), std::move(projector))) {}

projection_bootstrap_store::~projection_bootstrap_store() = default;

projection_snapshot projection_bootstrap_store::rebuild(const std::vector<durable_record> &records,
                                                        std::optional<stream_position> through) {
  std::lock_guard lock(impl_->mutex);
  validate_record_chain(records, impl_->options.stream_id, impl_->options.container_epoch);
  if (records.empty()) {
    throw std::invalid_argument("projection_rebuild_requires_durable_records");
  }
  const auto target = through.value_or(records.back().position);
  if (target.stream_id != impl_->options.stream_id || target.container_epoch != impl_->options.container_epoch) {
    throw std::invalid_argument("projection_rebuild_cut_mismatch");
  }
  projection_snapshot snapshot;
  snapshot.projection_name = impl_->options.projection_name;
  snapshot.projection_schema = impl_->options.projection_schema;
  snapshot.source_qualification_profile = impl_->options.source_qualification_profile;
  bool found_target = false;
  try {
    for (const auto &record : records) {
      const auto order = compare_positions(record.position, target);
      if (order == position_order::Unordered) {
        throw std::invalid_argument("projection_rebuild_cut_unordered");
      }
      if (order == position_order::After) {
        break;
      }
      impl_->apply(snapshot.state, record);
      snapshot.through_position = record.position;
      found_target = order == position_order::Equal;
    }
  } catch (...) {
    impl_->current_status.rebuild_state = "failed";
    impl_->current_status.last_error = projection_error::ProjectorFailed;
    impl_->current_status.last_error_message = "projection_projector_failed";
    throw;
  }
  if (!found_target) {
    throw std::invalid_argument("projection_rebuild_cut_not_in_durable_chain");
  }
  const auto body = encode_snapshot_body(snapshot);
  snapshot.integrity_sha256 = compute_content_hash_value(body);
  const auto target_path = impl_->path();
  fs::create_directories(target_path.parent_path());
  const auto temp_path = target_path.string() + ".tmp";
  {
    std::ofstream output(temp_path, std::ios::binary | std::ios::trunc);
    if (!output) {
      throw std::runtime_error("projection_snapshot_temp_open_failed");
    }
    output.write(body.data(), static_cast<std::streamsize>(body.size()));
    output.write(snapshot.integrity_sha256.data(), static_cast<std::streamsize>(snapshot.integrity_sha256.size()));
    output.flush();
    if (!output) {
      throw std::runtime_error("projection_snapshot_write_failed");
    }
  }
  replace_snapshot(temp_path, target_path);
  impl_->current_status.available = true;
  impl_->current_status.snapshot_present = true;
  impl_->current_status.rebuild_state = "complete";
  impl_->current_status.durable_watermark = records.back().position;
  impl_->current_status.projection_watermark = target;
  impl_->current_status.lag_records = records.back().position.sequence - target.sequence;
  impl_->current_status.last_error = projection_error::None;
  impl_->current_status.last_error_message.clear();
  return snapshot;
}

projection_snapshot projection_bootstrap_store::load_snapshot() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->load_unlocked();
}

bootstrap_result projection_bootstrap_store::bootstrap(const std::vector<durable_record> &records,
                                                       peer_state_requirement requirement) {
  std::lock_guard lock(impl_->mutex);
  bootstrap_result result;
  if (requirement == peer_state_requirement::None) {
    result.outcome = bootstrap_outcome::Ready;
    result.message = "peer_declares_no_state_requirement";
    result.status = impl_->current_status;
    return result;
  }
  try {
    validate_record_chain(records, impl_->options.stream_id, impl_->options.container_epoch);
    auto snapshot = impl_->load_unlocked();
    if (records.empty()) {
      throw std::runtime_error("projection_durable_chain_missing");
    }
    const auto snapshot_it = std::find_if(records.begin(), records.end(), [&](const auto &record) {
      return record.position == snapshot.through_position;
    });
    if (snapshot_it == records.end()) {
      throw std::runtime_error("projection_snapshot_cut_not_in_durable_chain");
    }
    result.state = snapshot.state;
    result.snapshot_through = snapshot.through_position;
    auto previous = snapshot.through_position;
    for (auto iterator = std::next(snapshot_it); iterator != records.end(); ++iterator) {
      if (iterator->position.sequence != previous.sequence + 1) {
        throw std::runtime_error("projection_replay_position_gap");
      }
      try {
        impl_->apply(result.state, *iterator);
      } catch (...) {
        throw std::runtime_error("projection_projector_failed");
      }
      previous = iterator->position;
      result.replay_through = iterator->position;
      ++result.replayed_records;
    }
    const auto projection_watermark = result.replay_through.value_or(snapshot.through_position);
    result.outcome = bootstrap_outcome::Ready;
    result.message = "snapshot_through_t_plus_replay_after_t";
    impl_->current_status.snapshot_present = true;
    impl_->current_status.available = true;
    impl_->current_status.rebuild_state = "ready";
    impl_->current_status.durable_watermark = records.back().position;
    impl_->current_status.projection_watermark = projection_watermark;
    impl_->current_status.lag_records = records.back().position.sequence - projection_watermark.sequence;
    impl_->current_status.last_error = projection_error::None;
    impl_->current_status.last_error_message.clear();
  } catch (const std::exception &error) {
    impl_->current_status.snapshot_present = fs::exists(impl_->path());
    impl_->current_status.available = false;
    impl_->current_status.rebuild_state = "unavailable";
    impl_->current_status.last_error = classify_snapshot_error(error.what());
    impl_->current_status.last_error_message = error.what();
    result.outcome =
        requirement == peer_state_requirement::Required ? bootstrap_outcome::Refused : bootstrap_outcome::Degraded;
    result.error = impl_->current_status.last_error;
    result.message = error.what();
  }
  result.status = impl_->current_status;
  return result;
}

projection_status projection_bootstrap_store::status() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->current_status;
}

std::string projection_bootstrap_store::snapshot_path() const { return impl_->path().string(); }

const char *projection_error_name(projection_error error) noexcept {
  switch (error) {
  case projection_error::None:
    return "none";
  case projection_error::InvalidArgument:
    return "invalid_argument";
  case projection_error::ServiceUnavailable:
    return "service_unavailable";
  case projection_error::SnapshotMissing:
    return "snapshot_missing";
  case projection_error::SnapshotCorrupt:
    return "snapshot_corrupt";
  case projection_error::SchemaMismatch:
    return "schema_mismatch";
  case projection_error::PositionMismatch:
    return "position_mismatch";
  case projection_error::PositionGap:
    return "position_gap";
  case projection_error::ProjectorFailed:
    return "projector_failed";
  case projection_error::IoError:
    return "io_error";
  }
  return "unknown";
}

const char *bootstrap_outcome_name(bootstrap_outcome outcome) noexcept {
  switch (outcome) {
  case bootstrap_outcome::Ready:
    return "ready";
  case bootstrap_outcome::Degraded:
    return "degraded";
  case bootstrap_outcome::Refused:
    return "refused";
  }
  return "unknown";
}

} // namespace kungfu::runtime::state_service
