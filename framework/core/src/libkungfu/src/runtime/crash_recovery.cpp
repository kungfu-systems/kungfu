// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/crash_recovery.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <tuple>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace kungfu::runtime::recovery {
namespace {

namespace fs = std::filesystem;
using yijinjing::storage::compute_content_hash_value;
using yijinjing::storage::episode_content_root_status;

std::string read_bytes(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("recovery_evidence_read_failed");
  }
  std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  if (input.bad()) {
    throw std::runtime_error("recovery_evidence_read_failed");
  }
  return bytes;
}

std::string digest(const std::string &bytes) { return compute_content_hash_value(bytes); }

template <typename FixedString> std::string fixed_text(const FixedString &value) { return value.to_string(); }

bool has_prefix(const fs::path &path, std::initializer_list<const char *> components) {
  auto current = path.begin();
  for (const auto *component : components) {
    if (current == path.end() || current->generic_string() != component) {
      return false;
    }
    ++current;
  }
  return true;
}

bool is_content_store_temp_path(const fs::path &relative) {
  auto component = relative.begin();
  if (component == relative.end() || component->generic_string() != "storage") {
    return false;
  }
  ++component;
  if (component == relative.end()) {
    return false;
  }
  ++component;
  return component != relative.end() && component->generic_string() == "tmp";
}

bool is_backup_excluded_path(const fs::path &relative) {
  return has_prefix(relative, {"ownership"}) || has_prefix(relative, {"durable", "quarantine"}) ||
         has_prefix(relative, {"storage", "projections"}) || is_content_store_temp_path(relative) ||
         has_prefix(relative, {".kungfu", "durability", "projections"}) ||
         has_prefix(relative, {".kungfu", "recovery"});
}

bool is_safe_relative_path(const fs::path &relative) {
  if (relative.empty() || relative.is_absolute() || relative.has_root_path() ||
      relative != relative.lexically_normal()) {
    return false;
  }
  for (const auto &component : relative) {
    if (component == "." || component == ".." || component.empty()) {
      return false;
    }
  }
  return !is_backup_excluded_path(relative) && !relative.filename().generic_string().ends_with(".pending");
}

std::vector<backup_file_material> scan_backup_files(const fs::path &root) {
  std::vector<backup_file_material> files;
  if (!fs::is_directory(root)) {
    throw std::runtime_error("recovery_backup_data_root_missing");
  }
  for (auto iterator = fs::recursive_directory_iterator(root); iterator != fs::recursive_directory_iterator();
       ++iterator) {
    const auto relative = fs::relative(iterator->path(), root).lexically_normal();
    if (iterator->is_symlink()) {
      throw std::runtime_error("recovery_backup_symlink_entry");
    }
    if (is_backup_excluded_path(relative)) {
      if (iterator->is_directory()) {
        iterator.disable_recursion_pending();
      }
      continue;
    }
    if (iterator->is_directory()) {
      continue;
    }
    if (!iterator->is_regular_file() || !is_safe_relative_path(relative)) {
      throw std::runtime_error("recovery_backup_unsafe_or_unknown_entry");
    }
    auto bytes = read_bytes(iterator->path());
    files.push_back({relative.generic_string(), bytes.size(), digest(bytes), std::move(bytes)});
  }
  std::sort(files.begin(), files.end(),
            [](const auto &left, const auto &right) { return left.relative_path < right.relative_path; });
  return files;
}

std::vector<episode_backup_identity> capture_episode_identities(const std::string &data_root) {
  const auto &storage = storage_service_api::default_storage_service();
  const auto listed = storage.episode_list(storage_service_api::storage_episode_list_request{data_root, 0, 0});
  if (listed.unknown_record_count != 0) {
    throw std::runtime_error("recovery_backup_episode_unknown_records");
  }

  std::vector<episode_backup_identity> identities;
  identities.reserve(listed.episodes.size());
  for (const auto &episode : listed.episodes) {
    if (!episode.opened || !episode.closed || episode.open_count != 1 || episode.close_count != 1) {
      throw std::runtime_error("recovery_backup_episode_not_sealed");
    }
    storage_service_api::storage_episode_inspect_request request{};
    request.runtime_dir = data_root;
    request.episode_id = episode.episode_id;
    const auto inspected = storage.episode_inspect(request);
    if (inspected.unknown_record_count != 0 || inspected.content_root.status != episode_content_root_status::Verified ||
        !inspected.content_root.match.value_or(false) || !inspected.content_root.computed.has_value()) {
      throw std::runtime_error("recovery_backup_episode_identity_unverified");
    }
    if (!inspected.qualification.has_value() || inspected.qualification->status != "ok") {
      throw std::runtime_error("recovery_backup_episode_payload_unverified");
    }

    episode_backup_identity identity;
    identity.episode_id = episode.episode_id;
    identity.closed = true;
    identity.content_root_algorithm = inspected.content_root.computed->algorithm;
    identity.content_root_value = inspected.content_root.computed->value;
    for (size_t position = 0; position < inspected.episode.ref_indices.size(); ++position) {
      const auto &ref = inspected.episode.ref_at(position);
      if (ref.ref_kind == yijinjing::enums::EpisodeRefKind::Payload) {
        identity.payload_hashes.push_back(fixed_text(ref.ref_hash));
      }
    }
    std::sort(identity.payload_hashes.begin(), identity.payload_hashes.end());
    identities.push_back(std::move(identity));
  }
  std::sort(identities.begin(), identities.end(),
            [](const auto &left, const auto &right) { return left.episode_id < right.episode_id; });
  return identities;
}

void append_identity_text(std::ostringstream &identity, const std::string &value) {
  identity << value.size() << ':' << value << '\n';
}

std::string backup_identity(const recovery_backup_bundle &bundle) {
  std::ostringstream identity;
  append_identity_text(identity, bundle.schema);
  identity << bundle.stream_id << '\n' << bundle.container_epoch << '\n';
  if (bundle.backup_cut.has_value()) {
    const auto &cut = *bundle.backup_cut;
    identity << cut.stream_id << ':' << cut.container_epoch << ':' << cut.sequence << ':' << cut.frame_uid;
  }
  identity << '\n'
           << bundle.durable_record_count << '\n'
           << bundle.lost_visible_tail_bytes << '\n'
           << bundle.projection_rebuild_required << '\n';
  append_identity_text(identity, bundle.rpo_boundary);
  append_identity_text(identity, bundle.qualification_profile);
  for (const auto &file : bundle.files) {
    append_identity_text(identity, file.relative_path);
    identity << file.size << '\n';
    append_identity_text(identity, file.sha256);
  }
  for (const auto &episode : bundle.episodes) {
    identity << episode.episode_id << '\n' << episode.closed << '\n';
    append_identity_text(identity, episode.content_root_algorithm);
    append_identity_text(identity, episode.content_root_value);
    for (const auto &payload_hash : episode.payload_hashes) {
      append_identity_text(identity, payload_hash);
    }
    identity << "episode-end\n";
  }
  return digest(identity.str());
}

bool valid_backup_identity(const recovery_backup_bundle &bundle) {
  return bundle.schema == RECOVERY_BACKUP_SCHEMA_V1 && !bundle.bundle_id.empty() &&
         bundle.bundle_id == backup_identity(bundle) && bundle.backup_cut.has_value() &&
         bundle.durable_record_count != 0 && !bundle.files.empty();
}

bool valid_backup_report_position(const recovery_backup_bundle &bundle) {
  const auto &report = bundle.source_report;
  return report.outcome == recovery_outcome::Ready && report.schema == RECOVERY_REPORT_SCHEMA_V1 &&
         bundle.backup_cut->stream_id == bundle.stream_id &&
         bundle.backup_cut->container_epoch == bundle.container_epoch && report.stream_id == bundle.stream_id &&
         report.container_epoch == bundle.container_epoch && report.durable_frontier == bundle.backup_cut &&
         report.durable_record_count == bundle.durable_record_count;
}

bool valid_backup_report_evidence(const recovery_backup_bundle &bundle) {
  const auto &report = bundle.source_report;
  const std::vector<recovery_phase> completed_phases = {recovery_phase::Discover, recovery_phase::Verify,
                                                        recovery_phase::Select, recovery_phase::Classify,
                                                        recovery_phase::Report};
  return report.completed_phases == completed_phases &&
         report.unacknowledged_tail_bytes == bundle.lost_visible_tail_bytes &&
         report.unacknowledged_tail_integrity == durability::tail_integrity::None &&
         report.evidence_error == durability::ingest_error::None && report.evidence_message.empty() &&
         report.qualification_passed && report.episode_unknown_record_count == 0 &&
         report.interrupted_episodes.empty() && report.episode_findings.empty() && !report.mutation_performed;
}

bool valid_backup_policy(const recovery_backup_bundle &bundle) {
  const std::vector<std::string> restart_order = {"supervisor", "state_service", "projection", "peers"};
  return bundle.source_report.restart_order == restart_order && bundle.lost_visible_tail_bytes == 0 &&
         bundle.rpo_boundary == "through-checkpoint-covered-durable-frontier" &&
         bundle.qualification_profile == bundle.source_report.qualification_profile &&
         bundle.projection_rebuild_required;
}

void validate_backup_contract(const recovery_backup_bundle &bundle) {
  if (!valid_backup_identity(bundle) || !valid_backup_report_position(bundle) ||
      !valid_backup_report_evidence(bundle) || !valid_backup_policy(bundle)) {
    throw std::runtime_error("recovery_backup_bundle_identity_invalid");
  }
}

void validate_backup_files(const recovery_backup_bundle &bundle) {
  std::string previous_path;
  for (const auto &file : bundle.files) {
    const fs::path relative(file.relative_path);
    if (!is_safe_relative_path(relative) || (!previous_path.empty() && file.relative_path <= previous_path) ||
        file.size != file.bytes.size() || file.sha256 != digest(file.bytes)) {
      throw std::runtime_error("recovery_backup_file_invalid");
    }
    previous_path = file.relative_path;
  }
}

void validate_episode_payloads(const recovery_backup_bundle &bundle, const episode_backup_identity &episode) {
  for (const auto &payload_hash : episode.payload_hashes) {
    constexpr size_t SHA256_HEX_SIZE = 64;
    const std::string prefix = "sha256:";
    const auto value = payload_hash.starts_with(prefix) ? payload_hash.substr(prefix.size()) : std::string{};
    const bool lowercase_hex =
        value.size() == SHA256_HEX_SIZE && std::ranges::all_of(value, [](unsigned char character) {
          return std::isdigit(character) != 0 ||
                 (character >= static_cast<unsigned char>('a') && character <= static_cast<unsigned char>('f'));
        });
    const auto payload_path =
        fs::path("storage") / "payloads" / value.substr(0, std::min<size_t>(2, value.size())) / value;
    const auto material = std::find_if(bundle.files.begin(), bundle.files.end(), [&payload_path](const auto &file) {
      return file.relative_path == payload_path.generic_string();
    });
    if (!lowercase_hex || material == bundle.files.end() || material->sha256 != value)
      throw std::runtime_error("recovery_backup_episode_payload_invalid");
  }
}

void validate_backup_episodes(const recovery_backup_bundle &bundle) {
  uint64_t previous_episode = 0;
  bool first_episode = true;
  for (const auto &episode : bundle.episodes) {
    if (!episode.closed || episode.content_root_algorithm.empty() || episode.content_root_value.empty() ||
        (!first_episode && episode.episode_id <= previous_episode) ||
        !std::is_sorted(episode.payload_hashes.begin(), episode.payload_hashes.end())) {
      throw std::runtime_error("recovery_backup_episode_identity_invalid");
    }
    validate_episode_payloads(bundle, episode);
    first_episode = false;
    previous_episode = episode.episode_id;
  }
}

void validate_backup_bundle(const recovery_backup_bundle &bundle) {
  validate_backup_contract(bundle);
  validate_backup_files(bundle);
  validate_backup_episodes(bundle);
}

using json = nlohmann::json;

bool has_exact_keys(const json &value, const std::set<std::string> &expected) {
  if (!value.is_object() || value.size() != expected.size()) {
    return false;
  }
  return std::ranges::all_of(value.items(), [&expected](const auto &item) { return expected.contains(item.key()); });
}

json position_json(const durability::stream_position &position) {
  return {{"stream_id", position.stream_id},
          {"container_epoch", position.container_epoch},
          {"sequence", position.sequence},
          {"frame_uid", position.frame_uid}};
}

json backup_package_manifest(const recovery_backup_bundle &bundle) {
  json files = json::array();
  for (const auto &file : bundle.files) {
    files.push_back({{"relative_path", file.relative_path}, {"size", file.size}, {"sha256", file.sha256}});
  }
  json episodes = json::array();
  for (const auto &episode : bundle.episodes) {
    episodes.push_back({{"episode_id", episode.episode_id},
                        {"closed", episode.closed},
                        {"content_root_algorithm", episode.content_root_algorithm},
                        {"content_root_value", episode.content_root_value},
                        {"payload_hashes", episode.payload_hashes}});
  }
  return {{"schema", RECOVERY_BACKUP_PACKAGE_SCHEMA_V1},
          {"backup_schema", bundle.schema},
          {"bundle_id", bundle.bundle_id},
          {"stream_id", bundle.stream_id},
          {"container_epoch", bundle.container_epoch},
          {"backup_cut", position_json(*bundle.backup_cut)},
          {"durable_record_count", bundle.durable_record_count},
          {"lost_visible_tail_bytes", bundle.lost_visible_tail_bytes},
          {"rpo_boundary", bundle.rpo_boundary},
          {"qualification_profile", bundle.qualification_profile},
          {"projection_rebuild_required", bundle.projection_rebuild_required},
          {"source_report",
           {{"schema", bundle.source_report.schema},
            {"outcome", recovery_outcome_name(bundle.source_report.outcome)},
            {"qualification_passed", bundle.source_report.qualification_passed},
            {"restart_order", bundle.source_report.restart_order}}},
          {"files", std::move(files)},
          {"episodes", std::move(episodes)}};
}

std::string canonical_document(const json &value) { return value.dump(2, ' ', false) + '\n'; }

void write_new_file(const fs::path &path, const std::string &bytes) {
  if (fs::exists(path)) {
    throw std::runtime_error("recovery_backup_package_path_exists");
  }
  fs::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  output.flush();
  if (!output) {
    throw std::runtime_error("recovery_backup_package_write_failed");
  }
  output.close();
#ifdef _WIN32
  const auto handle =
      CreateFileW(path.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(),
                            "recovery_backup_package_file_open_failed");
  }
  const auto synced = FlushFileBuffers(handle);
  const auto error = GetLastError();
  CloseHandle(handle);
  if (synced == 0) {
    throw std::system_error(static_cast<int>(error), std::system_category(),
                            "recovery_backup_package_file_sync_failed");
  }
#else
  const auto fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    throw std::system_error(errno, std::generic_category(), "recovery_backup_package_file_open_failed");
  }
  const auto synced = ::fsync(fd);
  const auto error = errno;
  ::close(fd);
  if (synced != 0) {
    throw std::system_error(error, std::generic_category(), "recovery_backup_package_file_sync_failed");
  }
#endif
}

void sync_backup_directory(const fs::path &directory) {
#ifdef _WIN32
  const auto handle =
      CreateFileW(directory.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                  nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(),
                            "recovery_backup_package_directory_open_failed");
  }
  const auto synced = FlushFileBuffers(handle);
  const auto error = GetLastError();
  CloseHandle(handle);
  if (synced == 0) {
    throw std::system_error(static_cast<int>(error), std::system_category(),
                            "recovery_backup_package_directory_sync_failed");
  }
#else
  const auto fd = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) {
    throw std::system_error(errno, std::generic_category(), "recovery_backup_package_directory_open_failed");
  }
  const auto synced = ::fsync(fd);
  const auto error = errno;
  ::close(fd);
  if (synced != 0) {
    throw std::system_error(error, std::generic_category(), "recovery_backup_package_directory_sync_failed");
  }
#endif
}

void sync_backup_directory_tree(const fs::path &root) {
  std::vector<fs::path> directories = {root};
  for (const auto &entry : fs::recursive_directory_iterator(root)) {
    if (entry.is_directory() && !entry.is_symlink()) {
      directories.push_back(entry.path());
    }
  }
  std::sort(directories.begin(), directories.end(), [](const auto &left, const auto &right) {
    return std::distance(left.begin(), left.end()) > std::distance(right.begin(), right.end());
  });
  for (const auto &directory : directories) {
    sync_backup_directory(directory);
  }
}

json parse_json_document(const std::string &bytes, const char *error) {
  try {
    return json::parse(bytes);
  } catch (const json::exception &) {
    throw std::runtime_error(error);
  }
}

durability::stream_position parse_package_position(const json &value) {
  if (!has_exact_keys(value, {"stream_id", "container_epoch", "sequence", "frame_uid"})) {
    throw std::runtime_error("recovery_backup_package_manifest_invalid");
  }
  try {
    return {value.at("stream_id").get<uint64_t>(), value.at("container_epoch").get<uint64_t>(),
            value.at("sequence").get<uint64_t>(), value.at("frame_uid").get<uint64_t>()};
  } catch (const json::exception &) {
    throw std::runtime_error("recovery_backup_package_manifest_invalid");
  }
}

recovery_backup_bundle parse_backup_package_manifest(const json &manifest, const fs::path &package) {
  const std::set<std::string> manifest_keys = {"schema",
                                               "backup_schema",
                                               "bundle_id",
                                               "stream_id",
                                               "container_epoch",
                                               "backup_cut",
                                               "durable_record_count",
                                               "lost_visible_tail_bytes",
                                               "rpo_boundary",
                                               "qualification_profile",
                                               "projection_rebuild_required",
                                               "source_report",
                                               "files",
                                               "episodes"};
  if (!has_exact_keys(manifest, manifest_keys) ||
      !has_exact_keys(manifest.at("source_report"), {"schema", "outcome", "qualification_passed", "restart_order"}) ||
      !manifest.at("files").is_array() || !manifest.at("episodes").is_array()) {
    throw std::runtime_error("recovery_backup_package_manifest_invalid");
  }

  recovery_backup_bundle bundle;
  try {
    if (manifest.at("schema").get<std::string>() != RECOVERY_BACKUP_PACKAGE_SCHEMA_V1) {
      throw std::runtime_error("recovery_backup_package_schema_unsupported");
    }
    bundle.schema = manifest.at("backup_schema").get<std::string>();
    bundle.bundle_id = manifest.at("bundle_id").get<std::string>();
    bundle.stream_id = manifest.at("stream_id").get<uint64_t>();
    bundle.container_epoch = manifest.at("container_epoch").get<uint64_t>();
    bundle.backup_cut = parse_package_position(manifest.at("backup_cut"));
    bundle.durable_record_count = manifest.at("durable_record_count").get<uint64_t>();
    bundle.lost_visible_tail_bytes = manifest.at("lost_visible_tail_bytes").get<uint64_t>();
    bundle.rpo_boundary = manifest.at("rpo_boundary").get<std::string>();
    bundle.qualification_profile = manifest.at("qualification_profile").get<std::string>();
    bundle.projection_rebuild_required = manifest.at("projection_rebuild_required").get<bool>();

    const auto &source = manifest.at("source_report");
    if (source.at("schema").get<std::string>() != RECOVERY_REPORT_SCHEMA_V1 ||
        source.at("outcome").get<std::string>() != "ready" || !source.at("qualification_passed").get<bool>() ||
        source.at("restart_order").get<std::vector<std::string>>() !=
            std::vector<std::string>{"supervisor", "state_service", "projection", "peers"}) {
      throw std::runtime_error("recovery_backup_package_source_report_invalid");
    }
    bundle.source_report.schema = RECOVERY_REPORT_SCHEMA_V1;
    bundle.source_report.outcome = recovery_outcome::Ready;
    bundle.source_report.completed_phases = {recovery_phase::Discover, recovery_phase::Verify, recovery_phase::Select,
                                             recovery_phase::Classify, recovery_phase::Report};
    bundle.source_report.stream_id = bundle.stream_id;
    bundle.source_report.container_epoch = bundle.container_epoch;
    bundle.source_report.durable_frontier = bundle.backup_cut;
    bundle.source_report.durable_record_count = bundle.durable_record_count;
    bundle.source_report.unacknowledged_tail_bytes = bundle.lost_visible_tail_bytes;
    bundle.source_report.unacknowledged_tail_integrity = durability::tail_integrity::None;
    bundle.source_report.evidence_error = durability::ingest_error::None;
    bundle.source_report.qualification_profile = bundle.qualification_profile;
    bundle.source_report.qualification_passed = true;

    for (const auto &value : manifest.at("files")) {
      if (!has_exact_keys(value, {"relative_path", "size", "sha256"})) {
        throw std::runtime_error("recovery_backup_package_manifest_invalid");
      }
      backup_file_material file;
      file.relative_path = value.at("relative_path").get<std::string>();
      file.size = value.at("size").get<uint64_t>();
      file.sha256 = value.at("sha256").get<std::string>();
      const fs::path relative(file.relative_path);
      if (!is_safe_relative_path(relative)) {
        throw std::runtime_error("recovery_backup_package_file_invalid");
      }
      const auto material = package / "data" / relative;
      if (!fs::is_regular_file(material) || fs::is_symlink(material)) {
        throw std::runtime_error("recovery_backup_package_file_missing");
      }
      file.bytes = read_bytes(material);
      if (file.bytes.size() != file.size || digest(file.bytes) != file.sha256) {
        throw std::runtime_error("recovery_backup_package_file_invalid");
      }
      bundle.files.push_back(std::move(file));
    }

    for (const auto &value : manifest.at("episodes")) {
      if (!has_exact_keys(value,
                          {"episode_id", "closed", "content_root_algorithm", "content_root_value", "payload_hashes"})) {
        throw std::runtime_error("recovery_backup_package_manifest_invalid");
      }
      bundle.episodes.push_back({value.at("episode_id").get<uint64_t>(), value.at("closed").get<bool>(),
                                 value.at("content_root_algorithm").get<std::string>(),
                                 value.at("content_root_value").get<std::string>(),
                                 value.at("payload_hashes").get<std::vector<std::string>>()});
    }
  } catch (const json::exception &) {
    throw std::runtime_error("recovery_backup_package_manifest_invalid");
  }
  validate_backup_bundle(bundle);
  return bundle;
}

void validate_backup_package_file_set(const fs::path &package, const recovery_backup_bundle &bundle) {
  std::set<std::string> expected_files = {"manifest.json", "complete.json"};
  std::set<std::string> expected_directories = {"data"};
  for (const auto &file : bundle.files) {
    const auto packaged = (fs::path("data") / file.relative_path).lexically_normal();
    expected_files.insert(packaged.generic_string());
    auto parent = packaged.parent_path();
    while (!parent.empty()) {
      expected_directories.insert(parent.generic_string());
      parent = parent.parent_path();
    }
  }
  for (auto iterator = fs::recursive_directory_iterator(package); iterator != fs::recursive_directory_iterator();
       ++iterator) {
    const auto relative = fs::relative(iterator->path(), package).lexically_normal().generic_string();
    if (iterator->is_symlink()) {
      throw std::runtime_error("recovery_backup_package_symlink_entry");
    }
    if (iterator->is_directory()) {
      if (!expected_directories.contains(relative)) {
        throw std::runtime_error("recovery_backup_package_extra_entry");
      }
    } else if (!iterator->is_regular_file() || !expected_files.erase(relative)) {
      throw std::runtime_error("recovery_backup_package_extra_entry");
    }
  }
  if (!expected_files.empty()) {
    throw std::runtime_error("recovery_backup_package_file_missing");
  }
}

std::string complete_document(const recovery_backup_bundle &bundle, const std::string &manifest_sha256) {
  return canonical_document({{"schema", RECOVERY_BACKUP_COMPLETE_SCHEMA_V1},
                             {"bundle_id", bundle.bundle_id},
                             {"manifest_sha256", manifest_sha256}});
}

std::string restore_receipt_bytes(const recovery_backup_bundle &bundle) {
  std::ostringstream receipt;
  receipt << "schema=kungfu.recovery-restore-receipt/v1\n"
          << "status=completed\n"
          << "bundle_id=" << bundle.bundle_id << '\n'
          << "stream_id=" << bundle.stream_id << '\n'
          << "container_epoch=" << bundle.container_epoch << '\n'
          << "durable_record_count=" << bundle.durable_record_count << '\n'
          << "lost_visible_tail_bytes=" << bundle.lost_visible_tail_bytes << '\n'
          << "projection_rebuild_required=true\n";
  if (bundle.backup_cut.has_value()) {
    const auto &cut = *bundle.backup_cut;
    receipt << "backup_cut=" << cut.stream_id << ':' << cut.container_epoch << ':' << cut.sequence << ':'
            << cut.frame_uid << '\n';
  }
  return receipt.str();
}

fs::path restore_receipt_path(const fs::path &root, const recovery_backup_bundle &bundle) {
  return root / ".kungfu" / "recovery" / (bundle.bundle_id + ".receipt");
}

std::set<std::string> allowed_restore_directories(const recovery_backup_bundle &bundle) {
  std::set<std::string> allowed = {"ownership"};
  for (const auto &file : bundle.files) {
    auto parent = fs::path(file.relative_path).parent_path();
    while (!parent.empty()) {
      allowed.insert(parent.generic_string());
      parent = parent.parent_path();
    }
  }
  return allowed;
}

void validate_restore_destination(const fs::path &root, const recovery_backup_bundle &bundle) {
  const std::set<std::string> expected_files = [&bundle] {
    std::set<std::string> paths;
    for (const auto &file : bundle.files) {
      paths.insert(file.relative_path);
      paths.insert(file.relative_path + ".pending");
    }
    return paths;
  }();
  auto allowed_directories = allowed_restore_directories(bundle);
  allowed_directories.insert(".kungfu");
  allowed_directories.insert(".kungfu/durability");
  allowed_directories.insert("storage");
  allowed_directories.insert("durable");

  for (auto iterator = fs::recursive_directory_iterator(root); iterator != fs::recursive_directory_iterator();
       ++iterator) {
    const auto relative = fs::relative(iterator->path(), root).lexically_normal();
    const auto relative_text = relative.generic_string();
    if (iterator->is_symlink()) {
      throw std::runtime_error("recovery_restore_symlink_entry");
    }
    if (has_prefix(relative, {"ownership"})) {
      if (iterator->is_directory()) {
        continue;
      }
      continue;
    }
    if (iterator->is_directory()) {
      if (!allowed_directories.contains(relative_text)) {
        throw std::runtime_error("recovery_restore_destination_not_empty");
      }
      continue;
    }
    if (!iterator->is_regular_file() || !expected_files.contains(relative_text)) {
      throw std::runtime_error("recovery_restore_destination_not_empty");
    }
  }
}

void validate_completed_restore_destination(const fs::path &root, const recovery_backup_bundle &bundle) {
  std::set<std::string> expected_files;
  for (const auto &file : bundle.files) {
    expected_files.insert(file.relative_path);
  }
  auto allowed_directories = allowed_restore_directories(bundle);
  allowed_directories.insert(".kungfu");
  allowed_directories.insert(".kungfu/durability");
  allowed_directories.insert("storage");
  allowed_directories.insert("durable");
  for (auto iterator = fs::recursive_directory_iterator(root); iterator != fs::recursive_directory_iterator();
       ++iterator) {
    const auto relative = fs::relative(iterator->path(), root).lexically_normal();
    const auto relative_text = relative.generic_string();
    if (iterator->is_symlink()) {
      throw std::runtime_error("recovery_restore_symlink_entry");
    }
    if (is_backup_excluded_path(relative)) {
      continue;
    }
    if (iterator->is_directory()) {
      if (!allowed_directories.contains(relative_text)) {
        throw std::runtime_error("recovery_restore_completed_root_has_extra_authority");
      }
      continue;
    }
    if (!iterator->is_regular_file() || !expected_files.contains(relative_text)) {
      throw std::runtime_error("recovery_restore_completed_root_has_extra_authority");
    }
  }
}

bool restored_files_match(const fs::path &root, const recovery_backup_bundle &bundle) {
  return std::ranges::all_of(bundle.files, [&root](const auto &file) {
    const auto destination = root / fs::path(file.relative_path);
    return fs::is_regular_file(destination) && !fs::is_symlink(destination) &&
           fs::file_size(destination) == file.size && digest(read_bytes(destination)) == file.sha256;
  });
}

bool is_stream_evidence_name(const std::string &name) {
  if (name == "checkpoint.0" || name == "checkpoint.1") {
    return true;
  }
  const auto prefix_size = name.starts_with("active-")   ? std::string("active-").size()
                           : name.starts_with("sealed-") ? std::string("sealed-").size()
                                                         : 0;
  if (prefix_size == 0 || !name.ends_with(".kfdl")) {
    return false;
  }
  const auto id = name.substr(prefix_size, name.size() - prefix_size - std::string(".kfdl").size());
  return !id.empty() && std::ranges::all_of(id, [](unsigned char value) { return std::isdigit(value) != 0; });
}

fs::path stream_directory(const durability::ingest_options &options) {
  return fs::absolute(options.data_root).lexically_normal() / "durable" / "streams" /
         std::to_string(options.stream_id) / std::to_string(options.container_epoch);
}

std::string preview_identity(const quarantine_preview &preview) {
  std::ostringstream identity;
  identity << preview.schema << '\n' << preview.stream_id << '\n' << preview.container_epoch << '\n';
  if (preview.durable_frontier.has_value()) {
    const auto &frontier = *preview.durable_frontier;
    identity << frontier.stream_id << ':' << frontier.container_epoch << ':' << frontier.sequence << ':'
             << frontier.frame_uid;
  }
  identity << '\n'
           << preview.unacknowledged_tail_bytes << '\n'
           << static_cast<unsigned>(preview.unacknowledged_tail_integrity) << '\n'
           << preview.source_digest << '\n';
  return identity.str();
}

std::string receipt_bytes(const quarantine_preview &preview) {
  std::ostringstream receipt;
  receipt << "schema=kungfu.recovery-maintenance-receipt/v1\n"
          << "status=completed\n"
          << "plan_id=" << preview.plan_id << '\n'
          << "source_digest=" << preview.source_digest << '\n'
          << "source_mutation_performed=false\n"
          << "retained_file_count=" << preview.files.size() << '\n';
  for (const auto &file : preview.files) {
    receipt << "file_name_sha256=" << digest(file.name) << '\t' << file.size << '\t' << file.sha256 << '\n';
  }
  return receipt.str();
}

bool retained_package_matches(const fs::path &package, const quarantine_preview &preview) {
  std::set<std::string> expected_files = {"receipt.txt"};
  for (const auto &file : preview.files) {
    expected_files.insert(file.name);
    const auto retained = package / file.name;
    if (!fs::is_regular_file(retained) || fs::file_size(retained) != file.size ||
        digest(read_bytes(retained)) != file.sha256) {
      return false;
    }
  }
  const auto receipt = package / "receipt.txt";
  if (!fs::is_regular_file(receipt) || read_bytes(receipt) != receipt_bytes(preview)) {
    return false;
  }
  return std::ranges::all_of(fs::directory_iterator(package), [&expected_files](const auto &entry) {
    return !entry.is_symlink() && entry.is_regular_file() && expected_files.contains(entry.path().filename().string());
  });
}

bool valid_partial_retained_package(const fs::path &package, const quarantine_preview &preview) {
  std::set<std::string> expected_files;
  std::set<std::string> pending_files = {"receipt.txt.pending"};
  for (const auto &file : preview.files) {
    expected_files.insert(file.name);
    pending_files.insert(file.name + ".pending");
  }
  for (const auto &entry : fs::directory_iterator(package)) {
    if (entry.is_symlink() || !entry.is_regular_file()) {
      return false;
    }
    const auto name = entry.path().filename().string();
    if (pending_files.contains(name)) {
      continue;
    }
    const auto expected = std::find_if(preview.files.begin(), preview.files.end(),
                                       [&name](const auto &file) { return file.name == name; });
    if (!expected_files.contains(name) || expected == preview.files.end() ||
        fs::file_size(entry.path()) != expected->size || digest(read_bytes(entry.path())) != expected->sha256) {
      return false;
    }
  }
  return true;
}

} // namespace

using durability::durable_ingest_log;
using durability::ingest_error;
using durability::tail_integrity;
using storage_service_api::storage_episode_list_request;
using storage_service_api::storage_fsck_request;
using storage_service_api::storage_fsck_scope;

recovery_engine::recovery_engine(durability::ingest_options options) : options_(std::move(options)) {
  options_.read_only = true;
}

recovery_report recovery_engine::inspect() const {
  recovery_report report;
  report.stream_id = options_.stream_id;
  report.container_epoch = options_.container_epoch;
  report.qualification_profile = options_.qualification_profile;
  report.completed_phases.push_back(recovery_phase::Discover);
  try {
    durable_ingest_log log(options_);
    const auto status = log.status();
    report.durable_frontier = status.durable_watermark;
    report.durable_record_count = log.read_durable_records().size();
    report.unacknowledged_tail_bytes = status.unacknowledged_tail_bytes;
    report.unacknowledged_tail_integrity = status.unacknowledged_tail_integrity;
    report.evidence_error = status.last_error;
    report.evidence_message = status.last_error_message;
    report.qualification_profile = status.qualification_profile;
    report.qualification_passed = status.qualification_passed;
    const auto &storage = storage_service_api::default_storage_service();
    const auto episodes = storage.episode_list(storage_episode_list_request{options_.data_root, 0, 0});
    report.episode_unknown_record_count = episodes.unknown_record_count;
    for (const auto &episode : episodes.episodes) {
      if (!episode.opened) {
        continue;
      }
      storage_fsck_request request{};
      request.runtime_dir = options_.data_root;
      request.scope = storage_fsck_scope::Episode;
      request.episode_id = episode.episode_id;
      request.verify_frames = true;
      const auto fsck = storage.fsck(request);
      if (!fsck.qualification.has_value()) {
        throw std::runtime_error("recovery_episode_qualification_missing");
      }
      if (!episode.closed) {
        report.interrupted_episodes.push_back(*fsck.qualification);
      }
      if (!episode.closed || fsck.qualification->status != "ok") {
        report.episode_findings.push_back(*fsck.qualification);
      }
    }
    report.completed_phases.push_back(recovery_phase::Verify);
    report.completed_phases.push_back(recovery_phase::Select);
    report.completed_phases.push_back(recovery_phase::Classify);

    const bool episode_blocked =
        report.episode_unknown_record_count != 0 ||
        std::any_of(report.episode_findings.begin(), report.episode_findings.end(),
                    [](const auto &qualification) { return qualification.status == "failed"; });
    const bool episode_degraded =
        !report.episode_findings.empty() ||
        std::any_of(report.episode_findings.begin(), report.episode_findings.end(),
                    [](const auto &qualification) { return qualification.status == "degraded"; });
    if (!status.available || episode_blocked ||
        (!status.durable_watermark.has_value() && status.last_error == ingest_error::CheckpointCorrupt)) {
      report.outcome = recovery_outcome::Blocked;
    } else if (status.unacknowledged_tail_integrity != tail_integrity::None ||
               status.last_error != ingest_error::None || episode_degraded) {
      report.outcome = recovery_outcome::Degraded;
    } else {
      report.outcome = recovery_outcome::Ready;
    }
  } catch (const std::exception &error) {
    report.outcome = recovery_outcome::Blocked;
    report.evidence_error = ingest_error::IoError;
    report.evidence_message = error.what();
  }
  report.completed_phases.push_back(recovery_phase::Report);
  return report;
}

std::optional<quarantine_preview> recovery_engine::preview_quarantine() const {
  const auto report = inspect();
  if (report.outcome != recovery_outcome::Degraded || report.unacknowledged_tail_bytes == 0) {
    return std::nullopt;
  }

  quarantine_preview preview;
  preview.stream_id = report.stream_id;
  preview.container_epoch = report.container_epoch;
  preview.durable_frontier = report.durable_frontier;
  preview.unacknowledged_tail_bytes = report.unacknowledged_tail_bytes;
  preview.unacknowledged_tail_integrity = report.unacknowledged_tail_integrity;
  const auto directory = stream_directory(options_);
  for (const auto &entry : fs::directory_iterator(directory)) {
    const auto name = entry.path().filename().string();
    if (entry.is_symlink() || !entry.is_regular_file() || !is_stream_evidence_name(name)) {
      throw std::runtime_error("recovery_quarantine_unknown_stream_entry");
    }
    const auto bytes = read_bytes(entry.path());
    preview.files.push_back({name, bytes.size(), digest(bytes)});
  }
  std::sort(preview.files.begin(), preview.files.end(),
            [](const auto &left, const auto &right) { return left.name < right.name; });
  std::ostringstream source_identity;
  for (const auto &file : preview.files) {
    source_identity << file.name.size() << ':' << file.name << ':' << file.size << ':' << file.sha256 << '\n';
  }
  preview.source_digest = digest(source_identity.str());
  preview.plan_id = digest(preview_identity(preview));
  return preview;
}

maintenance_receipt recovery_engine::quarantine(const quarantine_preview &preview) const {
  maintenance_receipt receipt;
  receipt.plan_id = preview.plan_id;
  bool mutated = false;
  try {
    const auto current = preview_quarantine();
    if (!current.has_value() || !(*current == preview) || preview.plan_id.empty()) {
      receipt.error = "recovery_quarantine_preview_stale_or_invalid";
      return receipt;
    }

    auto service_owner = yijinjing::ownership::lease::acquire_data_root_service(options_.data_root);
    auto writer_owner =
        yijinjing::ownership::lease::acquire_stream_writer(options_.data_root, options_.writer_resource_id);
    if (!service_owner.owns() || !writer_owner.owns()) {
      receipt.error = "recovery_quarantine_ownership_unavailable";
      return receipt;
    }

    const auto source = stream_directory(options_);
    const auto package = fs::absolute(options_.data_root).lexically_normal() / "durable" / "quarantine" /
                         std::to_string(options_.stream_id) / std::to_string(options_.container_epoch) /
                         preview.plan_id;
    receipt.package_path = package.string();
    receipt.retained_file_count = preview.files.size();
    for (const auto &file : preview.files) {
      receipt.retained_bytes += file.size;
    }
    if (fs::is_directory(package) && retained_package_matches(package, preview)) {
      receipt.status = maintenance_status::AlreadyCompleted;
      return receipt;
    }

    if (fs::is_directory(package) && !valid_partial_retained_package(package, preview)) {
      receipt.error = "recovery_quarantine_partial_package_invalid";
      return receipt;
    }

    mutated = fs::create_directories(package) || mutated;
    for (const auto &file : preview.files) {
      const auto retained = package / file.name;
      const auto temporary = package / (file.name + ".pending");
      std::error_code ignored;
      mutated = fs::remove(temporary, ignored) || mutated;
      if (fs::is_regular_file(retained) && fs::file_size(retained) == file.size &&
          digest(read_bytes(retained)) == file.sha256) {
        continue;
      }
      fs::copy_file(source / file.name, temporary, fs::copy_options::overwrite_existing);
      if (fs::file_size(temporary) != file.size || digest(read_bytes(temporary)) != file.sha256) {
        throw std::runtime_error("recovery_quarantine_copy_mismatch");
      }
      fs::remove(retained, ignored);
      fs::rename(temporary, retained);
      mutated = true;
    }
    const auto receipt_path = package / "receipt.txt";
    const auto temporary_receipt = package / "receipt.txt.pending";
    std::error_code ignored;
    mutated = fs::remove(temporary_receipt, ignored) || mutated;
    mutated = true;
    {
      std::ofstream output(temporary_receipt, std::ios::binary | std::ios::trunc);
      output << receipt_bytes(preview);
      output.flush();
      if (!output) {
        throw std::runtime_error("recovery_quarantine_receipt_write_failed");
      }
    }
    fs::remove(receipt_path, ignored);
    fs::rename(temporary_receipt, receipt_path);
    if (!retained_package_matches(package, preview)) {
      throw std::runtime_error("recovery_quarantine_package_verification_failed");
    }
    receipt.status = maintenance_status::Completed;
    receipt.mutation_performed = mutated;
    return receipt;
  } catch (const std::exception &error) {
    receipt.mutation_performed = mutated;
    receipt.error = error.what();
    return receipt;
  }
}

backup_export_result recovery_engine::export_consistent_backup() const {
  backup_export_result result;
  try {
    auto service_owner = yijinjing::ownership::lease::acquire_data_root_service(options_.data_root);
    auto writer_owner =
        yijinjing::ownership::lease::acquire_stream_writer(options_.data_root, options_.writer_resource_id);
    if (!service_owner.owns() || !writer_owner.owns()) {
      throw std::runtime_error("recovery_backup_ownership_unavailable");
    }

    const auto first_report = inspect();
    if (first_report.outcome != recovery_outcome::Ready || !first_report.durable_frontier.has_value() ||
        first_report.unacknowledged_tail_bytes != 0) {
      if (first_report.episode_unknown_record_count != 0 || !first_report.episode_findings.empty()) {
        (void)capture_episode_identities(options_.data_root);
      }
      throw std::runtime_error("recovery_backup_source_not_ready");
    }
    const auto root = fs::absolute(options_.data_root).lexically_normal();
    const auto first_files = scan_backup_files(root);
    const auto first_episodes = capture_episode_identities(options_.data_root);

    const auto repeated_report = inspect();
    const auto repeated_episodes = capture_episode_identities(options_.data_root);
    const auto repeated_files = scan_backup_files(root);
    if (!(first_report == repeated_report) || first_files != repeated_files || first_episodes != repeated_episodes) {
      throw std::runtime_error("recovery_backup_source_changed_during_export");
    }

    recovery_backup_bundle bundle;
    bundle.stream_id = repeated_report.stream_id;
    bundle.container_epoch = repeated_report.container_epoch;
    bundle.backup_cut = repeated_report.durable_frontier;
    bundle.durable_record_count = repeated_report.durable_record_count;
    bundle.lost_visible_tail_bytes = repeated_report.unacknowledged_tail_bytes;
    bundle.qualification_profile = repeated_report.qualification_profile;
    bundle.source_report = repeated_report;
    bundle.files = repeated_files;
    bundle.episodes = repeated_episodes;
    bundle.bundle_id = backup_identity(bundle);
    validate_backup_bundle(bundle);
    result.ok = true;
    result.bundle = std::move(bundle);
    return result;
  } catch (const std::exception &error) {
    result.error = error.what();
    return result;
  }
}

void write_pending_restore_file(const fs::path &temporary, const backup_file_material &file) {
  std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
  output.write(file.bytes.data(), static_cast<std::streamsize>(file.bytes.size()));
  output.flush();
  if (!output)
    throw std::runtime_error("recovery_restore_file_write_failed");
}

bool restore_backup_file(const fs::path &root, const backup_file_material &file) {
  const auto destination = root / fs::path(file.relative_path);
  const auto temporary = fs::path(destination.string() + ".pending");
  if (fs::is_regular_file(destination)) {
    if (fs::exists(temporary))
      throw std::runtime_error("recovery_restore_stale_pending_file");
    if (fs::file_size(destination) != file.size || digest(read_bytes(destination)) != file.sha256)
      throw std::runtime_error("recovery_restore_existing_file_mismatch");
    return false;
  }
  if (fs::exists(destination))
    throw std::runtime_error("recovery_restore_destination_path_conflict");
  fs::create_directories(destination.parent_path());
  if (fs::exists(temporary) && (!fs::is_regular_file(temporary) || fs::is_symlink(temporary)))
    throw std::runtime_error("recovery_restore_pending_path_conflict");
  write_pending_restore_file(temporary, file);
  if (fs::file_size(temporary) != file.size || digest(read_bytes(temporary)) != file.sha256)
    throw std::runtime_error("recovery_restore_file_verification_failed");
  fs::rename(temporary, destination);
  return true;
}

bool restore_backup_files(const fs::path &root, const recovery_backup_bundle &bundle) {
  bool mutated = false;
  for (const auto &file : bundle.files)
    mutated = restore_backup_file(root, file) || mutated;
  return mutated;
}

restore_receipt recovery_engine::restore_backup(const recovery_backup_bundle &bundle) const {
  restore_receipt receipt;
  bool mutated = false;
  receipt.bundle_id = bundle.bundle_id;
  receipt.restored_cut = bundle.backup_cut;
  receipt.restored_file_count = bundle.files.size();
  receipt.restored_episode_count = bundle.episodes.size();
  for (const auto &file : bundle.files) {
    receipt.restored_bytes += file.size;
  }
  try {
    validate_backup_bundle(bundle);
    if (bundle.stream_id != options_.stream_id || bundle.container_epoch != options_.container_epoch ||
        bundle.qualification_profile != options_.qualification_profile) {
      throw std::runtime_error("recovery_restore_target_contract_mismatch");
    }

    auto service_owner = yijinjing::ownership::lease::acquire_data_root_service(options_.data_root);
    auto writer_owner =
        yijinjing::ownership::lease::acquire_stream_writer(options_.data_root, options_.writer_resource_id);
    if (!service_owner.owns() || !writer_owner.owns()) {
      throw std::runtime_error("recovery_restore_ownership_unavailable");
    }

    const auto root = fs::absolute(options_.data_root).lexically_normal();
    const auto receipt_path = restore_receipt_path(root, bundle);
    receipt.receipt_path = receipt_path.string();
    const auto expected_receipt = restore_receipt_bytes(bundle);
    if (fs::exists(receipt_path)) {
      if (!fs::is_regular_file(receipt_path) || read_bytes(receipt_path) != expected_receipt) {
        throw std::runtime_error("recovery_restore_receipt_mismatch");
      }
      validate_completed_restore_destination(root, bundle);
      receipt.restored_report = inspect();
      if (!restored_files_match(root, bundle) || !(receipt.restored_report == bundle.source_report) ||
          capture_episode_identities(options_.data_root) != bundle.episodes) {
        throw std::runtime_error("recovery_restore_completed_root_mismatch");
      }
      receipt.status = maintenance_status::AlreadyCompleted;
      return receipt;
    }

    validate_restore_destination(root, bundle);
    mutated = restore_backup_files(root, bundle) || mutated;

    if (!restored_files_match(root, bundle)) {
      throw std::runtime_error("recovery_restore_file_set_mismatch");
    }
    receipt.restored_report = inspect();
    if (!(receipt.restored_report == bundle.source_report)) {
      throw std::runtime_error("recovery_restore_frontier_mismatch");
    }
    if (capture_episode_identities(options_.data_root) != bundle.episodes) {
      throw std::runtime_error("recovery_restore_episode_identity_mismatch");
    }

    mutated = fs::create_directories(receipt_path.parent_path()) || mutated;
    const auto temporary_receipt = fs::path(receipt_path.string() + ".pending");
    mutated = true;
    {
      std::ofstream output(temporary_receipt, std::ios::binary | std::ios::trunc);
      output << expected_receipt;
      output.flush();
      if (!output) {
        throw std::runtime_error("recovery_restore_receipt_write_failed");
      }
    }
    fs::rename(temporary_receipt, receipt_path);
    if (read_bytes(receipt_path) != expected_receipt) {
      throw std::runtime_error("recovery_restore_receipt_verification_failed");
    }
    receipt.status = maintenance_status::Completed;
    receipt.mutation_performed = mutated;
    return receipt;
  } catch (const std::exception &error) {
    receipt.mutation_performed = mutated;
    receipt.error = error.what();
    return receipt;
  }
}

backup_package_load_result load_backup_package(const std::string &package_path) {
  backup_package_load_result result;
  result.package_path = fs::absolute(package_path).lexically_normal().string();
  try {
    const fs::path package(result.package_path);
    if (!fs::is_directory(package) || fs::is_symlink(package)) {
      throw std::runtime_error("recovery_backup_package_missing");
    }
    const auto manifest_path = package / "manifest.json";
    const auto complete_path = package / "complete.json";
    if (!fs::is_regular_file(manifest_path) || fs::is_symlink(manifest_path) || !fs::is_regular_file(complete_path) ||
        fs::is_symlink(complete_path)) {
      throw std::runtime_error("recovery_backup_package_incomplete");
    }
    const auto manifest_bytes = read_bytes(manifest_path);
    result.manifest_sha256 = digest(manifest_bytes);
    const auto complete = parse_json_document(read_bytes(complete_path), "recovery_backup_package_complete_invalid");
    if (!has_exact_keys(complete, {"schema", "bundle_id", "manifest_sha256"})) {
      throw std::runtime_error("recovery_backup_package_complete_invalid");
    }
    try {
      if (complete.at("schema").get<std::string>() != RECOVERY_BACKUP_COMPLETE_SCHEMA_V1 ||
          complete.at("manifest_sha256").get<std::string>() != result.manifest_sha256) {
        throw std::runtime_error("recovery_backup_package_complete_invalid");
      }
    } catch (const json::exception &) {
      throw std::runtime_error("recovery_backup_package_complete_invalid");
    }
    const auto manifest = parse_json_document(manifest_bytes, "recovery_backup_package_manifest_invalid");
    auto bundle = parse_backup_package_manifest(manifest, package);
    try {
      if (complete.at("bundle_id").get<std::string>() != bundle.bundle_id) {
        throw std::runtime_error("recovery_backup_package_complete_invalid");
      }
    } catch (const json::exception &) {
      throw std::runtime_error("recovery_backup_package_complete_invalid");
    }
    validate_backup_package_file_set(package, bundle);
    result.ok = true;
    result.bundle = std::move(bundle);
    return result;
  } catch (const std::exception &error) {
    result.error = error.what();
    return result;
  }
}

backup_package_receipt publish_backup_package(const recovery_backup_bundle &bundle, const std::string &package_path) {
  backup_package_receipt receipt;
  bool mutated = false;
  receipt.bundle_id = bundle.bundle_id;
  receipt.package_path = fs::absolute(package_path).lexically_normal().string();
  receipt.file_count = bundle.files.size();
  for (const auto &file : bundle.files) {
    receipt.total_bytes += file.size;
  }
  try {
    validate_backup_bundle(bundle);
    const fs::path package(receipt.package_path);
    if (package.filename() != bundle.bundle_id || package.parent_path().empty() ||
        fs::is_symlink(package.parent_path())) {
      throw std::runtime_error("recovery_backup_package_path_invalid");
    }
    if (fs::exists(package)) {
      const auto loaded = load_backup_package(package.string());
      if (!loaded.ok || !loaded.bundle.has_value() || *loaded.bundle != bundle) {
        throw std::runtime_error("recovery_backup_package_existing_invalid");
      }
      receipt.status = maintenance_status::AlreadyCompleted;
      receipt.manifest_sha256 = loaded.manifest_sha256;
      return receipt;
    }

    const fs::path pending(package.string() + ".pending");
    if (fs::exists(pending)) {
      throw std::runtime_error("recovery_backup_package_pending_exists");
    }
    mutated = fs::create_directories(package.parent_path()) || mutated;
    if (!fs::create_directory(pending)) {
      throw std::runtime_error("recovery_backup_package_pending_create_failed");
    }
    mutated = true;
    sync_backup_directory(package.parent_path());
    for (const auto &file : bundle.files) {
      const auto destination = pending / "data" / fs::path(file.relative_path);
      write_new_file(destination, file.bytes);
      if (fs::file_size(destination) != file.size || digest(read_bytes(destination)) != file.sha256) {
        throw std::runtime_error("recovery_backup_package_file_verification_failed");
      }
    }
    sync_backup_directory_tree(pending);
    const auto manifest_bytes = canonical_document(backup_package_manifest(bundle));
    receipt.manifest_sha256 = digest(manifest_bytes);
    write_new_file(pending / "manifest.json", manifest_bytes);
    sync_backup_directory(pending);
    write_new_file(pending / "complete.json", complete_document(bundle, receipt.manifest_sha256));
    sync_backup_directory(pending);
    const auto staged = load_backup_package(pending.string());
    if (!staged.ok || !staged.bundle.has_value() || *staged.bundle != bundle ||
        staged.manifest_sha256 != receipt.manifest_sha256) {
      throw std::runtime_error("recovery_backup_package_staged_verification_failed");
    }
    fs::rename(pending, package);
    sync_backup_directory(package.parent_path());
    const auto published = load_backup_package(package.string());
    if (!published.ok || !published.bundle.has_value() || *published.bundle != bundle) {
      throw std::runtime_error("recovery_backup_package_publication_verification_failed");
    }
    receipt.status = maintenance_status::Completed;
    receipt.mutation_performed = mutated;
    return receipt;
  } catch (const std::exception &error) {
    receipt.mutation_performed = mutated;
    receipt.error = error.what();
    return receipt;
  }
}

backup_package_selection select_latest_backup_package(const std::string &store_root, uint64_t stream_id,
                                                      uint64_t container_epoch,
                                                      const std::string &qualification_profile) {
  backup_package_selection selection;
  try {
    const auto root = fs::absolute(store_root).lexically_normal();
    if (!fs::is_directory(root) || fs::is_symlink(root)) {
      throw std::runtime_error("recovery_backup_store_missing");
    }
    for (const auto &entry : fs::directory_iterator(root)) {
      const auto name = entry.path().filename().generic_string();
      if (entry.is_symlink() || !entry.is_directory() || name.ends_with(".pending")) {
        selection.rejected_candidates.push_back(name + ":recovery_backup_candidate_incomplete_or_invalid");
        continue;
      }
      const auto loaded = load_backup_package(entry.path().string());
      if (!loaded.ok || !loaded.bundle.has_value()) {
        selection.rejected_candidates.push_back(name + ":" + loaded.error);
        continue;
      }
      const auto &candidate = *loaded.bundle;
      if (candidate.stream_id != stream_id || candidate.container_epoch != container_epoch ||
          candidate.qualification_profile != qualification_profile) {
        selection.rejected_candidates.push_back(name + ":recovery_backup_candidate_contract_mismatch");
        continue;
      }
      if (!selection.bundle.has_value() ||
          std::tie(candidate.backup_cut->sequence, candidate.backup_cut->frame_uid) >
              std::tie(selection.bundle->backup_cut->sequence, selection.bundle->backup_cut->frame_uid)) {
        selection.bundle = candidate;
        selection.package_path = loaded.package_path;
        selection.manifest_sha256 = loaded.manifest_sha256;
      }
    }
    std::sort(selection.rejected_candidates.begin(), selection.rejected_candidates.end());
    if (!selection.bundle.has_value()) {
      throw std::runtime_error("recovery_backup_no_verified_candidate");
    }
    selection.ok = true;
    selection.fallback_used = !selection.rejected_candidates.empty();
    return selection;
  } catch (const std::exception &error) {
    selection.error = error.what();
    return selection;
  }
}

const char *recovery_outcome_name(recovery_outcome outcome) noexcept {
  switch (outcome) {
  case recovery_outcome::Ready:
    return "ready";
  case recovery_outcome::Degraded:
    return "degraded";
  case recovery_outcome::Blocked:
    return "blocked";
  }
  return "blocked";
}

const char *recovery_phase_name(recovery_phase phase) noexcept {
  switch (phase) {
  case recovery_phase::Discover:
    return "discover";
  case recovery_phase::Verify:
    return "verify";
  case recovery_phase::Select:
    return "select";
  case recovery_phase::Classify:
    return "classify";
  case recovery_phase::Report:
    return "report";
  }
  return "report";
}

const char *maintenance_status_name(maintenance_status status) noexcept {
  switch (status) {
  case maintenance_status::Completed:
    return "completed";
  case maintenance_status::AlreadyCompleted:
    return "already_completed";
  case maintenance_status::Rejected:
    return "rejected";
  }
  return "rejected";
}

const char *recovery_component_name(recovery_component component) noexcept {
  switch (component) {
  case recovery_component::Supervisor:
    return "supervisor";
  case recovery_component::StateService:
    return "state_service";
  case recovery_component::Projection:
    return "projection";
  case recovery_component::Peers:
    return "peers";
  }
  return "supervisor";
}

restart_authorization authorize_restart(const recovery_report &report, recovery_component component,
                                        const restart_progress &progress) {
  restart_authorization decision{false, component, {}};
  const std::vector<recovery_phase> completed_phases = {recovery_phase::Discover, recovery_phase::Verify,
                                                        recovery_phase::Select, recovery_phase::Classify,
                                                        recovery_phase::Report};
  const std::vector<std::string> restart_order = {"supervisor", "state_service", "projection", "peers"};
  const bool report_complete = report.schema == RECOVERY_REPORT_SCHEMA_V1 &&
                               report.completed_phases == completed_phases && report.restart_order == restart_order;
  switch (component) {
  case recovery_component::Supervisor:
    decision.allowed = report_complete && !progress.supervisor_verified && !progress.state_service_ready &&
                       !progress.projection_ready && !progress.peers_started;
    decision.reason = decision.allowed ? "" : "recovery_restart_supervisor_report_or_progress_invalid";
    break;
  case recovery_component::StateService:
    decision.allowed = report_complete && report.outcome != recovery_outcome::Blocked && progress.supervisor_verified &&
                       !progress.state_service_ready && !progress.projection_ready && !progress.peers_started;
    decision.reason = decision.allowed ? "" : "recovery_restart_state_service_not_authorized";
    break;
  case recovery_component::Projection:
    decision.allowed = report_complete && report.outcome != recovery_outcome::Blocked && progress.supervisor_verified &&
                       progress.state_service_ready && !progress.projection_ready && !progress.peers_started;
    decision.reason = decision.allowed ? "" : "recovery_restart_projection_not_authorized";
    break;
  case recovery_component::Peers:
    decision.allowed = report_complete && report.outcome == recovery_outcome::Ready && progress.supervisor_verified &&
                       progress.state_service_ready && progress.projection_ready && !progress.peers_started;
    decision.reason = decision.allowed ? "" : "recovery_restart_peers_not_authorized";
    break;
  }
  return decision;
}

} // namespace kungfu::runtime::recovery
