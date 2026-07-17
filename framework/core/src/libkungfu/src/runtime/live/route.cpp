// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/live/route.h>

#include <algorithm>
#include <stdexcept>
#include <utility>

#include <fmt/format.h>
#include <nlohmann/json.hpp>

namespace kungfu::runtime::live {

const char *phase_name(route_phase phase) {
  switch (phase) {
  case route_phase::extend:
    return "extend";
  case route_phase::handle:
    return "handle";
  case route_phase::observe:
    return "observe";
  case route_phase::teardown:
    return "teardown";
  }
  return "unknown";
}

std::string state_names(route_state state) {
  static constexpr std::pair<route_state, const char *> ALL[] = {
      {route_state::registry, "registry"},
      {route_state::locations, "locations"},
      {route_state::writers, "writers"},
      {route_state::channels, "channels"},
  };
  std::string result;
  for (const auto &[bit, name] : ALL) {
    if (route_state_empty(route_state_shared(state, bit))) {
      continue;
    }
    if (not result.empty()) {
      result.append(" ");
    }
    result.append(name);
  }
  return result.empty() ? std::string("none") : result;
}

route_record &route_builder::record() { return table_.records_.at(index_); }

route_builder &route_builder::guard(const char *name, std::function<bool(const event_ptr &)> predicate) {
  auto &rec = record();
  rec.guard_name = name;
  rec.guard = std::move(predicate);
  return *this;
}

route_builder &route_builder::add_reads(route_state state) {
  auto &rec = record();
  rec.reads = route_state_merge(rec.reads, state);
  return *this;
}

route_builder &route_builder::add_writes(route_state state) {
  auto &rec = record();
  rec.writes = route_state_merge(rec.writes, state);
  return *this;
}

route_builder &route_builder::op(route_stream transform) {
  record().stream_op = std::move(transform);
  return *this;
}

route_builder &route_builder::consumes(int32_t carrier) {
  record().consumes.push_back(carrier);
  return *this;
}

route_builder &route_builder::why(const char *text) {
  record().why = text;
  return *this;
}

route_builder route_table::add(route_record record) {
  records_.push_back(std::move(record));
  return route_builder(*this, records_.size() - 1);
}

void route_table::validate() const {
  for (const auto &reader : records_) {
    if (route_state_empty(reader.reads)) {
      continue;
    }
    if (reader.dynamic) {
      continue; // installed at run time; phase does not order it
    }
    for (const auto &writer : records_) {
      if (&reader == &writer or writer.dynamic) {
        continue;
      }
      const auto shared = route_state_shared(reader.reads, writer.writes);
      if (route_state_empty(shared)) {
        continue;
      }
      if (reader.phase != writer.phase) {
        continue;
      }
      throw std::runtime_error(
          fmt::format("route '{}' reads {} but route '{}' writes it in the same phase ({}); their order is undefined - "
                      "assign explicit phases so the dependency is stated rather than implied (ADR-0108)",
                      reader.name, state_names(shared), writer.name, phase_name(reader.phase)));
    }
  }
}

std::vector<const route_record *> route_table::in_wire_order() const {
  std::vector<const route_record *> ordered;
  ordered.reserve(records_.size());
  for (const auto &record : records_) {
    ordered.push_back(&record);
  }
  // Stable: declaration order is preserved inside a phase, where the relative
  // order of carrier-disjoint handlers carries no meaning anyway.
  std::stable_sort(ordered.begin(), ordered.end(), [](const route_record *a, const route_record *b) {
    return static_cast<uint8_t>(a->phase) < static_cast<uint8_t>(b->phase);
  });
  return ordered;
}

std::vector<std::string> route_table::consumers_of(int32_t carrier) const {
  std::vector<std::string> names;
  for (const auto &record : records_) {
    const bool selected = record.carrier == carrier;
    const bool declared = std::find(record.consumes.begin(), record.consumes.end(), carrier) != record.consumes.end();
    if (selected or declared) {
      names.push_back(record.name);
    }
  }
  return names;
}

std::string route_table::to_json() const {
  nlohmann::json routes = nlohmann::json::array();
  for (const auto *record : in_wire_order()) {
    nlohmann::json entry;
    entry["name"] = record->name;
    entry["phase"] = phase_name(record->phase);
    entry["dynamic"] = record->dynamic;
    entry["any_frame"] = record->any_frame;
    if (record->carrier != 0) {
      entry["carrier"] = record->carrier;
    }
    if (not record->consumes.empty()) {
      entry["consumes"] = record->consumes;
    }
    if (not record->guard_name.empty()) {
      entry["guard"] = record->guard_name;
    }
    if (record->stream_op) {
      entry["stream_op"] = true;
    }
    if (not route_state_empty(record->reads)) {
      entry["reads"] = state_names(record->reads);
    }
    if (not route_state_empty(record->writes)) {
      entry["writes"] = state_names(record->writes);
    }
    if (not record->why.empty()) {
      entry["why"] = record->why;
    }
    routes.push_back(std::move(entry));
  }
  nlohmann::json out;
  out["schema"] = "kungfu.route-table/v1";
  out["routes"] = std::move(routes);
  return out.dump(2);
}

} // namespace kungfu::runtime::live
