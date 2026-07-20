---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0120
decision_status: accepted
implementation_status: staged
implementation_prs: []
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-19
theme: kfd7-library-boundary-and-successor-abi
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-19; based on repository sources, KFD-7, and user-authorized design constraints; no claim about unfinished dependency goals, unobserved platform behavior, or external adoption
---

# ADR-0120: KFD-7 fixes the reality-kernel boundary and one successor libkungfu ABI

- Status: accepted boundary; boundary-contract stage delivered; successor ABI
  implementation not started
- Date: 2026-07-19
- Category: library ownership / native ABI / consumer readiness
- Related: [ADR-0018](ADR-0018-runtime-storage-service-architecture.md),
  [ADR-0026](ADR-0026-runtime-greenfield-core-surface.md),
  [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md),
  [ADR-0078](ADR-0078-minimal-generic-core-closure-and-membrane-decode-checksum.md),
  [ADR-0109](ADR-0109-four-object-agent-work-state-contract.md),
  [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md), and
  [ADR-0117](ADR-0117-action-mjs-dual-host-kernel-bootstrap.md),
  [ADR-0123](ADR-0123-action-geometry-domain-profile-separation.md)
- Machine contract:
  [`kfd7-library-boundary.contract.json`](../../framework/core/architecture/kfd7-library-boundary.contract.json)

## Context

KFD-7 keeps Fact cuts, causal occurrence, direction, perspective, and
authority independently addressable. Kungfu already has most of the required
mechanisms, but its library boundary and native ABI still describe different
eras:

- `libyijinjing` is a source-embedded static journal and storage-contract core,
  but the generic Fact Cut implementation and much of Episode orchestration
  still live in `libkungfu`;
- `kungfu_embedding_get_api` exposes zero-copy journal reads, diagnostics,
  generic decoding, checksums, and maintenance plans through ABI v1-v4;
- `kungfu_native_storage_get_api` exposes a second bootstrap whose v1 semantic
  currency is an operation name plus JSON; and
- Python, Node, MJS, CLI, projections, and concrete providers reach overlapping
  parts of the runtime without one published end-state ownership map.

Freezing either current bootstrap as the complete long-term action-runtime ABI
would preserve that accidental split. Moving every current storage/runtime
service below the membrane would instead pull providers, projections, process
coordination, Profile policy, and language-host concerns into the reality
kernel. Both outcomes violate the generic/domain boundary and KFD-7.

## Decision

### 1. The product has three semantic ownership levels

`libyijinjing` owns the source/static **reality-ledger kernel**:

- canonical Fact identity, immutable versions, typed relations, Cuts, refs,
  compare-and-swap transitions, and their receipts;
- Episode identity, causal ordering, append/seal records, and replay inputs;
- journal and content-addressed authority, integrity, recovery primitives,
  portable bundles, and provider-neutral storage ports.

It does not own a shared-library ABI, concrete storage engines, SQLite
projections, runtime processes, transport, GUI, TrustReport policy, or Profile
success semantics. Its supported distribution remains source embedding of the
`yijinjing` static target. The escalation rules in
[`EMBEDDING.md`](../../framework/core/src/libyijinjing/EMBEDDING.md) remain in
force; this decision does not create `libyijinjing.so` or a separate package.

`libkungfu` owns the installed **action-runtime membrane**:

- contract and capability discovery;
- zero-copy stream/data-plane access;
- runtime composition over the reality kernel and replaceable providers;
- Fact/Episode and ActionBinding operations, authority conversion, bounded
  action receipts, query/replay, maintenance, and polyglot adaptation;
- the stable C ABI and its memory, error, cancellation, timeout, and
  thread-affinity rules.

The Action Geometry contract owns Pursuit, Atlas, and Warrant responsibility
boundaries, cross-role invariants, and conservative session refinement. Domain
Profiles own domain fields, lifecycle vocabulary, defaults, plans,
presentation, and success policy. A Domain Profile may be implemented in MJS
or another host, but it cannot establish Fact/Episode authority, write private
journal/CAS layouts, mint native receipts, or redefine Action Geometry.

### 2. Generic mechanism, not product vocabulary, decides the lower boundary

Fact and Episode mechanics belong below the membrane only when they are
domain-neutral and required to preserve admitted reality or causal occurrence.
Action Geometry, Pursuit, Atlas, Warrant, Agent Work, trading, Rewind, Work,
Mission Control, TrustReport, and future domain folds remain above the
membrane. Their schemas may use the generic substrate, but their vocabulary
and success policy never become `libyijinjing` records merely because they are
first-party.

Concrete engines and projections stay behind `libkungfu` adapters. Moving a
provider implementation, SQLite query path, CLI handler, or JSON renderer into
`libyijinjing` is not evidence of a cleaner kernel.

### 3. One successor bootstrap discovers responsibility-scoped interfaces

The long-term installed entry is one C-compatible bootstrap named
`kungfu_get_api`. It discovers independently versioned interfaces rather than
growing one function table forever:

| Interface | Responsibility |
| --- | --- |
| discovery | runtime identity, contracts, schemas, capabilities, interface versions, and stable errors |
| stream | zero-copy journal/data-plane access and borrowed-buffer lifetime |
| ledger-action | Fact/Episode operations, exact ActionBinding inputs, plans, authority conversion, occurrence, receipts, and query/replay |
| maintenance | read-only diagnostics plus explicitly planned, fenced maintenance and recovery operations |

The bootstrap and every table use opaque handles, fixed-width values,
caller-sized structs, explicit release, numeric statuses, no-cross-boundary
unwind, and version/capability negotiation. Interfaces may evolve
independently. Unknown bootstrap, interface, protocol, schema, or encoding
versions fail closed.

The ledger-action interface does not make a successful call, sealed Episode,
admitted Fact, or settled Pursuit interchangeable. Its ActionBinding carries
exact Fact Cut, Pursuit, Atlas, Warrant, candidate-action, precondition, and
resource roots. Any changed decision input requires a new binding.

Semantic requests and responses name an explicit protocol, schema, and
encoding. Canonical Root bytes are owned by the relevant protocol contract,
not by C struct padding, a JSON library, or the ABI. JSON may remain a named
edge rendering and compatibility encoding, but cannot silently define Root
identity or operation meaning.

### 4. Existing bootstraps remain stable compatibility adapters

`kungfu_embedding_get_api` v1-v4 and `kungfu_native_storage_get_api` v1 remain
supported symbols. They are not removed, renamed, or reinterpreted in place.
Their existing table layouts, capability bits, memory rules, and refusal
behavior remain covered by frozen old-consumer fixtures.

The eventual adapters may delegate to the successor implementation after
byte/root/error parity is proved. Until then they retain their current
implementations. New consumers target `kungfu_get_api` only after the successor
header, implementation, package coordinates, and qualification gates land.
The accepted name in this ADR is not itself a shipped symbol or an ABI promise.

### 5. Migration is dependency-gated and incremental

The migration order is:

1. freeze current ownership, symbols, contracts, package gaps, and compatibility
   evidence;
2. land the successor bootstrap, discovery interface, stream adapter, and
   retained old-consumer tests without moving semantic authority;
3. consume the qualified Fact canonical-root protocol and Fact Kernel internal
   decomposition, then move generic Fact/Episode authority slices into
   `libyijinjing` one characterized slice at a time;
4. expose ledger-action and maintenance interfaces over the single authority,
   keeping JSON as an explicit compatibility edge;
5. land installed/shared consumer coordinates, public headers, C and C++
   examples, wrapper guidance, conformance vectors, and platform evidence; and
6. switch old bootstraps to compatibility adapters only after differential
   evidence proves no semantic change.

The paused Fact native-closure, canonical-root, and internal-decomposition
goals own steps 3 and 4 prerequisites. This ADR does not invent their roots,
move their code early, or treat their unqualified state as delivered.

### 6. Consumer readiness is evidence, not an adopter count

Completion requires disposable repo-external consumers built only from
supported source/static or installed/shared coordinates, plus retained
compatibility, fault, cross-language, and platform evidence. It does not
require two unrelated external adopters. External adoption remains a market
and ecosystem non-claim until observed.

## Current inventory and contradictions

The reviewed human-readable inventory is
[`kfd7-library-boundary.md`](../architecture/kfd7-library-boundary.md). The
machine contract records the same ownership, current bootstraps, successor
interfaces, dependency gates, and readiness states.

One concrete drift is corrected with this decision: the architecture registry
listed `kungfu_embedding_get_api` only through v3 while the public header and
implementation already support v4. The registry and frozen old-consumer test
now cover v4. That correction changes no ABI.

## Falsification and qualification

This decision is false if an implementation:

- gives `libyijinjing` Action Geometry or Domain Profile vocabulary, a concrete
  provider, projection, language host, process, or shared-library product
  responsibility;
- makes Action Geometry or Domain Profile code authoritative for Fact/Episode
  roots or receipts;
- publishes `kungfu_get_api` while its declared interface and package evidence
  are missing;
- removes or reinterprets either legacy bootstrap or any retained version;
- lets JSON text, C layout, backend encoding, wall clock, path, or host runtime
  define a semantic Root;
- fuses plan, authority, occurrence, admission, consequence review, and
  settlement; or
- claims consumer readiness from in-tree private-header tests alone.

Qualification must include old-caller/new-library negotiation, unknown-version
and undersized-struct refusal, buffer lifetime, stale handles, concurrency,
cancellation, crash/restart, provider switch, import/export, missing body,
degraded evidence, language-host-free closure, and exact cross-platform
protocol/root/receipt comparisons where the surface claims portability.

## Version impact

The boundary and machine contract are additive documentation and architecture
authority. Correcting the recorded embedding version from v1-v3 to v1-v4
matches the already implemented public ABI and is non-breaking.

`kungfu_get_api` and its responsibility-scoped interfaces are a planned
successor surface. They do not become stable until implemented, exported,
packaged, and qualified. Existing symbols and versions remain the current
stable native entry points throughout migration. Any persisted Root protocol
change requires a successor protocol tag, preserved legacy reader, and
explicit mapping/admission receipts.

## Consequences

Consumers and future maintainers get one end-state ownership map and one
compatibility story without prematurely freezing unfinished Fact internals.
The cost is a staged migration: the repository must carry both old bootstraps
until the successor is real and independently qualified, and the library goal
cannot claim completion while its Root/decomposition/native-closure
dependencies remain unproved.
