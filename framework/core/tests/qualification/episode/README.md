# Episode Qualification Harness

This directory implements the executable v0 slice of
[`docs/episode-atomicity-qualification.md`](../../../../../docs/episode-atomicity-qualification.md).
It exercises the shipped Python facade backed by the C++ Episode manifest
implementation; it does not parse or mutate journal bytes itself.

Build the core first so `framework/core/dist/kungfu` contains the native binding,
then run:

```sh
./kungfu-code episode:qualify -- --profile mvp-smoke-v1
./kungfu-code episode:qualify -- --profile mvp-baseline-v1
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

## Result boundary

The v0 profiles are metadata-only: each independent Episode contains exactly
one open and one terminal record. They qualify manifest population, fold/fsck
readback, writer contention, retry progress, and cold-process stability. They
do not qualify realistic payload bytes, dependency DAGs, projection rebuild,
distributed writers, or fleet-scale capacity. Those gaps remain explicit in
every Trust Report.

`manifest_writer_busy` is the only retryable error. The worker records every
busy result and applies the profile's bounded backoff. An exhausted retry,
unexpected exception, count mismatch, fsck failure, recovery of an unexpected
open Episode, or fresh-process mismatch fails the scenario.

## Files

- `run.mjs` owns profiles, worker processes, timeouts, aggregation, and reports.
- `episode_workload.py` performs writes and readback through
  `kungfu.storage.service`.
- `profiles/*.json` are versioned workload and progress policies.
- `schemas/trust-report-v1.schema.json` validates every emitted report.
