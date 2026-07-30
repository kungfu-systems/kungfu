// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/action_geometry.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace action = kungfu::runtime::action;
using nlohmann::json;

namespace {

// Source-tree paths injected by CMake so the test is self-contained: the welded
// contract is resolved through the real registry rooted at KUNGFU_REPO_ROOT, and
// the golden fixtures are the language-neutral contract corpus consumed by
// both native and Python conformance tests.
const std::string kRepoRoot = KUNGFU_REPO_ROOT;
const std::string kFixturesDir = ACTION_GEOMETRY_FIXTURES_DIR;
const std::string kCanonicalJsonVectors = CANONICAL_JSON_VECTORS;

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::string read_file(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  require(static_cast<bool>(stream), "cannot open fixture: " + path);
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

json load_fixture(const std::string &name) { return json::parse(read_file(kFixturesDir + "/" + name + ".json")); }

// Compare a fresh native result against the golden output, both routed through
// action_canonical_json so the assertion is on canonical bytes.
void expect_canonical_equal(const std::string &name, const json &actual, const json &expected) {
  const auto actual_bytes = action::action_canonical_json(actual);
  const auto expected_bytes = action::action_canonical_json(expected);
  require(actual_bytes == expected_bytes,
          name + " mismatch\n  actual  : " + actual_bytes + "\n  expected: " + expected_bytes);
}

void check_evaluate_case(const std::string &name) {
  const auto fixture = load_fixture(name);
  const auto &input = fixture.at("input");
  const auto responsibility_ids = input.value("responsibilityIds", json::object());
  const auto inference_claims = input.value("inferenceClaims", json::array());
  const auto actual = action::evaluate_action_geometry(responsibility_ids, inference_claims, kRepoRoot);
  expect_canonical_equal(name, actual, fixture.at("output"));
}

void check_session_case(const std::string &name) {
  const auto fixture = load_fixture(name);
  const auto &input = fixture.at("input");
  const auto before = input.value("before", json::object());
  const auto after = input.value("after", json::object());
  const auto actual = action::evaluate_session_refinement(before, after, kRepoRoot);
  expect_canonical_equal(name, actual, fixture.at("output"));
}

void check_canonical_json() {
  const auto corpus = json::parse(read_file(kCanonicalJsonVectors));
  const auto &profile = corpus.at("profiles").at(action::ACTION_CANONICAL_JSON_V1);
  for (const auto &vector : profile.at("accepted")) {
    const auto id = vector.at("id").get<std::string>();
    require(action::action_canonical_json(vector.at("value")) == vector.at("canonical").get<std::string>(),
            "canonical accepted vector mismatch: " + id);
  }
  for (const auto &vector : profile.at("rejected")) {
    const auto id = vector.at("id").get<std::string>();
    auto value = vector.value("specialFloat", "") == "nan" ? json(std::numeric_limits<double>::quiet_NaN())
                 : vector.value("specialFloat", "") == "positive-infinity"
                     ? json(std::numeric_limits<double>::infinity())
                     : vector.at("value");
    try {
      (void)action::action_canonical_json(value);
      throw std::runtime_error("canonical rejected vector was accepted: " + id);
    } catch (const action::canonical_json_error &error) {
      require(error.code() == vector.at("failureCode").get<std::string>(),
              "canonical rejected vector failure mismatch: " + id);
    }
  }
}

void check_geometry_root() {
  require(action::action_geometry_root(kRepoRoot) ==
              "sha256:7714576ce33208544ca8a9ee1869ad988d815c07dacbf9e136e0475ce2fb9793",
          "geometryRoot mismatch");
}

} // namespace

int main() {
  try {
    check_canonical_json();
    check_geometry_root();
    check_evaluate_case("geometry_evaluate_admissible");
    check_evaluate_case("geometry_evaluate_topology_mismatch");
    check_evaluate_case("geometry_evaluate_identity_alias");
    check_evaluate_case("geometry_evaluate_non_substitution");
    check_session_case("geometry_session_refinement_preserved");
    check_session_case("geometry_session_refinement_changed");
    std::cout << "kungfu_action_geometry_tests: OK" << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu_action_geometry_tests: FAIL: " << error.what() << std::endl;
    return 1;
  }
}
