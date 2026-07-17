// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_LIVE_ROUTE_H
#define KUNGFU_RUNTIME_LIVE_ROUTE_H

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <kungfu/common.h>
#include <kungfu/runtime/rx.h>

namespace kungfu::runtime::live {

/**
 * An extra stream stage appended after a route's frame filter.
 *
 * Some routes are not a predicate plus a handler. `first()` is stateful and
 * completes the chain; `skip_until` / `take_until` need a second stream and may
 * reference events_ recursively. Those cannot be expressed as a guard, so a
 * route may supply the stage itself. This is the escape hatch that lets the
 * table describe such a route instead of failing to model it.
 */
using route_stream = std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)>;

/**
 * Coarse per-frame traversal order for routes subscribed on the live event
 * stream (ADR-0108).
 *
 * Within a phase the order is deliberately undefined. Ordinary handlers match
 * disjoint carrier types, so at most one of them fires for any given frame and
 * their relative order carries no meaning. Only a catch-all route and some other
 * route can both match the same frame, and exactly those pairs need ordering.
 *
 * The phase supplies the direction; route_table::validate() checks that the
 * assignment is not silently ambiguous.
 */
enum class route_phase : uint8_t {
  extend = 0,   // subclass extension points; installed before any wired route
  handle = 1,   // ordinary handlers; carrier-disjoint, mutually unordered
  observe = 2,  // catch-all routes reading state established during handle
  teardown = 3, // routes destroying shared state
};

/**
 * Shared runtime state whose access creates a cross-route ordering dependency.
 *
 * Only state that actually brackets a catch-all is listed. A route annotates
 * state access so that route_table::validate() can prove the phase assignment
 * orders every reader against every writer; the annotations exist for that
 * check, not as general documentation.
 */
enum class route_state : uint32_t {
  none = 0,
  registry = 1u << 0,  // reactor::registry_; gates coordinator::feed via is_location_live
  locations = 1u << 1, // reactor location table; read by feed via get_location
  writers = 1u << 2,   // reactor::writers_
  channels = 1u << 3,  // reactor channel table
};

// Deliberately no operator| / operator& for route_state.
//
// The rx pipe operator| lives in rxcpp::operators and reaches this code only
// through the using-directive chain (kungfu::rx does `using namespace
// rxcpp::operators`, and the live translation units do `using namespace
// kungfu::rx` at global scope). It is therefore found by unqualified lookup
// walking outward to the global namespace, and ADL cannot substitute: ADL on
// rxcpp::observable searches rxcpp, not rxcpp::operators.
//
// Any operator| declared in kungfu::runtime::live would stop that outward walk
// at the first enclosing namespace and silently hide the pipe operator for every
// translation unit in this namespace — `events_ | holdon()` in reactor::setup()
// stops compiling. Named helpers and variadic reads()/writes() keep the bitset
// ergonomic without putting an operator in the way of the composition primitive.

constexpr bool route_state_empty(route_state s) { return s == route_state::none; }

constexpr route_state route_state_shared(route_state a, route_state b) {
  return static_cast<route_state>(static_cast<uint32_t>(a) & static_cast<uint32_t>(b));
}

constexpr route_state route_state_merge(route_state a, route_state b) {
  return static_cast<route_state>(static_cast<uint32_t>(a) | static_cast<uint32_t>(b));
}

const char *phase_name(route_phase phase);

/** Space-separated names of every bit set in `state`; "none" when empty. */
std::string state_names(route_state state);

/**
 * One recorded route.
 *
 * `matcher` is the frame predicate the engine installs; `carrier` and
 * `any_frame` are the projection of that predicate used by topology queries.
 * The engine builds `matcher` from the declared carrier type, so a declared
 * carrier cannot drift from the installed filter.
 */
struct route_record {
  route_phase phase = route_phase::handle;
  std::string name = {};
  std::string why = {};
  int32_t carrier = 0;    // 0 when the route does not select one carrier type
  bool any_frame = false; // true for RTTI catch-all routes
  bool dynamic = false;   // installed at run time; position is not phase-controlled
  // Carriers this route handles that its matcher does not name. A guard is an
  // opaque predicate, so a route selecting inside one must say what it consumes
  // or no query can attribute it. This is declared, and can therefore be wrong;
  // it is the drift ADR-0108 accepts in exchange for describing the composition.
  std::vector<int32_t> consumes = {};
  std::string guard_name = {};
  std::function<bool(const event_ptr &)> matcher = {};
  std::function<bool(const event_ptr &)> guard = {};
  route_stream stream_op = {}; // optional extra stage; see route_stream
  std::function<void(const event_ptr &)> handler = {};
  route_state reads = route_state::none;
  route_state writes = route_state::none;
};

class route_table;

/** Chained metadata for the route just declared. Not meant to outlive the statement. */
class route_builder {
public:
  route_builder(route_table &table, size_t index) : table_(table), index_(index) {}

  route_builder &guard(const char *name, std::function<bool(const event_ptr &)> predicate);

  /** Shared state this route reads; pass one or more bits. */
  template <typename... States> route_builder &reads(States... states) { return add_reads(combine(states...)); }

  /** Shared state this route writes; pass one or more bits. */
  template <typename... States> route_builder &writes(States... states) { return add_writes(combine(states...)); }

  /** Append a stream stage after this route's filter (e.g. first(), take_until). */
  route_builder &op(route_stream transform);

  /**
   * Declare a carrier this route handles but does not select by name.
   *
   * Needed when the selection lives in a guard: the predicate cannot be read, so
   * without this the consumer is unattributable.
   */
  route_builder &consumes(int32_t carrier);

  route_builder &why(const char *text);

private:
  static constexpr route_state combine() { return route_state::none; }

  template <typename... Rest> static constexpr route_state combine(route_state first, Rest... rest) {
    return route_state_merge(first, combine(rest...));
  }

  route_builder &add_reads(route_state state);

  route_builder &add_writes(route_state state);

  route_record &record();

  route_table &table_;
  size_t index_;
};

/** Records the routes a component declares, then hands them back in wire order. */
class route_table {
public:
  route_builder add(route_record record);

  /**
   * Reject a same-phase reader/writer pair on any shared state.
   *
   * Within a phase the order is undefined, so a reader and a writer sharing one
   * makes the outcome depend on declaration order rather than on stated intent.
   * Throws std::runtime_error naming both routes and the shared state.
   */
  void validate() const;

  /** Routes in the order they should be subscribed: by phase, declaration order within. */
  [[nodiscard]] std::vector<const route_record *> in_wire_order() const;

  /** Names of every route handling `carrier`, whether selected or declared via consumes(). */
  [[nodiscard]] std::vector<std::string> consumers_of(int32_t carrier) const;

  /** The recorded table as JSON, for topology queries and evidence. */
  [[nodiscard]] std::string to_json() const;

  [[nodiscard]] const std::vector<route_record> &records() const { return records_; }

  [[nodiscard]] bool empty() const { return records_.empty(); }

private:
  friend class route_builder;

  std::vector<route_record> records_ = {};
};

} // namespace kungfu::runtime::live

/**
 * Handler body for a declared route, mirroring $$ from rx.h but yielding a plain
 * callable instead of a subscriber, because a declared route is subscribed later
 * by wire_routes() rather than at the declaration site.
 */
#define $R(body) [&](const kungfu::event_ptr &event) { body; }

#endif // KUNGFU_RUNTIME_LIVE_ROUTE_H
