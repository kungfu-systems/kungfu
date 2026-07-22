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
// the golden fixtures are the stage-3 characterization corpus recorded from the
// Python authority.
const std::string kRepoRoot = KUNGFU_REPO_ROOT;
const std::string kFixturesDir = ACTION_GEOMETRY_FIXTURES_DIR;

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

// Step-1 guardrail: action_canonical_json must equal Python
// json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False).
void check_canonical_json() {
  json unsorted;
  unsorted["b"] = 1;
  unsorted["a"] = 2;
  require(action::action_canonical_json(unsorted) == "{\"a\":2,\"b\":1}", "canonical sort_keys mismatch");

  const auto nested = json::parse("{\"x\":[1,2,{\"k\":\"v\"}]}");
  require(action::action_canonical_json(nested) == "{\"x\":[1,2,{\"k\":\"v\"}]}", "canonical compact mismatch");

  json unicode;
  unicode["k"] = "caf\xC3\xA9"; // "café" as raw UTF-8
  require(action::action_canonical_json(unicode) == std::string("{\"k\":\"caf\xC3\xA9\"}"),
          "canonical ensure_ascii=false mismatch");
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
