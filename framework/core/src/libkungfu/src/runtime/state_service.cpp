// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/state_service.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <map>
#include <mutex>
#include <stdexcept>
#include <tuple>
#include <utility>

#include <kungfu/runtime/state_cache/manager.h>
#include <kungfu/runtime/typed_state_projection.h>

namespace kungfu::runtime::state_service {

namespace {

bool valid_sha256_identity(const std::string &value) {
  if (!value.starts_with("sha256:") || value.size() != 71) {
    return false;
  }
  return std::all_of(value.begin() + 7, value.end(),
                     [](unsigned char c) { return std::isdigit(c) != 0 || (c >= 'a' && c <= 'f'); });
}

bool valid_sha256_hex(const std::string &value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
           return std::isdigit(c) != 0 || (c >= 'a' && c <= 'f');
         });
}

bool admit_current_hardware_candidate(durability_candidate_config &candidate, std::string &reason) {
  const auto &capability = durability::single_host_institutional_capability();
  if (candidate.qualification_profile != capability.qualification_profile) {
    reason = "durability_candidate_qualification_profile_mismatch";
    return false;
  }
  if (!capability.admission.current_hardware_candidate_complete ||
      !valid_sha256_hex(capability.admission.evidence_sha256)) {
    reason = "durability_candidate_evidence_incomplete";
    return false;
  }
  if (!valid_sha256_identity(candidate.contract_hash) || !valid_sha256_identity(candidate.policy_digest)) {
    reason = "durability_candidate_policy_identity_invalid";
    return false;
  }
  if (candidate.failure_policy != "fail-closed") {
    reason = "durability_candidate_failure_policy_not_fail_closed";
    return false;
  }
  try {
    const auto profile = durability::parse_durability_profile(candidate.default_profile);
    if (profile == durability::durability_profile::Replicated) {
      reason = "durability_candidate_replicated_profile_unavailable";
      return false;
    }
  } catch (const std::exception &) {
    reason = "durability_candidate_default_profile_invalid";
    return false;
  }
  reason = "admitted_current_hardware_candidate";
  return true;
}

durability::barrier_result unavailable_barrier(uint64_t request_id, durability::durability_profile profile,
                                               const std::string &message) {
  durability::barrier_result result;
  result.receipt.request_id = request_id;
  result.receipt.requested_profile = profile;
  result.receipt.status = durability::receipt_status::Unknown;
  result.receipt.error = durability::durability_error_code::ServiceUnavailable;
  result.error = durability::ingest_error::ServiceUnavailable;
  result.message = message;
  result.status.available = false;
  result.status.last_error = durability::ingest_error::ServiceUnavailable;
  result.status.last_error_message = message;
  return result;
}

durability::receipt_reconciliation_view unavailable_reconciliation(const durability::durability_request &request,
                                                                   const std::string &message) {
  durability::receipt_reconciliation_view result;
  result.request_id = request.request_id;
  result.state = durability::reconciliation_state_name(durability::reconciliation_state::Unknown);
  result.error = durability::durability_error_name(durability::durability_error_code::ServiceUnavailable);
  result.message = message;
  return result;
}

bootstrap_result unavailable_bootstrap(const std::string &message, peer_state_requirement requirement) {
  bootstrap_result result;
  if (requirement == peer_state_requirement::None) {
    result.outcome = bootstrap_outcome::Ready;
    result.message = "peer_declares_no_state_requirement";
    result.status.available = true;
    return result;
  }
  result.outcome =
      requirement == peer_state_requirement::Required ? bootstrap_outcome::Refused : bootstrap_outcome::Degraded;
  result.error = projection_error::ServiceUnavailable;
  result.message = message;
  result.status.available = false;
  result.status.rebuild_state = "unavailable";
  result.status.last_error = projection_error::ServiceUnavailable;
  result.status.last_error_message = message;
  return result;
}

} // namespace

struct service::impl {
  explicit impl(const io_device_ptr &io_device, durability_candidate_config candidate,
                projection_candidate_config projection_candidate)
      : ownership(yijinjing::ownership::lease::acquire_data_root_service(io_device->get_locator()->get_root())),
        manager(io_device), candidate(std::move(candidate)), projection_candidate(std::move(projection_candidate)) {
    if (this->candidate.segment_max_bytes < 1024ULL * 1024ULL ||
        this->candidate.segment_max_bytes > 1024ULL * 1024ULL * 1024ULL || this->candidate.request_timeout_ms == 0 ||
        this->candidate.request_timeout_ms > 600000 || this->candidate.group_max_delay_ms > 1000 ||
        this->candidate.group_max_records == 0 || this->candidate.group_max_records > 65536 ||
        this->candidate.group_max_bytes < 4096 || this->candidate.group_max_bytes > 64ULL * 1024ULL * 1024ULL) {
      throw std::invalid_argument("durability candidate policy limits are invalid");
    }
    if (this->candidate.enabled && !this->candidate.qualification_profile.starts_with("candidate/")) {
      throw std::invalid_argument("durability candidate profile must use candidate/ namespace");
    }
    if (this->candidate.default_profile != "visible") {
      this->candidate.strong_profiles_requested = true;
    }
    const auto &current_capability = durability::single_host_institutional_capability();
    if (this->candidate.enabled && this->candidate.qualification_profile == current_capability.qualification_profile) {
      this->candidate.qualification_passed = admit_current_hardware_candidate(this->candidate, admission_reason);
    } else if (this->candidate.qualification_passed) {
      admission_reason = "admitted_internal_test_fixture";
    } else if (!this->candidate.enabled) {
      admission_reason = "durability_candidate_disabled";
    } else {
      admission_reason = "durability_candidate_not_admitted";
    }
    if (this->candidate.strong_profiles_requested && !this->candidate.enabled) {
      throw std::invalid_argument("strong durability profiles require qualified-candidate activation");
    }
    if (this->candidate.strong_profiles_requested && !this->candidate.qualification_passed) {
      throw std::invalid_argument(admission_reason);
    }
    if (this->projection_candidate.enabled) {
      if (!this->candidate.enabled ||
          this->projection_candidate.qualification_profile != this->candidate.qualification_profile ||
          !this->projection_candidate.qualification_profile.starts_with("candidate/") ||
          this->projection_candidate.stream_id == 0 || this->projection_candidate.container_epoch == 0 ||
          this->projection_candidate.writer_resource_id.empty() || this->projection_candidate.projection_name.empty() ||
          this->projection_candidate.projection_schema.empty()) {
        throw std::invalid_argument("invalid projection candidate configuration");
      }
      if (this->projection_candidate.qualification_passed != this->candidate.qualification_passed) {
        throw std::invalid_argument("projection and durability candidate qualification mismatch");
      }
    }
  }

  void require_write_authority() const {
    if (!ownership.owns()) {
      throw std::logic_error("state_service_ownership_lost");
    }
    if (!manager.running()) {
      throw std::logic_error("state_service_not_running");
    }
  }

  void initialize_projection_candidate() {
    if (!projection_candidate.enabled || projection_candidate_initialized) {
      return;
    }
    require_write_authority();
    durability::ingest_options ingest{};
    ingest.data_root = ownership.status().data_root;
    ingest.stream_id = projection_candidate.stream_id;
    ingest.container_epoch = projection_candidate.container_epoch;
    ingest.writer_resource_id = projection_candidate.writer_resource_id;
    ingest.qualification_profile = projection_candidate.qualification_profile;
    ingest.qualification_passed = projection_candidate.qualification_passed;
    ingest.activation = durability::ingest_activation::ProductionCandidate;
    auto durable = std::make_unique<durability::durable_ingest_log>(std::move(ingest));

    projection_options projection{};
    projection.data_root = ownership.status().data_root;
    projection.stream_id = projection_candidate.stream_id;
    projection.container_epoch = projection_candidate.container_epoch;
    projection.projection_name = projection_candidate.projection_name;
    projection.projection_schema = projection_candidate.projection_schema;
    projection.source_qualification_profile = projection_candidate.qualification_profile;
    auto projected = std::make_unique<projection_bootstrap_store>(std::move(projection), make_typed_state_projector());

    std::lock_guard lock(durable_shadows_mutex);
    const auto durable_key = std::make_pair(projection_candidate.stream_id, projection_candidate.container_epoch);
    const auto projection_key = std::make_tuple(projection_candidate.stream_id, projection_candidate.container_epoch,
                                                projection_candidate.projection_name);
    if (durable_shadows.contains(durable_key) || projection_shadows.contains(projection_key)) {
      throw std::logic_error("projection candidate stream or projection is already open");
    }
    durable_shadows.emplace(durable_key, std::move(durable));
    projection_shadows.emplace(projection_key, std::move(projected));
    projection_candidate_initialized = true;
  }

  yijinjing::ownership::lease ownership;
  state_cache::manager manager;
  durability_candidate_config candidate;
  projection_candidate_config projection_candidate;
  bool projection_candidate_initialized = false;
  std::string admission_reason = "durability_candidate_disabled";
  std::map<std::pair<uint64_t, uint64_t>, std::unique_ptr<durability::durable_ingest_log>> durable_shadows;
  std::map<std::tuple<uint64_t, uint64_t, std::string>, std::unique_ptr<projection_bootstrap_store>> projection_shadows;
  mutable std::mutex durable_shadows_mutex;
};

service::service(const io_device_ptr &io_device, durability_candidate_config candidate,
                 projection_candidate_config projection_candidate)
    : impl_(std::make_unique<impl>(io_device, std::move(candidate), std::move(projection_candidate))) {}

service::~service() { stop(); }

void service::start() {
  impl_->manager.start();
  try {
    impl_->initialize_projection_candidate();
  } catch (...) {
    impl_->manager.stop();
    throw;
  }
}

void service::stop() { impl_->manager.stop(); }

service_status service::status() const {
  service_status result;
  result.ownership = impl_->ownership.status();
  result.running = impl_->manager.running();
  result.durability_candidate_enabled = impl_->candidate.enabled;
  result.durability_candidate_qualified = impl_->candidate.enabled && impl_->candidate.qualification_passed;
  result.durability_qualification_profile = impl_->candidate.qualification_profile;
  result.durability_contract_hash = impl_->candidate.contract_hash;
  result.durability_policy_digest = impl_->candidate.policy_digest;
  result.durability_default_profile = impl_->candidate.default_profile;
  result.durability_admission_reason = impl_->admission_reason;
  result.durability_segment_max_bytes = impl_->candidate.segment_max_bytes;
  result.durability_request_timeout_ms = impl_->candidate.request_timeout_ms;
  result.durability_reconcile_on_timeout = impl_->candidate.reconcile_on_timeout;
  result.durability_failure_policy = impl_->candidate.failure_policy;
  result.durability_group_max_delay_ms = impl_->candidate.group_max_delay_ms;
  result.durability_group_max_records = impl_->candidate.group_max_records;
  result.durability_group_max_bytes = impl_->candidate.group_max_bytes;
  result.projection_candidate_enabled = impl_->projection_candidate.enabled;
  result.projection_candidate_qualified =
      impl_->projection_candidate.enabled && impl_->projection_candidate.qualification_passed;
  result.projection_qualification_profile = impl_->projection_candidate.qualification_profile;
  return result;
}

std::vector<yijinjing::types::Location> service::locations() {
  return impl_->manager.get_all(yijinjing::types::Location{});
}

std::vector<yijinjing::types::Config> service::configs() { return impl_->manager.get_all(yijinjing::types::Config{}); }

void service::record_location(const yijinjing::types::Location &location) {
  impl_->require_write_authority();
  impl_->manager.feed_profile(location);
}

void service::reset_cache_shift(const yijinjing::data::location_ptr &location) {
  impl_->require_write_authority();
  impl_->manager.reset_cache_shift(location);
}

void service::ensure_storage(const yijinjing::data::location_ptr &location, uint32_t dest) {
  impl_->require_write_authority();
  impl_->manager.try_ensure_cached_storage(location, dest);
}

void service::restore(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer) {
  impl_->require_write_authority();
  impl_->manager.restore(location, writer);
}

void service::cache_reset(const event_ptr &event) {
  impl_->require_write_authority();
  impl_->manager.cache_reset(event);
}

void service::pause_projection(bool pause) {
  impl_->require_write_authority();
  impl_->manager.switch_feed_storage(pause);
}

void service::ingest(const event_ptr &event) {
  impl_->require_write_authority();
  impl_->manager.feed(event);
}

void service::open_durable_shadow(durability::ingest_options options) {
  impl_->require_write_authority();
  if (options.activation != durability::ingest_activation::Shadow) {
    throw std::invalid_argument("durable shadow cannot activate production-candidate mode");
  }
  if (std::filesystem::absolute(options.data_root).lexically_normal() !=
      std::filesystem::absolute(impl_->ownership.status().data_root).lexically_normal()) {
    throw std::invalid_argument("durable shadow data root does not match state service ownership");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto key = std::make_pair(options.stream_id, options.container_epoch);
  if (impl_->durable_shadows.contains(key)) {
    throw std::logic_error("durable shadow stream epoch is already open");
  }
  impl_->durable_shadows.emplace(key, std::make_unique<durability::durable_ingest_log>(std::move(options)));
}

void service::append_durable_shadow(const durability::stream_position &position, int32_t carrier_type,
                                    const std::string &payload,
                                    const yijinjing::ownership::evidence &writer_generation) {
  append_durable_shadow(position, carrier_type, durability::durable_frame_context{}, payload, writer_generation);
}

void service::append_durable_shadow(const durability::stream_position &position, int32_t carrier_type,
                                    const durability::durable_frame_context &frame, const std::string &payload,
                                    const yijinjing::ownership::evidence &writer_generation) {
  impl_->require_write_authority();
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({position.stream_id, position.container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durable shadow stream epoch is not open");
  }
  found->second->append(position, carrier_type, frame, payload.data(), payload.size(), impl_->ownership,
                        writer_generation);
}

durability::barrier_result service::barrier_durable_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                           uint64_t request_id, durability::durability_profile profile,
                                                           durability::barrier_options options) {
  if (!impl_->ownership.owns() || !impl_->manager.running()) {
    return unavailable_barrier(request_id, profile, "state_service_not_running_or_fenced");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({stream_id, container_epoch});
  if (found == impl_->durable_shadows.end()) {
    return unavailable_barrier(request_id, profile, "durable_shadow_stream_epoch_not_open");
  }
  return found->second->barrier(request_id, profile, impl_->ownership, options);
}

durability::ingest_status service::durable_shadow_status(uint64_t stream_id, uint64_t container_epoch) const {
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({stream_id, container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durable shadow stream epoch is not open");
  }
  return found->second->status();
}

void service::open_durability_candidate(durability::ingest_options options) {
  impl_->require_write_authority();
  if (!impl_->candidate.enabled) {
    throw std::logic_error("durability production-candidate path is disabled");
  }
  if (!impl_->candidate.qualification_passed) {
    throw std::logic_error("durability production-candidate profile has no matching qualification evidence");
  }
  if (options.qualification_profile != impl_->candidate.qualification_profile) {
    throw std::invalid_argument("durability candidate qualification profile mismatch");
  }
  if (std::filesystem::absolute(options.data_root).lexically_normal() !=
      std::filesystem::absolute(impl_->ownership.status().data_root).lexically_normal()) {
    throw std::invalid_argument("durability candidate data root does not match state service ownership");
  }
  options.activation = durability::ingest_activation::ProductionCandidate;
  options.qualification_passed = true;
  options.segment_max_bytes = impl_->candidate.segment_max_bytes;
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto key = std::make_pair(options.stream_id, options.container_epoch);
  if (impl_->durable_shadows.contains(key)) {
    throw std::logic_error("durability candidate stream epoch is already open");
  }
  impl_->durable_shadows.emplace(key, std::make_unique<durability::durable_ingest_log>(std::move(options)));
}

void service::append_durability_candidate(const durability::stream_position &position, int32_t carrier_type,
                                          const std::string &payload,
                                          const yijinjing::ownership::evidence &writer_generation) {
  append_durability_candidate(position, carrier_type, durability::durable_frame_context{}, payload, writer_generation);
}

void service::append_durability_candidate(const durability::stream_position &position, int32_t carrier_type,
                                          const durability::durable_frame_context &frame, const std::string &payload,
                                          const yijinjing::ownership::evidence &writer_generation) {
  impl_->require_write_authority();
  if (!impl_->candidate.enabled || !impl_->candidate.qualification_passed) {
    throw std::logic_error("durability production-candidate path is not admitted");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({position.stream_id, position.container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durability candidate stream epoch is not open");
  }
  found->second->append(position, carrier_type, frame, payload.data(), payload.size(), impl_->ownership,
                        writer_generation);
}

durability::barrier_result service::request_durability_candidate(const durability::durability_request &request,
                                                                 durability::barrier_options options) {
  if (!impl_->ownership.owns() || !impl_->manager.running() || !impl_->candidate.enabled ||
      !impl_->candidate.qualification_passed) {
    return unavailable_barrier(request.request_id, request.requested_profile,
                               "durability_candidate_not_running_qualified_or_enabled");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({request.position.stream_id, request.position.container_epoch});
  if (found == impl_->durable_shadows.end()) {
    return unavailable_barrier(request.request_id, request.requested_profile,
                               "durability_candidate_stream_epoch_not_open");
  }
  return found->second->barrier(request, impl_->ownership, options);
}

durability::receipt_reconciliation_view
service::reconcile_durability_candidate(const durability::durability_request &request) {
  if (!impl_->ownership.owns() || !impl_->manager.running() || !impl_->candidate.enabled ||
      !impl_->candidate.qualification_passed) {
    return unavailable_reconciliation(request, "durability_candidate_not_running_qualified_or_enabled");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({request.position.stream_id, request.position.container_epoch});
  if (found == impl_->durable_shadows.end()) {
    return unavailable_reconciliation(request, "durability_candidate_stream_epoch_not_open");
  }
  return found->second->reconcile(request);
}

durability::ingest_status service::durability_candidate_status(uint64_t stream_id, uint64_t container_epoch) const {
  if (!impl_->candidate.enabled) {
    throw std::logic_error("durability production-candidate path is disabled");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({stream_id, container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durability candidate stream epoch is not open");
  }
  return found->second->status();
}

void service::open_projection_shadow(projection_options options, durable_projector projector) {
  impl_->require_write_authority();
  if (std::filesystem::absolute(options.data_root).lexically_normal() !=
      std::filesystem::absolute(impl_->ownership.status().data_root).lexically_normal()) {
    throw std::invalid_argument("projection shadow data root does not match state service ownership");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto durable = impl_->durable_shadows.find({options.stream_id, options.container_epoch});
  if (durable == impl_->durable_shadows.end()) {
    throw std::logic_error("projection shadow requires an open durable shadow");
  }
  options.source_qualification_profile = durable->second->status().qualification_profile;
  const auto key = std::make_tuple(options.stream_id, options.container_epoch, options.projection_name);
  if (impl_->projection_shadows.contains(key)) {
    throw std::logic_error("projection shadow is already open");
  }
  impl_->projection_shadows.emplace(
      key, std::make_unique<projection_bootstrap_store>(std::move(options), std::move(projector)));
}

projection_snapshot service::rebuild_projection_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                       const std::string &projection_name,
                                                       std::optional<durability::stream_position> through) {
  impl_->require_write_authority();
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto durable = impl_->durable_shadows.find({stream_id, container_epoch});
  const auto projection = impl_->projection_shadows.find({stream_id, container_epoch, projection_name});
  if (durable == impl_->durable_shadows.end() || projection == impl_->projection_shadows.end()) {
    throw std::logic_error("projection shadow or durable shadow is not open");
  }
  return projection->second->rebuild(durable->second->read_durable_records(), through);
}

bootstrap_result service::bootstrap_projection_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                      const std::string &projection_name,
                                                      peer_state_requirement requirement) {
  if (!impl_->ownership.owns() || !impl_->manager.running()) {
    return unavailable_bootstrap("state_service_not_running_or_fenced", requirement);
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto durable = impl_->durable_shadows.find({stream_id, container_epoch});
  const auto projection = impl_->projection_shadows.find({stream_id, container_epoch, projection_name});
  if (durable == impl_->durable_shadows.end() || projection == impl_->projection_shadows.end()) {
    return unavailable_bootstrap("projection_shadow_or_durable_shadow_not_open", requirement);
  }
  return projection->second->bootstrap(durable->second->read_durable_records(), requirement);
}

projection_status service::projection_shadow_status(uint64_t stream_id, uint64_t container_epoch,
                                                    const std::string &projection_name) const {
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->projection_shadows.find({stream_id, container_epoch, projection_name});
  if (found == impl_->projection_shadows.end()) {
    throw std::logic_error("projection shadow is not open");
  }
  return found->second->status();
}

projection_snapshot service::rebuild_projection_candidate(std::optional<durability::stream_position> through) {
  impl_->require_write_authority();
  if (!impl_->projection_candidate.enabled || !impl_->projection_candidate.qualification_passed) {
    throw std::logic_error("projection production-candidate path is not admitted");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto durable =
      impl_->durable_shadows.find({impl_->projection_candidate.stream_id, impl_->projection_candidate.container_epoch});
  const auto projection = impl_->projection_shadows.find({impl_->projection_candidate.stream_id,
                                                          impl_->projection_candidate.container_epoch,
                                                          impl_->projection_candidate.projection_name});
  if (durable == impl_->durable_shadows.end() || projection == impl_->projection_shadows.end()) {
    throw std::logic_error("projection candidate is not open");
  }
  return projection->second->rebuild(durable->second->read_durable_records(), through);
}

projection_candidate_result
service::bootstrap_projection_candidate(const peer_projection_declaration &declaration,
                                        const std::optional<projection_compatibility_view> &compatibility) {
  if (!declaration.candidate) {
    bootstrap_result compatibility_result;
    compatibility_result.outcome = bootstrap_outcome::Ready;
    compatibility_result.message = "compatibility_restore";
    return make_projection_candidate_result(declaration, std::move(compatibility_result));
  }
  if (declaration.requirement == peer_state_requirement::None) {
    bootstrap_result no_state;
    no_state.outcome = bootstrap_outcome::Ready;
    no_state.message = "peer_declares_no_state_requirement";
    return make_projection_candidate_result(declaration, std::move(no_state));
  }
  if (!impl_->ownership.owns() || !impl_->manager.running() || !impl_->projection_candidate.enabled ||
      !impl_->projection_candidate.qualification_passed ||
      declaration.qualification_profile != impl_->projection_candidate.qualification_profile) {
    auto unavailable = unavailable_bootstrap("projection_candidate_not_running_qualified_enabled_or_matching",
                                             declaration.requirement);
    unavailable.error = projection_error::QualificationMismatch;
    unavailable.status.last_error = projection_error::QualificationMismatch;
    return make_projection_candidate_result(declaration, std::move(unavailable));
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto durable =
      impl_->durable_shadows.find({impl_->projection_candidate.stream_id, impl_->projection_candidate.container_epoch});
  const auto projection = impl_->projection_shadows.find({impl_->projection_candidate.stream_id,
                                                          impl_->projection_candidate.container_epoch,
                                                          impl_->projection_candidate.projection_name});
  if (durable == impl_->durable_shadows.end() || projection == impl_->projection_shadows.end()) {
    return make_projection_candidate_result(
        declaration, unavailable_bootstrap("projection_candidate_not_open", declaration.requirement));
  }
  return make_projection_candidate_result(
      declaration, projection->second->bootstrap(durable->second->read_durable_records(), declaration.requirement),
      compatibility);
}

projection_status service::projection_candidate_status() const {
  if (!impl_->projection_candidate.enabled) {
    throw std::logic_error("projection production-candidate path is disabled");
  }
  return projection_shadow_status(impl_->projection_candidate.stream_id, impl_->projection_candidate.container_epoch,
                                  impl_->projection_candidate.projection_name);
}

} // namespace kungfu::runtime::state_service
