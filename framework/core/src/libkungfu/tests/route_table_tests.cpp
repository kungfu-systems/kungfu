// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/live/route.h>

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using kungfu::runtime::live::route_phase;
using kungfu::runtime::live::route_record;
using kungfu::runtime::live::route_state;
using kungfu::runtime::live::route_state_merge;
using kungfu::runtime::live::route_table;
using kungfu::runtime::live::state_names;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

route_record make_route(const char *name, route_phase phase) {
  route_record record;
  record.name = name;
  record.phase = phase;
  return record;
}

bool validate_throws(const route_table &table, const std::string &expected_fragment) {
  try {
    table.validate();
  } catch (const std::runtime_error &error) {
    return std::string(error.what()).find(expected_fragment) != std::string::npos;
  }
  return false;
}

/**
 * The negative fixture for ADR-0108: a reader and a writer of the same state in
 * one phase are unordered, so the table must refuse to wire rather than let the
 * outcome depend on declaration order.
 */
void test_same_phase_reader_and_writer_is_rejected() {
  route_table table;
  table.add(make_route("register_peer", route_phase::handle)).writes(route_state::registry);
  table.add(make_route("feed", route_phase::handle)).reads(route_state::registry);

  require(validate_throws(table, "their order is undefined"),
          "a same-phase reader/writer pair on registry was accepted");
  require(validate_throws(table, "feed"), "the rejection did not name the reading route");
  require(validate_throws(table, "register_peer"), "the rejection did not name the writing route");
  require(validate_throws(table, "registry"), "the rejection did not name the shared state");
}

/** The coordinator's real shape: feed is bracketed by two writers of registry. */
void test_bracketed_catch_all_is_accepted() {
  route_table table;
  table.add(make_route("register_peer", route_phase::handle)).writes(route_state::registry, route_state::locations);
  table.add(make_route("feed", route_phase::observe)).reads(route_state::registry, route_state::locations);
  table.add(make_route("on_request_deregister", route_phase::teardown))
      .writes(route_state::registry, route_state::locations);

  table.validate();

  const auto ordered = table.in_wire_order();
  require(ordered.size() == 3, "wire order dropped or duplicated a route");
  require(ordered.at(0)->name == "register_peer", "the registry writer did not precede the catch-all");
  require(ordered.at(1)->name == "feed", "the catch-all was not ordered between its writers");
  require(ordered.at(2)->name == "on_request_deregister", "teardown did not run last");
}

/** Disjoint state must not couple routes that never interact. */
void test_disjoint_state_in_one_phase_is_accepted() {
  route_table table;
  table.add(make_route("on_channel_request", route_phase::handle)).writes(route_state::channels);
  table.add(make_route("reads_registry_only", route_phase::handle)).reads(route_state::registry);

  table.validate();
}

/** A route that neither reads nor writes is never constrained. */
void test_unannotated_routes_are_unconstrained() {
  route_table table;
  table.add(make_route("pong", route_phase::handle));
  table.add(make_route("on_time_request", route_phase::handle));
  table.add(make_route("feed", route_phase::observe)).reads(route_state::registry);

  table.validate();
}

/**
 * Declaration order is preserved inside a phase. The coordinator relies on this
 * to migrate without behaviour change: its fifteen carrier-disjoint handlers
 * keep their original relative order.
 */
void test_wire_order_is_stable_within_a_phase() {
  route_table table;
  table.add(make_route("first_handler", route_phase::handle));
  table.add(make_route("second_handler", route_phase::handle));
  table.add(make_route("extension", route_phase::extend));

  const auto ordered = table.in_wire_order();
  require(ordered.at(0)->name == "extension", "extend did not sort ahead of handle");
  require(ordered.at(1)->name == "first_handler", "declaration order was not preserved within a phase");
  require(ordered.at(2)->name == "second_handler", "declaration order was not preserved within a phase");
}

/** A route writing state it also reads is not a contradiction with itself. */
void test_route_reading_and_writing_same_state_is_accepted() {
  route_table table;
  table.add(make_route("register_peer", route_phase::handle))
      .reads(route_state::registry)
      .writes(route_state::registry);

  table.validate();
}

/**
 * The acceptance case for the topology query: a route may handle a carrier its
 * matcher never names, because the selection lives in an opaque guard. The
 * watcher's ACTION_ENVELOPE consumer is exactly that, so consumes() is what
 * keeps it attributable.
 */
void test_consumers_include_declared_and_selected_carriers() {
  constexpr int32_t ACTION_ENVELOPE = 1000;
  constexpr int32_t OTHER = 10205;

  route_table table;
  auto selected = make_route("observe:1000", route_phase::extend);
  selected.carrier = ACTION_ENVELOPE;
  selected.dynamic = true;
  table.add(std::move(selected));

  table.add(make_route("Watcher::CaptureCustomEvent", route_phase::handle)).consumes(ACTION_ENVELOPE);

  auto unrelated = make_route("on_new_location", route_phase::handle);
  unrelated.carrier = OTHER;
  table.add(std::move(unrelated));

  const auto consumers = table.consumers_of(ACTION_ENVELOPE);
  require(consumers.size() == 2, "consumers_of did not return both the selecting and the declaring route");
  require(consumers.at(0) == "observe:1000", "the carrier-selecting consumer was not reported");
  require(consumers.at(1) == "Watcher::CaptureCustomEvent",
          "the consumer that only declares the carrier was not reported");
  require(table.consumers_of(OTHER).size() == 1, "an unrelated carrier picked up extra consumers");
  require(table.consumers_of(99999).empty(), "an unconsumed carrier reported a consumer");
}

/** A dynamic route's order is not phase-controlled, so the assertion cannot speak to it. */
void test_dynamic_routes_are_exempt_from_the_phase_assertion() {
  route_table table;
  auto reader = make_route("Watcher::feed_state_data_started", route_phase::handle);
  reader.dynamic = true;
  table.add(std::move(reader)).reads(route_state::registry);
  table.add(make_route("register_peer", route_phase::handle)).writes(route_state::registry);

  table.validate(); // must not throw: the dynamic route is not ordered by phase
}

void test_json_reports_the_recorded_table() {
  route_table table;
  auto route = make_route("feed", route_phase::observe);
  route.any_frame = true;
  table.add(std::move(route)).reads(route_state::registry).why("state projection sees the frame while live");

  const auto json = table.to_json();
  for (const char *fragment : {"kungfu.route-table/v1", "\"name\": \"feed\"", "\"phase\": \"observe\"",
                               "\"any_frame\": true", "\"reads\": \"registry\"", "state projection sees the frame"}) {
    require(json.find(fragment) != std::string::npos, std::string("route JSON is missing: ") + fragment);
  }
}

void test_state_names_are_readable() {
  require(state_names(route_state::none) == "none", "empty state set was not reported as none");
  require(state_names(route_state::registry) == "registry", "single state was not named");
  require(state_names(route_state_merge(route_state::registry, route_state::locations)) == "registry locations",
          "combined state set was not named in bit order");
}

} // namespace

int main() {
  const std::vector<std::pair<std::string, void (*)()>> tests = {
      {"same-phase reader and writer is rejected", test_same_phase_reader_and_writer_is_rejected},
      {"bracketed catch-all is accepted", test_bracketed_catch_all_is_accepted},
      {"disjoint state in one phase is accepted", test_disjoint_state_in_one_phase_is_accepted},
      {"unannotated routes are unconstrained", test_unannotated_routes_are_unconstrained},
      {"wire order is stable within a phase", test_wire_order_is_stable_within_a_phase},
      {"route reading and writing same state is accepted", test_route_reading_and_writing_same_state_is_accepted},
      {"consumers include declared and selected carriers", test_consumers_include_declared_and_selected_carriers},
      {"dynamic routes are exempt from the phase assertion", test_dynamic_routes_are_exempt_from_the_phase_assertion},
      {"json reports the recorded table", test_json_reports_the_recorded_table},
      {"state names are readable", test_state_names_are_readable},
  };
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "PASS " << name << '\n';
    } catch (const std::exception &error) {
      std::cerr << "FAIL " << name << ": " << error.what() << '\n';
      return 1;
    }
  }
  return 0;
}
