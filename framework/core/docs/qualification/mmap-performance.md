---
status: draft
period: 2026-07-11
theme: yijinjing-mmap-performance-qualification
doc_type: qualification-contract
source_level: local-files + user-decision
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-11
  invisible_context_boundary: No credentials, private journals, or hidden provider state were read
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

The first run records the untouched `demand + visibility` implementation from
ADR-0058. Candidate decisions remain `defer` until both macOS and Linux
baselines are retained. Windows is a recorded coverage gap unless a suitable
runner is available.

### macOS baseline 01

- Evidence: [`mmap-macos-arm64-f857fa162-baseline-01.json`](mmap-macos-arm64-f857fa162-baseline-01.json)
- Git head: `f857fa162b0cf21fbe157ceb38bc81a674aebc94`
- Command: `./shifu qualify:mmap -- --profile baseline --output
  framework/core/docs/qualification/mmap-macos-arm64-f857fa162-baseline-01.json`
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
