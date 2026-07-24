---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: qualification-contract
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-11
theme: yijinjing-mmap-performance-qualification
confidence: high
evidence_grade: B
last_reviewed: 2026-07-11
---

# yijinjing mmap performance qualification

This contract decides whether an mmap optimization is safe and useful enough
to enter production. It does not turn a microbenchmark into a product SLO.

## Run contract

Configure/build through Shifu, then run the native evidence tool through
Shifu. `qualify:mmap` incrementally builds only its evidence executable from
the configured core tree before running it:

```sh
./shifu build
./shifu qualify:mmap -- --profile smoke
./shifu qualify:mmap -- --profile baseline --output mmap-baseline.json
```

The tool creates and removes its own directory under the operating system's
temporary root. It never accepts a user journal path and refuses to overwrite
an existing evidence file. JSON is an evidence-edge format; production journal
and mapping APIs remain typed C++ structures.

The `smoke` profile proves that the harness and invariants run. The `baseline`
profile is the minimum decision input. A result is identified by its Git head,
host facts, compiler/toolchain, profile, fixture sizes, and raw JSON output.
The Git head and exact Shifu command must accompany retained evidence.

## Measurements and meanings

| Measurement | Meaning | Explicit non-claim |
|---|---|---|
| mapping open | open, inspect, and map an existing file | not disk cold-start |
| process first touch | touch one byte per 4 KiB after each new mapping | not guaranteed OS page-cache cold |
| sequential read/write | bounded fixture traversal or mutation | not application end-to-end throughput |
| page switch | operation crossing a journal page boundary | not summarized by mean alone |
| seek early/middle/late | fresh journal seek at growing page counts | not a stable complexity claim from one host |
| visibility flush | full mapped-range `MS_SYNC` / `FlushViewOfFile` cost | not power-loss durability |
| resource delta | user/system CPU, RSS high-water mark, major/minor faults, and mapped-region count where available | unavailable fields remain explicit |

Clearing the host's global page cache is forbidden by this qualification.
Therefore `os_page_cache_cold` is `not_measured`. A future cold-storage study
must use an isolated disposable host or volume and a separate safety review.

## Decision gate

Every candidate is isolated and classified `accept`, `reject`, or `defer`.
Acceptance requires all of the following:

1. The benchmark command, fixture, host facts, raw baseline, and raw candidate
   result are retained.
2. The representative scenario improves p50 and/or p99 materially across at
   least three baseline/candidate alternations; a mean-only win is insufficient.
3. CPU, RSS, major/minor faults, mapped-region count, startup, sequential
   throughput, and the opposite latency tail show no unexplained regression.
4. The result holds for the relevant rapid-rollover or long-history fixture,
   not only a primitive mapping loop.
5. `./shifu test:mmap`, historic-wire checks, `./shifu check`, and the Mac build
   pass. Linux must reproduce the direction before a POSIX default changes.
6. The candidate has an explicit rollback and does not weaken wire-v1, Hana POD
   layout, zero-copy access, single-writer publication, mapping authority, or
   error propagation.

Noise below 5% is treated as neutral unless its confidence interval and tail
distribution show otherwise. Host-to-host absolute numbers are not compared;
only controlled baseline/candidate runs on the same host support a decision.

## Candidate boundaries

- File sizing/preallocation, OS advice, prefault, bounded pinning,
  committed-range flush, seek metadata/indexing, and release-queue behavior are
  separate experiments and separate commits.
- `prefault` or `pinned` cannot become a default merely because the primitive
  first-touch scenario improves. RSS, fault displacement, startup, limits, and
  journal page-switch tails are load-bearing evidence.
- `asynchronous` is a visibility/writeback policy, not durability.
  `durable` remains blocked until file-data and metadata ordering, device cache,
  error propagation, and crash recovery are qualified separately.
- Unlimited pinning, huge-page defaults, global kernel tuning, and real user
  journal fixtures are outside this contract.

## Initial evidence status

The first runs record the untouched `demand + visibility` implementation from
KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f. macOS and Linux baselines are retained below. Windows remains a
recorded coverage gap unless a suitable runner is available.

### macOS baseline 01

- Evidence: [`mmap-macos-arm64-f857fa162-baseline-01.json`](evidence/mmap/mmap-macos-arm64-f857fa162-baseline-01.json)
- Git head: `f857fa162b0cf21fbe157ceb38bc81a674aebc94`
- Command: `./shifu qualify:mmap -- --profile baseline --output
  docs/qualification/evidence/mmap/mmap-macos-arm64-f857fa162-baseline-01.json`
- Host: Darwin 25.5.0, arm64 `Mac13,2`, 20 hardware threads, 16 KiB OS
  pages, Apple Clang 21, C++23.
- Integrity: all written data frames were read back at 8, 32, and 128 journal
  pages; no major read faults were observed.

| Pages | Write switch p50 / p99 | Read switch p50 / p99 | Seek early p50 / p99 | Seek middle p50 | Seek late p50 |
|---:|---:|---:|---:|---:|---:|
| 8 | 0.199 / 0.333 ms | 0.039 / 0.041 ms | 0.244 / 0.457 ms | 0.167 ms | 0.088 ms |
| 32 | 0.199 / 0.405 ms | 0.042 / 0.079 ms | 0.931 / 1.306 ms | 0.592 ms | 0.105 ms |
| 128 | 0.174 / 3.391 ms | 0.056 / 0.165 ms | 6.371 / 13.862 ms | 3.152 ms | 0.249 ms |

The position-dependent seek curve is consistent with the current reverse
linear header scan: old targets inspect many page headers while a late target
usually stops near the tail. This is a candidate-selection signal, not yet an
optimization verdict. The 128-page write-switch p99 spike also needs repeated
baseline/candidate alternation before it can justify preallocation, advice, or
residency changes.

Current classification:

- page metadata/indexing: `defer`, highest-priority controlled candidate after
  Linux baseline because the scaling signal is representative and structural;
- file sizing/preallocation, advice, prefault/pinning, committed-range flush,
  and release queue: `defer`, insufficient isolated evidence;
- production policy/default changes: none.

### Linux baseline 01

- Evidence: [`mmap-linux-x86_64-bc3dcb7d2-baseline-01.json`](evidence/mmap/mmap-linux-x86_64-bc3dcb7d2-baseline-01.json)
- Git head: `bc3dcb7d2976dadb9651b9e4ad115257720d9d75`
- Command: `./shifu qualify:mmap -- --profile baseline --output
  /tmp/mmap-linux-x86_64-bc3dcb7d2-baseline-01.json`
- Host: Linux 6.8.0-134-generic, x86_64 `agent-120`, 32 hardware threads,
  4 KiB OS pages, GCC 13.3, C++23.
- Integrity: all written data frames were read back at 8, 32, and 128 journal
  pages. Read/seek observed no major faults; journal creation observed one
  major fault per page on this run.

| Pages | Write switch p50 / p99 | Read switch p50 / p99 | Seek early p50 / p99 | Seek middle p50 | Seek late p50 |
|---:|---:|---:|---:|---:|---:|
| 8 | 0.068 / 0.074 ms | 0.026 / 0.030 ms | 0.061 / 0.070 ms | 0.045 ms | 0.024 ms |
| 32 | 0.066 / 0.155 ms | 0.026 / 0.028 ms | 0.206 / 0.471 ms | 0.128 ms | 0.045 ms |
| 128 | 0.066 / 0.120 ms | 0.026 / 0.028 ms | 0.788 / 1.004 ms | 0.460 ms | 0.127 ms |

Linux reproduces the same direction as macOS: seeking old history grows with
page count and is much slower than seeking near the tail. Absolute timings are
not compared across hosts. The cross-platform shape raises page lookup from a
single-host suspicion to the first controlled production candidate.

### Ordered page lookup candidate

- Candidate: tail fast path plus binary upper-bound probes over append-ordered
  page begin times.
- Candidate head: `4a36ae5ea4662ed78be500530e2335e35d8644e0`.
- Retained evidence: [`mmap-macos-arm64-4a36ae5ea-candidate-01.json`](evidence/mmap/mmap-macos-arm64-4a36ae5ea-candidate-01.json).
- Rollback: revert `4a36ae5ea` and `60a3d5cf2`; no journal bytes, page names,
  persisted metadata, or public API changed.

Three baseline/candidate alternations on the same Mac produced these 128-page
seek ranges (minimum to maximum p50 across the three runs):

| Position | Linear baseline p50 | Ordered candidate p50 | Decision signal |
|---|---:|---:|---|
| early | 3.131-3.505 ms | 0.298-0.517 ms | 6.1-11.8x faster |
| middle | 1.825-1.953 ms | 0.293-0.454 ms | 4.0-6.7x faster |
| late | 0.186-0.234 ms | 0.162-0.221 ms | tail fast path removes the first candidate's regression |

The candidate reduces early-seek minor faults by an order of magnitude because
it maps a bounded number of sliced headers. Write and sequential-read code is
unchanged; their noisy p99 samples are retained as opposite-path evidence and
are not claimed as candidate improvements.

Linux reproduced the result in three baseline/candidate alternations at 128
pages:

| Position | Linear baseline p50 | Ordered candidate p50 | Decision signal |
|---|---:|---:|---|
| early | 0.750-0.782 ms | 0.153-0.155 ms | 4.8-5.1x faster |
| middle | 0.431-0.454 ms | 0.152-0.154 ms | 2.8-3.0x faster |
| late | 0.120-0.127 ms | 0.117-0.119 ms | no regression |

Retained Linux candidate evidence:
[`mmap-linux-x86_64-285158703-candidate-01.json`](evidence/mmap/mmap-linux-x86_64-285158703-candidate-01.json).
The full agent-120 product rebuild also completed with both production libwasm
engines using the repository-pinned rustup 1.95.0 toolchain.

### Independent policy decisions

| Candidate | Classification | Evidence and boundary |
|---|---|---|
| ordered page lookup | accept | Mac and Linux three-round alternations improve old-history seek, preserve the tail fast path, and leave wire/API/durability semantics unchanged. |
| exact file sizing | keep current | Writer creation grows each page once to its declared fixed size; no redundant resize was found. |
| extra preallocation | defer | The harness does not isolate allocation guarantees from page-cache and filesystem effects; no default changes. |
| `MADV_RANDOM` | reject as default | Journal traffic mixes sequential traversal with sparse header probes, so global random advice contradicts the representative sequential path. |
| sequential / will-need advice | defer | Page-cache-cold behavior is intentionally not measured, so the present evidence cannot support an OS advice default. |
| prefault | reject as default | It only displaces first-touch faults into startup without evidence of better journal page-switch tails; the mapping policy remains unqualified. |
| bounded pinning | reject as default | It consumes process and system lock budgets and has no representative end-to-end win; unlimited pinning remains out of scope. |
| committed-range flush | defer | Current visibility flush is whole-range and the mapping layer has no independently qualified committed-range authority; narrowing it could silently omit published bytes. |
| release queue polling | defer | No representative cross-thread shared-page ownership workload exists yet; replacing the bounded one-microsecond wait would be speculative. |

These are separate verdicts. Deferrals do not authorize hidden experimental
branches or weaken the policy truth table: `prefault`, `pinned`, asynchronous,
and durable mappings remain rejected by production mapping policy.
