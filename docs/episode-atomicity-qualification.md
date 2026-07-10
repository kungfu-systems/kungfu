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

## Executable v0 slice

The first harness intentionally implements only the two independent axes needed
to establish an MVP baseline. It does not attempt the full fault matrix or claim
fleet-scale capacity.

```text
accumulation: one writer, increasing retained Episode population
contention:   fixed total work, 1 / 2 / 5 / 10 physical workers
```

Keeping these axes separate makes a regression attributable. The accumulation
run does not increase concurrency, and the contention run does not increase the
total Episode population as worker count rises.

### Repository layout and entrypoint

The v0 implementation lives under the existing core test tree:

```text
framework/core/tests/qualification/episode/
  README.md
  run.mjs
  episode_workload.py
  profiles/
    mvp-smoke-v1.json
    mvp-baseline-v1.json
  schemas/
    trust-report-v1.schema.json
```

`run.mjs` is the cross-platform entrypoint and process/report coordinator.
`episode_workload.py` drives the shipped Python facade backed by the real C++
Episode implementation; it is not a second manifest parser or Episode engine.
All load uses `kungfu.storage.service` operations. The harness never creates or
edits journal bytes directly.

The repository command is:

```sh
./kungfu-code episode:qualify -- --profile mvp-smoke-v1
./kungfu-code episode:qualify -- --profile mvp-baseline-v1
```

Generated runtime homes and reports default to an operating-system temporary
directory and are not checked in. `--report <path>` selects a Trust Report
destination, and `--keep-runtime` retains the generated runtime home for
diagnosis. CI may upload the report as an evidence artifact.

### Deterministic metadata workload

The first population profile is explicitly `metadata-only`. Every generated
Episode is independent and terminal:

```text
EpisodeOpen -> EpisodeClosed(Ended|Aborted)
```

Episode ids and bounded title/actor/source content are derived from the profile,
mode, seed, worker id, and sequence number. They never depend on wall-clock time.
The expected record count and every sampled Episode are therefore reproducible.
The initial profile attaches no event frames, payloads, schemas, or dependency
edges; later payload/DAG profiles must not reuse its throughput as full-ledger
evidence.

The accumulation mode accepts a parameterized Episode count and records
checkpoints. The initial checkpoints are `10^3`, `10^4`, and `10^5`; a `10^6`
run remains a manual qualification until measured duration and memory usage make
it suitable for a recurring gate. At each checkpoint the harness records:

- open and terminal-append throughput plus p50/p95/p99 latency;
- `episode_list(limit=100)` latency, plus an explicit unbounded-list count for
  the current v1 API whose bounded result does not carry a separate total;
- semantic Episode record totals derived from the listed per-Episode views,
  while journal page/control frames remain a separate physical observation;
- inspect latency and exact readback for the first, middle, last, and
  seed-selected Episodes;
- Episode-scoped and full fsck latency and verdict;
- clean recovery (`episode_recover` must recover zero Episodes after a clean
  run);
- a fresh-process list/inspect/fsck probe after the writer process exits;
- runtime bytes, journal file count, RSS high-water mark, and file-descriptor
  observations where the platform exposes them.

The current implementation folds the whole manifest for list, inspect, and
fsck. The v0 curve is expected to expose that cost. It must report the curve
honestly rather than hiding it behind a smaller sampled data set.

### Bounded writer contention

The contention mode runs `1`, `2`, `5`, and `10` worker processes against one
data root while keeping the total number of Episodes fixed. Every worker writes
a disjoint deterministic Episode-id range through the same public Episode
surface.

The current manifest contract is acquire-or-fail. A competing operation may
return `manifest_writer_busy`; this is an expected explicit contention result,
not a successful append and not manifest corruption. The v0 client applies a
bounded exponential backoff with seed-derived jitter only to that exact error.
The profile records the initial delay, cap, retry limit, and progress deadline.
Every other exception is immediately unexpected.

The Trust Report separates at least:

```text
successful_appends
manifest_writer_busy
retry_count
retry_exhausted
unexpected_errors
longest_no_progress_interval
```

A passing contention run requires every expected Episode to reach exactly one
terminal state, zero exhausted retries, zero unexpected errors, no deadlock or
progress timeout, clean full fsck, and identical fresh-process readback. The
bounded claim is that the declared single-node profile preserved Episode
authority under ten-worker contention and completed under the recorded retry
policy. It is not evidence for ten thousand workers or a distributed service.

### Versioned initial profiles

`mvp-smoke-v1` is the Episode/manifest PR gate:

```text
seed: fixed and recorded
accumulation: 1,000 Episodes
contention: 1 / 2 / 5 / 10 workers, 1,000 total Episodes per run
payload profile: metadata-only
```

`mvp-baseline-v1` is the MVP-candidate/manual baseline:

```text
seeds: at least three fixed and recorded seeds
accumulation checkpoints: 1,000 / 10,000 / 100,000 Episodes
contention: 1 / 2 / 5 / 10 workers, 10,000 total Episodes per run
payload profile: metadata-only
```

The baseline may be split into separate invocations when runtime is long, but
each report must retain the exact profile, seed, source revision, and completed
scenario list.

### v0 correctness and progress gates

The following conditions fail the profile regardless of throughput:

- expected, listed, folded, inspected, or fsck Episode counts disagree;
- an Episode has a missing/duplicate open or terminal record, an unexpected
  status, or mismatched deterministic metadata;
- full fsck fails or emits a warning not declared by the profile;
- recovery finds an open Episode after a clean workload;
- fresh-process readback differs from the writer-process result;
- a worker crashes, deadlocks, exhausts retries, exceeds the no-progress
  deadline, or reports an exception other than the declared busy result;
- the emitted Trust Report does not validate against its versioned schema.

The first baseline records performance observations without inventing an
absolute throughput or latency SLO. OOM, timeout, or loss of forward progress is
an availability failure. After repeatable baselines exist, numerical SLOs may be
added to a new profile version without changing ADR-0042.

The v0 report sets the Episode query profile to
`episode-manifest-direct`. The current Episode query path reads the manifest
fold directly; source-registry SQLite rebuild is not an Episode projection
rebuild and must not be reported as one. Until an Episode projection exists,
projection-rebuild coverage remains an explicit gap.

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

## First development baseline (2026-07-10)

The first v0 run exercised source revision
`b6961891731bf55da589fae9377b5af6039b3232` on `darwin/arm64`, Node
`v22.22.3`, 20 logical CPUs, and 128 GiB RAM. All three reports validated as
`kungfu.episode.trust-report/v1` and were generated from a clean source tree.
This is development evidence, not an adopted SLO or supported-capacity promise.

The complete `mvp-smoke-v1` run passed all five scenarios in 8.4 seconds:
1,000-Episode accumulation plus 1/2/5/10-worker contention at 1,000 Episodes
per worker-count scenario. The ten-worker scenario observed 1,013 explicit
`manifest_writer_busy` results, exhausted none, and finished with zero count,
readback, fsck, recovery, unexpected-error, or progress-timeout violations.

One seed (`42042`) then exercised the accumulation envelope:

| Retained Episodes | Added-batch ingest | Full list | Full fsck | Inspect p95 | Probe RSS |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,670 Episodes/s | 40 ms | 9 ms | 1.1 ms | 54 MB |
| 10,000 | 937 Episodes/s | 444 ms | 82 ms | 11.0 ms | 115 MB |
| 100,000 | 316 Episodes/s | 4.20 s | 804 ms | 87.5 ms | 698 MB |

At 100,000 Episodes, all 100,000 objects and 200,000 semantic Episode records
matched exactly after fresh-process readback. The physical manifest contained
200,002 frames across three journal pages; the additional two frames were page
control records and are reported separately rather than misclassified as
Episode corruption. Clean recovery found zero interrupted Episodes.

The profile also ran 10,000 Episodes at each declared worker count:

| Workers | Aggregate ingest | Busy/retry results | Exhausted | Correctness violations |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,230 Episodes/s | 0 | 0 | 0 |
| 2 | 1,205 Episodes/s | 1,091 | 0 | 0 |
| 5 | 1,143 Episodes/s | 4,343 | 0 | 0 |
| 10 | 1,169 Episodes/s | 8,252 | 0 | 0 |

The bounded conclusion is two-sided:

- the current single-node manifest path preserved Episode authority and made
  forward progress under ten physical writers with the declared retry policy;
- writer throughput did not scale with worker count, and retained-population
  cost is visible in both append and whole-manifest read paths. A long-lived
  writer/request queue plus bounded/indexed Episode reads are implementation
  priorities before adopting a materially larger support envelope.

Only one of the baseline profile's three declared seeds was run for the 100k and
10k-contention tables. Repeating all seeds, payload-volume profiles, dependency
DAGs, faults, and soak remains required before a broader qualification claim.

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
