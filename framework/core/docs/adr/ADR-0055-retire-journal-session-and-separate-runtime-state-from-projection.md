---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0055
decision_status: accepted
implementation_status: implemented
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0055: retire journal Session and separate live state from schema projections

- Status: accepted; implemented
- Date: 2026-07-11
- Category: architecture — runtime lifecycle and projection ownership
- Subsystem: `libyijinjing`, `libkungfu`, Python/Node bindings, journal CLI,
  capability SDK
- Related: ADR-0033 makes Episode the causal storage object; ADR-0037 and
  ADR-0047 define schema/projection ownership; ADR-0039 confines FlatBuffers
  reflection to `kungfu::view`; ADR-0056 retires the remaining loose-file
  journal lifecycle CLI.

## Context

The pre-Episode runtime retained a second lifecycle model named `Session`:
`SessionStart`/`SessionEnd` marks, a SQLite session index, C++ finder/builder
objects, Python journal commands, and a Node `SessionStore`. It duplicated facts
already represented by registry liveness and Episode manifests. Its index was
derived from heuristics, its tools exposed a second replay anchor, and the old
`runtime/cache` directory mixed three unrelated responsibilities: live runtime
state, Hana-to-SQLite compilation, and FlatBuffers reflection projection.

## Decision

1. The journal `Session` model is retired without a compatibility facade.
   Runtime liveness comes from `Register`/`Deregister`; causal history, replay
   anchors, frame ranges, and closure come from Episode manifests.
2. `Session`, `SessionStart`, `SessionEnd`, `ResumePolicy`, the session index,
   `SessionStore`, Python finder/builder bindings, and session-oriented journal
   CLI commands are deleted. Existing pre-v4 session indexes are not migrated;
   authoritative journals remain readable as frames, while v4 APIs do not
   reconstruct the retired semantic object.
3. `runtime/cache` ceases to exist. Live state ownership is named
   `runtime/state_cache`; rebuildable schema-to-SQLite machinery is named
   `runtime/projection`. State code may consume projection compilers, but
   projection code does not depend on state-cache lifecycle.
4. Capability SDK replay discovery uses typed Episode list results. A replay
   anchor is an Episode coordinate and carries Episode closure/frame metadata,
   never a session-index row.
5. Terminal, WebSocket, and action-run contexts that use the ordinary word
   “session” are separate concepts and are not journal Session compatibility
   surfaces.

## Enforcement

`scripts/check-journal-authority-boundary.mjs` blocks reintroduction of the retired
symbols, files, CLI verbs, and `runtime/cache` path while explicitly ignoring
unrelated terminal/network/action contexts. The gate runs in staged, changed,
and whole-tree checks.

## Consequences

- There is one causal history object: Episode.
- There is no Python/Node/C++ semantic adapter preserving the retired Session.
- Runtime state and database projection have one-way, named dependencies.
- This is a breaking pre-release cleanup; no stable-v4 compatibility promise is
  consumed.
