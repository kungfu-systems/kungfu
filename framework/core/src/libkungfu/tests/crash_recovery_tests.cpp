// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/crash_recovery.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/storage/service.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/storage/content_store.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
using namespace kungfu::runtime::durability;
using namespace kungfu::runtime::recovery;
using namespace kungfu::runtime::state_service;
using namespace kungfu::runtime::storage_service_api;
using kungfu::yijinjing::ownership::lease;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

class temp_tree {
public:
  temp_tree() {
    root_ = fs::temp_directory_path() / ("kungfu-crash-recovery-test-" +
                                         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(root_);
  }
  ~temp_tree() {
    std::error_code ignored;
    fs::remove_all(root_, ignored);
  }
  [[nodiscard]] const fs::path &root() const { return root_; }

private:
  fs::path root_;
};

ingest_options options(const fs::path &root) {
  return {root.string(), 7, 11, "recovery-writer", "test/macos-apfs-recovery", true, 4096};
}

stream_position position(uint64_t sequence) { return {7, 11, sequence, 100 + sequence}; }

struct fixture_owners {
  explicit fixture_owners(const fs::path &root)
      : service(lease::acquire_data_root_service(root.string())),
        writer(lease::acquire_stream_writer(root.string(), "recovery-writer")) {}
  lease service;
  lease writer;
};

std::vector<std::pair<std::string, std::string>> file_bytes(const fs::path &directory) {
  std::vector<std::pair<std::string, std::string>> result;
  for (const auto &entry : fs::directory_iterator(directory)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    std::ifstream input(entry.path(), std::ios::binary);
    result.emplace_back(entry.path().filename().string(),
                        std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()));
  }
  std::sort(result.begin(), result.end());
  return result;
}

std::vector<std::pair<std::string, std::string>> recursive_file_bytes(const fs::path &directory) {
  std::vector<std::pair<std::string, std::string>> result;
  for (const auto &entry : fs::recursive_directory_iterator(directory)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    std::ifstream input(entry.path(), std::ios::binary);
    result.emplace_back(fs::relative(entry.path(), directory).generic_string(),
                        std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()));
  }
  std::sort(result.begin(), result.end());
  return result;
}

void begin_episode(const fs::path &root, uint64_t episode_id, uint64_t parent_episode_id = 0) {
  storage_episode_begin_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = episode_id;
  request.options.parent_episode_id = parent_episode_id;
  request.options.location_uid = 1;
  request.options.begin_time = 1000 + static_cast<int64_t>(episode_id);
  request.options.title = "crash-recovery-fixture";
  const auto opened = default_storage_service().episode_begin(request);
  require(opened.episode_id == episode_id, "Episode fixture opened the wrong identity");
}

void end_episode(const fs::path &root, uint64_t episode_id) {
  storage_episode_close_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = episode_id;
  request.options.location_uid = 1;
  request.options.end_time = 2000 + static_cast<int64_t>(episode_id);
  const auto closed = default_storage_service().episode_end(request);
  require(closed.close.episode_id == episode_id, "Episode fixture closed the wrong identity");
}

void attach_payload_ref(const fs::path &root, uint64_t episode_id, const std::string &payload_hash) {
  storage_episode_ref_attach_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = episode_id;
  request.options.location_uid = 1;
  request.options.ref_kind = kungfu::yijinjing::enums::EpisodeRefKind::Payload;
  request.options.ref_uid = 1;
  request.options.update_time = 1500 + static_cast<int64_t>(episode_id);
  request.options.ref_id = "recovery-payload";
  request.options.ref_hash = payload_hash;
  const auto attached = default_storage_service().episode_attach_ref(request);
  require(attached.episode_id == episode_id, "Episode fixture attached a payload to the wrong identity");
}

std::string store_payload(const fs::path &root, const std::string &bytes) {
  kungfu::yijinjing::storage::file_content_store store((root / "storage").string());
  const auto stored = store.put_if_absent("payloads", bytes);
  require(stored.ok(), "Episode fixture payload was not stored");
  return stored.hash.algorithm + ":" + stored.hash.value;
}

projection_options recovery_projection_options(const fs::path &root) {
  return {root.string(), 7, 11, "recovery-state", "test-recovery-state-v1", "test/macos-apfs-recovery"};
}

std::optional<projection_mutation> recovery_projector(const durable_record &input) {
  const auto separator = input.payload.find('=');
  if (separator == std::string::npos) {
    throw std::invalid_argument("recovery_test_payload_missing_separator");
  }
  return projection_mutation{input.payload.substr(0, separator), input.payload.substr(separator + 1), false};
}

bool same_durable_records(const std::vector<durable_record> &left, const std::vector<durable_record> &right) {
  return left.size() == right.size() &&
         std::equal(left.begin(), left.end(), right.begin(), [](const auto &left_record, const auto &right_record) {
           return left_record.segment_id == right_record.segment_id &&
                  left_record.segment_offset == right_record.segment_offset &&
                  left_record.record_size == right_record.record_size &&
                  left_record.position == right_record.position &&
                  left_record.carrier_type == right_record.carrier_type && left_record.frame == right_record.frame &&
                  left_record.owner_generation == right_record.owner_generation &&
                  left_record.writer_generation == right_record.writer_generation &&
                  left_record.payload_sha256 == right_record.payload_sha256 &&
                  left_record.record_sha256 == right_record.record_sha256 &&
                  left_record.payload == right_record.payload;
         });
}

const episode_qualification_capability &capability(const episode_qualification_result &qualification,
                                                   const std::string &name) {
  const auto found = std::find_if(qualification.capabilities.begin(), qualification.capabilities.end(),
                                  [&name](const auto &candidate) { return candidate.name == name; });
  if (found == qualification.capabilities.end()) {
    throw std::runtime_error("missing episode capability: " + name);
  }
  return *found;
}

bool has_issue(const episode_qualification_result &qualification, const std::string &code) {
  return std::ranges::any_of(qualification.issues, [&code](const auto &candidate) { return candidate.code == code; });
}

void test_clean_frontier_is_ready_and_repeatable() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  const auto active_writer =
      kungfu::yijinjing::ownership::inspect_active_stream_writer(tree.root().string(), "recovery-writer");
  require(active_writer.owned && active_writer.resource_id == "recovery-writer",
          "active writer evidence was not readable while its ownership lock was held");
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(1, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "clean fixture barrier failed");
  }
  recovery_engine engine(options(tree.root()));
  const auto first = engine.inspect();
  const auto repeated = engine.inspect();
  require(first == repeated, "repeated read-only recovery changed its report");
  require(first.outcome == recovery_outcome::Ready && first.durable_frontier == position(1) &&
              first.durable_record_count == 1 && first.unacknowledged_tail_bytes == 0 && !first.mutation_performed,
          "clean recovery report selected the wrong frontier or outcome");
  require(first.completed_phases == std::vector<recovery_phase>{recovery_phase::Discover, recovery_phase::Verify,
                                                                recovery_phase::Select, recovery_phase::Classify,
                                                                recovery_phase::Report},
          "recovery state machine skipped or reordered a read-only phase");
}

void test_complete_unknown_tail_is_degraded_without_promotion() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(2, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "tail fixture barrier failed");
    log.append(position(2), 1001, "visible-only", owners.service, owners.writer);
  }
  const auto report = recovery_engine(options(tree.root())).inspect();
  require(report.outcome == recovery_outcome::Degraded && report.durable_frontier == position(1) &&
              report.durable_record_count == 1 && report.unacknowledged_tail_bytes > 0 &&
              report.unacknowledged_tail_integrity == tail_integrity::CompleteRecords,
          "complete unknown tail was promoted, hidden, or misclassified");
  const restart_progress ready_until_projection{true, true, true, false};
  require(!authorize_restart(report, recovery_component::Peers, ready_until_projection).allowed,
          "degraded recovery authorized required peers");
}

void test_interrupted_episode_reuses_typed_qualification_without_mutation() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(1, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "interrupted Episode fixture barrier failed");
  }
  begin_episode(tree.root(), 41);
  const auto before = recursive_file_bytes(tree.root());

  recovery_engine engine(options(tree.root()));
  const auto first = engine.inspect();
  const auto repeated = engine.inspect();

  require(first == repeated, "interrupted Episode fold was not deterministic");
  require(recursive_file_bytes(tree.root()) == before, "interrupted Episode inspection mutated the data root");
  require(first.outcome == recovery_outcome::Degraded && first.episode_unknown_record_count == 0 &&
              first.interrupted_episodes.size() == 1 && first.episode_findings == first.interrupted_episodes,
          "interrupted Episode was not classified as degraded retained evidence");
  const auto &qualification = first.interrupted_episodes.front();
  require(qualification.episode_id == 41 && qualification.lifecycle == "open" && qualification.status == "ok",
          "recovery did not reuse the typed Episode qualification contract");
  require(capability(qualification, "append").safe && !capability(qualification, "replay").safe &&
              !capability(qualification, "depend_on").safe,
          "interrupted Episode capabilities diverged from ADR-0042 qualification semantics");
}

void test_invalid_interrupted_episode_blocks_recovery() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(1, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "invalid Episode fixture barrier failed");
  }
  begin_episode(tree.root(), 42);
  begin_episode(tree.root(), 42);

  const auto report = recovery_engine(options(tree.root())).inspect();
  require(report.outcome == recovery_outcome::Blocked && report.interrupted_episodes.size() == 1 &&
              report.interrupted_episodes.front().status == "failed",
          "invalid interrupted Episode did not fail recovery closed");
}

void test_closed_episode_does_not_degrade_recovery() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(1, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "closed Episode fixture barrier failed");
  }
  begin_episode(tree.root(), 43);
  end_episode(tree.root(), 43);

  const auto report = recovery_engine(options(tree.root())).inspect();
  require(report.outcome == recovery_outcome::Ready && report.interrupted_episodes.empty(),
          "closed Episode was misclassified as interrupted recovery evidence");
  require(report.episode_findings.empty(), "healthy closed Episode leaked into recovery findings");
}

void test_closed_dependency_failure_is_contained_and_named() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(11, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "dependency fixture barrier failed");
  }
  begin_episode(tree.root(), 46, 999);
  end_episode(tree.root(), 46);
  begin_episode(tree.root(), 47);
  end_episode(tree.root(), 47);

  const auto degraded = recovery_engine(options(tree.root())).inspect();
  require(degraded.outcome == recovery_outcome::Degraded && degraded.interrupted_episodes.empty() &&
              degraded.episode_findings.size() == 1 && degraded.episode_findings.front().episode_id == 46 &&
              degraded.episode_findings.front().status == "degraded" &&
              has_issue(degraded.episode_findings.front(), "episode_dependency_missing"),
          "closed dependency damage was hidden, misnamed, or spread to an independent Episode");

  begin_episode(tree.root(), 999);
  end_episode(tree.root(), 999);
  const auto healed = recovery_engine(options(tree.root())).inspect();
  require(healed.outcome == recovery_outcome::Ready && healed.episode_findings.empty(),
          "resolving the named dependency did not restore the contained recovery result");
}

void test_torn_tail_is_degraded_and_frontier_stays_at_checkpoint() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  fs::path active;
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(3, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "torn fixture barrier failed");
    log.append(position(2), 1001, "tear", owners.service, owners.writer);
    active = tree.root() / "durable" / "streams" / "7" / "11" /
             ("active-" + std::to_string(log.status().active_segment_id) + ".kfdl");
  }
  fs::resize_file(active, fs::file_size(active) - 1);
  const auto report = recovery_engine(options(tree.root())).inspect();
  require(report.outcome == recovery_outcome::Degraded && report.durable_frontier == position(1) &&
              report.unacknowledged_tail_integrity == tail_integrity::TornOrCorrupt,
          "torn tail changed the selected frontier or escaped classification");
}

void test_no_provable_checkpoint_is_blocked() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(4, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "blocked fixture barrier failed");
  }
  const auto directory = tree.root() / "durable" / "streams" / "7" / "11";
  for (const auto &entry : fs::directory_iterator(directory)) {
    if (entry.path().filename().string().starts_with("checkpoint.")) {
      std::ofstream(entry.path(), std::ios::binary | std::ios::trunc) << "corrupt";
    }
  }
  const auto report = recovery_engine(options(tree.root())).inspect();
  require(report.outcome == recovery_outcome::Blocked && !report.durable_frontier.has_value() &&
              report.evidence_error == ingest_error::CheckpointCorrupt && !report.mutation_performed,
          "unprovable checkpoint evidence did not block startup recovery");
  const restart_progress supervisor_only{true, false, false, false};
  require(!authorize_restart(report, recovery_component::StateService, supervisor_only).allowed,
          "blocked recovery authorized the state service");
}

void test_quarantine_preview_and_apply_retain_exact_evidence_idempotently() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(5, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "quarantine fixture barrier failed");
    log.append(position(2), 1001, "retain-me", owners.service, owners.writer);
  }
  const auto source = tree.root() / "durable" / "streams" / "7" / "11";
  const auto before = file_bytes(source);
  recovery_engine engine(options(tree.root()));
  const auto first_preview = engine.preview_quarantine();
  const auto repeated_preview = engine.preview_quarantine();
  require(first_preview.has_value() && first_preview == repeated_preview && !first_preview->source_mutation_planned &&
              first_preview->unacknowledged_tail_integrity == tail_integrity::CompleteRecords,
          "quarantine preview was missing, unstable, or destructive");
  const auto first = engine.quarantine(*first_preview);
  require(first.status == maintenance_status::Completed && first.mutation_performed &&
              !first.source_mutation_performed && first.retained_file_count == before.size() && first.error.empty(),
          "quarantine did not publish a typed completed receipt");
  require(file_bytes(source) == before, "quarantine changed source KFDL evidence");
  const auto repeated = engine.quarantine(*first_preview);
  require(repeated.status == maintenance_status::AlreadyCompleted && !repeated.mutation_performed &&
              !repeated.source_mutation_performed && repeated.package_path == first.package_path,
          "repeated quarantine was not idempotent");
  require(file_bytes(source) == before, "repeated quarantine changed source KFDL evidence");
}

void test_quarantine_rejects_stale_preview() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(6, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "stale-preview fixture barrier failed");
    log.append(position(2), 1001, "first-tail", owners.service, owners.writer);
  }
  recovery_engine engine(options(tree.root()));
  const auto preview = engine.preview_quarantine();
  require(preview.has_value(), "stale-preview fixture produced no quarantine plan");
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(2), 1001, "changed-tail", owners.service, owners.writer);
  }
  const auto receipt = engine.quarantine(*preview);
  require(receipt.status == maintenance_status::Rejected && !receipt.mutation_performed &&
              receipt.error == "recovery_quarantine_preview_stale_or_invalid",
          "quarantine accepted a stale source digest");
}

void test_quarantine_requires_exclusive_ownership() {
  temp_tree tree;
  fixture_owners owners(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(7, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "ownership fixture barrier failed");
    log.append(position(2), 1001, "owned-tail", owners.service, owners.writer);
  }
  recovery_engine engine(options(tree.root()));
  const auto preview = engine.preview_quarantine();
  require(preview.has_value(), "ownership fixture produced no quarantine plan");
  const auto receipt = engine.quarantine(*preview);
  require(receipt.status == maintenance_status::Rejected && !receipt.mutation_performed &&
              receipt.error.starts_with("ownership_busy:"),
          "quarantine bypassed an active data-root or writer owner");
}

void test_quarantine_resumes_exact_partial_package_and_rejects_extra_files() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "durable", owners.service, owners.writer);
    require(log.barrier(12, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "partial quarantine fixture barrier failed");
    log.append(position(2), 1001, "interrupted-tail", owners.service, owners.writer);
  }

  recovery_engine engine(options(tree.root()));
  const auto preview = engine.preview_quarantine();
  require(preview.has_value() && preview->files.size() >= 2,
          "partial quarantine fixture produced insufficient retained files");
  const auto source = tree.root() / "durable" / "streams" / "7" / "11";
  const auto package = tree.root() / "durable" / "quarantine" / "7" / "11" / preview->plan_id;
  fs::create_directories(package);
  fs::copy_file(source / preview->files.front().name, package / preview->files.front().name);
  std::ofstream(package / (preview->files[1].name + ".pending"), std::ios::binary | std::ios::trunc)
      << "interrupted-copy";

  const auto resumed = engine.quarantine(*preview);
  require(resumed.status == maintenance_status::Completed && resumed.mutation_performed && resumed.error.empty(),
          "quarantine did not resume an exact partial retained-evidence package");
  require(
      std::ranges::none_of(fs::directory_iterator(package),
                           [](const auto &entry) { return entry.path().filename().string().ends_with(".pending"); }),
      "quarantine completion left an interrupted pending file behind");

  std::ofstream(package / "foreign-evidence", std::ios::binary | std::ios::trunc) << "not-in-preview";
  const auto rejected = engine.quarantine(*preview);
  require(rejected.status == maintenance_status::Rejected && !rejected.mutation_performed &&
              rejected.error == "recovery_quarantine_partial_package_invalid",
          "quarantine accepted or rewrote a completed package with extra evidence");
}

void test_consistent_backup_rejects_unacknowledged_tail() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "alpha=one", owners.service, owners.writer);
    require(log.barrier(8, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "backup rejection fixture barrier failed");
    log.append(position(2), 1001, "alpha=two", owners.service, owners.writer);
  }

  const auto exported = recovery_engine(options(tree.root())).export_consistent_backup();
  require(!exported.ok && !exported.bundle.has_value() && exported.error == "recovery_backup_source_not_ready",
          "consistent backup accepted a visible tail beyond the durable cut");
}

void test_consistent_backup_rejects_missing_episode_payload() {
  temp_tree tree;
  {
    fixture_owners owners(tree.root());
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "alpha=one", owners.service, owners.writer);
    require(log.barrier(10, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "missing-payload backup fixture barrier failed");
  }
  begin_episode(tree.root(), 45);
  attach_payload_ref(tree.root(), 45, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
  end_episode(tree.root(), 45);

  const auto exported = recovery_engine(options(tree.root())).export_consistent_backup();
  require(!exported.ok && !exported.bundle.has_value() &&
              exported.error == "recovery_backup_episode_payload_unverified",
          "consistent backup accepted a sealed Episode with a missing payload object");
}

void test_consistent_backup_empty_root_restore_and_projection_rebuild() {
  temp_tree source;
  temp_tree restored;
  temp_tree corrupt_target;
  temp_tree nonempty_target;
  {
    fixture_owners owners(source.root());
    durable_ingest_log log(options(source.root()));
    log.append(position(1), 1001, "alpha=one", owners.service, owners.writer);
    log.append(position(2), 1001, "alpha=two", owners.service, owners.writer);
    log.append(position(3), 1001, "beta=three", owners.service, owners.writer);
    require(log.barrier(9, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
                receipt_status::Succeeded,
            "backup round-trip fixture barrier failed");
  }
  begin_episode(source.root(), 44);
  const std::string episode_payload = "episode-payload-44";
  const auto episode_payload_hash = store_payload(source.root(), episode_payload);
  attach_payload_ref(source.root(), 44, episode_payload_hash);
  end_episode(source.root(), 44);

  ingest_options source_read_options = options(source.root());
  source_read_options.read_only = true;
  std::vector<durable_record> source_records;
  {
    durable_ingest_log source_log(source_read_options);
    source_records = source_log.read_durable_records();
  }
  projection_snapshot source_projection;
  std::string source_projection_path;
  {
    projection_bootstrap_store projection(recovery_projection_options(source.root()), recovery_projector);
    source_projection = projection.rebuild(source_records);
    source_projection_path = projection.snapshot_path();
  }
  require(fs::is_regular_file(source_projection_path), "source projection fixture was not created");

  const auto exported = recovery_engine(options(source.root())).export_consistent_backup();
  require(exported.ok && exported.bundle.has_value() && exported.error.empty(),
          "READY source did not produce a consistent backup bundle");
  const auto &bundle = *exported.bundle;
  require(bundle.backup_cut == position(3) && bundle.durable_record_count == 3 && bundle.lost_visible_tail_bytes == 0 &&
              bundle.projection_rebuild_required && bundle.episodes.size() == 1 && bundle.episodes.front().closed &&
              bundle.episodes.front().payload_hashes == std::vector<std::string>{episode_payload_hash},
          "backup bundle omitted its cut, RPO, projection, or Episode payload identity contract");
  require(std::ranges::none_of(bundle.files,
                               [](const auto &file) {
                                 return file.relative_path.starts_with("ownership/") ||
                                        file.relative_path.starts_with("durable/quarantine/") ||
                                        file.relative_path.starts_with("storage/projections/") ||
                                        file.relative_path.starts_with(".kungfu/durability/projections/") ||
                                        file.relative_path.starts_with(".kungfu/recovery/");
                               }),
          "backup bundle copied ownership, quarantine, projection, or recovery receipt state");

  auto corrupt_bundle = bundle;
  require(!corrupt_bundle.files.empty(), "backup fixture unexpectedly contained no authoritative files");
  corrupt_bundle.files.front().bytes.push_back('x');
  const auto corrupt_receipt = recovery_engine(options(corrupt_target.root())).restore_backup(corrupt_bundle);
  require(corrupt_receipt.status == maintenance_status::Rejected && !corrupt_receipt.mutation_performed &&
              corrupt_receipt.error == "recovery_backup_file_invalid",
          "restore mutated an empty root before rejecting corrupted backup bytes");

  std::ofstream(nonempty_target.root() / "unrelated.txt", std::ios::binary | std::ios::trunc) << "unrelated";
  const auto nonempty_receipt = recovery_engine(options(nonempty_target.root())).restore_backup(bundle);
  require(nonempty_receipt.status == maintenance_status::Rejected && !nonempty_receipt.mutation_performed &&
              nonempty_receipt.error == "recovery_restore_destination_not_empty",
          "restore accepted an unrelated file in the destination data root");

  const auto &already_copied = bundle.files.front();
  const auto partial_path = restored.root() / fs::path(already_copied.relative_path);
  fs::create_directories(partial_path.parent_path());
  std::ofstream(partial_path, std::ios::binary | std::ios::trunc) << already_copied.bytes;

  recovery_engine restore_engine(options(restored.root()));
  const auto first_restore = restore_engine.restore_backup(bundle);
  require(first_restore.status == maintenance_status::Completed && first_restore.mutation_performed &&
              first_restore.error.empty() && first_restore.restored_report == bundle.source_report &&
              first_restore.restored_episode_count == 1,
          "empty-root restore did not complete from an exact partial copy");
  kungfu::yijinjing::storage::file_content_store restored_content((restored.root() / "storage").string());
  const auto separator = episode_payload_hash.find(':');
  const auto restored_payload = restored_content.get(
      "payloads", {episode_payload_hash.substr(0, separator), episode_payload_hash.substr(separator + 1)});
  require(restored_payload.ok() && restored_payload.bytes == episode_payload,
          "restored Episode payload did not verify against its content hash");

  projection_bootstrap_store restored_projection(recovery_projection_options(restored.root()), recovery_projector);
  require(!fs::exists(restored_projection.snapshot_path()), "restore copied a derived projection snapshot");
  ingest_options restored_read_options = options(restored.root());
  restored_read_options.read_only = true;
  durable_ingest_log restored_log(restored_read_options);
  const auto restored_records = restored_log.read_durable_records();
  const auto before_rebuild = restored_projection.bootstrap(restored_records, peer_state_requirement::Required);
  require(before_rebuild.outcome == bootstrap_outcome::Refused &&
              before_rebuild.error == projection_error::SnapshotMissing,
          "required restored projection became ready before an explicit rebuild");
  const auto rebuilt = restored_projection.rebuild(restored_records);
  require(same_durable_records(restored_records, source_records) &&
              rebuilt.through_position == source_projection.through_position &&
              rebuilt.state == source_projection.state &&
              rebuilt.integrity_sha256 == source_projection.integrity_sha256,
          "restored projection did not rebuild to the source typed state, cut, and integrity hash");

  const auto repeated_restore = restore_engine.restore_backup(bundle);
  require(repeated_restore.status == maintenance_status::AlreadyCompleted && !repeated_restore.mutation_performed &&
              repeated_restore.restored_report == first_restore.restored_report && repeated_restore.error.empty(),
          "completed restore was not idempotent after projection rebuild");

  std::ofstream(restored.root() / fs::path(bundle.files.front().relative_path), std::ios::binary | std::ios::app)
      << "tampered";
  const auto tampered_restore = restore_engine.restore_backup(bundle);
  require(tampered_restore.status == maintenance_status::Rejected && !tampered_restore.mutation_performed &&
              tampered_restore.error == "recovery_restore_completed_root_mismatch",
          "completed restore receipt hid later authoritative file corruption");
}

void create_whole_data_root_fixture(const fs::path &root) {
  fs::create_directories(root);
  fixture_owners owners(root);
  durable_ingest_log log(options(root));
  log.append(position(1), 1001, "alpha=whole-root", owners.service, owners.writer);
  require(log.barrier(13, durability_profile::DurableGroup, owners.service, owners.writer).receipt.status ==
              receipt_status::Succeeded,
          "whole-data-root fixture barrier failed");
  begin_episode(root, 61);
  end_episode(root, 61);
  projection_bootstrap_store projection(recovery_projection_options(root), recovery_projector);
  (void)projection.rebuild(log.read_durable_records());
}

void verify_whole_data_root_fixture(const fs::path &root) {
  const auto report = recovery_engine(options(root)).inspect();
  require(report.outcome == recovery_outcome::Ready && report.durable_frontier == position(1) &&
              report.durable_record_count == 1 && report.interrupted_episodes.empty() &&
              report.episode_findings.empty() &&
              report.restart_order == std::vector<std::string>{"supervisor", "state_service", "projection", "peers"},
          "fresh process did not recover the whole data root to its verified frontier");

  restart_progress progress;
  require(!authorize_restart(report, recovery_component::StateService, progress).allowed &&
              authorize_restart(report, recovery_component::Supervisor, progress).allowed,
          "restart gate did not require supervisor verification first");
  progress.supervisor_verified = true;
  require(!authorize_restart(report, recovery_component::Projection, progress).allowed &&
              authorize_restart(report, recovery_component::StateService, progress).allowed,
          "restart gate did not require the state service before projection");

  durable_ingest_log reopened_log(options(root));
  const auto records = reopened_log.read_durable_records();
  require(records.size() == 1 && records.front().position == position(1) &&
              records.front().payload == "alpha=whole-root",
          "fresh state service did not reopen the durable fact at the report frontier");
  storage_fsck_request episode_request{};
  episode_request.runtime_dir = root.string();
  episode_request.scope = storage_fsck_scope::Episode;
  episode_request.episode_id = 61;
  episode_request.verify_frames = true;
  const auto episode = default_storage_service().fsck(episode_request);
  require(episode.qualification.has_value() && episode.qualification->lifecycle == "ended" &&
              episode.qualification->status == "ok",
          "fresh state service did not preserve the sealed Episode identity");
  progress.state_service_ready = true;
  require(!authorize_restart(report, recovery_component::Peers, progress).allowed &&
              authorize_restart(report, recovery_component::Projection, progress).allowed,
          "restart gate did not require projection readiness before peers");

  projection_bootstrap_store projection(recovery_projection_options(root), recovery_projector);
  const auto bootstrap = projection.bootstrap(records, peer_state_requirement::Required);
  require(bootstrap.outcome == bootstrap_outcome::Ready && bootstrap.state.at("alpha") == "whole-root" &&
              bootstrap.status.projection_watermark == position(1),
          "fresh projection did not reopen at the whole-data-root durable cut");
  progress.projection_ready = true;
  require(authorize_restart(report, recovery_component::Peers, progress).allowed,
          "restart gate refused peers after the verified ordered recovery sequence");
}

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc == 3 && std::string(argv[1]) == "--create-whole-data-root-fixture") {
      create_whole_data_root_fixture(argv[2]);
      return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "--verify-whole-data-root-fixture") {
      verify_whole_data_root_fixture(argv[2]);
      return 0;
    }
    if (argc != 1) {
      return 64;
    }
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  const std::pair<const char *, void (*)()> tests[] = {
      {"clean frontier is ready and repeatable", test_clean_frontier_is_ready_and_repeatable},
      {"complete unknown tail is degraded without promotion", test_complete_unknown_tail_is_degraded_without_promotion},
      {"interrupted Episode reuses typed qualification without mutation",
       test_interrupted_episode_reuses_typed_qualification_without_mutation},
      {"invalid interrupted Episode blocks recovery", test_invalid_interrupted_episode_blocks_recovery},
      {"closed Episode does not degrade recovery", test_closed_episode_does_not_degrade_recovery},
      {"closed dependency failure is contained and named", test_closed_dependency_failure_is_contained_and_named},
      {"torn tail is degraded at checkpoint frontier", test_torn_tail_is_degraded_and_frontier_stays_at_checkpoint},
      {"no provable checkpoint is blocked", test_no_provable_checkpoint_is_blocked},
      {"quarantine retains exact evidence idempotently",
       test_quarantine_preview_and_apply_retain_exact_evidence_idempotently},
      {"quarantine rejects a stale preview", test_quarantine_rejects_stale_preview},
      {"quarantine requires exclusive ownership", test_quarantine_requires_exclusive_ownership},
      {"quarantine resumes exact partial packages and rejects extras",
       test_quarantine_resumes_exact_partial_package_and_rejects_extra_files},
      {"consistent backup rejects unacknowledged tail", test_consistent_backup_rejects_unacknowledged_tail},
      {"consistent backup rejects missing Episode payload", test_consistent_backup_rejects_missing_episode_payload},
      {"consistent backup restores empty root and rebuilds projection",
       test_consistent_backup_empty_root_restore_and_projection_rebuild},
  };
  int failures = 0;
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "ok - " << name << '\n';
    } catch (const std::exception &error) {
      ++failures;
      std::cerr << "not ok - " << name << ": " << error.what() << '\n';
    }
  }
  return failures == 0 ? 0 : 1;
}
