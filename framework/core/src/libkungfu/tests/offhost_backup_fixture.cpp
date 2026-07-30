// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/crash_recovery.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/storage/service.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/storage/content_store.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace kungfu::runtime::durability;
using namespace kungfu::runtime::recovery;
using namespace kungfu::runtime::state_service;
using namespace kungfu::runtime::storage_service_api;
using kungfu::yijinjing::ownership::lease;

namespace {

constexpr uint64_t STREAM_ID = 7201;
constexpr uint64_t CONTAINER_EPOCH = 1;
constexpr uint64_t EPISODE_ID = 7201001;
constexpr const char *PROFILE = "candidate/linux-ext4-agent120-ubuntu222-offhost-v1";

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::map<std::string, std::string> arguments(int argc, char **argv) {
  std::map<std::string, std::string> parsed;
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc || !std::string(argv[index]).starts_with("--")) {
      throw std::invalid_argument("usage: offhost fixture requires --key value pairs");
    }
    parsed.emplace(std::string(argv[index]).substr(2), argv[index + 1]);
  }
  return parsed;
}

std::string required(const std::map<std::string, std::string> &args, const std::string &name) {
  const auto found = args.find(name);
  if (found == args.end() || found->second.empty()) {
    throw std::invalid_argument("missing required option --" + name);
  }
  return found->second;
}

ingest_options fixture_options(const fs::path &root, uint64_t stream_id = STREAM_ID,
                               uint64_t container_epoch = CONTAINER_EPOCH, std::string profile = PROFILE) {
  ingest_options result{root.string(),      stream_id, container_epoch, "offhost-backup-writer",
                        std::move(profile), true,      64 * 1024};
  result.activation = ingest_activation::ProductionCandidate;
  return result;
}

stream_position fixture_position(uint64_t sequence) {
  return {STREAM_ID, CONTAINER_EPOCH, sequence, 720100000 + sequence};
}

projection_options fixture_projection_options(const fs::path &root, uint64_t stream_id = STREAM_ID,
                                              uint64_t container_epoch = CONTAINER_EPOCH,
                                              const std::string &profile = PROFILE) {
  return {root.string(), stream_id, container_epoch, "offhost-state", "offhost-state-v1", profile};
}

std::optional<projection_mutation> fixture_projector(const durable_record &record) {
  const auto separator = record.payload.find('=');
  if (separator == std::string::npos) {
    throw std::invalid_argument("offhost_fixture_payload_missing_separator");
  }
  return projection_mutation{record.payload.substr(0, separator), record.payload.substr(separator + 1), false};
}

void write_report(const fs::path &path, const json &report) {
  if (fs::exists(path) || fs::exists(path.string() + ".pending")) {
    throw std::runtime_error("offhost_fixture_report_path_exists");
  }
  fs::create_directories(path.parent_path());
  const fs::path pending(path.string() + ".pending");
  {
    std::ofstream output(pending, std::ios::binary | std::ios::trunc);
    output << report.dump(2, ' ', false) << '\n';
    output.flush();
    if (!output) {
      throw std::runtime_error("offhost_fixture_report_write_failed");
    }
  }
  fs::rename(pending, path);
}

json position_json(const std::optional<stream_position> &position) {
  if (!position.has_value()) {
    return nullptr;
  }
  return {{"stream_id", position->stream_id},
          {"container_epoch", position->container_epoch},
          {"sequence", position->sequence},
          {"frame_uid", position->frame_uid}};
}

json record_json(const std::vector<durable_record> &records) {
  json values = json::array();
  for (const auto &record : records) {
    values.push_back({{"position", position_json(record.position)},
                      {"carrier_type", record.carrier_type},
                      {"payload_sha256", record.payload_sha256},
                      {"record_sha256", record.record_sha256},
                      {"payload", record.payload}});
  }
  return values;
}

json ownership_json(const kungfu::yijinjing::ownership::evidence &value) {
  return {{"scope", kungfu::yijinjing::ownership::scope_name(value.ownership_scope)},
          {"resource_id", value.resource_id},
          {"generation", value.generation},
          {"owner_pid", value.owner_pid},
          {"recovered_stale_owner", value.recovered_stale_owner},
          {"owned", value.owned}};
}

void begin_episode(const fs::path &root) {
  storage_episode_begin_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = EPISODE_ID;
  request.options.location_uid = 7201;
  request.options.begin_time = 7201001;
  request.options.title = "offhost-backup-qualification";
  const auto opened = default_storage_service().episode_begin(request);
  require(opened.episode_id == EPISODE_ID, "offhost_fixture_episode_open_failed");
}

std::string store_episode_payload(const fs::path &root) {
  kungfu::yijinjing::storage::file_content_store store((root / "storage").string());
  const auto stored = store.put_if_absent("payloads", "offhost-backup-episode-payload");
  require(stored.ok(), "offhost_fixture_payload_store_failed");
  return stored.hash.algorithm + ":" + stored.hash.value;
}

void attach_episode_payload(const fs::path &root, const std::string &payload_hash) {
  storage_episode_ref_attach_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = EPISODE_ID;
  request.options.location_uid = 7201;
  request.options.ref_kind = kungfu::yijinjing::enums::EpisodeRefKind::Payload;
  request.options.ref_uid = 1;
  request.options.update_time = 7201002;
  request.options.ref_id = "offhost-backup-payload";
  request.options.ref_hash = payload_hash;
  const auto attached = default_storage_service().episode_attach_ref(request);
  require(attached.episode_id == EPISODE_ID, "offhost_fixture_episode_attach_failed");
}

void end_episode(const fs::path &root) {
  storage_episode_close_request request{};
  request.runtime_dir = root.string();
  request.options.episode_id = EPISODE_ID;
  request.options.location_uid = 7201;
  request.options.end_time = 7201003;
  const auto closed = default_storage_service().episode_end(request);
  require(closed.close.episode_id == EPISODE_ID, "offhost_fixture_episode_close_failed");
}

json export_fixture(const fs::path &source_root, const fs::path &store_root) {
  if (fs::exists(source_root)) {
    throw std::runtime_error("offhost_fixture_source_root_exists");
  }
  fs::create_directories(source_root);
  kungfu::yijinjing::ownership::evidence service_ownership;
  kungfu::yijinjing::ownership::evidence writer_ownership;
  {
    auto service = lease::acquire_data_root_service(source_root.string());
    auto writer = lease::acquire_stream_writer(source_root.string(), "offhost-backup-writer");
    require(service.owns() && writer.owns(), "offhost_fixture_source_ownership_failed");
    service_ownership = service.status();
    writer_ownership = writer.status();
    durable_ingest_log log(fixture_options(source_root));
    log.append(fixture_position(1), 7201, "account=42", service, writer);
    log.append(fixture_position(2), 7201, "position=17", service, writer);
    log.append(fixture_position(3), 7201, "risk=bounded", service, writer);
    require(log.barrier(7201, durability_profile::DurableSync, service, writer).receipt.status ==
                receipt_status::Succeeded,
            "offhost_fixture_durable_barrier_failed");
  }
  begin_episode(source_root);
  const auto payload_hash = store_episode_payload(source_root);
  attach_episode_payload(source_root, payload_hash);
  end_episode(source_root);

  ingest_options read_options = fixture_options(source_root);
  read_options.read_only = true;
  durable_ingest_log read_log(read_options);
  const auto records = read_log.read_durable_records();
  projection_bootstrap_store projection(fixture_projection_options(source_root), fixture_projector);
  const auto projected = projection.rebuild(records);
  const auto exported = recovery_engine(fixture_options(source_root)).export_consistent_backup();
  require(exported.ok && exported.bundle.has_value(), "offhost_fixture_backup_export_failed:" + exported.error);
  const auto &bundle = *exported.bundle;
  const auto package_path = store_root / bundle.bundle_id;
  const auto published = publish_backup_package(bundle, package_path.string());
  require(published.status == maintenance_status::Completed && published.error.empty(),
          "offhost_fixture_package_publish_failed:" + published.error);
  return {{"schema", "kungfu.offhost-backup-fixture-report/v1"},
          {"mode", "export"},
          {"qualification_profile", PROFILE},
          {"bundle_id", bundle.bundle_id},
          {"package_path", published.package_path},
          {"manifest_sha256", published.manifest_sha256},
          {"backup_cut", position_json(bundle.backup_cut)},
          {"durable_record_count", bundle.durable_record_count},
          {"file_count", published.file_count},
          {"total_bytes", published.total_bytes},
          {"episode_count", bundle.episodes.size()},
          {"episode_payload_sha256", payload_hash},
          {"records", record_json(records)},
          {"projection_state", projected.state},
          {"projection_integrity_sha256", projected.integrity_sha256},
          {"projection_cut", position_json(projected.through_position)},
          {"ownership", {{"service", ownership_json(service_ownership)}, {"writer", ownership_json(writer_ownership)}}},
          {"fresh_process_reopen_verified", false},
          {"clean_host_restart_qualified", false},
          {"physical_power_loss_qualified", false},
          {"off_host_verified", false},
          {"independent_failure_domain_qualified", false},
          {"production_eligible", false}};
}

json reopen_fixture(const fs::path &source_root) {
  require(fs::is_directory(source_root), "offhost_fixture_reopen_source_root_missing");
  auto service = lease::acquire_data_root_service(source_root.string());
  auto writer = lease::acquire_stream_writer(source_root.string(), "offhost-backup-writer");
  require(service.owns() && writer.owns(), "offhost_fixture_reopen_ownership_failed");

  const auto recovery = recovery_engine(fixture_options(source_root)).inspect();
  require(recovery.outcome == recovery_outcome::Ready, "offhost_fixture_reopen_recovery_not_ready");
  require(recovery.durable_frontier == fixture_position(3), "offhost_fixture_reopen_frontier_mismatch");
  require(recovery.durable_record_count == 3, "offhost_fixture_reopen_record_count_mismatch");
  require(recovery.unacknowledged_tail_bytes == 0, "offhost_fixture_reopen_visible_tail_present");
  require(recovery.qualification_passed, "offhost_fixture_reopen_qualification_missing");

  ingest_options read_options = fixture_options(source_root);
  read_options.read_only = true;
  durable_ingest_log read_log(read_options);
  const auto records = read_log.read_durable_records();
  projection_bootstrap_store projection(fixture_projection_options(source_root), fixture_projector);
  const auto bootstrapped = projection.bootstrap(records, peer_state_requirement::Required);
  require(bootstrapped.outcome == bootstrap_outcome::Ready, "offhost_fixture_reopen_projection_not_ready");
  require(bootstrapped.status.projection_watermark == fixture_position(3),
          "offhost_fixture_reopen_projection_cut_mismatch");

  storage_fsck_request request{};
  request.runtime_dir = source_root.string();
  request.scope = storage_fsck_scope::Episode;
  request.episode_id = EPISODE_ID;
  request.verify_frames = true;
  const auto checked = default_storage_service().fsck(request);
  require(checked.qualification.has_value() && checked.qualification->status == "ok" &&
              checked.qualification->lifecycle == "ended",
          "offhost_fixture_reopen_episode_fsck_failed");

  return {{"schema", "kungfu.offhost-backup-fixture-report/v1"},
          {"mode", "reopen"},
          {"qualification_profile", PROFILE},
          {"recovery_outcome", recovery_outcome_name(recovery.outcome)},
          {"durable_frontier", position_json(recovery.durable_frontier)},
          {"durable_record_count", records.size()},
          {"unacknowledged_tail_bytes", recovery.unacknowledged_tail_bytes},
          {"records", record_json(records)},
          {"episodes", json::array({{{"episode_id", EPISODE_ID},
                                     {"status", checked.qualification->status},
                                     {"lifecycle", checked.qualification->lifecycle}}})},
          {"projection_state", bootstrapped.state},
          {"projection_integrity_sha256", projection.load_snapshot().integrity_sha256},
          {"projection_cut", position_json(bootstrapped.status.projection_watermark)},
          {"projection_outcome", bootstrap_outcome_name(bootstrapped.outcome)},
          {"ownership", {{"service", ownership_json(service.status())}, {"writer", ownership_json(writer.status())}}},
          {"fresh_process_reopen_verified", true},
          {"clean_host_restart_qualified", false},
          {"physical_power_loss_qualified", false},
          {"production_eligible", false}};
}

json verify_package(const fs::path &package) {
  const auto loaded = load_backup_package(package.string());
  require(loaded.ok && loaded.bundle.has_value(), "offhost_fixture_package_verify_failed:" + loaded.error);
  return {{"schema", "kungfu.offhost-backup-fixture-report/v1"},
          {"mode", "verify"},
          {"bundle_id", loaded.bundle->bundle_id},
          {"manifest_sha256", loaded.manifest_sha256},
          {"backup_cut", position_json(loaded.bundle->backup_cut)},
          {"durable_record_count", loaded.bundle->durable_record_count},
          {"file_count", loaded.bundle->files.size()},
          {"episode_count", loaded.bundle->episodes.size()},
          {"complete", true}};
}

json restore_fixture(const fs::path &package, const fs::path &restore_root) {
  const auto loaded = load_backup_package(package.string());
  require(loaded.ok && loaded.bundle.has_value(), "offhost_fixture_package_load_failed:" + loaded.error);
  const auto &bundle = *loaded.bundle;
  if (!fs::exists(restore_root)) {
    fs::create_directories(restore_root);
  }
  const auto options =
      fixture_options(restore_root, bundle.stream_id, bundle.container_epoch, bundle.qualification_profile);
  recovery_engine engine(options);
  const auto restored = engine.restore_backup(bundle);
  require(restored.status == maintenance_status::Completed && restored.error.empty(),
          "offhost_fixture_restore_failed:" + restored.error);

  ingest_options read_options = options;
  read_options.read_only = true;
  durable_ingest_log read_log(read_options);
  const auto records = read_log.read_durable_records();
  require(records.size() == bundle.durable_record_count, "offhost_fixture_record_count_mismatch");
  projection_bootstrap_store projection(
      fixture_projection_options(restore_root, bundle.stream_id, bundle.container_epoch, bundle.qualification_profile),
      fixture_projector);
  require(!fs::exists(projection.snapshot_path()), "offhost_fixture_projection_was_restored_instead_of_rebuilt");
  const auto projected = projection.rebuild(records);
  require(projected.through_position == bundle.backup_cut, "offhost_fixture_projection_cut_mismatch");

  json episode_reports = json::array();
  for (const auto &episode : bundle.episodes) {
    storage_fsck_request request{};
    request.runtime_dir = restore_root.string();
    request.scope = storage_fsck_scope::Episode;
    request.episode_id = episode.episode_id;
    request.verify_frames = true;
    const auto checked = default_storage_service().fsck(request);
    require(checked.qualification.has_value() && checked.qualification->status == "ok" &&
                checked.qualification->lifecycle == "ended",
            "offhost_fixture_episode_fsck_failed");
    episode_reports.push_back({{"episode_id", episode.episode_id},
                               {"status", checked.qualification->status},
                               {"lifecycle", checked.qualification->lifecycle}});
  }

  const auto repeated = engine.restore_backup(bundle);
  require(repeated.status == maintenance_status::AlreadyCompleted && !repeated.mutation_performed &&
              repeated.error.empty(),
          "offhost_fixture_repeated_restore_not_idempotent");
  return {{"schema", "kungfu.offhost-backup-fixture-report/v1"},
          {"mode", "restore"},
          {"qualification_profile", bundle.qualification_profile},
          {"bundle_id", bundle.bundle_id},
          {"manifest_sha256", loaded.manifest_sha256},
          {"restored_cut", position_json(restored.restored_cut)},
          {"durable_record_count", records.size()},
          {"restored_file_count", restored.restored_file_count},
          {"restored_bytes", restored.restored_bytes},
          {"records", record_json(records)},
          {"episodes", std::move(episode_reports)},
          {"projection_state", projected.state},
          {"projection_integrity_sha256", projected.integrity_sha256},
          {"projection_cut", position_json(projected.through_position)},
          {"repeated_restore_idempotent", true},
          {"off_host_verified", true},
          {"independent_failure_domain_qualified", false},
          {"production_eligible", false}};
}

} // namespace

int main(int argc, char **argv) {
  try {
    const auto args = arguments(argc, argv);
    const auto mode = required(args, "mode");
    json report;
    if (mode == "export") {
      report = export_fixture(required(args, "source-root"), required(args, "store-root"));
    } else if (mode == "verify") {
      report = verify_package(required(args, "package"));
    } else if (mode == "restore") {
      report = restore_fixture(required(args, "package"), required(args, "restore-root"));
    } else if (mode == "reopen") {
      report = reopen_fixture(required(args, "source-root"));
    } else {
      throw std::invalid_argument("unsupported offhost fixture mode");
    }
    write_report(required(args, "report"), report);
    std::cout << report.dump(-1, ' ', false) << '\n';
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
