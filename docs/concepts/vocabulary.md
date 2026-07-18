# Kungfu Vocabulary Reference

This reference defines the public language Kungfu uses for real-world
execution. Start with [Facts Before Trust](facts-before-trust.md) and
[The Episode](the-episode.md) for the narrative, then return here when an API,
document, extension, or product surface needs the precise term.

[`vocabulary.registry.json`](../vocabulary.registry.json) is the machine-readable
authority for canonical core-term spelling and layer membership, domain-profile
classification, governed public prose, and executable language policy. This
document remains the normative human-readable definition and boundary
reference. `./shifu docs:check` rejects disagreement between the registry and
the core headings below; `./shifu docs:prose` derives its Vale configuration
from the registry instead of maintaining another rule copy.

The hierarchy is intentional:

```text
runtime substrates
  Fact / Episode

evidence and commitment
  Artifact / Manifest / Receipt

coordinates and perspective
  Source / Observer / Cut / Watermark

derivation, trust, and action
  Projection / Timeline / Claim / Proof / Purpose / TrustReport / Decision

operations
  Replay / Rewind / Recovery

domain profiles
  Agent Work / Trading / Games and Virtual Worlds / future profiles
```

## Runtime substrates

### Fact

**Definition:** A typed statement preserved by Kungfu under a declared schema
and fact contract.

**Boundary:** An observation can be recorded but not admitted. An admitted fact
can enter a canonical fold but is not universally trusted. Trust applies to a
Claim for a Purpose over pinned evidence.

**Authority:** An admitted journal record establishes semantic visibility at an
explicit Cut. A content-addressed body without that record is material, not a
Fact; a journal record whose required body is missing or unverifiable remains
visible as degraded evidence rather than a complete Fact version.

**Relationship to Episode:** Facts are recorded in or referenced by Episodes;
their identity, provenance, causal position, and schema commitments remain
inspectable.

### Episode

**Definition:** A first-class, bounded causal segment of actual work in the
Kungfu fact ledger.

**Owns:** The inspectable closure of journal facts, artifacts and payload
commitments, source provenance, schemas, receipts, dependencies, and
verification roots required to reason about one unit of work.

**Is not:** A chat session, process, terminal, journal page, source, mutable
status row, state diff, or unstructured collection of logs.

**Lifecycle:** `open -> append -> seal`, followed by non-destructive inspect,
query, verify, export, import, replay, rewind, and recovery operations.
Tombstone, repair, compaction, and garbage collection are explicit maintenance
operations and must not silently rewrite retained evidence.

**Authority:** The journal-backed Episode manifest and referenced fact evidence;
not a GUI model, SQLite projection, or exported JSON rendering.

**Relationship to Fact:** Fact answers what is admitted at a Cut. Episode
answers how bounded causal experience occurred across Cuts. An Episode may
produce observations that later become admitted Facts, while its own lifecycle
and identity are also established by journal records. Neither substrate is a
substitute for the other.

See [Episode Object Model](episode-object-model.md).

## Evidence and commitment

### Artifact

**Definition:** Durable material produced, consumed, or validated by work and
bound to an Episode through an inspectable reference or commitment.

**Boundary:** An Artifact is not required to live inline in the journal.
Content-addressed bodies and explicit absent, missing, or redacted states keep
large material off the hot path without weakening the evidence boundary.

### Manifest

**Definition:** The authoritative folded declaration of an Episode's contents,
dependencies, provenance, schema and artifact inventory, lifecycle, and
verification roots.

**Boundary:** JSON, SQLite, and GUI representations are edge views or rebuildable
projections. They are not the local manifest authority.

### Receipt

**Definition:** A typed acknowledgement that binds an operation to a specific
stream position, Episode coordinate, policy, and established guarantee.

**Boundary:** A generic success response, completed function call, mapped write,
or visible frame is not a stronger Receipt. Unknown outcomes and unsupported
profiles fail explicitly.

**Relationship to Watermark:** A durability Receipt may claim only a position at
or below the applicable qualified Watermark.

## Coordinates and perspective

### Source

**Definition:** A logical provenance and synchronization identity that can
enumerate or supply facts, Artifacts, or Episodes.

**Boundary:** Location and Channel describe runtime identity and transport. They
do not replace Source provenance or fact authority.

### Observer

**Definition:** The declared participant or location whose accepted fact set
and perspective govern a view.

**Boundary:** An Observer does not create facts by viewing them. It declares the
basis from which a Timeline or mixed-source answer is produced.

### Cut

**Definition:** An exact, reproducible boundary of accepted authority at which a
query, Proof, Projection, or assessment is evaluated.

**Boundary:** A Cut is not merely a displayed timestamp. It may be expressed by
an Episode root, exact system-time boundary, stream position, or another
declared authority coordinate supported by the queried object.

### Watermark

**Definition:** The stream position through which one named guarantee is known
to hold.

**Named forms:**

- `visible_watermark` — live readers may consume complete published facts
  through this position;
- `durable_watermark` — the selected qualified local durability contract holds
  through this position;
- `projection_watermark` — derived query state incorporates facts through this
  position;
- `replicated_watermark` — reserved for a separately qualified future
  replication profile.

**Boundary:** Watermarks are not interchangeable. Projection progress cannot
upgrade visibility into durability, and process residency cannot establish a
durable Watermark.

## Derivation, trust, and action

### Projection

**Definition:** A deterministic, rebuildable interpretation or index derived
from authoritative Facts and Episode manifests under a declared policy and
Cut.

**Examples:** SQLite query state, folded current state, a table, causal graph,
or responsibility view.

**Boundary:** Losing a Projection must not erase authoritative Facts. Rebuilding
it must not silently reinterpret history under a newer declaration.

### Timeline

**Definition:** A Projection that orders accepted Facts from one or more Sources
under a declared Observer, causal constraints, source-local order, projection
policy, and deterministic tie-breakers.

**Boundary:** A Timeline is not an assertion of a universal global clock. Known
causality must not be inverted for presentation convenience, and missing
evidence produces a degraded view rather than an invented order.

### Claim

**Definition:** A statement made by a participant that asks another participant
or system to rely on a conclusion.

**Examples:** Work is complete; an Artifact is valid; a handoff is safe; a
release may proceed; a recovered ledger may resume authority.

**Boundary:** A Claim is recorded as a statement, not promoted to truth by the
identity or confidence of its author.

### Proof

**Definition:** The evidence and derivation envelope that binds an answer or
Claim to declarations, Sources, accepted ranges, Episodes, Artifacts, a Cut,
query and policy identities, result hashes, and known gaps.

**Boundary:** An execution plan explains how an answer will be computed. Proof
states which authority and evidence support the answer.

### Purpose

**Definition:** The intended decision or use for which a Claim is assessed.

**Examples:** Internal review, handoff, continued delegation, release,
institutional adoption, external commitment, or recovery of authority.

**Boundary:** Fitness is Purpose-dependent. Evidence sufficient for one Purpose
does not silently qualify another.

### TrustReport

**Definition:** A durable, purpose-bound assessment of one Claim over pinned
Facts and Proof at a declared Cut.

**Carries:** Fitness, supporting evidence, responsibility, freshness, evidence
gaps, conflicts, residual risk, validation state, and applicable next actions.

**Boundary:** A TrustReport is not a universal boolean property of a Fact,
Episode, participant, extension, or product.

### Decision

**Definition:** A recorded choice by an authorized participant about what may or
should happen next on the basis of available facts, Proof, constraints, and
Purpose.

**Examples:** Continue, adjust, stop, approve, request evidence, hand off,
archive, recover, or reopen.

**Boundary:** Recommendation and authorization remain distinct. Agent prose
cannot create Facts, expand authority, or silently execute a Decision.

## Operations

### Replay

**Definition:** Reconstruction of recorded Facts and derived state under the
same declared runtime semantics used by live work.

**Boundary:** Replay fidelity is limited by the declared capture boundary and
available evidence. It does not imply complete recording of outside-world
state.

### Rewind

**Definition:** The user-facing operation of reopening an Episode to inspect
its causal chain, verify its evidence, understand failure, or resume recovery.

**Boundary:** Rewind defaults to forensic inspection. It never silently repeats
external side effects.

### Recovery

**Definition:** The deterministic process of validating retained authority,
identifying the last proven frontier, classifying any uncertain tail,
rebuilding Projections, qualifying interrupted Episodes, and reporting which
capabilities remain safe.

**Boundary:** A process restart is not proof of Recovery. Recovery completes
only when the applicable facts, Watermarks, repairs, quarantine, loss, and
capability contractions are reported under the selected profile.

## Domain profiles

Domain profiles add vocabulary and policies above the core without redefining
Fact or Episode identity, fact authority, Cuts, Receipts, Proof, or Recovery.

### Agent Work profile

The profile preserves Pursuit for intent continuity, Atlas for declared
perspective and fact Cut, Warrant for bounded authority, and Episode for causal
experience. Mission, Go, Responsibility State, Cost/State/Proof, Completion
Claim, Handoff, and Agent Work Inbox are current product projections. Pursuit,
Atlas, and Warrant use the generic Fact substrate; Episode remains separately
identified on the temporal substrate. These profile terms do not redefine the
domain-neutral runtime.

### Quantitative trading profile

Trading profiles may define orders, executions, positions, accounts,
settlement, and exchange-specific authority while using the same Episode,
Fact, Receipt, Projection, Cut, and Replay contracts.

### Games and virtual worlds profile

Game profiles may define inputs, entity state, rule outcomes, world changes,
random commitments, and checkpoints while using Episodes, Facts, Artifacts,
Timelines, Cuts, and Replay as the neutral substrate.

### Future profiles

Industrial, device, research, operations, and other profiles may introduce
their own domain objects only when they preserve the core authority and
verification boundaries. A domain term belongs in Kungfu Core only after its
neutral invariant is clear and demonstrated beyond one profile.

## Canonical relationship

The compact relationship among the core terms is:

```text
Journal authority
  -> admits Fact state at explicit Cuts
  -> establishes Episode identity and causal lifecycle

Fact state + Episode experience
  -> bind Artifacts through Manifests
  -> acknowledged by Receipts
  -> established through named Watermarks
  -> selected from a declared Observer
  -> rendered as Projections and Timelines
  -> used as Proof for a Claim and Purpose
  -> assessed in a TrustReport
  -> considered by an authorized Decision
  -> reopened through Replay, Rewind, and Recovery
```

## Naming discipline

- Use **Episode** for the semantic unit of bounded causal work; use `run`,
  `process`, `session`, `page`, and `source` only for their narrower meanings.
- Use **Fact** only with its declaration, provenance, and admission boundary;
  use `observation` when canonical admission has not occurred.
- Use **Receipt** only when the acknowledged guarantee and position are named.
- Use **Cut** for a reproducible fact boundary and **Watermark** for the advance
  of one guarantee.
- Use **Projection** for rebuildable derived state; never call a GUI or SQLite
  cache the authority.
- Use **Claim**, **Proof**, **Purpose**, and **TrustReport** as distinct objects;
  do not compress them into `trusted=true` or `done=true`.
- Use **Rewind** for forensic reopening and reserve re-execution for an
  explicit mode with side-effect boundaries.

## Maturity and guarantees

This reference defines Kungfu's vocabulary and target semantic boundaries. It
does not imply that every operation or durability profile is fully implemented
or qualified on every platform. Current guarantees and staged work are stated
in [Contracts](../qualification/contracts.md), [Known Limits](../qualification/known-limits.md), and
[Strong durability and crash recovery](../qualification/durability-and-crash-recovery.md).
