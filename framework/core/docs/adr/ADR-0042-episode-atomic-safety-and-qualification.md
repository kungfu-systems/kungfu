---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0042
decision_status: proposed
implementation_status: not-started
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-10
theme: episode-atomic-safety
confidence: high
evidence_grade: B
last_reviewed: 2026-07-10
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-10
  visible_context: User discussion, ADR-0033, ADR-0034, ADR-0040, ADR-0041, the Episode object model, and current v1 degraded/repair tests
  invisible_context_boundary: Exact model build and hidden system implementation are unknown
---

# ADR-0042: Episode is the atomic safety and fault-containment unit, qualified by evidence under load

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) Episode trust semantics — atomic safety, graceful
  degradation, recovery, fault containment, and qualification evidence.
- Subsystem: Episode identity and manifest semantics, runtime storage service,
  fsck, query/projection, export/import, repair, replay, and release gates.
- Related: ADR-0033 defines Episode as the first-class causal segment object;
  ADR-0034 makes its manifest a yijinjing journal; ADR-0041 makes the POD journal
  plus one typed fold the trust boundary; ADR-0040 defines the immutable content
  store used by Episode references; ADR-0023 and ADR-0028 define frame and hash
  integrity boundaries. The ADR-0041 field map and writer/crash contract are
  recorded in
  [`framework/core/docs/episode-manifest-trust-boundary.md`](../episode-manifest-trust-boundary.md).
  The executable qualification design lives in
  [`docs/episode-atomicity-qualification.md`](../../../../docs/episode-atomicity-qualification.md).

## Context

Episode is intended to become Kungfu's most important semantic object: the unit
that users and agents inspect, move, verify, replay, repair, hide, and reason
about. If the rest of the storage design is organized around Episode, users need
more than a useful API. They need a reason to trust the boundary under crashes,
missing evidence, corruption, repair, high concurrency, and large retained
populations.

"Atomic" is easy to misread as either a physical transaction or a binary rule:
an Episode is completely healthy or it must be deleted. Neither interpretation
is sufficient.

- Event frames, manifest records, content objects, and projections cross several
  persistence surfaces. They cannot be made one physical write without replacing
  the journal architecture.
- Real work is valuable. Missing a projection, payload, schema, dependency, or
  remote evidence should not cause Kungfu to discard facts that remain readable
  and verified.
- Continuing to work is safe only when Kungfu states honestly which capabilities
  the available evidence supports. "Degraded" must not mean either "pretend it is
  healthy" or "delete it by default."

The v1 Episode path already points in the right direction: a readable manifest
may be degraded, inspected, exported for diagnosis, and passed through an
auditable repair plan/fetch/apply flow. It does not yet define a complete
capability contract, and a single `ok` boolean can be confused with a claim that
every operation is safe.

Scale makes the semantic question sharper. A single machine may retain millions
of Episodes while thousands of logical agents write independent journals. A
system that is correct only in small fixtures, or that relaxes verification to
preserve throughput, cannot claim Episode as its atomic core.

## Decision

### 1. Atomic safety means bounded trust and failure containment

Episode is Kungfu's atomic unit for:

- verification and trust reporting;
- capability decisions;
- export/import and repair evidence;
- failure localization;
- causal membership and explicit cross-Episode dependency.

Atomic safety does **not** mean that every Episode is always fully available,
that every Episode is physically one transaction or file, or that damage implies
deletion. It means that partial failure is contained and made explicit at the
Episode boundary, and that no operation claims more safety than the evidence can
support.

For every Episode `E`:

```text
advertised_capabilities(E) ⊆ evidence_safe_capabilities(E)
```

An implementation violates the atomic boundary if it silently consumes missing
or unverifiable evidence, presents a partial Episode as complete, or lets one
Episode's damage corrupt unrelated Episode facts.

### 2. Lifecycle, health, and capability are separate dimensions

Lifecycle facts (`open`, sealed terminal outcomes, tombstone and later
maintenance receipts) remain append-only manifest facts. Health labels such as
`healthy`, `degraded`, or `failed` are derived diagnostics. Neither is by itself
a complete permission model.

The typed Episode view and its edge projection must be able to report at least:

- authority/manifest integrity;
- frame and content integrity;
- dependency and causal-closure status;
- projection freshness/rebuildability;
- structured issues and supporting evidence;
- the capabilities currently safe for the requested operation.

Capabilities are operation-oriented, not one global bit. The vocabulary may
include inspect, query, project, export, import/accept, replay, depend-on, repair,
sync, and continue/seal where applicable. The exact public schema is staged, but
all language bindings must project the same C++ decision rather than inventing
their own gates.

The existing v1 `ok` and `degraded` fields may remain for compatibility while a
structured capability report is introduced. `ok: true` must be interpreted in a
documented scope (for example, "manifest is readable"), never as an implicit
claim that every capability is safe.

### 3. Degradation preserves safe work

A degraded Episode is not automatically unusable and is not a deletion
candidate merely because it is degraded. Kungfu preserves all verified evidence
and keeps every capability whose preconditions remain satisfied.

Examples:

- A missing rebuildable projection does not invalidate the journal authority;
  projection-backed query can fall back or pause while inspect and rebuild remain
  safe.
- A missing optional or remotely recoverable payload may still permit manifest
  inspection, dependency analysis, evidence export, and repair discovery while
  disabling operations that require those bytes.
- A missing dependency may restrict projection, replay, or acceptance that needs
  that dependency without hiding the Episode or erasing its local facts.
- Unreadable authority evidence requires stronger isolation, but raw evidence is
  retained for forensic inspection and recovery whenever possible.

Degradation is therefore a capability contraction backed by explicit issues.
It must not silently substitute guessed facts or turn an unknown state into an
intentional absence.

### 4. Recovery is evidence-preserving and monotonic

Repair is preferred over deletion when trusted evidence can be recovered.
Repair operations must be auditable, validate incoming material before use, and
append receipts or missing facts through the authoritative path rather than
rewrite known-good history.

For a repair transition from `E` to `E'`:

```text
verified_facts(E) ⊆ verified_facts(E')
```

unless an explicit, separately governed correction contract supersedes a fact.
Normal repair may add evidence and restore capabilities; it must not remove or
silently alter facts that already verified. Retrying the same repair should be
idempotent at the semantic level.

Quarantine, tombstone, and physical purge are progressively stronger controls.
They remain available for unsafe, intentionally excluded, or unrecoverable
material, but are not the default response to ordinary degradation. Destructive
operations retain their dry-run, dependency-impact, archive, and policy gates.

### 5. Cross-Episode influence is explicit and failure does not propagate silently

ADR-0033 causal closure remains the core invariant. Damage to Episode `A` may
reduce capabilities of Episode `B` only through an explicit dependency or shared
evidence relation that fsck can name. Unrelated Episodes retain their verified
facts and safe capabilities.

Deletion, tombstone, repair, and import planning must surface reverse dependency
impact before mutation. This ADR does not choose one universal cascade policy;
it requires that any supported policy leave the selected Episode set in an
explicit, verifiable state rather than create hidden broken dependencies.

### 6. Logical admission is evidence-derived across non-atomic physical writes

Event journals, the Episode manifest journal, content objects, and projections
do not share one atomic write. The writer/recovery contract must therefore make
visibility and capability decisions from durable evidence:

- a crash before publication cannot create a silently complete Episode;
- a terminal manifest record is not sufficient for a healthy claim if attached
  evidence is missing or unverifiable;
- recovery deterministically classifies interrupted publication and exposes the
  exact missing side;
- projections never become authority merely because they committed before or
  after a journal record.

The publication state machine and crash fixtures required by ADR-0041 are the
first implementation of this rule.

### 7. Safety semantics are pressure-invariant

Concurrency and volume may change latency, availability, scheduling, and which
backend profile is selected. They must not change the meaning of a verified
fact, causal closure, degradation, or a safe capability.

Thousands of logical agents should normally write independent per-agent
journals. Shared catalog, manifest, content-store, projection, file-descriptor,
and query paths remain pressure points and must be tested as such. Backpressure
or explicit unavailability is safer than accepting unverified facts to preserve
throughput.

### 8. Production trust claims require an Episode qualification report

Kungfu must not claim Episode as a production-grade atomic core from unit tests
or benchmark throughput alone. A supported profile requires a reproducible
qualification run covering:

- model/property tests over lifecycle, dependency, capability, and repair
  transitions;
- crash injection at every declared publication boundary;
- corruption and missing-evidence fixtures;
- recovery and idempotence checks;
- cross-Episode failure-containment checks;
- projection rebuild and export/import round trips;
- concurrent-writer and ownership tests;
- scale and soak tests over the declared workload envelope.

The run emits an Episode Trust Report containing the source revision, platform,
hardware/profile, workload and random seeds, fault coverage, correctness
violations, performance distributions, and remaining gaps. A profile is
qualified only when its correctness gates pass; capacity observations do not
become support promises until explicitly adopted.

The stable requirements live in this ADR. Workload distributions, scale tiers,
fault matrices, commands, SLOs, and report schema evolve in
`docs/episode-atomicity-qualification.md` without rewriting this decision.

## Consequences

- Users can continue useful work with degraded Episodes when the required
  evidence for that operation remains valid.
- `degraded` becomes a precise contraction with repair paths, not a euphemism for
  healthy and not a deletion policy.
- C++ owns the capability decision; Python, Node, CLI, GUI, and export formats
  expose it consistently.
- Fsck must report evidence and operation impact, not only aggregate errors.
- Repair, sync, import, and maintenance gain a common safety oracle.
- Performance engineering must preserve semantics under pressure rather than
  benchmark a weakened path.
- Release language becomes profile- and evidence-scoped: Kungfu can say what was
  tested and observed without claiming immunity to every possible fault.

## First delivery

1. Define a versioned internal Episode qualification result containing evidence
   dimensions, issues, and safe capabilities; project it through the existing
   edge JSON without breaking v1 consumers. Delivered as
   `kungfu.episode.qualification/v1`: one C++-owned typed result projected by
   scoped fsck and inspect, with capability requirements, contractions and
   repair prerequisites.
2. Build an independent, executable reference model for lifecycle, dependency,
   capability, repair, and interruption states; compare the C++ typed fold/fsck
   result against it with generated histories.
3. Add deterministic crash and corruption injection around the ADR-0041
   publication state machine and the ADR-0040 content-store boundary.
4. Add the scalable workload harness and machine-readable Trust Report described
   by the companion qualification document.
5. Gate production Episode claims on the declared profile's qualification result;
   keep current unit/E2E tests as the fast inner tier.

These stages may land incrementally. The current ADR-0041 typed-fold work need
not wait for the whole scale harness, but writer lifecycle, capability reporting,
repair, and production-readiness claims must converge on this contract.

## Explicitly out of scope

- Selecting the final Episode id or hash-root composition algorithm.
- Requiring one Episode to map to one mmap file or physical transaction.
- Defining the final Episode-aware page/segment layout.
- Choosing a universal retention, tombstone cascade, GC, or purge policy.
- Fixing permanent numerical SLOs or supported capacity in an ADR.
- Implementing the distributed fleet storage service or remote consistency model.
- Guaranteeing that every degraded Episode can be fully repaired; the guarantee
  is honest capability reporting, evidence preservation, and best-effort recovery.

## Alternatives considered

- **Healthy or delete.** Rejected. It destroys recoverable work and confuses
  atomic safety with binary availability.
- **Keep one `ok` boolean as the whole contract.** Rejected. Different operations
  require different evidence; one bit either over-promises or disables useful
  work.
- **Treat degraded as healthy until an operation fails.** Rejected. It moves the
  trust decision into callers and permits silent partial behavior.
- **Stop all operations on any degradation.** Rejected. It is safe only in the
  narrowest sense and violates the requirement to preserve useful user work.
- **Benchmark throughput without a semantic oracle.** Rejected. A fast system
  that admits invalid Episodes or misreports capabilities has failed the core
  requirement.
- **Put all test parameters in the ADR.** Rejected. Hardware, distributions,
  scale tiers, and SLOs need to evolve while the safety decision remains stable.

## Residual risk

- A capability vocabulary can become too fine-grained or inconsistent across
  callers. Keep the first version small, operation-oriented, and C++-owned.
- The reference model can share assumptions with the implementation and miss the
  same bug. Keep it structurally independent and add hand-authored adversarial
  fixtures alongside generation.
- Logical-agent simulation can hide real process, file-descriptor, scheduler, or
  filesystem contention. Qualification needs both multiplexed scale and real
  multi-process tiers.
- A successful finite campaign cannot prove absence of every fault. Reports must
  name the tested envelope, seeds, uncovered surfaces, and hardware profile.
- Repair can become a second mutation language if it bypasses append-only
  authority. Every repair path needs receipts, idempotence tests, and fsck after
  application.
