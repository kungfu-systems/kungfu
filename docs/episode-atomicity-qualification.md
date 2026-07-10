---
status: draft
period: ongoing
theme: episode-atomicity-qualification
doc_type: verification-design
source_level: user-consensus + local-files
confidence: medium-high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-10
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-10
  visible_context: ADR-0042 design discussion, current Episode v1 implementation/tests, and Kungfu fuzz/verification conventions
  invisible_context_boundary: No qualification harness or industrial-scale run exists yet; numerical envelopes are planning targets, not measured capacity
---

# Episode Atomicity Qualification

This document is the living verification design for
[ADR-0042](../framework/core/docs/adr/ADR-0042-episode-atomic-safety-and-qualification.md).
It defines how Kungfu should accumulate evidence that Episode is a trustworthy
atomic safety and fault-containment boundary. ADR-0042 owns the stable semantics;
this document owns the evolving workload, fault matrix, scale tiers, metrics,
and report format.

## Qualification claim

A successful run supports only a bounded claim:

> Under the named source revision, platform, hardware, backend profile, workload,
> duration, and injected-fault set, Kungfu observed no silent Episode-integrity,
> capability-soundness, recovery-monotonicity, causal-closure, or failure-
> containment violation, and met the recorded performance objectives.

It does not prove correctness under every hardware failure or establish a
permanent capacity guarantee. New profiles and larger claims require new runs.

## What is being qualified

The system under test includes the complete Episode trust path:

```text
writer ownership and publication
  -> event journal + manifest journal
  -> content-addressed refs
  -> typed fold and qualification result
  -> fsck and capability report
  -> projection/query
  -> export/import and repair
```

Testing only a JSON facade, SQLite projection, or manifest append throughput is
not Episode qualification.

## Semantic oracle

Build a small executable reference model independent of the production fold. It
consumes abstract operations and evidence changes rather than mmap bytes:

```text
open(E)
append_frame(E, F, trigger)
attach_ref(E, R)
seal_or_abort(E)
lose_or_corrupt(evidence)
restore(evidence)
rebuild_projection(E)
import_or_export(E)
tombstone(E)
```

For every generated state it returns:

- lifecycle facts;
- verified evidence dimensions;
- structured issues;
- safe capabilities;
- dependency impact;
- permitted repair transitions.

The production typed fold/fsck result is compared with the oracle. A mismatch is
a correctness failure even when the operation returned success.

### Core properties

| Property | Required observation |
| --- | --- |
| Deterministic fold | The same authoritative record/evidence set yields the same typed result, issues, capabilities, and roots. |
| No partial completion | Interrupted publication is never reported as a fully verified Episode. |
| Capability soundness | Every advertised capability's evidence preconditions hold. |
| Useful degradation | Losing evidence disables only capabilities that need it; unaffected safe capabilities remain available. |
| Honest unknowns | Unknown or missing evidence is not rewritten as intentional absence. |
| Recovery monotonicity | Ordinary repair preserves verified facts and may add evidence/capabilities; retry is semantically idempotent. |
| Failure containment | Damage affects another Episode only through a named dependency/shared-evidence relation. |
| Projection derivation | Deleting and rebuilding projections produces an equivalent derived result without changing authority. |
| Portable identity | Qualified export/import preserves the Episode identity/root and qualification result under the same contract version. |

Small-state exhaustive enumeration should cover short histories before random
generation scales them. Every discovered counterexample becomes a minimized,
checked-in regression fixture.

## Fault matrix

The harness injects one fault and selected combinations at declared durability
boundaries. Each case records the expected capability contraction and recovery
path, not just a final pass/fail bit.

| Surface | Fault examples | Required checks |
| --- | --- | --- |
| Writer ownership | two writers for one manifest location, stale owner, restart race | one owner or explicit failure; no interleaved silent authority |
| Publication | kill before/after event append, manifest attach, content publish, seal, fsync/visibility | deterministic recovery; no false complete claim |
| Journal | truncated page/frame, torn tail, bit flip, duplicate/out-of-order record, unknown version | bounded failure, exact issue, unaffected Episode isolation |
| Frames | missing frame, wrong receipt/checksum, undeclared external trigger | closure/capability contraction and repair target |
| Content | missing object, wrong bytes/hash/length, delayed visibility, duplicate put | verified reads, no guessed substitution, idempotent recovery |
| Schema | absent/unknown/corrupt schema | decode-dependent capabilities close; raw evidence remains inspectable |
| Dependencies | missing Episode, cycle, deep/fan-out graph, dependency restored later | explicit impact, deterministic traversal, monotonic recovery |
| Projection | missing database, stale/mutated rows, interrupted rebuild | authority remains journal; rebuild restores equivalence |
| Export/import | truncated bundle, missing closure material, duplicate import, incompatible version | reject or contract-safe degrade; no partial acceptance |
| Repair | bad donor, repeated material, partial apply, crash during apply | validation first, append-only receipts, idempotence, fsck after apply |
| Resource pressure | ENOSPC, descriptor exhaustion, allocation failure, backpressure, process kill | explicit failure/backpressure; verification is not bypassed |

Fault injection should sit at named production boundaries rather than depend only
on timing races. The harness must also retain stochastic kill/chaos runs to find
unanticipated interleavings.

## Workload model

Workloads are generated from versioned profiles. Dogfood measurements should
eventually replace synthetic guesses, but the first harness needs explicit
distributions for:

- Episode frame count and lifetime;
- payload count, size, and dedup ratio;
- schema count and reuse;
- dependency depth, fan-out, fan-in, and hot ancestors;
- open/seal/abort ratio;
- inspect/query/export/import/repair mix;
- projection rebuild frequency;
- retained Episode age and hot/cold access distribution.

Use at least these shapes:

- many small independent Episodes;
- long Episodes with bounded/streamed folds;
- wide and deep dependency DAGs;
- shared content with high dedup;
- sparse large payloads;
- degraded populations undergoing repair while healthy work continues.

Generated workloads must be reproducible from a profile version and random seed.

## Concurrency model

Keep logical and physical concurrency separate:

- **logical agents** each own their declared writer/journal identity;
- a multiplexed driver can generate thousands of logical agents without
  requiring one OS process per agent;
- real thread and multi-process tiers exercise scheduler, lock, descriptor, mmap,
  and filesystem behavior that logical multiplexing cannot reproduce;
- future distributed/service-backed profiles are separate qualifications, not
  inferred from a single-node run.

The single-node campaign must pressure shared catalog/manifest, content-store,
projection, query, and descriptor paths even though per-agent journals avoid
logical write contention.

## Initial scale tiers

These are planning envelopes for harness construction, not product capacity
claims. Revise them from measured dogfood evidence.

| Tier | Initial envelope | Purpose |
| --- | --- | --- |
| PR smoke | `10^3–10^4` Episodes, tens of logical agents, fixed fault corpus | fast semantic regression |
| Heavy/alpha | `10^5` Episodes, up to `10^3` logical agents, generated faults and projection rebuild | recurring scale and sanitizer gate |
| Single-node qualification | `10^6+` Episodes, up to `10^4` logical agents, mixed real concurrency, 24–72 hour soak | evidence for an industrial single-node profile |
| Fleet qualification | multi-node/service-backed workload declared separately | later distributed profile; never inferred from single-node results |

Episode bodies may be compact in metadata-scale runs. Separate payload-volume
profiles must exercise realistic bytes, dedup, cold material, and I/O pressure so
metadata throughput is not misreported as full-ledger throughput.

## Metrics

### Correctness gates

The following counts must be zero for a qualified run:

- silently accepted invalid/partial Episodes;
- over-advertised capabilities;
- deterministic-fold/root disagreements;
- undeclared cross-Episode failure propagation;
- ordinary repair that loses or changes verified facts;
- projection results treated as authority when they disagree with the journal;
- fault cases without a deterministic diagnostic or explicit unsupported label.

Coverage evidence includes:

- publication crash points exercised;
- fault-matrix cells and combinations exercised;
- property histories and random seeds;
- minimized regression corpus size;
- Episode/dependency shapes covered;
- recovery/idempotence transitions covered.

### Performance observations

Record distributions, not only averages:

- open/append/seal throughput and p50/p95/p99 latency;
- inspect and capability-evaluation latency;
- incremental and full fsck throughput;
- projection rebuild time and peak memory;
- export/import and repair throughput;
- memory and descriptor high-water marks;
- bytes per Episode and storage amplification;
- content dedup ratio;
- recovery time after crash;
- performance as Episode count, Episode size, and dependency depth increase.

Numerical pass/fail SLOs belong to a named profile and can be tightened without
changing ADR-0042.

## Harness architecture

Prefer five separable components:

1. **Generator** — emits a versioned workload and expected abstract history.
2. **Driver** — executes the history through the real C++-owned Episode surface.
3. **Fault controller** — injects deterministic and stochastic failures at named
   boundaries.
4. **Oracle/verifier** — compares authority, typed fold, fsck, capabilities,
   projections, bundles, and recovery with the independent model.
5. **Reporter** — emits the machine-readable Trust Report and a short human
   summary.

Python may orchestrate qualification, generation, and reporting, but must not
become an alternative product Episode engine. Load-bearing parsing, storage, and
capability decisions remain C++-owned.

Reuse Kungfu's existing sanitizer/libFuzzer tiers for byte-facing boundaries and
add Episode-specific targets/corpora. Property histories and crash fixtures are
complementary: fuzzing malformed bytes cannot replace lifecycle/dependency model
checking, and model checking cannot replace ASan/UBSan coverage.

## Execution schedule

| Event | Required tier |
| --- | --- |
| Episode/manifest PR | semantic smoke plus affected deterministic fault fixtures |
| Alpha/release candidate | heavy tier, sanitizer corpus, bounded generated campaign |
| Production-profile claim | full named qualification and soak on declared hardware/backend |
| New backend or publication protocol | rerun relevant full profile; do not inherit evidence automatically |
| New schema/capability contract | version oracle/profile and rerun compatibility plus qualification |

The first implementation may keep the full qualification manual. Once runtime
and false-positive rates stabilize, automate it as a release gate. A failed
correctness gate always blocks the corresponding trust claim; a missed
performance SLO blocks only the profile whose SLO was missed, unless safety was
compromised.

## Episode Trust Report

Each run records at least:

```json
{
  "schema": "kungfu.episode.trust-report/v1",
  "source_revision": "<git sha>",
  "episode_contract": "<version>",
  "profile": "single-node-qualification/v1",
  "platform": "<os/arch>",
  "hardware": {},
  "backend_capabilities": {},
  "workload": {
    "profile": "<name/version>",
    "seed": "<seed>",
    "episodes": 0,
    "logical_agents": 0,
    "duration_seconds": 0
  },
  "fault_coverage": {},
  "correctness": {
    "silent_invalid": 0,
    "capability_violations": 0,
    "containment_violations": 0,
    "repair_monotonicity_violations": 0
  },
  "performance": {},
  "gaps": [],
  "qualified": false
}
```

The real schema should use stable field names and normalized hardware/backend
descriptions. Reports are evidence artifacts, not authority facts inside an
Episode. A human summary must link the exact report rather than restate only the
best throughput number.

## First implementation slices

1. Encode the abstract state/capability oracle and exhaust short histories.
2. Convert current happy/degraded/repair Episode fixtures into oracle comparisons.
3. Add deterministic publication crash points and a checked-in corruption
   corpus.
4. Add generated DAG and recovery properties with reproducible seeds.
5. Add a metadata-scale driver, then realistic payload and multi-process modes.
6. Emit Trust Report v1 and run the first single-node baseline without treating
   its numbers as a support promise.

## Open questions

- What is the smallest stable capability vocabulary for v1?
- Which capability decisions require fresh full fsck, cached verification, or
  verification-on-use?
- Which missing evidence is optional, intentionally absent, recoverable, or
  required for each operation?
- How are repair receipts represented without expanding the kernel schema too
  early?
- Which real dogfood traces can be anonymized into workload distributions?
- Which hardware and filesystem profiles should become the first supported
  single-node qualification targets?
