// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_CRASH_RECOVERY_H
#define KUNGFU_RUNTIME_CRASH_RECOVERY_H

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/storage/service.h>

namespace kungfu::runtime::recovery {

inline constexpr const char *RECOVERY_REPORT_SCHEMA_V1 = "kungfu.recovery-report/v1";
inline constexpr const char *RECOVERY_BACKUP_SCHEMA_V1 = "kungfu.recovery-backup/v1";
inline constexpr const char *RECOVERY_BACKUP_PACKAGE_SCHEMA_V1 = "kungfu.recovery-backup-package/v1";
inline constexpr const char *RECOVERY_BACKUP_COMPLETE_SCHEMA_V1 = "kungfu.recovery-backup-complete/v1";

enum class recovery_phase : uint8_t { Discover, Verify, Select, Classify, Report };
enum class recovery_outcome : uint8_t { Ready, Degraded, Blocked };
enum class maintenance_status : uint8_t { Completed, AlreadyCompleted, Rejected };
enum class recovery_component : uint8_t { Supervisor, StateService, Projection, Peers };

struct retained_evidence_file {
  std::string name = {};
  uint64_t size = 0;
  std::string sha256 = {};

  friend bool operator==(const retained_evidence_file &, const retained_evidence_file &) = default;
};

struct quarantine_preview {
  std::string schema = "kungfu.recovery-quarantine-preview/v1";
  std::string plan_id = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::optional<durability::stream_position> durable_frontier = std::nullopt;
  uint64_t unacknowledged_tail_bytes = 0;
  durability::tail_integrity unacknowledged_tail_integrity = durability::tail_integrity::None;
  std::string source_digest = {};
  std::vector<retained_evidence_file> files = {};
  bool source_mutation_planned = false;

  friend bool operator==(const quarantine_preview &, const quarantine_preview &) = default;
};

struct maintenance_receipt {
  std::string schema = "kungfu.recovery-maintenance-receipt/v1";
  maintenance_status status = maintenance_status::Rejected;
  std::string plan_id = {};
  std::string package_path = {};
  uint64_t retained_file_count = 0;
  uint64_t retained_bytes = 0;
  bool mutation_performed = false;
  bool source_mutation_performed = false;
  std::string error = {};
};

struct backup_file_material {
  std::string relative_path = {};
  uint64_t size = 0;
  std::string sha256 = {};
  std::string bytes = {};

  friend bool operator==(const backup_file_material &, const backup_file_material &) = default;
};

struct episode_backup_identity {
  uint64_t episode_id = 0;
  bool closed = false;
  std::string content_root_algorithm = {};
  std::string content_root_value = {};
  std::vector<std::string> payload_hashes = {};

  friend bool operator==(const episode_backup_identity &, const episode_backup_identity &) = default;
};

struct recovery_report {
  std::string schema = RECOVERY_REPORT_SCHEMA_V1;
  recovery_outcome outcome = recovery_outcome::Blocked;
  std::vector<recovery_phase> completed_phases = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::optional<durability::stream_position> durable_frontier = std::nullopt;
  uint64_t durable_record_count = 0;
  uint64_t unacknowledged_tail_bytes = 0;
  durability::tail_integrity unacknowledged_tail_integrity = durability::tail_integrity::None;
  durability::ingest_error evidence_error = durability::ingest_error::None;
  std::string evidence_message = {};
  std::string qualification_profile = {};
  bool qualification_passed = false;
  uint64_t episode_unknown_record_count = 0;
  std::vector<storage_service_api::episode_qualification_result> interrupted_episodes = {};
  // Open Episodes and sealed Episodes whose typed qualification is not ok.
  // This keeps cross-Episode dependency damage visible without misnaming a
  // sealed finding as an interrupted Episode.
  std::vector<storage_service_api::episode_qualification_result> episode_findings = {};
  bool mutation_performed = false;
  std::vector<std::string> restart_order = {"supervisor", "state_service", "projection", "peers"};

  friend bool operator==(const recovery_report &, const recovery_report &) = default;
};

struct recovery_backup_bundle {
  std::string schema = RECOVERY_BACKUP_SCHEMA_V1;
  std::string bundle_id = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::optional<durability::stream_position> backup_cut = std::nullopt;
  uint64_t durable_record_count = 0;
  uint64_t lost_visible_tail_bytes = 0;
  std::string rpo_boundary = "through-checkpoint-covered-durable-frontier";
  std::string qualification_profile = {};
  recovery_report source_report = {};
  std::vector<backup_file_material> files = {};
  std::vector<episode_backup_identity> episodes = {};
  bool projection_rebuild_required = true;

  friend bool operator==(const recovery_backup_bundle &, const recovery_backup_bundle &) = default;
};

struct backup_export_result {
  bool ok = false;
  std::optional<recovery_backup_bundle> bundle = std::nullopt;
  std::string error = {};
};

struct backup_package_receipt {
  maintenance_status status = maintenance_status::Rejected;
  std::string bundle_id = {};
  std::string package_path = {};
  std::string manifest_sha256 = {};
  uint64_t file_count = 0;
  uint64_t total_bytes = 0;
  bool mutation_performed = false;
  std::string error = {};
};

struct backup_package_load_result {
  bool ok = false;
  std::optional<recovery_backup_bundle> bundle = std::nullopt;
  std::string package_path = {};
  std::string manifest_sha256 = {};
  std::string error = {};
};

struct backup_package_selection {
  bool ok = false;
  std::optional<recovery_backup_bundle> bundle = std::nullopt;
  std::string package_path = {};
  std::string manifest_sha256 = {};
  std::vector<std::string> rejected_candidates = {};
  bool fallback_used = false;
  std::string error = {};
};

struct restore_receipt {
  std::string schema = "kungfu.recovery-restore-receipt/v1";
  maintenance_status status = maintenance_status::Rejected;
  std::string bundle_id = {};
  std::optional<durability::stream_position> restored_cut = std::nullopt;
  uint64_t restored_file_count = 0;
  uint64_t restored_bytes = 0;
  uint64_t restored_episode_count = 0;
  bool projection_rebuild_required = true;
  bool mutation_performed = false;
  recovery_report restored_report = {};
  std::string receipt_path = {};
  std::string error = {};
};

struct restart_progress {
  bool supervisor_verified = false;
  bool state_service_ready = false;
  bool projection_ready = false;
  bool peers_started = false;
};

struct restart_authorization {
  bool allowed = false;
  recovery_component component = recovery_component::Supervisor;
  std::string reason = {};
};

class recovery_engine {
public:
  explicit recovery_engine(durability::ingest_options options);

  // DISCOVER -> VERIFY -> SELECT -> CLASSIFY -> REPORT. This entry point is
  // read-only and never creates, truncates, renames, or repairs evidence.
  [[nodiscard]] recovery_report inspect() const;

  // Builds a deterministic plan for retaining a degraded tail. Clean and
  // blocked evidence cannot be quarantined by this operation.
  [[nodiscard]] std::optional<quarantine_preview> preview_quarantine() const;

  // Revalidates the complete preview, acquires exclusive local ownership, and
  // publishes a verified evidence package. Source KFDL bytes are never changed.
  [[nodiscard]] maintenance_receipt quarantine(const quarantine_preview &preview) const;

  // Acquires exclusive local ownership, proves a stable READY cut with two
  // identical evidence scans, and exports authoritative bytes plus sealed
  // Episode identities. Ownership, quarantine, and rebuildable projections
  // are intentionally excluded.
  [[nodiscard]] backup_export_result export_consistent_backup() const;

  // Restores a verified bundle only into an empty data root or an exact
  // byte-matching partial restore. The deterministic receipt is published
  // last; projection snapshots are never restored and must be rebuilt.
  [[nodiscard]] restore_receipt restore_backup(const recovery_backup_bundle &bundle) const;

private:
  durability::ingest_options options_;
};

// Materializes a transport-neutral immutable directory. Authoritative bytes
// are written under data/, manifest.json binds their paths/sizes/digests, and
// complete.json is published last before the pending directory is atomically
// renamed. Interrupted pending packages remain inspectable and are never
// accepted as completed backups.
[[nodiscard]] backup_package_receipt publish_backup_package(const recovery_backup_bundle &bundle,
                                                            const std::string &package_path);

// Loads only a complete, exact-file-set package and reconstructs the typed
// bundle after checking its marker, manifest digest, every authoritative byte,
// Episode identity, and bundle identity.
[[nodiscard]] backup_package_load_result load_backup_package(const std::string &package_path);

// Selects the highest verified durable cut for one exact stream/profile
// contract. Invalid or incomplete candidates are retained in the result; an
// older verified package may be returned only with fallback_used=true.
[[nodiscard]] backup_package_selection select_latest_backup_package(const std::string &store_root, uint64_t stream_id,
                                                                    uint64_t container_epoch,
                                                                    const std::string &qualification_profile);

[[nodiscard]] const char *recovery_outcome_name(recovery_outcome outcome) noexcept;
[[nodiscard]] const char *recovery_phase_name(recovery_phase phase) noexcept;
[[nodiscard]] const char *maintenance_status_name(maintenance_status status) noexcept;
[[nodiscard]] const char *recovery_component_name(recovery_component component) noexcept;

// Pure fail-closed gate for the local restart order recorded in the recovery
// report. Callers advance restart_progress only after the named component has
// actually reached its ready condition. Required peers are authorized only by
// a READY report and a verified projection.
[[nodiscard]] restart_authorization authorize_restart(const recovery_report &report, recovery_component component,
                                                      const restart_progress &progress);

} // namespace kungfu::runtime::recovery

#endif // KUNGFU_RUNTIME_CRASH_RECOVERY_H
