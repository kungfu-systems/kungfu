---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0108
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1017]
qualification_refs: [framework/core/src/libkungfu/tests/route_table_tests.cpp, scripts/route-topology-contract.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-16
theme: declared-event-route-topology
confidence: high
evidence_grade: A
last_reviewed: 2026-07-18
---

# ADR-0108: Event routes carry declared phase and state access

- Status: accepted; closure implemented and pending merge
- Date: 2026-07-16
- Category: Live runtime / reactive event layer / contract surface
- Related: [ADR-0075](ADR-0075-profile-level-kfd3-qualification.md),
  [ADR-0005](ADR-0005-control-event-axis-modernization-assessment.md)

## Context

The live runtime assembles its rx subscription topology imperatively. Each
component's `react()` composes `events_ | is(Tag) | $$(handler)` chains at
startup. The topology is real and load-bearing, but it exists only as executed
code: it cannot be enumerated, ordered-checked, or queried without running the
process and reading the source.

A full-repository inventory at `9d8366bcca` locates every subscription site:

```text
framework/core/src/libkungfu/src/runtime/live/peer.cpp          19
framework/core/src/libkungfu/src/runtime/live/coordinator.cpp   17
framework/core/src/libkungfu/include/kungfu/runtime/live/peer.h  7
framework/core/src/bindings/node/binding/watcher.cpp             7
framework/core/src/libkungfu/src/runtime/live/reactor.cpp        1
```

### Ordering invariants are undocumented or documented at the wrong end

`coordinator.cpp` carries one ordering comment, above its `RequestDeregister`
subscription:

```text
// have to be at bottom of react, for avoid event still required after reader disjoin
```

Three things are wrong with relying on it.

**It describes the wrong mechanism.** `reactor::disjoin` only records the
location (`disjoin_locations_.insert(location)`); the real `reader_->disjoin`
runs in `cleanup_reader_disjoin()` after the stream is over, exactly as that
function's own comment requires. The crash scenario is already prevented by that
deferral, not by subscription order. What subscription order actually controls is
`coordinator::feed`:

```cpp
void coordinator::feed(const event_ptr &event) {
  handle_timer_tasks();
  if (!is_location_live(event->source())) return;   // the real gate
  ...
  state_service_.ingest(event);
}
```

`is_location_live(uid)` is `registry_.find(uid) != registry_.end()`.
`on_request_deregister` reaches `deregister_location`, which erases from
`registry_`. If it ran first, `feed` would early-return for that frame and the
state projection would silently miss it. The failure is a silent skip, not a
crash — which is a reason to assert it, not a reason to relax.

**It protects the wrong end.** The invariant is a relationship between two
routes: a catch-all that reads `registry_` must precede a route that erases from
it. The comment is attached to the teardown route and phrased as an absolute
position ("at bottom"). Anyone adding a *new* catch-all route below
`RequestDeregister` gets no warning at all, because the constraint binds
catch-alls and the comment sits on the teardown.

**It is not the only such invariant.** `register_peer` reaches
`register_location`, which does `registry_.insert_or_assign(...)`. For a
`Register` frame both `is(Register) | $$(register_peer(event))` and the RTTI
catch-all `instanceof<frame>() | $$(feed(event))` fire, in subscription order.
`register_peer` must precede `feed`, or `feed` early-returns and the `Register`
frame is never ingested. That dependency has no comment at all. It is the same
shape as the documented one, and it is invisible.

So `feed` is bracketed by two writers of the same state:

```text
register_peer  <  feed  <  on_request_deregister
   (writes)       (reads)        (writes)
```

The requirement is not an abstract "phase". It is a read/write dependency on
shared state, and today nothing expresses or checks it.

### Catch-all routes are invisible to search

`instanceof<yijinjing::journal::frame>()` expands to
`filter(dynamic_cast<frame *>(event.get()) != nullptr)`. It is an RTTI predicate,
not a carrier-type predicate, so it matches every journal frame while naming no
carrier type at all. Three such catch-alls exist: the coordinator's `feed`, the
peer's carrier-less `filter(not started_)` route, and the node `Watcher`'s
`capture_custom_` branch.

The consequence is structural, not a matter of search skill: "who consumes
carrier X" cannot be answered by searching for X, for any X, because the
catch-alls consume every X without mentioning any. Retiring or changing the
semantics of a carrier type therefore silently changes what reaches the state
projection.

`ACTION_ENVELOPE` shows the cross-boundary cost: it is consumed by the Python
lock arbiter (`runtime_service.py`), the Python arbiter client
(`arbiter_client.py`), and the C++ `Watcher` — three consumers across three
language and binding boundaries, one of which is reachable only through a
catch-all.

## Decision

The table **describes** the composition; it does not generate it. `react()` stays
imperative. Each subscription is installed through a `wire` builder that records
its phase, name, intent, and shared-state access while composing the ordinary
`is(carrier)` filter itself.

This is the load-bearing choice, and section "Alternatives" records what it is
chosen against. Describing rather than generating is what keeps the mode gates,
operator chains, compound streams, and argument-unpacking handlers exactly as
they are.

### 1. Phases give a coarse total order

```cpp
enum class phase {
  extend,    // subclass extension points (on_react / observe); installed first
  handle,    // ordinary handlers; carrier-disjoint, mutually unordered
  observe,   // catch-all routes that read state established during handle
  teardown,  // routes that destroy shared state
};
```

Within a phase, order is deliberately undefined. The coordinator's fifteen
uniform routes match disjoint carrier types, so exactly one fires per frame and
their relative order carries no meaning. Only routes that can both match the same
frame — that is, a catch-all and anything else — have an ordering requirement.

### 2. Routes declare the shared state they read and write

```cpp
enum class st { registry, locations, writers, channels };
```

Only routes that participate in a cross-route dependency carry these fields: the
catch-alls that read shared state, and the routes that write it. In the
coordinator that is five routes out of seventeen.

### 3. The assertion makes the phase assignment falsifiable

At startup, before `events_.connect`:

```cpp
for (auto &r : routes)
  for (auto &w : routes)
    if (r.reads & w.writes)
      KF_ASSERT(r.phase != w.phase,
                "route '{}' reads {} but '{}' writes it in the same phase — "
                "their order is undefined; assign explicit phases",
                r.name, state_name(r.reads & w.writes), w.name);
```

A reader and a writer of the same state must not share a phase, because within a
phase the order is undefined. The phase order then fixes the direction.

This is what gives the model teeth. A phase field alone is only an assertion that
the author's intent was correct; `reads`/`writes` make that intent checkable.
Both real dependencies are then expressed:

| Pair | Phases | Result |
| --- | --- | --- |
| `feed` reads `registry` / `register_peer` writes it | `observe` vs `handle` | distinct; `handle` < `observe` |
| `feed` reads `registry` / `on_request_deregister` writes it | `observe` vs `teardown` | distinct; `observe` < `teardown` |

Placing `register_peer` in `observe` alongside `feed` fails at startup.

### 4. Shape

```cpp
void coordinator::react() {
  wire_extend("on_react", [&] { on_react(); });

  wire<RequestWriteTo>(phase::handle, "on_request_write_to", $$(on_request_write_to(event)));
  wire<Register>(phase::handle, "register_peer", $$(register_peer(event)))
      .writes(st::registry, st::locations);
  wire<RequestStop>(phase::handle, "signal_stop", $$(signal_stop()))
      .guard("dest_is_coordinator_wire", &coordinator::dest_is_coordinator_wire);

  wire_any(phase::observe, "feed", $$(feed(event)))
      .reads(st::registry, st::locations)
      .why("state projection must see the frame while its source is still live");

  wire<RequestDeregister>(phase::teardown, "on_request_deregister", $$(on_request_deregister(event)))
      .writes(st::registry, st::locations);
}
```

`wire<T>` builds `is(T::tag)` from the template parameter, so the declared
carrier type cannot drift from the installed filter. Irregular shapes append to
the chain rather than being modelled:

```cpp
declare<TimeReset>(phase::handle, "reset_time", $R(reset_time(event->data<TimeReset>())))
    .op([](const rx::observable<event_ptr> &src) { return src | first(); });
declare_events(phase::handle, "exceed_end_time_check", $R(request_deregister()))
    .op([&](const rx::observable<event_ptr> &src) {
      return src | skip_until(events_ | filter(past_end_time)) | first();
    });
```

One slot covers every irregular shape, including the route that recursively uses
`events_` as its own `skip_until` trigger. A separate escape hatch for compound
streams is therefore unnecessary; so is the registered-exception mechanism a
generating table would have required. `declare_events` covers a route that
selects on no carrier at all.

Declaring does not subscribe; a terminal `wire_routes()` installs the table in
phase order. That distinction matters: installing at the declaration site would
leave the order determined by source layout and reduce the phase to an assertion
about it, whereas installing from the sorted table makes the phase the order.

Mode gates stay ordinary control flow:

```cpp
if (mode != mode::BACKTEST) { wire<Location>(...); ... }
```

### 5. Dynamic subscriptions are registered extension points

Four mechanisms install subscriptions outside a component's route table:

| Mechanism | Entry point | Routed through |
| --- | --- | --- |
| Subclass observation | `reactor::observe(carrier_type, cb)` | `on_react()` |
| Timers | `peer::add_timer`, `peer::add_time_interval` | ordinary methods |
| Lazy write-wait | `peer::try_write_to`, `try_write_raw_to`, `try_write_as` | ordinary write path |
| Start hook | `Watcher::on_start()` | `peer::on_start()` |

The set is not the one first recorded. `Watcher::on_react()` was listed here as
an extension point; it is now declared through the table like any other
component, and `Watcher::on_start()` took its place — a mechanism the first
inventory missed entirely.

It was missed in an instructive way. The inventory counted subscription sites by
searching the file, found six in `watcher.cpp`, and attributed them to the hook
that was being read. Two of them are not in `on_react()` at all: `on_start()`
installs an `is(Channel)` and an `is(CacheReset)` subscription.
`peer::on_start()` runs from two places — inside `react()` for backtest, before
the table is wired, and from `on_request_start()` for live and replay, which is
during dispatch. A route installed from there subscribes to `events_` from
inside an `events_` handler, so it cannot be declared at all: by the time it
runs, `wire_routes()` has already installed the table. Its position depends on
the mode and on when a frame arrives, not on any declared order.

This is why the closed-world check is defined against the mechanisms rather than
against a list of routes. A list is what a reader assembles by searching and
attributing, and that is the failure this record exists to remove — it produced
a wrong inventory here even while the inventory was the task.

`try_write_*` is the sharpest: when no writer exists for a destination it
installs a one-shot `first()` Channel subscription from the ordinary business
write path, at arbitrary times, from call sites throughout the tree. It already
keeps a runtime ledger in `try_write_dest_ids_`, which the runtime route table
extends rather than replaces.

Observation is small in practice: Python installs exactly two `observe` routes,
both on `ACTION_ENVELOPE`. `on_react()` is not a routing hook by definition —
`resource_manager::on_react()` starts a background thread and installs nothing,
and `arbiter_client.py` overrides it with no subscriptions. Verification must not
infer routes from the presence of an override.

### 6. The recorded topology becomes queryable

The wired routes form a runtime table. A query command answers consumer and
producer questions over it and emits JSON, including catch-alls, which no
text search can attribute. The acceptance bar is the `ACTION_ENVELOPE` case: one
query returns all three consumers across the Python and node boundaries.

## Alternatives

**Do nothing; improve the comments.** Rejected. The current comment is already
present, reasonably worded, and still wrong about its own mechanism and attached
to the wrong end of the dependency. A second undocumented dependency of the same
shape (`register_peer` < `feed`) shows comments do not scale to this. Comments
also cannot answer the catch-all attribution question.

**Phase field only, without `reads`/`writes`.** Rejected as false assurance. A
phase sort does happen to order `feed` before `on_request_deregister`, but only
because the author assigned the phases correctly; nothing checks the assignment.
It gives zero protection inside `handle`, which is exactly where the
`register_peer` < `feed` dependency lives, while presenting as though ordering is
now guarded. An unchecked guard is worse than none.

**A declarative table that generates the composition.** Rejected on cost and
expressiveness. To generate the composition the table must model a mode
applicability set, operator slots for `first` / `take_until` / `skip_until`,
sentinel forms for carrier-less routes, and handler adapters for arguments
unpacked from the event. The peer's `REPLAY` route
(`skip_until(events_ | filter(...)) | first()`) recursively references `events_`
as its own trigger stream and cannot be expressed at all, forcing a registered
exception mechanism. Describing instead of generating removes every one of these
requirements, at the cost recorded under Consequences. Note that `to(uid)` does
*not* motivate an operator slot: `is`, `to` and `from` are all
`event_filter_any(member)` over a pointer-to-member and return `filter(pred)`, so
they are predicates of one shape.

**Explicit dependency edges (`after: [register_peer]`).** Rejected as the primary
mechanism. It expresses the constraint exactly but requires each author to know
which other routes they depend on by name, which is the knowledge the ADR is
trying to stop relying on. `reads`/`writes` state the local fact the author does
know, and let the engine derive the ordering requirement.

## Invariants and falsification

- **Behaviour is unchanged.** The assembled subscription set after migration is
  identical, entry for entry and in order, to the set before it. Falsified by a
  differential test observing a different chain order, guard outcome, or handler
  effect.
- **Same-state reader and writer are never unordered.** Falsified by a negative
  fixture that declares a reader and a writer in one phase and still connects.
- **Declared carrier cannot drift.** `wire<T>` derives the filter from `T`.
  Falsified if any migrated uniform route can declare one carrier and install
  another.
- **The closed world is closed.** Every runtime subscription maps to a declared
  route or one of the four registered extension points. Dynamic route admission
  rejects a missing or mismatched extension before subscription, while the
  static contract inventories every `events_ |` source surface. Falsified by a
  new surface or dynamic subscription path that the registry does not name.

## Consequences

Ordering invariants gain teeth and, more importantly, gain falsifiable intent:
`reads`/`writes` turn "this route must come first" from a claim into a checkable
fact. The catch-all attribution problem becomes answerable. The recorded table is
a gateable artifact and prepares the declared source later needed for xinfa
projection, without depending on it.

The honest cost is a new drift surface. Because the table describes rather than
generates, `.reads()`, `.writes()`, `.guard()` and `.why()` can lie: a route may
declare state access it does not perform, or omit access it does. `wire<T>`
closes this for the carrier type, and the negative fixture closes it for the
phase assertion, but nothing checks the state annotations themselves. Deriving
them would require static analysis of handler bodies, which is not proportionate
here. The mitigation is scope: only catch-alls and state writers carry the
annotations — five of seventeen routes in the coordinator — so the hand-maintained
surface stays small relative to the silent failures it prevents.

The migration is behaviour-preserving and incremental. A component that has not
migrated keeps working; wired and unwired subscriptions coexist during delivery.

## Delivery stages

1. **Wire infrastructure and coordinator.** `phase`, `st`, the `wire` builder,
   the same-phase read/write assertion with a negative fixture, and the
   coordinator's seventeen routes. The coordinator covers every shape — uniform,
   named guard, RTTI catch-all, teardown, and an `extend` point — and both known
   ordering dependencies, so it validates the model before it spreads.
2. **Peer.** Mode gates stay as control flow; the `REPLAY` compound stream uses
   the `op()` stream slot, and `feed_state_data` uses `declare_events`.

   Delivered, and it corrected two expectations. `feed_state_data` selects on no
   carrier but is not a catch-all in effect: it only acts on the four
   `StateDataTypes`, none of which any other peer route handles, so it never
   observably co-fires with one and needs no ordering. Had it been a true
   catch-all, `observe` would have forced it behind routes it currently precedes
   and changed peer's order — the phase vocabulary is derived from the
   coordinator's lifecycle, and peer does not exercise `observe` or `teardown` at
   all.

   The limit that follows is worth stating plainly. `feed_state_data`'s guard
   reads `started_`, which `on_request_start` writes, and the reader must precede
   the writer — the opposite direction from the coordinator, whose catch-all must
   follow its writer. `reads`/`writes` state the dependency but not its
   direction; only the phase order supplies that, and the current vocabulary
   cannot place an ordinary handler after a reader without saying something false
   about what it is. The pair is inert today because `RequestStart` is not a
   `StateDataType`, so it is recorded in `why()` rather than annotated. If a
   future component needs a reader ordered before an ordinary writer, the
   vocabulary must grow before the annotation can be honest.
3. **Watcher.** Crosses the node binding boundary: a runtime-conditional route, a
   carrier-less catch-all, and a `take_until` compound stream. Included because
   the topology query cannot answer the `ACTION_ENVELOPE` question without it.

   Its four `on_react()` routes are delivered, and they needed nothing the peer
   had not already required. `CaptureCustomEvent` is the case that justifies the
   record: it consumes `ACTION_ENVELOPE` through a predicate that never names the
   carrier, and only when capture is enabled, so no search of the source can
   attribute that consumer.

   Its three `on_start()` routes are delivered as the `start-hook` extension.
   They still subscribe dynamically because `on_start()` may run during
   dispatch, after the table is wired, but each is admitted and recorded before
   the subscription is installed. The topology therefore includes
   `feed_state_data_started`, `InspectChannel`, and `UpdateEventCache` without
   pretending their order belongs to the startup phase table.
4. **Closure and query.** Runtime route table, the closed-world check over all
   four extension-point mechanisms, and the JSON topology query.

   The query is delivered, and it forced a split the record did not anticipate.
   The topology question is not about a running process: the three consumers of
   `ACTION_ENVELOPE` live in two processes and two languages, so no single
   runtime table can hold them. It needs a static account of what the source
   declares, which is what `docs/route-topology.registry.json` and
   `scripts/route-topology-contract.mjs` provide — the registry–anchor–verify
   shape of ADR-0075, checked in both directions and wired into the staged gate.
   Answering `--consumer ACTION_ENVELOPE` now returns all three.

   The runtime table serves the other half: every mechanism records, so the table
   is a complete account of what a process subscribed. Dynamic route admission
   now requires exactly one of `observe`, `timer`, `lazy-write`, or `start-hook`
   and rejects missing or mismatched extension attribution before the caller
   subscribes. The static contract complements that runtime guard with an exact
   inventory of all sixteen `events_ |` source surfaces; a new file, a changed
   count, a missing extension anchor, or an undeclared dynamic route fails the
   contract. Its self-test exercises all three negative shapes. Together these
   checks deliver the closed-world assertion without requiring a single process
   to contain the cross-language topology.

`continuity` is out of scope: it owns no routes. It is a policy module holding
admission decisions, backoff computation, JSON codecs, and the peer continuity
tracker state machine.
