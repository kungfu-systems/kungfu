// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>

#ifndef _WIN32
#include <fcntl.h>
#include <unistd.h>
#endif

#include <kungfu/yijinjing/io/advisory_file_lock.h>

namespace kungfu::runtime::storage_service_api {

namespace detail {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;
using kungfu::yijinjing::io::advisory_file_lock;
using kungfu::yijinjing::io::advisory_file_lock_options;
using kungfu::yijinjing::io::advisory_lock_mode;
using kungfu::yijinjing::io::advisory_lock_wait;

namespace {

inline constexpr const char *BINDING_SCHEMA = "kungfu.storage.backend-binding/v1";
inline constexpr const char *STATE_SCHEMA = "kungfu.storage.backend-switch-state/v1";
inline constexpr const char *RECEIPT_SCHEMA = "kungfu.storage.backend-switch-receipt/v1";

std::mutex operation_mutex;
std::atomic<uint64_t> temp_sequence{0};

fs::path binding_path(const std::string &runtime_dir) { return root_dir(runtime_dir) / "backend-binding.json"; }
fs::path state_path(const std::string &runtime_dir) { return root_dir(runtime_dir) / "backend-switch-state.json"; }
fs::path operation_lock_path(const std::string &runtime_dir) { return root_dir(runtime_dir) / "backend-switch.lock"; }
fs::path authority_lock_path(const std::string &runtime_dir) {
  return root_dir(runtime_dir) / "backend-authority.lock";
}
fs::path receipt_path(const std::string &runtime_dir, const std::string &operation_id) {
  return root_dir(runtime_dir) / "backend-switch-receipts" / (operation_id + ".json");
}

int64_t now_millis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

uint64_t process_id() {
#ifdef _WIN32
  return static_cast<uint64_t>(GetCurrentProcessId());
#else
  return static_cast<uint64_t>(::getpid());
#endif
}

advisory_file_lock acquire_backend_operation_lock(const std::string &runtime_dir) {
  const auto path = operation_lock_path(runtime_dir);
  fs::create_directories(path.parent_path());
  auto options = advisory_file_lock_options{};
  options.posix_permissions = 0600;
  try {
    return advisory_file_lock(path, options);
  } catch (const kungfu::yijinjing::io::advisory_file_lock_error &) {
    // Preserve the existing deliberately fail-closed domain classification:
    // an unavailable operation guard is reported as backend_switch_busy.
    throw std::runtime_error("backend_switch_busy: another process owns the operation lock");
  }
}

class backend_operation_file_lock {
public:
  explicit backend_operation_file_lock(const std::string &runtime_dir)
      : lock_(acquire_backend_operation_lock(runtime_dir)) {}

private:
  advisory_file_lock lock_;
};

advisory_file_lock acquire_backend_authority_lock(const std::string &runtime_dir, bool exclusive) {
  const auto path = authority_lock_path(runtime_dir);
  fs::create_directories(path.parent_path());
  auto options = advisory_file_lock_options{};
  options.mode = exclusive ? advisory_lock_mode::exclusive : advisory_lock_mode::shared;
  options.wait = advisory_lock_wait::blocking;
  options.posix_permissions = 0600;
  try {
    return advisory_file_lock(path, options);
  } catch (const kungfu::yijinjing::io::advisory_file_lock_error &) {
    throw std::runtime_error("backend_authority_lock_failed");
  }
}

class backend_authority_file_lock {
public:
  backend_authority_file_lock(const std::string &runtime_dir, bool exclusive)
      : lock_(acquire_backend_authority_lock(runtime_dir, exclusive)) {}

private:
  advisory_file_lock lock_;
};

std::recursive_mutex &backend_authority_mutex() {
  static auto *mutex = new std::recursive_mutex();
  return *mutex;
}

thread_local std::string active_cut_runtime;

std::optional<nlohmann::json> load_json(const fs::path &path) {
  if (!fs::exists(path)) {
    return std::nullopt;
  }
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("backend_authority_read_failed: " + path.string());
  }
  nlohmann::json value;
  input >> value;
  if (!value.is_object()) {
    throw std::runtime_error("backend_authority_invalid: " + path.string());
  }
  return value;
}

void sync_directory(const fs::path &path) {
#ifndef _WIN32
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd >= 0) {
    (void)::fsync(fd);
    (void)::close(fd);
  }
#else
  (void)path;
#endif
}

void atomic_write_json(const fs::path &path, const nlohmann::json &value) {
  fs::create_directories(path.parent_path());
  const auto temp = path.string() + ".tmp." + std::to_string(now_millis()) + "." + std::to_string(process_id()) + "." +
                    std::to_string(temp_sequence.fetch_add(1, std::memory_order_relaxed));
  std::FILE *output = std::fopen(temp.c_str(), "wb");
  if (output == nullptr) {
    throw std::runtime_error("backend_authority_write_failed: " + temp);
  }
  const auto encoded = value.dump(2) + "\n";
  if (std::fwrite(encoded.data(), 1, encoded.size(), output) != encoded.size() || std::fflush(output) != 0) {
    std::fclose(output);
    throw std::runtime_error("backend_authority_write_failed: " + temp);
  }
#ifdef _WIN32
  if (_commit(_fileno(output)) != 0) {
#else
  if (::fsync(fileno(output)) != 0) {
#endif
    std::fclose(output);
    throw std::runtime_error("backend_authority_sync_failed: " + temp);
  }
  if (std::fclose(output) != 0) {
    throw std::runtime_error("backend_authority_close_failed: " + temp);
  }
  std::error_code ec;
  fs::rename(temp, path, ec);
#ifdef _WIN32
  if (ec && !MoveFileExA(temp.c_str(), path.string().c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    throw std::runtime_error("backend_authority_publish_failed: " + path.string());
  }
#else
  if (ec) {
    throw std::runtime_error("backend_authority_publish_failed: " + path.string() + ": " + ec.message());
  }
#endif
  sync_directory(path.parent_path());
}

storage_backend_inventory_view inventory_view(const std::vector<stored_content_object> &objects) {
  storage_backend_inventory_view result{};
  std::string canonical;
  for (const auto &object : objects) {
    ++result.object_count;
    result.byte_count += object.byte_len;
    canonical += object.content_namespace + "\0" + object.digest + "\0" + std::to_string(object.byte_len) + "\n";
  }
  result.semantic_root = yy_storage::compute_content_hash(canonical).value;
  return result;
}

nlohmann::json inventory_json(const storage_backend_inventory_view &inventory) {
  return {{"object_count", inventory.object_count},
          {"byte_count", inventory.byte_count},
          {"semantic_root", inventory.semantic_root}};
}

storage_backend_inventory_view parse_inventory(const nlohmann::json &value) {
  return {uint64_or(value, "object_count"), uint64_or(value, "byte_count"), text_or(value, "semantic_root")};
}

storage_backend_binding_view parse_binding(const std::optional<nlohmann::json> &value) {
  if (!value.has_value()) {
    return {};
  }
  if (text_or(*value, "schema") != BINDING_SCHEMA) {
    throw std::runtime_error("backend_binding_schema_unsupported");
  }
  storage_backend_binding_view result{};
  result.present = true;
  result.provider = text_or(*value, "provider");
  result.previous_provider = text_or(*value, "previous_provider");
  result.generation = uint64_or(*value, "generation");
  result.operation_id = text_or(*value, "operation_id");
  result.committed_at = int64_or(*value, "committed_at");
  result.inventory = parse_inventory(object_or_empty(*value, "inventory"));
  return result;
}

storage_backend_migration_view parse_migration(const std::optional<nlohmann::json> &value) {
  if (!value.has_value()) {
    return {};
  }
  if (text_or(*value, "schema") != STATE_SCHEMA) {
    throw std::runtime_error("backend_switch_state_schema_unsupported");
  }
  storage_backend_migration_view result{};
  result.present = true;
  result.operation_id = text_or(*value, "operation_id");
  result.action = text_or(*value, "action");
  result.phase = text_or(*value, "phase");
  result.source_provider = text_or(*value, "source_provider");
  result.target_provider = text_or(*value, "target_provider");
  result.source_generation = uint64_or(*value, "source_generation");
  result.target_generation = uint64_or(*value, "target_generation");
  result.copied_objects = uint64_or(*value, "copied_objects");
  result.copied_bytes = uint64_or(*value, "copied_bytes");
  result.started_at = int64_or(*value, "started_at");
  result.updated_at = int64_or(*value, "updated_at");
  return result;
}

struct population_probe {
  bool available = true;
  std::vector<stored_content_object> objects = {};
};

population_probe probe_provider(const std::string &runtime_dir, const std::string &provider) {
  try {
    return {true, provider_cache::instance().acquire_migration(runtime_dir, provider)->all_content_objects()};
  } catch (const std::runtime_error &error) {
    if (std::string(error.what()).starts_with("provider_unavailable:")) {
      return {false, {}};
    }
    throw;
  }
}

std::optional<std::string> infer_legacy_provider(const std::string &runtime_dir) {
  const auto file = probe_provider(runtime_dir, PROVIDER_FILE);
  const auto rocks = probe_provider(runtime_dir, PROVIDER_ROCKSDB);
  const bool file_populated = !file.objects.empty();
  const bool rocks_populated = rocks.available && !rocks.objects.empty();
  if (file_populated && rocks_populated) {
    throw std::runtime_error("backend_authority_ambiguous: both providers contain objects; create an explicit binding");
  }
  if (file_populated) {
    return PROVIDER_FILE;
  }
  if (rocks_populated) {
    return PROVIDER_ROCKSDB;
  }
  return std::nullopt;
}

void publish_binding(const std::string &runtime_dir, const storage_backend_binding_view &binding) {
  atomic_write_json(binding_path(runtime_dir), {{"schema", BINDING_SCHEMA},
                                                {"provider", binding.provider},
                                                {"previous_provider", binding.previous_provider},
                                                {"generation", binding.generation},
                                                {"operation_id", binding.operation_id},
                                                {"committed_at", binding.committed_at},
                                                {"inventory", inventory_json(binding.inventory)}});
}

storage_backend_binding_view ensure_initial_binding(const std::string &runtime_dir, const std::string &provider) {
  auto binding = parse_binding(load_json(binding_path(runtime_dir)));
  if (binding.present) {
    return binding;
  }
  auto selected = provider_cache::instance().acquire_migration(runtime_dir, provider);
  binding.present = true;
  binding.provider = provider;
  binding.generation = 1;
  binding.operation_id =
      "initial-" + yy_storage::compute_content_hash(absolute_normalized(runtime_dir).string() + "\n" + provider).value;
  binding.committed_at = now_millis();
  binding.inventory = inventory_view(selected->all_content_objects());
  publish_binding(runtime_dir, binding);
  return binding;
}

std::string provider_profile(const std::shared_ptr<storage_provider> &provider) {
  return provider->content_store().capabilities().profile;
}

nlohmann::json binding_json(const storage_backend_binding_view &binding) {
  if (!binding.present) {
    return nullptr;
  }
  return {{"provider", binding.provider},
          {"previous_provider",
           binding.previous_provider.empty() ? nlohmann::json(nullptr) : nlohmann::json(binding.previous_provider)},
          {"generation", binding.generation},
          {"operation_id", binding.operation_id},
          {"committed_at", binding.committed_at},
          {"inventory", inventory_json(binding.inventory)}};
}

nlohmann::json migration_json(const storage_backend_migration_view &migration) {
  if (!migration.present) {
    return nullptr;
  }
  return {{"operation_id", migration.operation_id},
          {"action", migration.action},
          {"phase", migration.phase},
          {"source_provider", migration.source_provider},
          {"target_provider", migration.target_provider},
          {"source_generation", migration.source_generation},
          {"target_generation", migration.target_generation},
          {"copied_objects", migration.copied_objects},
          {"copied_bytes", migration.copied_bytes},
          {"started_at", migration.started_at},
          {"updated_at", migration.updated_at}};
}

void persist_state(const std::string &runtime_dir, nlohmann::json &state) {
  state["updated_at"] = now_millis();
  atomic_write_json(state_path(runtime_dir), state);
}

void copy_objects(const std::string &runtime_dir, const std::shared_ptr<storage_provider> &source,
                  const std::shared_ptr<storage_provider> &target, nlohmann::json &state,
                  const std::optional<uint64_t> &fail_after) {
  for (const auto &object : source->all_content_objects()) {
    const auto hash = yy_storage::make_content_hash(object.digest);
    const auto loaded = source->content_store().get(object.content_namespace, hash);
    if (!loaded.ok()) {
      throw std::runtime_error("backend_switch_source_read_failed: " + object.content_namespace + "/" + object.digest);
    }
    const auto copied = target->content_store().put_if_absent(object.content_namespace, loaded.bytes, hash);
    if (!copied.ok()) {
      throw std::runtime_error("backend_switch_target_write_failed: " + object.content_namespace + "/" + object.digest +
                               ": " + copied.message);
    }
    const auto verified = target->content_store().verify(object.content_namespace, hash);
    if (!verified.ok() || verified.byte_length != object.byte_len) {
      throw std::runtime_error("backend_switch_target_verify_failed: " + object.content_namespace + "/" +
                               object.digest);
    }
    if (!copied.existed) {
      state["copied_objects"] = uint64_or(state, "copied_objects") + 1;
      state["copied_bytes"] = uint64_or(state, "copied_bytes") + object.byte_len;
      persist_state(runtime_dir, state);
    }
    if (fail_after.has_value() && uint64_or(state, "copied_objects") >= *fail_after) {
      throw std::runtime_error("backend_switch_qualification_fault_after_copy");
    }
  }
}

void verify_authoritative_set(const std::shared_ptr<storage_provider> &source,
                              const std::shared_ptr<storage_provider> &target,
                              const std::vector<stored_content_object> &objects) {
  for (const auto &object : objects) {
    const auto hash = yy_storage::make_content_hash(object.digest);
    const auto source_check = source->content_store().verify(object.content_namespace, hash);
    const auto target_check = target->content_store().verify(object.content_namespace, hash);
    if (!source_check.ok() || !target_check.ok() || source_check.byte_length != target_check.byte_length) {
      throw std::runtime_error("backend_switch_root_parity_failed: " + object.content_namespace + "/" + object.digest);
    }
  }
}

storage_backend_change_result change_backend(const std::string &action, const storage_backend_change_request &request) {
  if (request.runtime_dir.empty()) {
    throw std::invalid_argument("runtime_dir is required");
  }
  std::lock_guard<std::mutex> operation_lock(operation_mutex);
  const auto runtime_dir = absolute_normalized(request.runtime_dir).string();
  backend_operation_file_lock cross_process_lock(runtime_dir);
  auto binding = parse_binding(load_json(binding_path(runtime_dir)));
  const auto current_selection =
      binding.present ? provider_selection{binding.provider, "binding:generation-" + std::to_string(binding.generation)}
                      : select_provider_for_runtime(runtime_dir, {});
  auto current_provider = provider_cache::instance().acquire_migration(runtime_dir, current_selection.name);
  binding = ensure_initial_binding(runtime_dir, current_selection.name);
  auto state_value = load_json(state_path(runtime_dir));
  if (state_value.has_value() && text_or(*state_value, "phase") != "committed" &&
      text_or(*state_value, "operation_id") == binding.operation_id &&
      text_or(*state_value, "target_provider") == binding.provider &&
      uint64_or(*state_value, "target_generation") == binding.generation) {
    // Binding publication is the authority commit point. If a process died
    // before persisting the matching terminal state, recover that observation
    // instead of treating the already-committed switch as an active conflict.
    (*state_value)["phase"] = "committed";
    (*state_value)["committed_at"] = binding.committed_at;
    persist_state(runtime_dir, *state_value);
  }
  if (request.expected_generation.has_value() && binding.generation != *request.expected_generation) {
    throw std::runtime_error("backend_generation_mismatch: expected " + std::to_string(*request.expected_generation) +
                             ", current " + std::to_string(binding.generation));
  }

  std::string target_name;
  if (action == "rollback") {
    if (binding.previous_provider.empty()) {
      throw std::runtime_error("backend_rollback_unavailable: no retained previous provider");
    }
    target_name = binding.previous_provider;
    if (!request.target_provider.empty() && select_provider(request.target_provider).name != target_name) {
      throw std::runtime_error("backend_rollback_target_mismatch");
    }
  } else {
    if (request.target_provider.empty()) {
      throw std::invalid_argument("target_provider is required");
    }
    target_name = select_provider(request.target_provider).name;
  }
  if (target_name == binding.provider) {
    throw std::runtime_error("backend_already_authoritative: " + target_name);
  }

  // Fail visibly before persisting migration state when the target is not
  // compiled into this candidate.
  auto target_provider = provider_cache::instance().acquire_migration(runtime_dir, target_name);
  state_value = load_json(state_path(runtime_dir));
  nlohmann::json state;
  if (state_value.has_value() && text_or(*state_value, "phase") != "committed") {
    state = *state_value;
    if (text_or(state, "action") != action || text_or(state, "source_provider") != binding.provider ||
        text_or(state, "target_provider") != target_name ||
        uint64_or(state, "source_generation") != binding.generation) {
      throw std::runtime_error("backend_switch_conflict: another migration state is active");
    }
  } else {
    const auto pre = inventory_view(current_provider->all_content_objects());
    const auto operation_material = action + "\n" + runtime_dir + "\n" + binding.provider + "\n" + target_name + "\n" +
                                    std::to_string(binding.generation) + "\n" + pre.semantic_root;
    state = {{"schema", STATE_SCHEMA},
             {"operation_id", yy_storage::compute_content_hash(operation_material).value},
             {"action", action},
             {"phase", "copying"},
             {"source_provider", binding.provider},
             {"target_provider", target_name},
             {"source_generation", binding.generation},
             {"target_generation", binding.generation + 1},
             {"copied_objects", 0},
             {"copied_bytes", 0},
             {"started_at", now_millis()},
             {"updated_at", now_millis()},
             {"pre_cut", inventory_json(pre)}};
    persist_state(runtime_dir, state);
  }

  copy_objects(runtime_dir, current_provider, target_provider, state, request.fail_after_copied_objects);

  storage_backend_inventory_view final_inventory{};
  uint64_t target_extra_objects = 0;
  {
    // The same recursive mutex is held by every provider write. Once phase is
    // cutting, old-authority writes fail and no already-admitted write can race
    // the final inventory/binding publication in this process.
    backend_authority_cut_guard cut_lock(runtime_dir);
    state["phase"] = "cutting";
    persist_state(runtime_dir, state);
    bool binding_published = false;
    try {
      copy_objects(runtime_dir, current_provider, target_provider, state, std::nullopt);
      const auto source_objects = current_provider->all_content_objects();
      final_inventory = inventory_view(source_objects);
      verify_authoritative_set(current_provider, target_provider, source_objects);
      const auto target_objects = target_provider->all_content_objects();
      target_extra_objects =
          target_objects.size() > source_objects.size() ? target_objects.size() - source_objects.size() : 0;

      storage_backend_binding_view next{};
      next.present = true;
      next.provider = target_name;
      next.previous_provider = binding.provider;
      next.generation = binding.generation + 1;
      next.operation_id = text_or(state, "operation_id");
      next.committed_at = now_millis();
      next.inventory = final_inventory;
      publish_binding(runtime_dir, next);
      binding_published = true;
      state["phase"] = "committed";
      state["committed_at"] = next.committed_at;
      state["post_cut"] = inventory_json(final_inventory);
      state["target_extra_objects"] = target_extra_objects;
      persist_state(runtime_dir, state);
      binding = next;
    } catch (const std::exception &error) {
      if (!binding_published) {
        state["phase"] = "copying";
        state["last_error"] = error.what();
        try {
          persist_state(runtime_dir, state);
        } catch (...) {
          // Preserve the cut failure. The old binding is still authoritative.
        }
      }
      throw;
    }
  }

  storage_backend_change_result result{};
  result.operation_id = text_or(state, "operation_id");
  result.action = action;
  result.phase = "committed";
  result.source_provider = text_or(state, "source_provider");
  result.target_provider = target_name;
  result.source_profile = provider_profile(current_provider);
  result.target_profile = provider_profile(target_provider);
  result.source_generation = uint64_or(state, "source_generation");
  result.target_generation = binding.generation;
  result.pre_cut = parse_inventory(object_or_empty(state, "pre_cut"));
  result.post_cut = final_inventory;
  result.copied_objects = uint64_or(state, "copied_objects");
  result.copied_bytes = uint64_or(state, "copied_bytes");
  result.target_extra_objects = target_extra_objects;
  result.target_fsck_ok = true;
  result.binding_committed = true;
  result.old_backend_retained_readonly = true;
  result.residual_risks = {
      "single-host provider binding; no cross-machine consensus",
      "retained provider is not deleted and may contain unreferenced immutable objects",
      "durability remains bounded by each provider capability profile",
  };
  atomic_write_json(receipt_path(runtime_dir, result.operation_id), backend_change_json(result));
  return result;
}

} // namespace

struct backend_authority_write_guard::implementation {
  implementation(const std::string &runtime_dir, const std::string &provider)
      : process_lock(backend_authority_mutex()) {
    if (active_cut_runtime != runtime_dir) {
      file_lock = std::make_unique<backend_authority_file_lock>(runtime_dir, false);
    }
    assert_provider_write_allowed(runtime_dir, provider);
  }

  std::unique_lock<std::recursive_mutex> process_lock;
  std::unique_ptr<backend_authority_file_lock> file_lock;
};

backend_authority_write_guard::backend_authority_write_guard(const std::string &runtime_dir,
                                                             const std::string &provider)
    : implementation_(std::make_unique<implementation>(runtime_dir, provider)) {}
backend_authority_write_guard::~backend_authority_write_guard() = default;

struct backend_authority_cut_guard::implementation {
  explicit implementation(const std::string &runtime_dir)
      : runtime_dir(runtime_dir), process_lock(backend_authority_mutex()), file_lock(runtime_dir, true) {
    if (!active_cut_runtime.empty()) {
      throw std::runtime_error("backend_authority_cut_reentrant");
    }
    active_cut_runtime = runtime_dir;
  }

  ~implementation() { active_cut_runtime.clear(); }

  std::string runtime_dir;
  std::unique_lock<std::recursive_mutex> process_lock;
  backend_authority_file_lock file_lock;
};

backend_authority_cut_guard::backend_authority_cut_guard(const std::string &runtime_dir)
    : implementation_(std::make_unique<implementation>(runtime_dir)) {}
backend_authority_cut_guard::~backend_authority_cut_guard() = default;

provider_selection select_provider_for_runtime(const std::string &runtime_dir, std::string provider) {
  if (runtime_dir.empty()) {
    return select_provider(std::move(provider));
  }
  const auto configured = select_provider(std::move(provider));
  const auto binding = parse_binding(load_json(binding_path(runtime_dir)));
  if (binding.present) {
    if (configured.source != "default" && configured.name != binding.provider) {
      throw std::runtime_error("provider_binding_mismatch: requested " + configured.name + ", authoritative " +
                               binding.provider + "; use storage backend switch");
    }
    return {binding.provider, "binding:generation-" + std::to_string(binding.generation)};
  }
  const auto inferred = infer_legacy_provider(runtime_dir);
  if (inferred.has_value()) {
    if (configured.source != "default" && configured.name != *inferred) {
      throw std::runtime_error("provider_binding_mismatch: requested " + configured.name + ", populated " + *inferred +
                               "; use storage backend switch");
    }
    return {*inferred, "inferred-populated-provider"};
  }
  return configured;
}

void assert_provider_write_allowed(const std::string &runtime_dir, const std::string &provider) {
  const auto state = parse_migration(load_json(state_path(runtime_dir)));
  if (state.present && state.phase != "committed") {
    if (provider == state.target_provider) {
      return;
    }
    if (state.phase == "cutting" && provider == state.source_provider) {
      throw std::runtime_error("backend_cut_in_progress: authoritative provider writes are fenced");
    }
  }
  auto binding = parse_binding(load_json(binding_path(runtime_dir)));
  if (!binding.present) {
    backend_operation_file_lock initial_binding_lock(runtime_dir);
    binding = parse_binding(load_json(binding_path(runtime_dir)));
  }
  if (!binding.present) {
    const auto inferred = infer_legacy_provider(runtime_dir);
    if (inferred.has_value() && *inferred != provider) {
      throw std::runtime_error("provider_binding_mismatch: populated provider is " + *inferred);
    }
    binding = ensure_initial_binding(runtime_dir, inferred.value_or(provider));
  }
  if (binding.provider != provider) {
    throw std::runtime_error("provider_binding_mismatch: provider " + provider +
                             " is retained read-only; authoritative " + binding.provider);
  }
}

nlohmann::json backend_status_json(const storage_backend_status_result &result) {
  return {{"ok", result.ok},
          {"schema", result.schema},
          {"runtime_dir", result.runtime_dir},
          {"provider", result.provider},
          {"provider_config_source", result.provider_config_source},
          {"binding", binding_json(result.binding)},
          {"migration", migration_json(result.migration)},
          {"inventory", inventory_json(result.inventory)},
          {"warnings", result.warnings}};
}

nlohmann::json backend_change_json(const storage_backend_change_result &result) {
  return {{"ok", result.ok},
          {"schema", RECEIPT_SCHEMA},
          {"operation_id", result.operation_id},
          {"action", result.action},
          {"phase", result.phase},
          {"source_provider", result.source_provider},
          {"target_provider", result.target_provider},
          {"source_profile", result.source_profile},
          {"target_profile", result.target_profile},
          {"source_generation", result.source_generation},
          {"target_generation", result.target_generation},
          {"pre_cut", inventory_json(result.pre_cut)},
          {"post_cut", inventory_json(result.post_cut)},
          {"copied_objects", result.copied_objects},
          {"copied_bytes", result.copied_bytes},
          {"target_extra_objects", result.target_extra_objects},
          {"target_fsck", {{"ok", result.target_fsck_ok}, {"semantic_root", result.post_cut.semantic_root}}},
          {"binding_committed", result.binding_committed},
          {"old_backend_retained_readonly", result.old_backend_retained_readonly},
          {"residual_risks", result.residual_risks}};
}

nlohmann::json backend_authority_capability_json() {
  return {{"schema", BINDING_SCHEMA},
          {"status_operation", "backend_status"},
          {"switch_operation", "backend_switch"},
          {"rollback_operation", "backend_rollback"},
          {"cutover", "copy-verify-atomic-binding"},
          {"retained_provider_write_fenced", true},
          {"cross_machine_consensus", false}};
}

std::string backend_operation_name(storage_operation operation) {
  switch (operation) {
  case storage_operation::BackendStatus:
    return "backend_status";
  case storage_operation::BackendSwitch:
    return "backend_switch";
  case storage_operation::BackendRollback:
    return "backend_rollback";
  default:
    throw std::runtime_error("storage_backend_operation_unsupported");
  }
}

std::optional<storage_operation> parse_backend_operation(const std::string &operation) {
  if (operation == "backend_status")
    return storage_operation::BackendStatus;
  if (operation == "backend_switch")
    return storage_operation::BackendSwitch;
  if (operation == "backend_rollback")
    return storage_operation::BackendRollback;
  return std::nullopt;
}

nlohmann::json dispatch_backend_operation(storage_operation operation, const storage_service_options &options) {
  if (operation == storage_operation::BackendStatus) {
    return backend_status_json(
        storage_backend_status({options.runtime_dir, text_or(options.operation_options, "provider")}));
  }

  storage_backend_change_request request{};
  request.runtime_dir = options.runtime_dir;
  request.target_provider = text_or(options.operation_options, "target_provider");
  if (options.operation_options.contains("expected_generation")) {
    request.expected_generation = uint64_or(options.operation_options, "expected_generation");
  }
  if (options.operation_options.contains("qualification_fail_after_copied_objects")) {
    request.fail_after_copied_objects = uint64_or(options.operation_options, "qualification_fail_after_copied_objects");
  }
  if (operation == storage_operation::BackendSwitch) {
    return backend_change_json(storage_backend_switch(request));
  }
  if (operation == storage_operation::BackendRollback) {
    return backend_change_json(storage_backend_rollback(request));
  }
  throw std::runtime_error("storage_backend_operation_unsupported");
}

} // namespace detail

storage_backend_status_result storage_backend_status(const storage_backend_status_request &request) {
  storage_backend_status_result result{};
  result.runtime_dir = detail::absolute_normalized(request.runtime_dir).string();
  result.binding = detail::parse_binding(detail::load_json(detail::binding_path(result.runtime_dir)));
  if (result.binding.present) {
    result.provider = result.binding.provider;
    result.provider_config_source = "binding:generation-" + std::to_string(result.binding.generation);
    const auto configured = detail::select_provider(request.requested_provider);
    if (configured.source != "default" && configured.name != result.provider) {
      result.ok = false;
      result.warnings.push_back("provider_binding_mismatch: configured " + configured.name + ", authoritative " +
                                result.provider);
    }
  } else {
    const auto selection = detail::select_provider_for_runtime(result.runtime_dir, request.requested_provider);
    result.provider = selection.name;
    result.provider_config_source = selection.source;
  }
  result.migration = detail::parse_migration(detail::load_json(detail::state_path(result.runtime_dir)));
  try {
    result.inventory = detail::inventory_view(detail::provider_cache::instance()
                                                  .acquire_migration(result.runtime_dir, result.provider)
                                                  ->all_content_objects());
  } catch (const std::runtime_error &error) {
    result.ok = false;
    result.warnings.push_back(error.what());
  }
  return result;
}

storage_backend_change_result storage_backend_switch(const storage_backend_change_request &request) {
  return detail::change_backend("switch", request);
}

storage_backend_change_result storage_backend_rollback(const storage_backend_change_request &request) {
  return detail::change_backend("rollback", request);
}

} // namespace kungfu::runtime::storage_service_api
