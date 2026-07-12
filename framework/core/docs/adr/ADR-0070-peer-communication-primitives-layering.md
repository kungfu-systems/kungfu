---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0070
decision_status: accepted
implementation_status: partial
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-13
theme: peer-communication-primitives-layering
confidence: medium
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0070: peer communication primitives — layering and domain-neutral channel/outlet naming

- Status: accepted; phase 1 implemented (naming + layering); phases 2/3 deferred
- Date: 2026-07-13
- Category: runtime architecture / communication primitives / naming
- Related: [ADR-0057](ADR-0057-domain-neutral-live-runtime-terminology.md)
  (domain-neutral runtime terminology),
  [ADR-0019](ADR-0019-git-like-source-sync-over-location-and-channel.md)
  (channel as transport edge), [ADR-0005](ADR-0005-control-event-axis-modernization-assessment.md)
  (reactive event layer frozen for v4)

## Context

The live runtime lets independent peers communicate without shared memory or
locks: every peer reads and writes append-only journals, and a `coordinator`
matches who-reads-whom and broadcasts the resulting topology. The primitives
that make this work are:

| Primitive | Layer / responsibility | First historical consumer (v3) |
| --- | --- | --- |
| `location` | Journal identity/address (role, namespace, name, mode, uid) | all runtime |
| `Channel` (`ChannelRequest`) | Routing edge: "source's data may flow to dest" | GUI order flow (account -> strategy) |
| `Band` (`RequestWriteToBand`) | A peer opening an extra **named output stream**, writable from an off-main thread | market-data source fan-out (entrust / transaction) |
| `RequestReadFrom` / `RequestWriteTo` | Subscribe / publish requests | GUI + broker client |
| `timer` / `time_interval` | Logical-clock timing off journal `Time` events | strategy / broker timers |

[ADR-0057](ADR-0057-domain-neutral-live-runtime-terminology.md) already made the
**terminology** domain-neutral (`apprentice` -> `peer`, `master` ->
`coordinator`, and the removal of `wingchun` trading types). But that change
renamed roles; it did not reshape the primitives. These primitives were first
grown for trading, yet they answer a general question — *how do peers
communicate?* — and were carried into v4 intact precisely because they are the
communication skeleton, not trading logic. Their current lack of live consumers
in v4 reflects that the first post-trading consumer has not yet appeared, not
that they are dead weight.

The gap this ADR addresses: the terminology is domain-neutral, but the
**structure of the primitives is still trading-shaped**.

## Diagnosis

Three concrete issues, each observable in the current code and traceable to a
trading-era origin.

### 1. Collapsed layering

`Channel` and `Band` carry identical fields (`source_id`, `dest_id`) and each
has a fully parallel `register_*` / `deregister_*` / `has_*` / `get_*` map and
PUBLIC broadcast. This makes them look like the same concept, but they sit at
different layers:

- `Channel` is a **routing edge** — an authorization that one location's data
  may flow to another.
- `Band` is an **output-creation** act — a peer opens an extra *named output
  location* (its own side-stream) and gains the ability to write to it from an
  off-main thread.

The identical field layout is reuse of a data structure, not a shared concept.

### 2. Coupled orthogonal capabilities

`Band` welds together two independent capabilities: (a) creating a named output
stream, and (b) writing from a non-main thread. `reactor::get_writer` dispatches
on `get_thread_id() != main_thread_id_` into a separate `band_writers_` pool,
with an off-main-thread fallback into `writers_` whose thread-safety is
uncertain. These two capabilities are orthogonal for general peer communication:
"main thread writes a named stream" and "off-main thread writes an existing
peer" are both natural, and neither is expressible cleanly today.

The off-main-thread writer pool itself is well-founded: journal writers assume a
single writer, so an external callback thread must not touch the main reactor's
`writers_`. The issue is that this necessary mechanism is named and gated by
`band` rather than by thread affinity.

### 3. Half-built establish-channel protocol

`ChannelRequest` has the same fields as `Channel` and is decoded with
`event->data<Channel>()`; it has no producer in v4. Meanwhile "establish a
routing edge" already has three overlapping entry points — implicit via
`RequestWriteTo`, implicit via `RequestReadFrom`, and explicit via
`ChannelRequest` — that were never unified. `ChannelRequest` is a placeholder
for the explicit path, left incomplete when the trading GUI that used it (order
flow establishing an account<->strategy edge) was retired.

## Decision

### Phase 1 — naming and layering (accepted; implemented)

Low risk, no behavior change. It removes the cognitive debt that makes these
primitives read as trading leftovers.

1. Rename `Band` to a name that states its role as a peer's named output stream
   (candidate: `Outlet`). Rename `band_writers_` to `off_thread_writers_` to
   decouple the writer-pool name from output semantics.
2. Document the four communication layers in `concepts.md` and here: `location`
   (journal unit), `channel` (routing edge), `outlet` (named output creation),
   read/write requests (subscribe/publish), with `timer` as logical-clock
   timing.
3. State the invariants explicitly: `channel` is routing, `outlet` is
   output-creation, off-thread writers are an orthogonal thread-affinity
   concern — not part of `outlet`.

### Phase 2 and Phase 3 — deferred, trigger-gated

Recorded here so the direction is not lost, but **not to be implemented while
the primitives have no live v4 consumer**. Building a general communication
layer with no second, non-trading consumer to validate it risks speculative
abstraction — a clean-looking layer that no real load has shaped. The single-
writer/off-thread mechanism and the routing model earn their current form from
trading; a redesign should be earned the same way, by a real new consumer.

- **Phase 2 — decouple named output from off-thread writing.** Split into
  `open_named_output(name) -> location` (any peer, any thread) and a
  thread-affinity writer pool keyed by thread id (any dest, any thread), so
  correctness comes from structure rather than the implicit "band == off-main"
  convention, and the fragile fallback is removed.
- **Phase 3 — unify the establish-channel protocol.** Recognize
  `RequestWriteTo`, `RequestReadFrom`, and `ChannelRequest` as one action with a
  direction, e.g. `EstablishChannel{source, dest, direction, from_time,
  page_size}` where `direction in {read, write, bidirectional}`. `ChannelRequest`
  becomes the bidirectional instance instead of an orphaned placeholder.

### Trigger conditions for Phase 2/3

Phase 2/3 open when the first post-trading peer consumer appears in v4 — an
external data-source adapter, an inter-component data path, agent-to-agent
coordination, or any real peer that uses these primitives. That consumer's
actual requirements drive the abstraction. Until then, Phase 2/3 stay deferred.

## Alternatives considered

- **Merge `Channel` and `Band` into one type.** Rejected. They are different
  layers (routing vs output-creation); the shared field layout is coincidental,
  and merging them would entrench the collapsed layering rather than fix it.
- **Rewrite the communication layer now.** Rejected. With no live consumer, a
  full redesign is speculative and likely to encode the wrong shape (see the
  Phase 2/3 rationale).
- **Retire these primitives as trading legacy.** Rejected. They are the general
  peer-communication skeleton; trading was only the first consumer. Retiring
  them would contradict the domain-neutral intent of ADR-0057 and discard
  working infrastructure that a v4 consumer will need.

## Consequences

- Positive: removes the "trading leftover" misreading; makes the concept
  layering explicit; gives the next consumer clean, self-describing primitives
  instead of an opaque `band`.
- Cost: Phase 1 is rename + documentation. A rename of `Band`/`band_writers_`
  must sweep any literal dependency in storage/manifest projections and GUI
  keyword tables (see Open questions).
- Deferred surface: Phase 2/3 are recorded, not scheduled; the trigger keeps
  them from becoming speculative work.

## Open questions (to verify before Phase 2/3, and to scope the Phase 1 rename)

- The coordinator-side band read and `deregister_channel` / `deregister_band`
  ordering dependencies, to confirm Phase 2 does not break topology teardown.
- Whether `RequestWriteTo` / `RequestReadFrom` in the registration handshake
  have semantics not covered by a unified `EstablishChannel`.
- Whether the `Band` -> `Outlet` rename has fixed string dependencies in
  storage/manifest projections or the schema registry that must move together.
