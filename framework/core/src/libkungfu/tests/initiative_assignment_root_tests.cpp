// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/profile/profile_lifecycle.h>

#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace profile = kungfu::runtime::profile;
using nlohmann::json;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

std::string read_file(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  require(static_cast<bool>(stream), "cannot open fixture: " + path);
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

void require_evidence(const json &actual, const json &expected, const std::string &id) {
  require(actual == expected, id + " evidence mismatch");
}

} // namespace

void check_initiative_assignment_root_vectors() {
  const auto fixture =
      std::filesystem::path(KUNGFU_REPO_ROOT) / "tests/fixtures/initiative-assignment-root/vectors.json";
  const auto corpus = json::parse(read_file(fixture.string()));
  std::map<std::string, json> accepted;
  for (const auto &vector : corpus.at("accepted")) {
    const auto id = vector.at("id").get<std::string>();
    const auto evidence = profile::compute_initiative_assignment_root(vector.at("input"));
    require_evidence(evidence, vector.at("expected"), id);
    require_evidence(profile::verify_initiative_assignment_root(
                         vector.at("input"), vector.at("expected").at("canonicalHex").get<std::string>(),
                         vector.at("expected").at("preimageHex").get<std::string>(),
                         vector.at("expected").at("root").get<std::string>()),
                     vector.at("expected"), id + " verification");
    accepted.emplace(id, vector);
  }

  for (const auto &vector : corpus.at("rejected")) {
    const auto id = vector.at("id").get<std::string>();
    try {
      if (vector.contains("acceptedId")) {
        const auto &basis = accepted.at(vector.at("acceptedId").get<std::string>());
        auto claim = basis.at("expected");
        const auto &override = vector.at("claimOverride");
        claim[override.at("field").get<std::string>()] = override.at("value");
        (void)profile::verify_initiative_assignment_root(basis.at("input"), claim.at("canonicalHex").get<std::string>(),
                                                         claim.at("preimageHex").get<std::string>(),
                                                         claim.at("root").get<std::string>());
      } else {
        (void)profile::compute_initiative_assignment_root(vector.at("input"));
      }
      throw std::runtime_error("rejected vector was accepted: " + id);
    } catch (const profile::initiative_assignment_root_error &error) {
      require(error.code() == vector.at("failureCode").get<std::string>(), id + " failure code mismatch");
    }
  }
}
