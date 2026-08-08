---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-08-01
theme: python-kfx-asyncio-performance
doc_type: qualification-evidence
sources: [architecture-decisions, executable-probe, local-files, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-03
ai_provenance: GPT-5 via Codex on 2026-08-03; derived from the frozen profile, public runtime APIs, exact-revision runner, and retained observations; no unretained platform result is claimed
---

# Python KFX asyncio Performance Qualification

This qualification measures the CPython 3.13 Python KFX **service plane** while
preserving the runtime boundary in
[`python-kfx-asyncio-runtime.contract.json`](python-kfx-asyncio-runtime.contract.json).
It does not move journal or data-plane work into Python, replace journal time
with asyncio time, or change Core/RxCpp ordering semantics.

The machine-readable profile is
[`cross-platform-v1.json`](../../framework/core/tests/qualification/python-kfx-asyncio-performance/profiles/cross-platform-v1.json).
It freezes the platform matrix (macOS ARM64, Linux x64, Windows x64), concurrency
levels (`1`, `8`, `64`), payload sizes (`64 B`, `1 KiB`, `64 KiB`), warm-up and
scored repetition counts, a 30-second bounded soak, statistics, invalidation
rules, evidence retention, and claim boundary before a scored run begins.

## Workload and evidence

The deterministic runner covers:

- raw asyncio task, future, one-yield, cancellation, timeout, and error paths;
- `JournalAsyncioBridge` callback dispatch and an empty pump step through public
  APIs;
- process-isolated Python service cold launch, capability round trip, state
  transitions, and graceful host shutdown;
- concurrent capability relay across every frozen concurrency/payload pair,
  including bounded backpressure; and
- a bounded relay soak with no silent task, relay, cancellation, or shutdown
  failure.

Every scored repetition is retained in `raw-observations.jsonl` in emission
order. The runner never removes outliers. `report.json` and `summary.md` are
derived from the complete raw set and bind the source commit/tree, CPython and
host facts, toolchain, profile, runner, and workload roots. Output paths are
create-only. Setup, correctness, toolchain, and workload output streams directly
to retained files from process start, so Windows descendant handle inheritance
cannot strand an in-memory capture pipe and a cancelled run keeps its partial
diagnostic evidence.

Before measurements, the runner builds the exact checkout and requires
`test:native-kfx-admission` to pass. A dirty tree, unsupported CPython/platform,
failed correctness gate, malformed/missing observation, or diagnostic `--quick`
run cannot produce a qualified claim.

Peak RSS is mandatory evidence. Windows reads the current process through the
typed `GetCurrentProcess` and `GetProcessMemoryInfo` APIs with the native
64-bit handle and `SIZE_T` layout. An API failure, process-exit race, missing
value, non-integer value, or value less than one byte fails the workload or
invalidates the report; the harness never converts unavailable memory evidence
to zero. The independent verifier applies the same positive-integer rule to
retained raw observations.

Dry-run is the default and does not write evidence or make a claim:

```bash
./shifu python-kfx-asyncio:qualify
```

A scored exact-revision run is explicit:

```bash
./shifu python-kfx-asyncio:qualify -- --execute \
  --output /new/disposable/output-directory
```

An independent reviewer checks the retained raw digest, complete frozen matrix,
derived statistics, exact source commit/tree, and profile/runner/workload roots
from a clean checkout of the recorded revision:

```bash
./shifu python-kfx-asyncio:qualify -- \
  --verify /retained/python-kfx-asyncio-performance-platform-directory
```

The manual **Gate Measurement** workflow exposes the same runner on the three
pinned self-hosted lanes. Set `python-kfx-asyncio-performance=true` and an
immutable `source-ref`; each lane retains raw observations, logs, report, and
summary for 30 days. This remains report-only and is not a noisy PR gate.

## Claim boundary

A `qualified` report means only that the exact CPython 3.13 service-plane
envelope completed on the exact recorded source, host, and frozen profile.
Latency, throughput, CPU, RSS, shutdown, backpressure, and soak values are
advisory observations, not universal SLOs.

The report does **not** qualify journal/data-plane hot paths, Core ordering,
production capacity, hard real-time behavior, cross-machine comparability, or
any platform without a retained exact-revision artifact. Single-Host
Qualification remains the release-evidence authority; this harness contributes
a bounded Python service-plane facet rather than creating a competing release
contract.
