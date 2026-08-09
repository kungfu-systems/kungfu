// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/profile_action.h>

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

// Replay golden kernel_io via a lambda that captures the call counter by
// reference. std::function copies its target, so a struct-held index would stay
// at 0 on the caller's stack copy.
action::FactKernelFn make_replay_kernel(const json &io, std::size_t &index) {
  return [&io, &index](const std::string & /*runtime_dir*/, const std::string &action_name, const json &request) {
    require(index < io.size(), "extra kernel call beyond golden kernel_io: " + action_name);
    const auto &expected = io.at(index++);
    require(expected.at("action").get<std::string>() == action_name,
            "kernel action mismatch at #" + std::to_string(index - 1) + ": actual=" + action_name +
                " expected=" + expected.at("action").get<std::string>());
    const auto &expected_request = expected.at("request");
    const auto actual_bytes = action::action_canonical_json(request.is_null() ? json::object() : request);
    const auto expected_bytes =
        action::action_canonical_json(expected_request.is_null() ? json::object() : expected_request);
    require(actual_bytes == expected_bytes, "kernel request mismatch at #" + std::to_string(index - 1) +
                                                " action=" + action_name + "\n  actual  : " + actual_bytes +
                                                "\n  expected: " + expected_bytes);
    return expected.at("response");
  };
}

void check_capabilities() {
  const auto fixture = load_fixture("capabilities");
  const auto actual = action::profile_action_capabilities(kRepoRoot);
  expect_canonical_equal("capabilities", actual, fixture.at("output"));
}

void check_apply(const std::string &name) {
  const auto fixture = load_fixture(name);
  std::size_t calls = 0;
  auto kernel = make_replay_kernel(fixture.at("kernel_io"), calls);
  const bool execute = fixture.value("execute", false);
  const auto actual = action::apply_profile_action("/runtime", fixture.at("input"), execute, kernel, kRepoRoot);
  require(calls == fixture.at("kernel_io").size(), name + ": missing kernel calls (used " + std::to_string(calls) +
                                                       " of " + std::to_string(fixture.at("kernel_io").size()) + ")");
  expect_canonical_equal(name, actual, fixture.at("output"));
}

void check_inspect(const std::string &name) {
  const auto fixture = load_fixture(name);
  std::size_t calls = 0;
  auto kernel = make_replay_kernel(fixture.at("kernel_io"), calls);
  const auto ref_name = fixture.at("input").at("refName").get<std::string>();
  const auto actual = action::inspect_profile_action("/runtime", ref_name, kernel, kRepoRoot);
  require(calls == fixture.at("kernel_io").size(), name + ": missing kernel calls");
  expect_canonical_equal(name, actual, fixture.at("output"));
}

} // namespace

int main() {
  try {
    check_capabilities();
    check_apply("apply_denied_responsibility_gap");
    check_apply("apply_denied_invalid_transition");
    check_apply("apply_denied_invalid_request");
    check_apply("apply_bootstrap_plan");
    check_apply("apply_bootstrap_execute");
    check_inspect("inspect_after_bootstrap");
    check_apply("apply_continue_execute");
    check_apply("apply_continue_stale_ref");
    check_apply("apply_episode_seal_execute");
    check_apply("apply_warrant_attenuate_execute");
    check_apply("apply_atlas_mark_stale_execute");
    check_apply("apply_pursuit_complete_execute");
    std::cout << "kungfu_profile_action_tests: OK" << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu_profile_action_tests: FAIL: " << error.what() << std::endl;
    return 1;
  }
}
