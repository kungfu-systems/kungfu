---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---

# The Episode

## A vocabulary for real-world agent work

An agent can call tools, change files, spend tokens, produce artifacts, and
report that it is done. But the report leaves the important questions open:

```text
What actually happened?
Which facts and artifacts belong to the work?
What did the runtime acknowledge?
What survived a crash?
What evidence supports completion?
What may safely happen next?
```

Logs show activity. Traces show calls. Workflows describe intended steps. A
chat session preserves a conversation. None of them, by itself, is the durable
object that real-world work needs.

**That object is an Episode.**

> An Episode is a bounded causal unit of actual work. Its facts, artifacts,
> dependencies, receipts, and verification roots can be inspected, sealed,
> exported, recovered, and used to support decisions.

This is the central object in Kungfu. Other concepts exist to state what an
Episode contains, where its guarantees stand, how it can be understood, and
which decisions its evidence can support.

```text
Real-world work happens in Episodes.
Episodes preserve Facts and Artifacts.
Receipts and Watermarks state what the runtime has actually established.
Claims require Proof before they support Decisions.
```

## Why the session is no longer enough

A session is an execution coordinate. It may end when a process exits, a
terminal disconnects, or a context window expires. Real work does not respect
those boundaries. One responsibility may span several runs; one run may
produce evidence used by several later decisions; an interrupted run may still
contain verified work worth preserving.

An Episode gives that work a stable semantic boundary. It is not defined by a
window, process, file, provider, or user interface.

```text
An Episode is not a chat session.
An Episode is not a process.
An Episode is not a bag of logs.
```

A conforming Episode has a stable identity, declared causal and external
dependencies, an authoritative manifest, inspectable facts and artifacts, and
an explicit lifecycle. It can be opened, appended to, sealed, inspected,
verified, exported, imported, rewound, and recovered without making a GUI or a
mutable database its authority.

## The language around an Episode

The vocabulary is layered deliberately. Episode is the flagship object; the
surrounding terms answer different questions about it.

### 1. What belongs to the work?

**Fact** — a typed statement preserved by the runtime under a declared fact
contract. An observation may be recorded without being admitted into canonical
fact state, and an admitted fact is not automatically trusted for every claim.

```text
recorded != admitted != trusted
```

**Artifact** — durable material produced, consumed, or validated by an Episode.
Artifacts may be content-addressed and referenced without forcing large bodies
onto the journal hot path.

**Manifest** — the authoritative declaration of an Episode's included frames,
facts, artifacts, schemas, dependencies, source provenance, and verification
roots. A JSON rendering or SQLite row may describe a manifest; it does not
replace the journal-backed authority.

**Receipt** — a typed acknowledgement of a specific position and guarantee. A
receipt says exactly what the runtime established, and no more. A successful
call is not a durability promise unless the returned receipt names and proves
that durability profile.

```text
write returned != visible
visible != durable
durable != projected
```

### 2. Where does the answer stand?

**Source** — the provenance identity from which facts or Episodes were
observed, imported, or accepted. Transporting a fact does not erase its source
authority.

**Observer** — the declared perspective from which accepted facts are viewed.
Kungfu does not pretend that a mixed-source history comes from an absolute
view from nowhere.

**Cut** — the exact fact boundary at which a query, proof, or assessment is
answered. A cut makes a historical answer reproducible instead of silently
consulting whatever happens to be current later.

**Watermark** — the position through which one named guarantee holds. Visible,
durable, projected, and eventually replicated guarantees advance
independently; they are not one generic progress number.

```text
visible watermark
durable watermark
projection watermark
replicated watermark
```

### 3. How does an Episode become understandable?

**Projection** — a rebuildable interpretation of authoritative facts. SQLite
indexes, folded state, query rows, and GUI models can make Episodes useful, but
they cannot become a second fact authority.

```text
Facts are authoritative.
Projections are rebuildable.
```

**Timeline** — a deterministic projection of accepted facts under a declared
observer, causal constraints, source-local order, and ordering policy. Known
causality dominates presentation policy; concurrent facts may be ordered for a
stable view without being misrepresented as universal time.

```text
Timeline != universal clock
```

**Replay** — reconstruction of recorded facts and derived state under the same
declared runtime semantics used by live work.

**Rewind** — the product action of reopening an Episode for causal inspection,
verification, proof, and recovery. Rewind does not silently repeat real-world
side effects.

```text
Rewind an Episode.
Replay its Facts.
Never re-execute side effects implicitly.
```

### 4. How do facts support trust and action?

**Claim** — a statement that a participant asks others to rely on: the work is
complete, an artifact is valid, a handoff is safe, or a system may resume.

**Proof** — the evidence and derivation that bind a result or Claim to fact
declarations, accepted sources, Episodes, Artifacts, a Cut, and verification
results. Proof also names missing, conflicted, redacted, or unverifiable input.

**Purpose** — the decision for which a Claim is being assessed. Evidence that
is sufficient for internal review may be insufficient for release, external
commitment, or recovery of authority.

**TrustReport** — a purpose-bound assessment of a Claim over pinned facts and
Proof. It reports fitness, evidence, responsibility, freshness, gaps, and
residual risk instead of attaching a universal `trusted=true` label.

```text
Claim + Purpose + Cut + Proof -> TrustReport
```

**Decision** — the recorded choice of an authorized participant: continue,
adjust, stop, approve, request evidence, hand off, archive, recover, or reopen.
Agent self-report may trigger an assessment; it cannot authorize its own Claim
without independent admitted evidence and the applicable authority.

## The distinctions that matter

The vocabulary is useful because it prevents categories with different
guarantees from collapsing into one status field.

```text
Episode != session
Fact != log line
recorded != admitted
Claim != Proof
claimed complete != fit for purpose
visible != durable != projected
Projection != authority
Timeline != universal clock
Rewind != re-execution
restart != recovery
```

These are operational boundaries, not rhetorical distinctions. They determine
what an API may acknowledge, what a query may infer, what a GUI may display,
and what recovery may claim after failure.

## One core, multiple domain profiles

Kungfu Core does not dictate what the work is about. It provides the common
runtime-fact language; a domain profile supplies the objects and policies that
give those facts local meaning.

| Profile | Domain vocabulary examples | Shared Kungfu language |
| --- | --- | --- |
| accountable agent work | delegated work, responsibility, cost, completion, handoff | Episode, Fact, Artifact, Receipt, Claim, Proof, Cut, TrustReport, Decision |
| quantitative trading | order, execution, position, account, settlement | Episode, Fact, Receipt, Watermark, Projection, Replay |
| games and virtual worlds | input, rule outcome, world change, entity state, checkpoint | Episode, Fact, Artifact, Timeline, Cut, Replay |
| future industrial or device profiles | command, observation, interlock, maintenance action, operator decision | Episode, Fact, Receipt, Claim, Proof, Recovery |

The current Agent Work profile uses **Mission**, **Go**, Responsibility State,
and Cost/State/Proof to test long-running delegated work. Those are profile
terms, not prerequisites for using Kungfu and not vocabulary owners of the
domain-neutral core. Their names may evolve as product validation improves;
an Episode remains the stable object beneath them.

## The Kungfu contract

Kungfu aims to turn real-world execution from an expendable stream of activity
into a locally owned, verifiable object. The product is successful when a human
or agent can answer:

```text
Which Episode contains the work?
Which Facts and Artifacts does it preserve?
What did its Receipts establish?
At which Cut and Watermark is this answer valid?
Which Projection or Timeline am I viewing?
What does the Proof support?
Which Decision may safely follow?
```

This vocabulary names the target contract. Individual guarantees remain scoped
by the current implementation, platform, durability profile, and retained
qualification evidence. Read [Known Limits](known-limits.md) before treating a
design target as a released guarantee.

## Go deeper

- [Vocabulary Reference](vocabulary.md) gives canonical definitions and
  relationships for the terms introduced here.
- [Episode Object Model](episode-object-model.md) defines Episode invariants,
  lifecycle, manifest authority, and implementation maturity.
- [Bringing domain facts into Kungfu](fact-surface-admission.md) defines the
  recorded/admitted/trusted boundary.
- [Querying runtime facts](querying-runtime-facts.md) defines Cuts,
  proof-carrying queries, projections, and changelogs.
- [Strong durability and crash recovery](durability-and-crash-recovery.md)
  defines Receipts, Watermarks, recovery, and current non-claims.
- [Domain Horizons](domain-horizons.md) explains how trading, agent work, and
  future virtual-world profiles share one neutral core.
