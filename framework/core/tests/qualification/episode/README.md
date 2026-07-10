# Episode Qualification Harness

This directory implements the executable scale v0 and Semantic v1 slices of
[`docs/episode-atomicity-qualification.md`](../../../../../docs/episode-atomicity-qualification.md).
It exercises the shipped Python facade backed by the C++ Episode manifest
implementation; it does not parse or mutate journal bytes itself.

Build the core first so `framework/core/dist/kungfu` contains the native binding,
then run:

```sh
./kungfu-code episode:qualify -- --profile mvp-smoke-v1
./kungfu-code episode:qualify -- --profile mvp-baseline-v1
./kungfu-code episode:qualify -- --profile mvp-smoke-v1 --mode semantic
```

Useful scoped runs:

```sh
./kungfu-code episode:qualify -- \
  --profile mvp-smoke-v1 \
  --mode accumulation \
  --accumulation-checkpoints 1000,10000 \
  --seed 42042

./kungfu-code episode:qualify -- \
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

`./kungfu-code verify` runs `mvp-smoke-v1` by default after checking the built
runtime artifacts. This means both the declared Buildchain `verify` lifecycle
and the alpha/release `verify --fuzz` workflow fail when the smoke profile
fails. `--skip-episode-qualification` is an explicit local diagnostic escape
hatch; the checked-in Buildchain and alpha/release commands do not use it.

`mvp-baseline-v1` is intentionally not a per-build gate. Run its 100k
accumulation and 10k contention workloads explicitly for periodic or
release-readiness qualification.

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

Trust Report v2 records every semantic dimension as `passed`, `failed`, or
`not_exercised`. A dimension can pass only when a production comparison ran.
`capability_soundness` remains `not_exercised` until the production Episode
safe-capability report exists; it is therefore not part of the current MVP
required-dimension set.

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

## Files

- `run.mjs` owns profiles, worker processes, timeouts, aggregation, and reports.
- `episode_workload.py` performs writes and readback through
  `kungfu.storage.service`.
- `semantic_oracle.py` is the dependency-free abstract model.
- `semantic_workload.py` performs bounded model-versus-production comparisons.
- `profiles/*.json` are versioned workload and progress policies.
- `schemas/trust-report-v2.schema.json` validates current reports; v1 remains
  checked in so historical evidence stays readable.
