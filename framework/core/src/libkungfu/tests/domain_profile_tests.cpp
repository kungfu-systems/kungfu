// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/domain_profile.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace action = kungfu::runtime::action;
using nlohmann::json;

namespace {

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

void expect_canonical_equal(const std::string &name, const json &actual, const json &expected) {
  const auto actual_bytes = action::action_canonical_json(actual);
  const auto expected_bytes = action::action_canonical_json(expected);
  require(actual_bytes == expected_bytes,
          name + " mismatch\n  actual  : " + actual_bytes + "\n  expected: " + expected_bytes);
}

void check_domain_roots() {
  const auto fixture = load_fixture("domain_roots");
  const auto actual = action::domain_profile_roots(kRepoRoot);
  expect_canonical_equal("domain_roots", actual, fixture.at("output"));
}

void check_role_bindings(const std::string &name) {
  const auto fixture = load_fixture(name);
  const auto role = fixture.at("input").at("role").get<std::string>();
  const auto actual = action::role_bindings(role, kRepoRoot);
  expect_canonical_equal(name, actual, fixture.at("output"));
}

void check_validate_role_body(const std::string &name) {
  const auto fixture = load_fixture(name);
  const auto &input = fixture.at("input");
  const bool allow_legacy = input.value("allow_legacy", true);
  const auto actual = action::validate_role_body(input.at("body"), allow_legacy, kRepoRoot);
  expect_canonical_equal(name, actual, fixture.at("output"));
}

// Fail-closed gate: a role schema keyword outside kfd7-role-schema-subset/v1 must
// be rejected at load time. Exercised indirectly through validate_role_body by
// temporarily mutating would be invasive; instead assert the live schemas load
// (roots succeeds) and that an unknown role fails closed with the Python message.
void check_unknown_role_fail_closed() {
  json body = {{"role", "not-a-role"}, {"schema", "kungfu.agent-work.fact-role/v2"}};
  bool threw = false;
  try {
    action::validate_role_body(body, true, kRepoRoot);
  } catch (const std::runtime_error &error) {
    threw = true;
    require(std::string(error.what()) == "Unknown Agent Work role: 'not-a-role'",
            std::string("unknown-role message mismatch: ") + error.what());
  }
  require(threw, "unknown role must fail closed");
}

void check_legacy_rejected_when_disallowed() {
  const auto fixture = load_fixture("validate_role_body_legacy_fact");
  bool threw = false;
  try {
    action::validate_role_body(fixture.at("input").at("body"), /*allow_legacy=*/false, kRepoRoot);
  } catch (const std::runtime_error &error) {
    threw = true;
    require(std::string(error.what()) == "Legacy Agent Work role bodies are not accepted here",
            std::string("legacy-reject message mismatch: ") + error.what());
  }
  require(threw, "legacy body must be rejected when allow_legacy=false");
}

} // namespace

int main() {
  try {
    check_domain_roots();
    check_role_bindings("domain_role_bindings_fact");
    check_role_bindings("domain_role_bindings_episode");
    check_role_bindings("domain_role_bindings_pursuit");
    check_role_bindings("domain_role_bindings_atlas");
    check_role_bindings("domain_role_bindings_warrant");
    check_validate_role_body("validate_role_body_valid_fact");
    check_validate_role_body("validate_role_body_legacy_fact");
    check_unknown_role_fail_closed();
    check_legacy_rejected_when_disallowed();
    std::cout << "kungfu_domain_profile_tests: OK" << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu_domain_profile_tests: FAIL: " << error.what() << std::endl;
    return 1;
  }
}
