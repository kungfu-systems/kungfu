---
status: accepted
period: 2026-07-11
theme: domain-neutral-live-runtime-terminology
doc_type: architecture-decision
source_level: local-files + user-decision
confidence: high
sensitivity: public
evidence_grade: A
review_state: user-reviewed
last_reviewed: 2026-07-11
---

# ADR-0057: live runtime internals use reactor, peer, and coordinator

- Status: accepted; implemented
- Date: 2026-07-11
- Category: runtime architecture / naming / compatibility
- Supersedes: the naming decision in [ADR-0036](ADR-0036-supervisor-and-workspace-master-topology.md)
- Related: [ADR-0038](ADR-0038-location-namespace-terminology.md),
  [ADR-0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md),
  [ADR-0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md), and
  [ADR-0055](ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md)

## Context

Kungfu's early runtime used `practice`, `hero`, `apprentice`, and `master` as
internal C++, Python, Node, CLI, and UI vocabulary. Those names were memorable
when the runtime was small, but they no longer exposed enough structure for a
system spanning trading, accountable agent work, and future game runtimes.
They also forced readers to translate product style before understanding
ownership, topology, and control flow.

The product may retain names such as Kungfu and Shifu at its outermost UI and
developer-tool surfaces. The load-bearing runtime vocabulary must instead be
domain-neutral and describe the role a component performs.

## Decision

The canonical live-runtime model is:

```text
runtime::live::reactor
├── peer
│   └── watcher
└── coordinator

per-user supervisor
└── owns and routes one coordinator per resolved data root
```

1. `runtime::live` is the namespace for live coordination above durable
   yijinjing storage.
2. `reactor` is the single-threaded reactive event-pump base.
3. `peer` is a normal participant attached to the live bus. The Node `watcher`
   remains a peer specialization.
4. `coordinator` is the per-data-root peer registry, routing, live projection,
   and assessment-scheduling process.
5. `supervisor` remains the per-user process manager and coordinator router.
6. The public operator surface is `kungfu runtime ...`. Language bindings
   expose `peer` and `coordinator`; the former stylized type and CLI names have
   no source-level aliases in this pre-stable release.
7. This decision does not rename the `yijinjing` library. It changes the live
   coordination layer above that journal/storage kernel.

## Compatibility boundary

Names and persisted identities are separate contracts. Existing v1 journals,
RocksDB state, nanomsg endpoints, and location UIDs were derived from the
historic coordinator location namespace and name. Changing those strings in
place would strand retained data.

Therefore:

- C++ centralizes the historic location identity behind
  `COORDINATOR_WIRE_NAMESPACE` and `COORDINATOR_WIRE_NAME`. New code uses only
  coordinator semantics; the old string is permitted only in that adapter.
- Python writes runtime service schemas and fields under `kungfu.runtime.* /v2`
  with `coordinatorPid`, while accepting the old route schema and process-state
  directory as read-only migration inputs.
- New process-control state is written under `runtime/coordinator/`. Existing
  `runtime/master/` state may be read and stale pid files may be repaired, but
  no durable journal or database is renamed or deleted automatically.
- A future wire-v2 identity change requires its own migration ADR, dual-read
  fixtures, and explicit data conversion. A terminology cleanup is not that
  migration.
- Historical ADR text, persisted v1 fixtures, and compatibility tests may name
  the retired terms when necessary to explain or prove compatibility.

## Enforcement

The live-runtime terminology gate rejects retired source paths, namespaces,
types, bindings, service modules, CLI commands, KFD surfaces, and current-doc
claims. It has a narrow allowlist for the centralized wire/state adapters,
compatibility fixtures, and the superseded ADR.

## Consequences

- Runtime code communicates topology directly and stays usable across domain
  horizons without trading-specific or martial-arts-specific translation.
- `peer` is short enough for frequent API use while still describing symmetric
  participation; `coordinator` remains longer because it names the rarer,
  load-bearing ownership role precisely.
- C++ includes, Python imports, binding class names, CLI commands, KFD IDs, and
  GUI IPC names change in this pre-stable release. Downstream source code must
  migrate rather than rely on indefinite aliases.
- Historic data remains readable. The compatibility cost is one explicit v1
  adapter until a separately governed wire migration retires it.
