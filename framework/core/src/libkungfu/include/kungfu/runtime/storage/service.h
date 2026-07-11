// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SERVICE_H
#define KUNGFU_RUNTIME_STORAGE_SERVICE_H

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/runtime/storage/projection_types.h>
#include <kungfu/yijinjing/storage/episode_manifest_types.h>
#include <kungfu/yijinjing/storage/manifest_catalog_types.h>
#include <kungfu/yijinjing/storage/source_registry_types.h>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *RUNTIME_STORAGE_SERVICE_SCHEMA_V1 = "kungfu.runtime.storage-service/v1";
inline constexpr const char *RUNTIME_STORAGE_SERVICE_OWNER = "libkungfu";

enum class storage_query_kind {
  Sources,
  Manifests,
  Entries,
  Episodes,
  EpisodeRecords,
  EpisodeFrames,
  EpisodeRefs,
};

struct storage_time_range {
  std::string since = {};
  std::string until = {};
};

struct storage_query_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string source_id = {};
  std::string entry_kind = {};
  storage_time_range range = {};
  storage_query_kind query = storage_query_kind::Entries;
  uint64_t episode_id = 0;
  uint64_t limit = 100;
};

struct storage_sync_root_view {
  std::string algorithm = {};
  std::string value = {};
};

struct storage_source_query_row {
  uint64_t source_uid = 0;
  std::string source_id = {};
  std::string source_type = {};
  std::string coordinate = {};
  std::string manifest_id = {};
  std::string source_head = {};
  int64_t accept_time = 0;
  uint64_t entry_count = 0;
  storage_sync_root_view sync_root = {};
  uint64_t manifest_count = 0;
  uint64_t export_count = 0;
};

struct storage_manifest_query_row {
  std::string source_id = {};
  std::string manifest_id = {};
  int64_t accept_time = 0;
  uint64_t entry_count = 0;
  std::string entries_hash = {};
  storage_sync_root_view sync_root = {};
  std::string status = {};
};

struct storage_entry_query_row {
  std::string kind = {};
  std::string source_id = {};
  std::string source_path = {};
  std::string source_time = {};
  uint32_t schema_version = 0;
  std::string content_type = {};
  std::string payload_hash = {};
  uint64_t byte_len = 0;
  std::string payload_state = {};
  uint64_t entry_index = 0;
  int64_t accept_time = 0;
  std::string storage_source_id = {};
  std::string manifest_id = {};
};

struct storage_query_error {
  std::string code = {};
  std::optional<uint64_t> episode_id = {};
};

using storage_query_rows =
    std::variant<std::vector<storage_source_query_row>, std::vector<storage_manifest_query_row>,
                 std::vector<storage_entry_query_row>, std::vector<yijinjing::storage::episode_current_view>,
                 std::vector<yijinjing::storage::episode_manifest_record>>;

struct storage_query_result {
  bool ok = true;
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  std::optional<uint64_t> episode_id = {};
  std::string projection_name = {};
  std::string projection_schema = {};
  std::string authority = "yijinjing-journal";
  bool rebuildable = false;
  storage_query_kind query = storage_query_kind::Entries;
  std::optional<std::string> entry_kind = {};
  storage_time_range range = {};
  uint64_t limit = 100;
  storage_query_rows rows = std::vector<storage_entry_query_row>{};
  std::vector<storage_query_error> errors = {};

  [[nodiscard]] size_t row_count() const;
};

struct storage_provider_runtime_view {
  std::string lifecycle = {};
  std::string instance_lifecycle = {};
  std::string handle = {};
  bool readonly_open_creates_backend = false;
  bool write_open_creates_backend = true;
  std::optional<bool> read_fill_cache = {};
  std::optional<bool> write_sync = {};
};

struct storage_provider_layout_view {
  std::optional<std::string> database = {};
  std::string manifest_catalog_journal = {};
  std::string manifest_entries = {};
  std::string payloads = {};
};

struct storage_provider_cache_view {
  std::string lifecycle = "process";
  uint64_t entries = 0;
  uint64_t hits = 0;
  uint64_t misses = 0;
};

struct storage_layout_request {
  std::string runtime_dir = {};
  std::string runtime_home = {};
  std::string config_home = {};
  std::string provider = {};
};

struct storage_layout_paths_view {
  std::string data_home = {};
  std::string runtime_dir = {};
  std::string dataset_dir = {};
  std::string inbox_dir = {};
  std::string journal_dir = {};
  std::string storage_dir = {};
  std::string source_registry_journal = {};
  std::string manifest_catalog_journal = {};
  std::string manifest_entries = {};
  std::string payloads = {};
  std::string rocksdb = {};
  std::string source_registry_projection = {};
  std::string manifest_catalog_projection = {};
  std::string episode_manifest_journal_dir = {};
  std::string episode_manifest_journal = {};
  std::string master_state = {};
  std::string remote_mirrors = {};
  std::string atlas_store = {};
};

struct storage_layout_episode_view {
  std::string authority = "yijinjing-journal";
  std::string schema = {};
  std::string manifest_namespace = {};
  std::string manifest_name = {};
  std::string manifest_journal = {};
  std::vector<std::string> query_tables = {};
  std::string export_schema = {};
};

struct storage_layout_ownership_view {
  std::string journal_dir = {};
  std::string episode_manifest_journal = {};
  std::string storage_dir = {};
  std::string source_registry_journal = {};
  std::string manifest_catalog_journal = {};
  std::string manifest_entries = {};
  std::string payloads = {};
  std::string source_registry_projection = {};
  std::string manifest_catalog_projection = {};
  std::string rocksdb = {};
  std::string config_home = {};
};

struct storage_layout_result {
  std::string schema = "kungfu.workspace.episode-layout/v1";
  std::string owner = RUNTIME_STORAGE_SERVICE_OWNER;
  uint32_t layout_version = 1;
  std::string runtime_home = {};
  std::string workspace_data_home = {};
  std::string runtime_home_source = {};
  std::string runtime_dir = {};
  bool runtime_dir_is_standard_child = false;
  std::string config_home = {};
  std::string provider = {};
  storage_provider_layout_view provider_layout = {};
  storage_provider_runtime_view provider_runtime = {};
  storage_provider_cache_view provider_cache = {};
  storage_layout_paths_view paths = {};
  storage_layout_episode_view episodes = {};
  storage_layout_ownership_view ownership = {};
  std::vector<std::string> notes = {};
};

struct storage_frame_range_view {
  uint64_t first_frame_uid = 0;
  uint64_t last_frame_uid = 0;
  int64_t since = 0;
  int64_t until = 0;
};

struct storage_source_registry_view {
  uint64_t source_uid = 0;
  std::string source_id = {};
  bool registered = false;
  uint64_t record_count = 0;
  uint64_t accepted_range_count = 0;
  std::optional<std::string> kind = {};
  std::optional<std::string> coordinate = {};
  std::optional<std::string> head = {};
  std::optional<uint32_t> location_uid = {};
  std::optional<int64_t> register_time = {};
  std::optional<storage_frame_range_view> current_range = {};
  std::optional<storage_sync_root_view> inventory_hash = {};
  std::optional<int64_t> update_time = {};
};

struct storage_accepted_range_view {
  std::string source_id = {};
  std::string manifest_id = {};
  storage_time_range range = {};
  std::string source_head = {};
  storage_sync_root_view sync_root = {};
  uint64_t entry_count = 0;
  std::string status = {};
};

struct storage_cursor_view {
  std::string source_id = {};
  std::string manifest_id = {};
  std::string source_head = {};
  storage_time_range range = {};
  storage_sync_root_view sync_root = {};
  uint64_t entry_count = 0;
};

struct storage_manifest_source_view {
  std::string source_id = {};
  std::string source_type = {};
  std::string kind = {};
  std::string coordinate = {};
  std::string source_head = {};
  storage_time_range range = {};
  std::string inventory_hash = {};
  storage_accepted_range_view accepted_range = {};
  std::string manifest_id = {};
};

struct storage_source_status_view {
  std::string source_id = {};
  bool ok = false;
  std::optional<std::string> reason = {};
  storage_source_registry_view source = {};
  std::optional<std::string> manifest_id = {};
  std::optional<std::string> source_type = {};
  std::optional<std::string> source_head = {};
  std::optional<storage_accepted_range_view> accepted_range = {};
  std::optional<storage_cursor_view> accepted_cursor = {};
  std::optional<storage_sync_root_view> sync_root = {};
  uint64_t entries = 0;
  uint64_t payload_inventory = 0;
  uint64_t schema_inventory = 0;
  std::optional<storage_manifest_source_view> source_record = {};
};

struct storage_projection_status_view {
  std::string name = {};
  std::string path = {};
  bool rebuildable = true;
  storage_projection_verify_result verification = {};
};

using episode_frame_field_value = std::variant<int64_t, uint64_t>;

struct episode_frame_field_mismatch {
  std::string field = {};
  episode_frame_field_value claimed = uint64_t{0};
  episode_frame_field_value actual = uint64_t{0};
};

struct episode_frame_verification_issue {
  std::string code = {};
  uint64_t episode_id = 0;
  uint64_t frame_uid = 0;
  std::optional<uint32_t> location_uid = {};
  std::optional<uint32_t> dest = {};
  std::optional<uint32_t> integrity_version = {};
  std::vector<episode_frame_field_mismatch> fields = {};
  std::optional<uint64_t> claimed_payload_checksum = {};
  std::optional<uint64_t> actual_payload_checksum = {};
  std::optional<uint64_t> claimed_frame_checksum = {};
  std::optional<uint64_t> actual_frame_checksum = {};
};

struct episode_frame_verification {
  std::vector<episode_frame_verification_issue> errors = {};
  std::vector<episode_frame_verification_issue> warnings = {};
  uint64_t verified = 0;
  bool degraded = false;
};

struct episode_qualification_evidence {
  std::string name = {};
  std::string state = {};
  std::vector<std::string> issue_codes = {};
};

using episode_qualification_issue_detail =
    std::variant<yijinjing::storage::episode_fsck_issue, episode_frame_verification_issue,
                 storage_projection_verify_result>;

struct episode_qualification_issue {
  std::string severity = {};
  std::string code = {};
  std::string evidence = {};
  episode_qualification_issue_detail detail = yijinjing::storage::episode_fsck_issue{};
};

struct episode_qualification_capability {
  std::string name = {};
  bool safe = false;
  std::vector<std::string> required_evidence = {};
  std::vector<std::string> blocked_by = {};
};

struct episode_repair_subject {
  std::optional<uint64_t> episode_id = {};
  std::optional<uint64_t> dependency_episode_id = {};
  std::optional<uint64_t> frame_uid = {};
  std::optional<uint64_t> dependent_frame_uid = {};
  std::optional<std::string> ref_id = {};
  std::optional<std::string> ref_hash = {};
  std::optional<std::string> role = {};
};

struct episode_repair_prerequisite {
  std::string issue_code = {};
  std::string action = {};
  std::vector<std::string> required_inputs = {};
  episode_repair_subject subject = {};
};

struct episode_qualification_result {
  uint64_t episode_id = 0;
  std::string lifecycle = "missing";
  std::string status = "failed";
  std::vector<episode_qualification_evidence> evidence = {};
  std::vector<episode_qualification_issue> issues = {};
  std::vector<episode_qualification_capability> capabilities = {};
  std::vector<episode_repair_prerequisite> repair_prerequisites = {};
};

enum class storage_fsck_scope { All, Source, Episode };

struct storage_fsck_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  storage_fsck_scope scope = storage_fsck_scope::All;
  std::string source_id = {};
  uint64_t episode_id = 0;
  bool verify_frames = false;
};

struct storage_fsck_cross_issue {
  std::optional<std::string> source_id = {};
  std::optional<std::string> path = {};
  std::optional<std::string> payload_hash = {};
  std::optional<std::string> expected = {};
  std::optional<std::string> actual = {};
  std::optional<std::string> reason = {};
};

using storage_fsck_issue_detail =
    std::variant<storage_fsck_cross_issue, yijinjing::storage::source_registry_fsck_issue,
                 yijinjing::storage::manifest_catalog_fsck_issue, yijinjing::storage::episode_fsck_issue,
                 episode_frame_verification_issue, storage_projection_status_view>;

struct storage_fsck_issue {
  std::string severity = "error";
  std::string code = {};
  std::string projection = {};
  storage_fsck_issue_detail detail = storage_fsck_cross_issue{};
};

struct storage_fsck_counts {
  uint64_t sources = 0;
  uint64_t manifests = 0;
  uint64_t manifest_entries = 0;
  uint64_t payloads = 0;
  uint64_t entries_documents = 0;
  uint64_t accepted_ranges = 0;
  uint64_t source_records = 0;
  uint64_t projection_indexes = 0;
  uint64_t orphan_payloads = 0;
  uint64_t episode_manifest_records = 0;
  uint64_t episodes = 0;
  uint64_t episode_frames_verified = 0;
};

struct storage_fsck_result {
  bool ok = true;
  bool degraded = false;
  std::string status = "ok";
  storage_fsck_scope scope = storage_fsck_scope::All;
  std::optional<std::string> source_id = {};
  std::optional<uint64_t> episode_id = {};
  std::string authority = "yijinjing-journal";
  storage_fsck_counts checked = {};
  yijinjing::storage::source_registry_fsck_result source_registry = {};
  std::optional<yijinjing::storage::manifest_catalog_fsck_result> manifest_catalog = {};
  yijinjing::storage::episode_fsck_result episode_manifest = {};
  std::vector<storage_projection_status_view> projections = {};
  std::optional<episode_frame_verification> frame_verification = {};
  std::optional<episode_qualification_result> qualification = {};
  std::vector<storage_fsck_issue> issues = {};
};

struct storage_repair_plan_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  storage_fsck_scope scope = storage_fsck_scope::All;
  std::string source_id = {};
  uint64_t episode_id = 0;
  bool verify_frames = false;
  bool dry_run = true;
};

struct storage_repair_subject {
  std::optional<uint64_t> episode_id = {};
  std::optional<uint64_t> dependency_episode_id = {};
  std::optional<uint64_t> frame_uid = {};
  std::optional<uint64_t> dependent_frame_uid = {};
  std::optional<std::string> ref_id = {};
  std::optional<std::string> ref_hash = {};
  std::optional<std::string> source_id = {};
  std::optional<std::string> subject = {};
  std::optional<std::string> state = {};
  std::optional<std::string> path = {};
  std::optional<std::string> payload_hash = {};
};

struct storage_repair_candidate_view {
  std::string code = {};
  std::string issue_code = {};
  std::string kind = {};
  std::string role = {};
  std::string action = {};
  bool safe_to_apply = false;
  std::vector<std::string> required_inputs = {};
  storage_repair_subject subject = {};
  storage_fsck_issue issue = {};
};

struct storage_repair_plan_result {
  bool ok = true;
  storage_fsck_scope scope = storage_fsck_scope::All;
  std::optional<std::string> source_id = {};
  std::optional<uint64_t> episode_id = {};
  bool dry_run = true;
  bool plan_only = true;
  std::string status = "ok";
  bool degraded = false;
  std::vector<storage_repair_candidate_view> candidates = {};
  std::vector<storage_fsck_issue> unsupported = {};
  storage_fsck_result fsck = {};
  std::vector<std::string> notes = {};
};

struct storage_status_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string source_id = {};
};

struct storage_status_result {
  bool ok = true;
  std::string backend = {};
  std::string provider = {};
  std::string provider_config_source = {};
  storage_provider_runtime_view provider_runtime = {};
  storage_provider_cache_view provider_cache = {};
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  std::string authority = "yijinjing-journal";
  std::vector<storage_source_registry_view> sources = {};
  std::vector<storage_projection_status_view> projections = {};
  std::vector<storage_source_status_view> source_status = {};
};

struct storage_gc_plan_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string source_id = {};
  bool dry_run = true;
};

struct storage_gc_candidate_view {
  std::string payload_hash = {};
  std::string uri = {};
  uint64_t bytes = 0;
  bool safe_to_delete = false;
};

struct storage_gc_plan_result {
  bool ok = true;
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  bool dry_run = true;
  uint64_t payloads_scanned = 0;
  uint64_t referenced_payloads = 0;
  uint64_t candidate_bytes = 0;
  std::vector<storage_gc_candidate_view> candidates = {};
  std::vector<std::string> notes = {};
};

using storage_projection_action_detail =
    std::variant<storage_projection_verify_result, storage_projection_rebuild_result>;

struct storage_projection_action_view {
  std::string name = {};
  bool dry_run = true;
  bool written = false;
  bool would_write = false;
  storage_projection_action_detail detail = storage_projection_verify_result{};
};

struct storage_rebuild_index_request {
  std::string runtime_dir = {};
  std::string source_id = {};
  bool dry_run = true;
};

struct storage_projection_error {
  std::string code = {};
  std::optional<std::string> projection = {};
  std::optional<std::string> source_id = {};
};

struct storage_rebuild_index_result {
  bool ok = true;
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  std::string authority = "yijinjing-journal";
  std::string rebuilt_from = "storage kernel journals";
  std::vector<storage_projection_action_view> projections = {};
  bool dry_run = true;
  bool would_write = false;
  bool written = false;
  uint64_t sources_rebuilt = 0;
  std::vector<storage_projection_error> errors = {};
};

struct storage_compact_plan_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string source_id = {};
  bool dry_run = true;
};

struct storage_retained_manifest_view {
  std::string source_id = {};
  std::string manifest_id = {};
  uint64_t entries = 0;
  storage_sync_root_view sync_root = {};
};

struct storage_projection_compact_view {
  std::string name = {};
  std::string path = {};
  std::string action = "rebuild-and-vacuum";
  bool dry_run = true;
  bool rebuildable = true;
};

struct storage_unsupported_action_view {
  std::string name = {};
  std::string reason = {};
};

struct storage_compact_plan_result {
  bool ok = true;
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  bool dry_run = true;
  std::vector<storage_retained_manifest_view> retained_manifests = {};
  storage_rebuild_index_result rebuild_index = {};
  storage_gc_plan_result gc = {};
  storage_projection_compact_view projection_compact = {};
  std::vector<storage_unsupported_action_view> unsupported = {};
  std::vector<std::string> notes = {};
};

struct storage_export_bundle_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string source_id = {};
  storage_time_range range = {};
  bool record_receipt = true;
};

struct storage_export_record_view {
  yijinjing::storage::manifest_entry_view entry = {};
  std::optional<std::string> payload_json = {};
};

struct storage_export_bundle_result {
  std::string bundle_id = {};
  std::string source_id = {};
  yijinjing::storage::manifest_document_view manifest = {};
  std::vector<storage_export_record_view> records = {};
};

// ADR-0053: the bytes an Episode owns travel with its bundle. A frame is
// carried whole (header + payload) because the header holds writer-local
// fields (frame_uid, trigger provenance) no claim covers and the claimed
// frame checksum recomputes over exactly these bytes.
struct episode_frame_material {
  uint64_t frame_uid = 0;
  int64_t gen_time = 0;
  int32_t carrier_type = 0;
  uint32_t frame_length = 0;
  uint32_t data_length = 0;
  std::string bytes = {};
};

struct episode_journal_material {
  std::string role = {};
  std::string namespace_ = {};
  std::string name = {};
  std::string mode = {};
  uint32_t seed = 0;
  uint32_t location_uid = 0;
  uint32_t dest = 0;
  std::vector<episode_frame_material> frames = {};
};

struct episode_ref_payload_material {
  std::string content_namespace = "payloads";
  std::string ref_hash = {};
  uint64_t byte_len = 0;
  std::string bytes = {};
};

struct storage_episode_bundle_result {
  std::string bundle_id = {};
  uint64_t episode_id = 0;
  yijinjing::storage::episode_current_view manifest = {};
  yijinjing::storage::episode_causal_graph causal_graph = {};
  bool self_contained = false;
  std::vector<episode_journal_material> journals = {};
  std::vector<episode_ref_payload_material> ref_payloads = {};
  uint64_t material_missing_frame_count = 0;
  uint64_t material_missing_ref_payload_count = 0;
};

struct storage_import_bundle_request {
  std::string runtime_dir = {};
  std::string provider = {};
  storage_export_bundle_result bundle = {};
  bool verify = true;
};

struct storage_import_bundle_result {
  bool ok = true;
  std::string scope = "source";
  std::string source_id = {};
  std::string manifest_id = {};
  uint64_t records = 0;
};

struct storage_verify_sync_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string source_id = {};
};

struct storage_verify_sync_result {
  bool ok = true;
  std::string scope = "source";
  std::string source_id = {};
  uint64_t exported_records = 0;
  storage_import_bundle_result import = {};
  storage_sync_root_view local_sync_root = {};
  storage_sync_root_view imported_sync_root = {};
  bool sync_roots_match = false;
  storage_fsck_result source_fsck = {};
  storage_fsck_result imported_fsck = {};
  std::string imported_runtime_dir = {};
};

struct storage_episode_begin_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_begin_options options = {};
};

struct storage_episode_heartbeat_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_heartbeat_options options = {};
};

struct storage_episode_frame_attach_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_frame_attach_options options = {};
};

struct storage_episode_ref_attach_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_ref_attach_options options = {};
};

struct storage_episode_close_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_close_options options = {};
};

struct storage_episode_recover_request {
  std::string runtime_dir = {};
  yijinjing::storage::episode_recover_options options = {};
};

struct storage_episode_projection_rebuild_request {
  std::string runtime_dir = {};
};

struct storage_episode_list_request {
  std::string runtime_dir = {};
  uint32_t location_uid = 0;
  uint64_t limit = 100;
};

struct storage_episode_list_result {
  bool ok = true;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  std::vector<yijinjing::storage::episode_current_view> episodes = {};
  uint64_t unknown_record_count = 0;
};

struct storage_episode_inspect_request {
  std::string runtime_dir = {};
  uint64_t episode_id = 0;
};

struct storage_episode_inspect_result {
  bool ok = true;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  yijinjing::storage::episode_current_view episode = {};
  yijinjing::storage::episode_content_root_verification content_root = {};
  yijinjing::storage::episode_causal_graph causal_graph = {};
  uint64_t unknown_record_count = 0;
  std::optional<episode_qualification_result> qualification = {};
};

struct storage_source_register_request {
  std::string runtime_dir = {};
  yijinjing::storage::source_register_options options = {};
};

struct storage_source_head_update_request {
  std::string runtime_dir = {};
  yijinjing::storage::source_head_update_options options = {};
};

struct storage_source_accepted_range_request {
  std::string runtime_dir = {};
  yijinjing::storage::accepted_range_options options = {};
};

struct storage_source_list_request {
  std::string runtime_dir = {};
};

struct storage_source_list_result {
  bool ok = true;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  std::vector<yijinjing::storage::source_registry_current_view> sources = {};
  uint64_t unknown_record_count = 0;
};

struct storage_source_inspect_request {
  std::string runtime_dir = {};
  std::string source_id = {};
};

struct storage_source_inspect_result {
  bool ok = true;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  yijinjing::storage::source_registry_current_view source = {};
  uint64_t unknown_record_count = 0;
};

struct storage_source_registry_fsck_request {
  std::string runtime_dir = {};
  std::string source_id = {};
};

struct storage_source_registry_fsck_result {
  bool ok = true;
  std::string status = "ok";
  yijinjing::storage::source_registry_fsck_result journal = {};
  storage_projection_verify_result projection = {};
};

struct storage_source_registry_rebuild_request {
  std::string runtime_dir = {};
};

class storage_service {
public:
  virtual ~storage_service() = default;

  [[nodiscard]] virtual storage_status_result status(const storage_status_request &request) const = 0;

  [[nodiscard]] virtual storage_layout_result layout(const storage_layout_request &request) const = 0;

  [[nodiscard]] virtual storage_fsck_result fsck(const storage_fsck_request &request) const = 0;

  [[nodiscard]] virtual storage_repair_plan_result repair_plan(const storage_repair_plan_request &request) const = 0;

  [[nodiscard]] virtual storage_query_result query(const storage_query_request &request) const = 0;

  [[nodiscard]] virtual storage_gc_plan_result gc_plan(const storage_gc_plan_request &request) const = 0;

  [[nodiscard]] virtual storage_rebuild_index_result
  rebuild_index(const storage_rebuild_index_request &request) const = 0;

  [[nodiscard]] virtual storage_compact_plan_result compact_plan(const storage_compact_plan_request &request) const = 0;

  [[nodiscard]] virtual storage_export_bundle_result
  export_bundle(const storage_export_bundle_request &request) const = 0;

  [[nodiscard]] virtual storage_import_bundle_result
  import_bundle(const storage_import_bundle_request &request) const = 0;

  [[nodiscard]] virtual storage_verify_sync_result verify_sync(const storage_verify_sync_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::EpisodeOpen
  episode_begin(const storage_episode_begin_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::EpisodeHeartbeat
  episode_heartbeat(const storage_episode_heartbeat_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::EpisodeFrameAttached
  episode_attach_frame(const storage_episode_frame_attach_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::EpisodeRefAttached
  episode_attach_ref(const storage_episode_ref_attach_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::storage::episode_close_write_result
  episode_end(const storage_episode_close_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::storage::episode_close_write_result
  episode_abort(const storage_episode_close_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::storage::episode_recover_result
  episode_recover(const storage_episode_recover_request &request) const = 0;

  [[nodiscard]] virtual storage_projection_rebuild_result
  episode_projection_rebuild(const storage_episode_projection_rebuild_request &request) const = 0;

  [[nodiscard]] virtual storage_episode_list_result episode_list(const storage_episode_list_request &request) const = 0;

  [[nodiscard]] virtual storage_episode_inspect_result
  episode_inspect(const storage_episode_inspect_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::SourceRegistered
  source_register(const storage_source_register_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::SourceHeadUpdated
  source_update_head(const storage_source_head_update_request &request) const = 0;

  [[nodiscard]] virtual yijinjing::types::AcceptedRangeRecorded
  source_record_accepted_range(const storage_source_accepted_range_request &request) const = 0;

  [[nodiscard]] virtual storage_source_list_result source_list(const storage_source_list_request &request) const = 0;

  [[nodiscard]] virtual storage_source_inspect_result
  source_inspect(const storage_source_inspect_request &request) const = 0;

  [[nodiscard]] virtual storage_source_registry_fsck_result
  source_registry_fsck(const storage_source_registry_fsck_request &request) const = 0;

  [[nodiscard]] virtual storage_projection_rebuild_result
  source_registry_rebuild(const storage_source_registry_rebuild_request &request) const = 0;
};

[[nodiscard]] std::string storage_query_kind_name(storage_query_kind kind);

[[nodiscard]] std::string storage_fsck_scope_name(storage_fsck_scope scope);

[[nodiscard]] storage_query_kind parse_storage_query_kind(const std::string &kind);

[[nodiscard]] const storage_service &default_storage_service();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_SERVICE_H
