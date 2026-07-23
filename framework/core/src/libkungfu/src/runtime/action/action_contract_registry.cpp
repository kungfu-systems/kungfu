// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_contract_registry.h>

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

namespace kungfu::runtime::action {

namespace {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

constexpr const char *REGISTRY_SCHEMA = "kungfu.contract-registry/v1";
constexpr const char *REGISTRY_FILE = "kungfu-contracts.registry.json";
constexpr const char *REGISTRY_ENV = "KUNGFU_CONTRACT_REGISTRY";

std::string env_value(const std::string &name) {
  const char *raw = std::getenv(name.c_str());
  return raw != nullptr ? std::string(raw) : std::string();
}

std::string read_file(const fs::path &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    throw std::runtime_error("cannot open Kungfu contract file: " + path.string());
  }
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

// Search origins mirror Python's [module dir, cwd]; here we use the caller's
// search_base (typically the runtime_dir) and the current directory, each walked
// up to the filesystem root.
std::vector<fs::path> search_starts(const std::string &search_base) {
  std::vector<fs::path> starts;
  std::error_code ec;
  if (!search_base.empty()) {
    auto absolute = fs::absolute(search_base, ec);
    if (!ec) {
      starts.push_back(absolute);
    }
  }
  auto cwd = fs::current_path(ec);
  if (!ec) {
    starts.push_back(cwd);
  }
  return starts;
}

fs::path find_upward(const std::string &search_base, const std::vector<fs::path> &relatives) {
  for (const auto &start : search_starts(search_base)) {
    for (fs::path dir = start;; dir = dir.parent_path()) {
      for (const auto &relative : relatives) {
        fs::path candidate = dir / relative;
        std::error_code ec;
        if (fs::is_regular_file(candidate, ec)) {
          return candidate;
        }
      }
      if (dir == dir.parent_path()) {
        break; // reached the filesystem root
      }
    }
  }
  return {};
}

fs::path resolve_registry_path(const std::string &search_base) {
  auto explicit_path = env_value(REGISTRY_ENV);
  if (!explicit_path.empty()) {
    return fs::absolute(explicit_path);
  }
  auto found = find_upward(search_base,
                           {fs::path("framework") / "contract" / REGISTRY_FILE, fs::path("config") / REGISTRY_FILE});
  if (found.empty()) {
    throw std::runtime_error(std::string("Kungfu contract registry not found: ") + REGISTRY_FILE);
  }
  return found;
}

nlohmann::json load_registry(const fs::path &path) {
  auto registry = nlohmann::json::parse(read_file(path));
  if (!registry.is_object()) {
    throw std::runtime_error("Kungfu contract registry must be a JSON object: " + path.string());
  }
  if (registry.value("schema", std::string()) != REGISTRY_SCHEMA) {
    throw std::runtime_error("Kungfu contract registry schema mismatch: " + path.string());
  }
  if (!registry.contains("contracts") || !registry.at("contracts").is_array()) {
    throw std::runtime_error("Kungfu contract registry missing contracts array: " + path.string());
  }
  return registry;
}

const nlohmann::json &contract_entry(const nlohmann::json &registry, const std::string &surface) {
  for (const auto &entry : registry.at("contracts")) {
    if (entry.is_object() && entry.value("surface", std::string()) == surface) {
      return entry;
    }
  }
  throw std::runtime_error("Kungfu contract surface is not registered: " + surface);
}

fs::path resolve_contract_path(const nlohmann::json &entry, const std::string &surface,
                               const std::string &search_base) {
  if (entry.contains("env") && entry.at("env").is_string()) {
    auto override_path = env_value(entry.at("env").get<std::string>());
    if (!override_path.empty()) {
      return fs::absolute(override_path);
    }
  }
  std::vector<fs::path> relatives;
  if (entry.contains("source") && entry.at("source").is_string()) {
    relatives.emplace_back(entry.at("source").get<std::string>());
  }
  if (entry.contains("artifact") && entry.at("artifact").is_string()) {
    relatives.emplace_back(entry.at("artifact").get<std::string>());
  }
  if (entry.contains("file") && entry.at("file").is_string()) {
    relatives.push_back(fs::path("config") / entry.at("file").get<std::string>());
  }
  auto found = find_upward(search_base, relatives);
  if (found.empty()) {
    throw std::runtime_error("Kungfu " + surface + " contract not found via registry entry");
  }
  return found;
}

std::string content_root(const std::string &bytes) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(bytes));
}

} // namespace

registered_contract load_registered_contract(const std::string &surface, const std::string &search_base) {
  auto registry_path = resolve_registry_path(search_base);
  auto registry = load_registry(registry_path);
  const auto &entry = contract_entry(registry, surface);
  auto contract_path = resolve_contract_path(entry, surface, search_base);

  auto raw = read_file(contract_path);
  auto root = content_root(raw);

  auto document = nlohmann::json::parse(raw);
  if (!document.is_object()) {
    throw std::runtime_error("Kungfu " + surface + " contract must be a JSON object: " + contract_path.string());
  }
  if (entry.contains("schema") && document.value("schema", std::string()) != entry.at("schema").get<std::string>()) {
    throw std::runtime_error("Kungfu " + surface + " contract schema mismatch: " + contract_path.string());
  }
  if (entry.contains("contractSchemaRoot") && entry.at("contractSchemaRoot").is_string()) {
    auto expected = entry.at("contractSchemaRoot").get<std::string>();
    if (!document.contains("contractSchema")) {
      throw std::runtime_error("Kungfu " + surface + " contract missing contractSchema");
    }
    auto actual = content_root(action_canonical_json(document.at("contractSchema")));
    if (actual != expected) {
      throw std::runtime_error("Kungfu " + surface + " contract schema authority mismatch: expected " + expected +
                               ", got " + actual);
    }
  }

  return registered_contract{std::move(document), std::move(root), contract_path.string()};
}

} // namespace kungfu::runtime::action
