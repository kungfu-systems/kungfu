# Episode Qualification Harness

This directory implements the executable scale v0 and Semantic v1 slices of
[`docs/qualification/episode-atomicity-qualification.md`](../../../../../docs/qualification/episode-atomicity-qualification.md).
It exercises the shipped Python facade backed by the C++ Episode manifest
implementation; it does not parse or mutate journal bytes itself.

Build the core first so `framework/core/dist/kungfu` contains the native binding,
then run:

```sh
./shifu episode:qualify -- --profile mvp-smoke-v1
./shifu episode:qualify -- --profile mvp-baseline-v1
./shifu episode:qualify -- --profile mvp-smoke-v1 --mode semantic
```

Useful scoped runs:

```sh
./shifu episode:qualify -- \
  --profile mvp-smoke-v1 \
  --mode accumulation \
  --accumulation-checkpoints 1000,10000 \
  --seed 42042

./shifu episode:qualify -- \
  --profile mvp-smoke-v1 \
  --mode contention \
  --contention-episodes 2000 \
  --workers 1,2,5,10 \
  --report /tmp/episode-trust-report.json
```

The default report path is a retained temporary directory printed at the end of
the run. Runtime homes are removed after their fresh-process probes unless
`--keep-runtime` is supplied.

## Build-chain gate

`./shifu verify` runs `mvp-smoke-v1` by default after checking the built
runtime artifacts. This means both the declared Buildchain `verify` lifecycle
and the alpha/release `verify --fuzz` workflow fail when the smoke profile
fails. `--skip-episode-qualification` is an explicit local diagnostic escape
hatch; the checked-in Buildchain and alpha/release commands do not use it.

`mvp-baseline-v1` is intentionally not a per-build gate. Run its 100k
accumulation and 10k contention workloads explicitly for periodic or
release-readiness qualification.

## Release evidence

Run the complete release profile and emit one retained evidence envelope with:

```sh
./shifu episode:qualify:release -- --output \
  product/release/qualification/episode-release-evidence.json
```

The `kungfu.episode.release-evidence/v1` envelope embeds Trust Report v2 and
binds it to the exact Git commit/tree, clean-source state, canonical profile
digest, platform/hardware facts, pinned Shifu/toolchain facts, and hashes of the
native runtime artifacts actually exercised. Its hard gates require all scale
scenarios, correctness counters, fresh-process/fsck/recovery facts, semantic
oracle histories, and required semantic dimensions to pass. Performance values
remain trend evidence; v1 adopts no absolute throughput SLO.

The profile's outer scenario timeout is only an execution watchdog. The
baseline sets it to two hours per process so a loaded qualification host does
not turn slow-but-progressing work into a one-hour performance SLO. The
independent 60-second no-progress deadline remains a hard gate; watchdog expiry
terminates the full `uv`/Python process tree and leaves the run unqualified.

Verify a retained envelope without rerunning the workload:

```sh
./shifu episode:qualify:release -- verify \
  --evidence product/release/qualification/episode-release-evidence.json
```

Add `--check-runtime` only when the exact built runtime is still present and
should be compared byte-for-byte with the recorded artifact manifest. The
alpha/release Build workflow and manual workflow dispatch run the release path
on the existing Buildchain platform matrix and retain the evidence beside the
product artifacts. Development PRs continue to run only the bounded source and
smoke gates.

## Semantic evidence

The independent `semantic_oracle.py` models externally observable lifecycle,
evidence, dependency, repair, and projection states without importing Kungfu or
reading journal bytes. `semantic_workload.py` compares that model with the real
storage service for:

- interrupted-open recovery and recovery idempotence;
- useful degradation for missing content and monotonic restoration;
- content hash rejection and put-if-absent idempotence;
- direct dependency failure containment;
- projection absence, drift, and rebuild convergence;
- export/import preservation of Episode identity and causal counts.
- exact safe-capability agreement for missing, open, ended, aborted, degraded,
  failed, repaired, and projection-derived states.

Trust Report v2 records every semantic dimension as `passed`, `failed`, or
`not_exercised`. A dimension can pass only when a production comparison ran.
`capability_soundness` compares the independent oracle with the C++-owned
`kungfu.episode.qualification/v1` result and is required by both MVP profiles.

## Result boundary

The scale v0 profiles are metadata-only: each independent Episode contains
exactly one open and one terminal record. They qualify manifest population,
fold/fsck readback, writer contention, retry progress, and cold-process
stability. They do not qualify realistic payload distributions, deep or wide dependency DAGs,
distributed writers, or fleet-scale capacity. Semantic v1 adds small
deterministic payload, direct-dependency, and projection cases; it does not turn
those bounded cases into a scale or soak claim. Those gaps remain explicit in
every Trust Report.

`manifest_writer_busy` is the only retryable error. The worker records every
busy result and applies the profile's bounded backoff. An exhausted retry,
unexpected exception, count mismatch, fsck failure, recovery of an unexpected
open Episode, or fresh-process mismatch fails the scenario.

The smoke profile budgets are cross-platform correctness ceilings, not latency
targets. They must accommodate a serialized durable writer on the slowest
qualified local filesystem while remaining bounded by both per-worker progress
and whole-scenario timeouts. Observed throughput and latency stay in the Trust
Report and do not become an implicit pass condition.

## Files

- `run.mjs` owns profiles, worker processes, timeouts, aggregation, and reports.
- `episode_workload.py` performs writes and readback through
  `kungfu.storage.service`.
- `semantic_oracle.py` is the dependency-free abstract model.
- `semantic_workload.py` performs bounded model-versus-production comparisons.
- `profiles/*.json` are versioned workload and progress policies.
- `schemas/episode-qualification-v1.schema.json` validates the production
  capability contract.
- `schemas/trust-report-v2.schema.json` validates current reports; v1 remains
  checked in so historical evidence stays readable.
- `schemas/release-evidence-v1.schema.json` validates the retained release
  envelope; `release_evidence.mjs` additionally verifies all embedded digests
  and hard-gate consistency.
