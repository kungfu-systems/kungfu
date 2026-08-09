---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: release-gate-contract
review_state: self-reviewed
sensitivity: public
sources: [architecture-decisions, local-files, public-reference-systems]
period: 2026-07-14
theme: single-host-performance-qualification
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# Single-host end-to-end performance qualification

This page defines the performance release gate for Kungfu's
`Single-Host Institutional Profile v1`. It prevents an implementation that is
correct but operationally unusable from being admitted as an institutional
local runtime ledger, while preventing benchmark pressure from weakening
durability, recovery, or agent-ledger semantics.

## Why this gate is different

Most observability pipelines optimize telemetry ingestion so recording does
not slow the observed application. That is the right boundary when a delayed
or missing trace reduces dashboard completeness but does not change the
authority of the work itself.

Kungfu's institutional profile has a different job: selected agent facts are
load-bearing ledger records. A false acknowledgement, a lost terminal fact, an
unrecoverable position, or a projection that silently changes meaning can alter
what an institution believes happened, what may safely resume, and which claim
is supported by evidence.

> **Kungfu's release gate asks not only how fast agent facts are recorded, but
> whether their visibility, durability, recovery, and meaning remain valid
> under load.**

Those four words are separate obligations:

- **visibility** — the declared readers observe the complete fact at the
  declared position, without reorder or partial publication;
- **durability** — a receipt never claims more than the qualified local
  persistence frontier has established;
- **recovery** — restart reconciles the same frontier, reports any uncertain
  tail, and neither loses acknowledged facts nor invents new ones;
- **meaning** — typed facts, Episode state, causal relationships, capability
  decisions, and projections still resolve to the same semantic cut.

This is why the gate measures long-tail latency, throughput, lag, replay,
recovery, and restore together with semantic violations. A path that is fast
only because it weakens one of these obligations fails qualification.

The gate is **planned, not yet passed**. No current release claims an
end-to-end performance profile for `durable_group` or `durable_sync`.

## Place in the release sequence

Performance qualification begins only after the complete single-host
durability and crash-recovery implementation series has passed its correctness
qualification:

```text
position / receipt contract
  -> state-service separation
  -> durable ingest
  -> projection bootstrap and cutover
  -> recovery engine
  -> durability correctness qualification
  -> product and SDK contract
  -> single-host end-to-end performance qualification
  -> release admission
```

The performance gate is not another functional implementation slice. It is an
independent post-series release gate. A correct implementation can remain
unreleased when it misses its declared operational envelope; a fast
implementation cannot pass when its receipt or recovery semantics are wrong.

## Gate principles

1. **Kungfu owns the contract.** Pass/fail is determined by versioned absolute
   thresholds, regression ceilings, and retained Kungfu evidence.
2. **Correctness comes first.** No performance result can override a durability,
   ordering, recovery, ownership-fencing, or backup/restore failure.
3. **Compare equivalent semantics.** A visible shared-memory publication is not
   compared with a synchronous durable acknowledgement, and a typed Episode
   commit is not presented as equivalent to a raw transport frame.
4. **Long tails are load-bearing.** Mean throughput or a best-case median cannot
   hide p99/p99.9 latency, stalls, backpressure, recovery time, or resource
   saturation.
5. **The envelope is explicit.** Results apply only to the declared Kungfu
   version, binary provenance, host, CPU topology, OS, filesystem, device,
   mount/cache policy, compiler, profile, workload, and process topology.
6. **Raw evidence is retained.** Summary tables never replace commands,
   configurations, host facts, histograms, counters, logs, and run identities.

## Surfaces under qualification

| Surface | Completion boundary | Required measurements |
|---|---|---|
| `visible` raw frame | a complete frame is visible to the declared local reader set | publication-to-read latency, throughput, backpressure, CPU, faults, page rollover |
| `visible` typed agent fact | the typed fact is visible through the supported C++/Python/Node surface | end-to-end adapter overhead, allocation/copy count, tail latency, throughput |
| `durable_group` | the receipt position is at or below the qualified group durable watermark | acknowledgement distribution, batch size/delay, sync cost, durable lag, load behavior |
| `durable_sync` | required fact data and metadata have crossed the qualified local durability barrier | acknowledgement distribution, device-sync cost, error propagation, sustainable rate |
| projection catch-up | SQLite projection reaches the declared durable cut | projection lag, catch-up throughput, CPU/RSS, writer interference |
| replay and bootstrap | a new reader or projection reaches the selected cut | cold/warm replay throughput, time to live, history-size scaling |
| crash recovery | the whole data root reopens and emits a reconciled recovery report | time to verified frontier, rebuild time, capability restoration, resource peak |
| backup restore | an empty data root is restored, checked, replayed, and projected | restore throughput, time to usable state, recovered cut/RPO |

Raw transport and agent-semantic costs must both remain visible. Kungfu may
choose the richer agent path because it provides Episode, manifest,
cost/state/proof, responsibility, and trust semantics; the report must still
show the incremental cost rather than hiding it in an incomparable benchmark.

## Workload contract

Each versioned qualification profile freezes its workload before release
candidate measurement. The initial profile must include:

- fixed-size payload classes covering small control facts, ordinary agent
  facts, and larger payload references;
- at least single-producer/single-consumer, single-producer/fan-out readers,
  burst, sustained-rate, and slow-reader/backpressure topologies;
- rapid page rollover and long-history seek/replay cases;
- cold and warm data-root starts;
- empty, representative, and high-cardinality projection state;
- representative Episode open, action/receipt append, terminal commit, query,
  replay, and recovery paths;
- load combined with the qualified fault and restart boundaries, so load cannot
  silently change acknowledgement semantics.

Message sizes, rates, batch policy, history length, run duration, warm-up, CPU
placement, idle strategy, and storage preparation are profile fields, not
unrecorded operator choices.

## Required metrics

Every latency surface reports p50, p95, p99, p99.9, maximum, sample count, and
the complete retained histogram. Every throughput surface reports both
messages/second and bytes/second at the declared latency ceiling.

The report also retains:

- application, state-service, ingest, projection, and total host CPU;
- per-process RSS and mapped-region count;
- major/minor page faults and storage I/O counters;
- visible/durable/projection lag distributions;
- backpressure duration and rejected/unknown outcomes;
- page-rollover, checkpoint, sync, projection, and recovery stalls;
- replay, catch-up, restart, and empty-data-root restore time;
- thermal, frequency, scheduler, virtualization, and noisy-neighbor facts that
  materially affect interpretation.

## Threshold and run discipline

The machine-readable performance profile owns the absolute thresholds and
allowed regression ceilings. They must be reviewed and frozen before the first
release-candidate run; a failed candidate cannot pass by rewriting its profile.

A passing report requires:

- all prerequisite correctness and recovery evidence to remain passing;
- the declared absolute latency, throughput, recovery-time, and resource
  ceilings to pass on every required platform/storage profile;
- repeated baseline/candidate alternation or equivalent drift control;
- a sustained/soak tier in addition to short latency and saturation tiers;
- no unexplained loss, duplicate, reorder, false receipt, unknown-success,
  deadlock, unbounded lag, or recovery divergence;
- no selective retry, removed outlier, weakened workload, or undeclared tuning;
- raw artifacts sealed into the same release-evidence system used by the
  corresponding Kungfu candidate.

Unsupported or unqualified profiles fail closed and remain explicit
non-claims. A neutral result is valid evidence; release waits or the declared
product envelope contracts.

## Aeron as a reference comparator

[Aeron](https://github.com/aeron-io/aeron) is a mature first-tier reference for
low-latency IPC, stream recording, replay, and operational position semantics.
Kungfu therefore includes Aeron IPC and Aeron Archive in an optional but
retained comparison profile.

Aeron is a **reference comparator, not the authority for Kungfu release
admission**:

- Kungfu's pass/fail thresholds do not move when Aeron releases a new version;
- the report always names the Aeron edition, version, commit/artifact,
  configuration, API, idle/threading strategy, sync level, and hardware;
- `visible` is compared with corresponding Aeron IPC delivery;
- `durable_group` and `durable_sync` are compared only with explicitly matched
  Aeron Archive recording/file-sync semantics;
- Aeron Cluster, Premium kernel-bypass features, replication, and HA are outside
  the v4.0.0 single-host comparison unless separately declared;
- Kungfu agent-ledger semantics are reported as their own end-to-end path and
  are not claimed to be equivalent to raw Aeron transport;
- the comparison uses the same payloads, topology, offered load, CPU/storage
  envelope, timing boundaries, duration, and percentile rules wherever the
  systems permit equivalent semantics.

Before retained results exist, public text must not say `Aeron-class
performance`, `Aeron-equivalent`, `Aeron-compatible`, or `faster than Aeron`.
After qualification, public text should state the exact measured result and
envelope, for example:

> Under Single-Host Performance Profile v1 on the declared host, Kungfu's
> `visible` path and Aeron IPC were measured with the retained latency and
> throughput distributions linked below.

Even after a favorable result, the numbers and profile are the claim; a loose
class label is not.

## Evidence and release decision

The release evidence must expose, in machine-readable form:

- profile schema/version and frozen thresholds;
- Kungfu and comparator identities and configurations;
- host/storage/toolchain facts;
- workload and topology identities;
- raw run references, histogram digests, violations, and excluded-run reasons;
- absolute and regression verdicts per surface and platform;
- comparator results marked `informative`, never `release_authority`;
- residual risks, unsupported envelopes, and explicit non-claims;
- final `admitted`, `rejected`, or `unqualified` decision.

## Current hardware candidate slice

The first executable slice is now frozen as
`linux-ext4-agent120-slo-v1`. It is deliberately narrower than the complete
profile above: it qualifies the explicit KFDL candidate's `durable_group` and
`durable_sync` paths on the named `agent-120` Linux/x86_64/NVMe/ext4 worktree.
It includes single-record latency, batched throughput, rapid 64 KiB segment
rollover, recovery, projection rebuild/bootstrap, same-host offline
backup/restore, and one 15-minute sustained run per durability profile.

The absolute ceilings live in the versioned machine profile and were frozen
before the first agent-120 measurement. Correctness is a knockout. The runner
retains complete p50/p95/p99/p99.9/max histograms and resource counters, fsyncs
each raw JSONL result before continuing, refuses existing evidence paths, and
never invokes GitHub CI. Its command is:

```sh
./shifu durability:slo -- --run-id SOURCE-agent120-slo-v1
```

This slice has no Aeron comparator and cannot admit the complete Single-Host
Institutional Profile. In particular it does not qualify the mmap visible
frame/typed-agent path, multi-reader backpressure, another host or filesystem,
physical power loss, off-host backup, or a production-default activation.
Those remain separate gates rather than inferred results.

The first retained agent-120 run at source `070e0804b` passed all eight frozen
workloads with zero correctness or SLO violations. The two 15-minute soaks
completed 449,984 `durable_group` and 224,992 `durable_sync` records at 492.95
and 247.17 end-to-end records/s. Their receipt p99.9 values were 73.4 ms and
109.1 ms; the largest RSS was 1,002,196 KiB and the slowest verified reopen was
6.18 seconds. See the
[retained evidence index](evidence/durability/070e0804b/README.md) for the
machine-report/raw hashes and the exact non-claims.

The public capability surface may advertise a performance profile only when it
can resolve to this retained report. Absence, staleness, version drift, or an
unmatched environment removes the claim rather than substituting a generic
"high performance" label.

## Related records

- [Single-host institutional trust profile](single-host-institutional-trust.md)
  defines the adoption decision and operator responsibility boundary.
- [Strong durability and crash recovery](durability-and-crash-recovery.md)
  defines the receipt, watermark, service, and recovery semantics that this
  gate must preserve.
- [yijinjing mmap performance qualification](mmap-performance.md)
  qualifies component-level mmap policies and regressions; it does not replace
  this product-level end-to-end gate.
- [Episode atomicity qualification](episode-atomicity-qualification.md)
  defines the related semantic oracle and fault-containment program.
