// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.h>
#include <kungfu/libwasm.h>

#include <kungfu/runtime/facts/fact_admission.h>
#include <kungfu/runtime/kfx/native_registry.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/time.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fs = std::filesystem;
namespace facts = kungfu::runtime::facts;
namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr const char *WORLD_V1 = "kungfu:journal/batch@1.0.0";
constexpr const char *FACT_WORLD_ID = "kungfu.libwasm";
constexpr const char *FACT_SURFACE_ID = "kungfu.libwasm.execution";
constexpr const char *FACT_SOURCE = "kungfu-libwasm-host";
constexpr const char *RECEIPT_SCHEMA = "kungfu.libwasm.execution-receipt/v1";

struct options {
  std::string runtime_dir;
  std::string module;
  std::string expected_sha256;
  std::string package_key;
  std::string package_root;
  std::string authorization_root;
  std::string capability_grant_root;
  std::string generation_root;
  std::string cut_root;
  std::string world;
  std::string source_namespace;
  std::string source_name;
  std::string engine = "auto";
  std::string adapter_dir;
  uint64_t capabilities = 0;
  uint64_t fuel = 0;
  uint32_t memory_pages = 0;
  uint32_t batch_frames = 0;
  uint64_t module_bytes = 0;
  uint32_t output_bytes = 0;
  uint64_t revision = 0;
  bool qualification_seed = false;
};

uint64_t parse_u64(const std::string &value, const char *name) {
  size_t end = 0;
  const auto result = std::stoull(value, &end, 10);
  if (end != value.size()) {
    throw std::invalid_argument(std::string("invalid ") + name);
  }
  return result;
}

options parse_args(int argc, char **argv) {
  std::map<std::string, std::string> values;
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc || std::string(argv[index]).find("--") != 0) {
      throw std::invalid_argument("arguments must be --name value pairs");
    }
    values[std::string(argv[index]).substr(2)] = argv[index + 1];
  }
  for (const auto *required :
       {"runtime-dir", "module", "expected-sha256", "package-key", "package-root", "authorization-root",
        "capability-grant-root", "generation-root", "cut-root", "revision", "world", "capabilities", "fuel",
        "memory-pages", "batch-frames", "module-bytes", "output-bytes", "source-namespace", "source-name"}) {
    if (!values.contains(required) || values.at(required).empty()) {
      throw std::invalid_argument(std::string("missing --") + required);
    }
  }
  options result{};
  result.runtime_dir = values.at("runtime-dir");
  result.module = values.at("module");
  result.expected_sha256 = values.at("expected-sha256");
  result.package_key = values.at("package-key");
  result.package_root = values.at("package-root");
  result.authorization_root = values.at("authorization-root");
  result.capability_grant_root = values.at("capability-grant-root");
  result.generation_root = values.at("generation-root");
  result.cut_root = values.at("cut-root");
  result.revision = parse_u64(values.at("revision"), "revision");
  result.world = values.at("world");
  result.capabilities = parse_u64(values.at("capabilities"), "capabilities");
  result.fuel = parse_u64(values.at("fuel"), "fuel");
  result.memory_pages = static_cast<uint32_t>(parse_u64(values.at("memory-pages"), "memory-pages"));
  result.batch_frames = static_cast<uint32_t>(parse_u64(values.at("batch-frames"), "batch-frames"));
  result.module_bytes = parse_u64(values.at("module-bytes"), "module-bytes");
  result.output_bytes = static_cast<uint32_t>(parse_u64(values.at("output-bytes"), "output-bytes"));
  result.source_namespace = values.at("source-namespace");
  result.source_name = values.at("source-name");
  if (values.contains("engine")) {
    result.engine = values.at("engine");
  }
  if (values.contains("adapter-dir")) {
    result.adapter_dir = values.at("adapter-dir");
  }
  if (values.contains("qualification-seed")) {
    result.qualification_seed = values.at("qualification-seed") == "1";
  }
  if (result.engine != "auto" && result.engine != "wasmtime" && result.engine != "wasmer") {
    throw std::invalid_argument("--engine must be auto, wasmtime, or wasmer");
  }
  return result;
}

std::vector<uint8_t> read_bytes(const fs::path &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    throw std::runtime_error("cannot read module: " + path.string());
  }
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

std::string hash_bytes(const std::vector<uint8_t> &bytes) {
  return yy_storage::compute_content_hash_value(bytes.data(), bytes.size());
}

std::string root_hash(const std::string &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value));
}

void seed_qualification_journal(const options &opts) {
  auto locator = std::make_shared<yy::data::locator>(opts.runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  opts.source_namespace, opts.source_name, locator);
  auto writer = std::make_shared<yy::journal::writer>(location, yy::data::location::PUBLIC,
                                                      std::make_shared<yy::journal::noop_publisher>(), false,
                                                      std::make_shared<yy::journal::bus>(false));
  const std::vector<uint8_t> payload(256, 0x5a);
  writer->write_bytes(yy::time::now_in_nano(), 21901, std::as_bytes(std::span{payload}));
}

nlohmann::json world_declaration() {
  return {{"id", FACT_WORLD_ID},
          {"version", "1"},
          {"effective_from", 1},
          {"effective_until", 0},
          {"fact_surface_ids", nlohmann::json::array({FACT_SURFACE_ID})}};
}

nlohmann::json reference_for(nlohmann::json declaration) {
  declaration["root"] = root_hash(declaration.dump());
  return {{"id", declaration.at("id")}, {"version", declaration.at("version")}, {"root", declaration.at("root")}};
}

nlohmann::json surface_declaration(const nlohmann::json &world_reference) {
  return {{"id", FACT_SURFACE_ID},
          {"version", "1"},
          {"contract_world", world_reference},
          {"effective_from", 1},
          {"effective_until", 0},
          {"schema_owner_root", root_hash(RECEIPT_SCHEMA)},
          {"source_authorities", nlohmann::json::array({FACT_SOURCE})},
          {"identity_policy", "artifact-sha256/v1"},
          {"valid_time_policy", "execution-instant/v1"},
          {"system_time_policy", "journal-event-time/v1"},
          {"causal_time_policy", "admission-before-execution/v1"},
          {"reducer_policy", "latest-admitted-per-source/v1"},
          {"correction_policy", "explicit-target/v1"},
          {"retraction_policy", "explicit-target/v1"},
          {"conflict_policy", "preserve-source-claims/v1"},
          {"redaction_policy", "hash-and-ref/v1"},
          {"compatibility_policy", "exact-schema-root/v1"},
          {"known_limits", nlohmann::json::array({"single-writer admission journal", "opaque receipt hash/ref"})}};
}

void ensure_fact_surface(const std::string &runtime_dir) {
  const auto world = world_declaration();
  const auto world_reference = reference_for(world);
  const auto surface = surface_declaration(world_reference);
  const auto surface_reference = reference_for(surface);
  const auto state = facts::query_fact_state(runtime_dir);
  const auto declarations = state.value("declarations", nlohmann::json::object());
  const auto current_world = declarations.value("contract_world", nlohmann::json(nullptr));
  const auto current_surface = declarations.value("fact_surface", nlohmann::json(nullptr));

  if (current_world.is_null() && current_surface.is_null()) {
    const auto recorded_world = facts::declare_contract_world(runtime_dir, world);
    (void)facts::declare_fact_surface(runtime_dir, surface_declaration(recorded_world.at("reference")));
    return;
  }
  if (current_world != world_reference || current_surface != surface_reference) {
    throw std::runtime_error("libwasm fact declarations are missing, ambiguous, or incompatible");
  }
}

nlohmann::json record_fact(const std::string &runtime_dir, const std::string &phase, const std::string &artifact_hash,
                           const nlohmann::json &body) {
  const auto now = yy::time::now_in_nano();
  const auto receipt_dir = fs::path(runtime_dir) / "receipts" / "libwasm";
  fs::create_directories(receipt_dir);
  const auto body_text = body.dump(2) + "\n";
  const auto body_hash = root_hash(body_text);
  const auto observation_id = "libwasm-" + phase + "-" + std::to_string(now) + "-" + artifact_hash.substr(0, 12);
  const auto receipt_path = receipt_dir / (observation_id + ".json");
  const auto temporary_path = receipt_path.string() + ".tmp";
  {
    std::ofstream output(temporary_path, std::ios::binary | std::ios::trunc);
    if (!output) {
      throw std::runtime_error("cannot write libwasm receipt");
    }
    output << body_text;
  }
  fs::rename(temporary_path, receipt_path);
  const nlohmann::json observation = {
      {"observation_id", observation_id},
      {"contract_world_id", FACT_WORLD_ID},
      {"fact_surface_id", FACT_SURFACE_ID},
      {"schema_owner_root", root_hash(RECEIPT_SCHEMA)},
      {"source_id", FACT_SOURCE},
      {"subject_key", artifact_hash},
      {"valid_from", now},
      {"valid_until", 0},
      {"payload_hash", body_hash},
      {"payload_ref", "file:" + receipt_path.string()},
      {"action", "assert"},
      {"target_observation_id", ""},
  };
  const auto recorded = facts::record_observation(runtime_dir, observation, now);
  if (recorded.at("admission").at("outcome") != "admitted") {
    throw std::runtime_error("libwasm receipt was not admitted: " + recorded.at("admission").dump());
  }
  return recorded;
}

class dynamic_library {
public:
  explicit dynamic_library(const fs::path &path) : path_(path) {
#if defined(_WIN32)
    handle_ = LoadLibraryW(path.wstring().c_str());
#else
    handle_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif
  }
  ~dynamic_library() {
    if (handle_ != nullptr) {
#if defined(_WIN32)
      FreeLibrary(static_cast<HMODULE>(handle_));
#else
      dlclose(handle_);
#endif
    }
  }
  dynamic_library(const dynamic_library &) = delete;
  dynamic_library &operator=(const dynamic_library &) = delete;
  [[nodiscard]] bool loaded() const { return handle_ != nullptr; }
  [[nodiscard]] const fs::path &path() const { return path_; }
  template <typename T> [[nodiscard]] T symbol(const char *name) const {
#if defined(_WIN32)
    return reinterpret_cast<T>(GetProcAddress(static_cast<HMODULE>(handle_), name));
#else
    return reinterpret_cast<T>(dlsym(handle_, name));
#endif
  }

private:
  fs::path path_;
  void *handle_ = nullptr;
};

fs::path executable_dir(const char *argv0) {
  std::error_code error;
  const auto canonical = fs::weakly_canonical(fs::absolute(argv0), error);
  return (error ? fs::absolute(argv0) : canonical).parent_path();
}

std::string adapter_filename(const std::string &engine) {
#if defined(_WIN32)
  return engine == "wasmtime" ? "kungfu_libwasm_wasmtime.dll" : "kungfu_libwasm_wasmer.dll";
#elif defined(__APPLE__)
  return engine == "wasmtime" ? "libkungfu_libwasm_wasmtime.dylib" : "libkungfu_libwasm_wasmer.dylib";
#else
  return engine == "wasmtime" ? "libkungfu_libwasm_wasmtime.so" : "libkungfu_libwasm_wasmer.so";
#endif
}

uint32_t engine_id(const std::string &engine) {
  return engine == "wasmtime" ? KF_LIBWASM_ENGINE_WASMTIME : KF_LIBWASM_ENGINE_WASMER;
}

nlohmann::json receipt_json(const options &opts, const std::string &engine,
                            const kf_libwasm_execution_receipt_v1 &receipt) {
  return {{"schema", RECEIPT_SCHEMA},
          {"world", opts.world},
          {"artifact_sha256", receipt.artifact_sha256},
          {"engine", engine},
          {"status", receipt.status},
          {"admitted", receipt.admitted == 1},
          {"limit_exceeded", receipt.limit_exceeded == 1},
          {"trap_contained", receipt.trap_contained == 1},
          {"granted_capabilities", receipt.granted_capabilities},
          {"fuel", {{"limit", receipt.fuel_limit}, {"consumed", receipt.fuel_consumed}}},
          {"batch_calls", receipt.batch_calls},
          {"frame_count", receipt.frame_count},
          {"payload_bytes", receipt.payload_bytes},
          {"host_to_guest_bytes_copied", receipt.host_to_guest_bytes_copied},
          {"guest_result", receipt.guest_result}};
}

class runtime_warrant_lease {
public:
  runtime_warrant_lease(const options &opts, nlohmann::json adoption) : opts_(opts), adoption_(std::move(adoption)) {
    const auto &warrant = adoption_.at("runtimeWarrant");
    const auto &state = adoption_.at("leaseState");
    if (adoption_.value("schema", "") != "kungfu.kfx.runtime-warrant-adoption/v1" ||
        !adoption_.value("executionAllowed", false) || warrant.at("packageKey") != opts_.package_key ||
        warrant.at("host") != "wasm" || warrant.at("capabilityGrantRoot") != opts_.capability_grant_root ||
        warrant.at("hostAuthorizationRoot") != opts_.authorization_root ||
        warrant.at("warrantRoot") == warrant.at("capabilityGrantRoot") ||
        warrant.at("warrantRoot") == warrant.at("mutationWarrantRoot") ||
        state.at("warrantRoot") != warrant.at("warrantRoot") || state.at("holder") != warrant.at("holder") ||
        state.at("state") != "active") {
      throw std::runtime_error("Core Runtime Warrant adoption identity does not match the WASM host launch");
    }
    heartbeat_thread_ = std::thread([this] { heartbeat_loop(); });
  }

  runtime_warrant_lease(const runtime_warrant_lease &) = delete;
  runtime_warrant_lease &operator=(const runtime_warrant_lease &) = delete;

  ~runtime_warrant_lease() {
    stop_heartbeat();
    if (!settled_ && heartbeat_error().empty()) {
      try {
        settle_transition("failed");
      } catch (...) {
      }
    }
  }

  void settle(const std::string &outcome) {
    stop_heartbeat();
    const auto failure = heartbeat_error();
    if (!failure.empty()) {
      throw std::runtime_error("Runtime Warrant heartbeat failed closed: " + failure);
    }
    settle_transition(outcome);
    settled_ = true;
  }

private:
  nlohmann::json fence_request(int64_t recorded_at) const {
    const auto &warrant = adoption_.at("runtimeWarrant");
    const auto &state = adoption_.at("leaseState");
    return {{"packageKey", warrant.at("packageKey")},
            {"host", warrant.at("host")},
            {"holder", warrant.at("holder")},
            {"expectedWarrantRoot", warrant.at("warrantRoot")},
            {"expectedGeneration", state.at("generation")},
            {"expectedFencingToken", state.at("fencingToken")},
            {"recordedAt", recorded_at}};
  }

  void heartbeat_loop() {
    std::unique_lock<std::mutex> lock(wait_mutex_);
    while (!wait_cv_.wait_for(lock, std::chrono::seconds(2), [this] { return stopping_; })) {
      lock.unlock();
      try {
        const auto transition = kungfu::runtime::kfx::query_native_kfx_registry(
            "runtime-warrant-heartbeat", fence_request(yy::time::now_in_nano()), opts_.runtime_dir);
        if (transition.at("leaseState").at("state") != "active")
          throw std::runtime_error("Core did not retain the active lease state");
      } catch (const std::exception &error) {
        std::lock_guard<std::mutex> failure_lock(failure_mutex_);
        failure_ = error.what();
        return;
      }
      lock.lock();
    }
  }

  void stop_heartbeat() {
    {
      std::lock_guard<std::mutex> lock(wait_mutex_);
      stopping_ = true;
    }
    wait_cv_.notify_all();
    if (heartbeat_thread_.joinable())
      heartbeat_thread_.join();
  }

  std::string heartbeat_error() const {
    std::lock_guard<std::mutex> lock(failure_mutex_);
    return failure_;
  }

  void settle_transition(const std::string &outcome) {
    auto request = fence_request(yy::time::now_in_nano());
    request["outcome"] = outcome;
    request["residualResponsibilityDisposition"] = "retained-by-kungfu-core";
    const auto transition =
        kungfu::runtime::kfx::query_native_kfx_registry("runtime-warrant-settle", request, opts_.runtime_dir);
    if (transition.at("leaseState").at("state") != "settled")
      throw std::runtime_error("Core did not retain terminal Runtime Warrant settlement");
  }

  const options &opts_;
  nlohmann::json adoption_;
  std::thread heartbeat_thread_;
  mutable std::mutex failure_mutex_;
  std::mutex wait_mutex_;
  std::condition_variable wait_cv_;
  std::string failure_;
  bool stopping_ = false;
  bool settled_ = false;
};

int run_self_test(const char *argv0) {
  const auto adapters = executable_dir(argv0) / "libwasm";
  auto results = nlohmann::json::object();
  for (const auto &engine : {std::string("wasmtime"), std::string("wasmer")}) {
    dynamic_library library(adapters / adapter_filename(engine));
    const auto self_test = library.symbol<kf_libwasm_self_test_v1_fn>("kf_libwasm_self_test_v1");
    if (!library.loaded() || self_test == nullptr) {
      throw std::runtime_error(engine + " production adapter is unavailable");
    }
    const auto status = self_test();
    results[engine] = {{"status", status}, {"metering", status == KF_LIBWASM_OK}};
    if (status != KF_LIBWASM_OK) {
      throw std::runtime_error(engine + " production adapter self-test failed");
    }
  }
  std::cout << nlohmann::json{{"schema", "kungfu.libwasm.self-test/v1"}, {"engines", results}}.dump() << std::endl;
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--self-test") {
      return run_self_test(argv[0]);
    }
    const auto opts = parse_args(argc, argv);
    const auto module = read_bytes(opts.module);
    if (module.size() > opts.module_bytes) {
      throw std::invalid_argument("module exceeds manifest moduleBytes limit");
    }
    const auto actual_hash = hash_bytes(module);
    if (actual_hash != opts.expected_sha256) {
      throw std::invalid_argument("module SHA-256 does not match the admitted manifest");
    }
    if (opts.world != WORLD_V1 || opts.capabilities != KF_LIBWASM_CAP_JOURNAL_READ_BATCH) {
      throw std::invalid_argument("unsupported world or capability grant");
    }
    const auto issued_at = yy::time::now_in_nano();
    const auto adoption = kungfu::runtime::kfx::query_native_kfx_registry(
        "runtime-warrant-adopt",
        {{"packageKey", opts.package_key},
         {"host", "wasm"},
         {"expectedCutRoot", opts.cut_root},
         {"expectedRevision", opts.revision},
         {"expectedGenerationRoot", opts.generation_root},
         {"expectedPackageRoot", opts.package_root},
         {"expectedCapabilityGrantRoot", opts.capability_grant_root},
         {"expectedAuthorizationRoot", opts.authorization_root},
         {"expectedGrantedCapabilities", nlohmann::json::array({"journal.read.batch"})},
         {"holder", "kungfu-wasm-host:" + std::to_string(issued_at)},
         {"purpose", "execute the authorized WASM product adapter"},
         {"leaseNonce", root_hash(opts.package_key + ":" + std::to_string(issued_at))},
         {"issuedAt", issued_at},
         {"expiresAt", issued_at + 3600LL * 1000LL * 1000LL * 1000LL},
         {"heartbeatTtl", 5LL * 1000LL * 1000LL * 1000LL},
         {"residualResponsibility", "retained-by-kungfu-core"},
         {"requestedCapabilities", nlohmann::json::array({"journal.read.batch"})}},
        opts.runtime_dir);
    runtime_warrant_lease runtime_lease(opts, adoption);
    if (opts.qualification_seed) {
      seed_qualification_journal(opts);
    }

    ensure_fact_surface(opts.runtime_dir);
    const nlohmann::json admission_body = {{"schema", "kungfu.libwasm.admission/v1"},
                                           {"artifact_sha256", actual_hash},
                                           {"world", opts.world},
                                           {"capabilities", opts.capabilities},
                                           {"limits",
                                            {{"fuel", opts.fuel},
                                             {"memory_pages", opts.memory_pages},
                                             {"batch_frames", opts.batch_frames},
                                             {"module_bytes", opts.module_bytes},
                                             {"output_bytes", opts.output_bytes}}}};
    const auto admission = record_fact(opts.runtime_dir, "admission", actual_hash, admission_body);

    const auto adapters = opts.adapter_dir.empty() ? executable_dir(argv[0]) / "libwasm" : fs::path(opts.adapter_dir);
    std::vector<std::string> engines =
        opts.engine == "auto" ? std::vector<std::string>{"wasmtime", "wasmer"} : std::vector<std::string>{opts.engine};
    std::unique_ptr<dynamic_library> library;
    kf_libwasm_execute_v1_fn execute = nullptr;
    std::string selected_engine;
    for (const auto &engine : engines) {
      auto candidate = std::make_unique<dynamic_library>(adapters / adapter_filename(engine));
      const auto symbol = candidate->symbol<kf_libwasm_execute_v1_fn>("kf_libwasm_execute_v1");
      if (candidate->loaded() && symbol != nullptr) {
        selected_engine = engine;
        execute = symbol;
        library = std::move(candidate);
        break;
      }
    }
    if (execute == nullptr) {
      throw std::runtime_error("no admitted libwasm engine adapter is available");
    }

    kf_api_v1 api{};
    if (kungfu_get_api(KF_ABI_V1, sizeof(api), &api) != KF_OK) {
      throw std::runtime_error("standard libkungfu bootstrap is unavailable");
    }
    kf_libwasm_execute_config_v1 config{};
    config.struct_size = sizeof(config);
    config.engine = engine_id(selected_engine);
    config.module_data = module.data();
    config.module_size = module.size();
    config.expected_sha256 = opts.expected_sha256.c_str();
    config.world = opts.world.c_str();
    config.granted_capabilities = opts.capabilities;
    config.fuel = opts.fuel;
    config.max_memory_pages = opts.memory_pages;
    config.max_batch_frames = opts.batch_frames;
    config.max_module_bytes = opts.module_bytes;
    config.max_output_bytes = opts.output_bytes;
    config.root = opts.runtime_dir.c_str();
    config.source_namespace = opts.source_namespace.c_str();
    config.source_name = opts.source_name.c_str();

    kf_libwasm_execution_receipt_v1 receipt{};
    receipt.struct_size = sizeof(receipt);
    const auto status = execute(&api, &config, &receipt);
    auto execution_body = receipt_json(opts, selected_engine, receipt);
    execution_body["admission_event_id"] = admission.at("admission_event_id");
    const auto execution_fact = record_fact(opts.runtime_dir, "execution", actual_hash, execution_body);
    execution_body["execution_admission_event_id"] = execution_fact.at("admission_event_id");
    runtime_lease.settle(status == KF_LIBWASM_OK ? "completed" : "failed");
    std::cout << execution_body.dump() << std::endl;
    return status == KF_LIBWASM_OK ? 0 : status;
  } catch (const std::exception &error) {
    std::cerr << "kungfu-wasm-host: " << error.what() << std::endl;
    return 2;
  }
}
