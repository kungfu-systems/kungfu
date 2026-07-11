# ADR-0002: yijinjing schema serialization — a FlatBuffers runtime schema over the zero-copy POD layout

- Status: superseded in schema scope by
  [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md); the
  `nanomsg` to `nng` transport migration remains historical fact
- Date: 2026-06-24
- Category: (b) improvement — data-axis modernization
- Subsystem: `kungfu/yijinjing/schema` + `yijinjing` journal / cross-process wire
- Related: predecessor to [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md),
  which turns this one-time migration into a standing schema-evolution policy;
  independent of [ADR-0001](ADR-0001-yijinjing-publish-barrier.md) (publish
  barrier — that ADR changed only the publish-synchronization semantics, not the
  schema or on-disk format).

## Supersession note

This record preserves the decision and implementation claim made in June 2026.
It is no longer the current schema-authority model. The live kernel remained a
Hana-described fixed-layout POD closed set, while FlatBuffers became the
open/domain substrate. ADR-0047 makes that split explicit and rejects the idea
that one FlatBuffers schema owns or overlays the POD layout.

Read the sections below as historical context. Do not use them to introduce a
FlatBuffers dependency into `libyijinjing`, generate a parallel `.fbs` schema
for a Hana kernel record, or route a closed POD projection through `.bfbs`.

## Decision

Make **FlatBuffers** the yijinjing runtime schema for journal and wire payloads,
generated from `*.fbs` definitions through `flatc` into the C++, Python, and Node
bindings, **while preserving the POD memory layout** so the hot path stays
zero-copy. Modernize the cross-process transport alongside it
(`nanomsg` → `nng`) during the data-axis modernization.

## Context

The runtime schema previously carried its types through a compile-time-reflection
representation. That made the wire contract effectively a C++-internal detail
rather than a declared, language-neutral schema — usable in-process, but not a
thing an external consumer could be handed and rely on.

Two pressures motivated the change:

- **A publishable contract.** For a system whose product is a zero-copy,
  cross-language, on-disk journal, the type layout *is* the ABI (see
  [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md)). A
  declared schema (`*.fbs` + codegen) turns the contract from an internal secret
  into an artifact that can be versioned, evolved, and consumed by third-party
  extensions — the precondition for a capability SDK.
- **Evolvability over time.** A journal must stay replayable for years. A schema
  with a defined evolution model (additive fields, optionals, defaults) lets a
  newer reader decode an older layout off the hot path, which a hand-rolled
  reflection representation did not provide.

## Consequences

- **Zero-copy preserved.** FlatBuffers is used for the schema, codegen, and the
  persisted/replay decode path; the in-memory POD layout on the hot path is
  unchanged, so in-process cross-language reads still pay no serialization.
- **Contract now externally declarable.** The schema becomes the published
  surface that `framework/api` and external consumers depend on.
- **Sets up ADR-0008.** This migration is the one-time move; the standing policy
  for how the v4 layout baseline evolves is governed separately by
  [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md).

## Gate outcome

The FlatBuffers write side, the read-side projection, true cross-process
operation over `nng`, and the `KF_SKIP_POD_WRITE` cutover were implemented and
compiled green for the full `libkungfu` on both Mac arm64 and Linux x86_64
(re-compiled in combination with [ADR-0001](ADR-0001-yijinjing-publish-barrier.md)).
