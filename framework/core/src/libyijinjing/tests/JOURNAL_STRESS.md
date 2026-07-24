<!--
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: ongoing
theme: kungfu-core-journal-stress
-->

# Journal publication-protocol stress harness

`journal_stress_harness.cpp` builds the `yijinjing_journal_stress` evidence
executable. It turns the KF-ADR-019f86da-4f90-7179-a900-c40bdb498910 concurrency contract — that the frame
`length` and page `last_frame_position` release/acquire tokens carry a writer's
payload stores to a reader in a *different process* on weak-memory hardware —
from "a human read a torn frame once" into "a machine keeps trying to read the
problem out".

It is an evidence tool. It exercises the qualified production writer / reader
surface but is never linked into or shipped with libkungfu. All state lives
under a temporary scratch root; nothing is written to the repository or the
current working directory.

## What it does

A single real writer process and several real reader processes share the same
mmap-backed journal pages:

- The writer publishes self-verifying frames through the real `writer` API
  (`write_raw_at_as`), rolling many small (2 MiB) pages so the `close_page`
  turn-page protocol runs constantly, then a sentinel frame carrying the total.
- Each reader opens the journal through the real reader (`journal` +
  `journal_open_policy::reader()`), live-tails from time 0, and content-verifies
  every observed frame.

Each frame payload carries a magic, a monotonic sequence number, the body
length, and an FNV-1a-64 hash of a deterministic body. A reader flags:

| kind                   | meaning                                                            |
|------------------------|--------------------------------------------------------------------|
| `torn_body`            | stored hash != recomputed body hash (partial/torn cross-process)   |
| `magic`                | payload magic wrong (published token seen ahead of payload)        |
| `short_frame`          | frame shorter than its declared payload                            |
| `reorder_or_duplicate` | observed seq went backwards or repeated                            |
| `gap`                  | observed seq skipped ahead                                         |

A reader crash, exception, page-bounds error, or stall also fails the run.

## Run

The entry point mirrors the sibling evidence tool `qualify:mmap`: it builds the
one evidence target against an already configured core build and forwards its
arguments.

```bash
./shifu build                      # once, if framework/core/build is not configured
./shifu qualify:journal-stress     # defaults to the fast smoke profile

# >=30 minute soak, zero violations expected
./shifu qualify:journal-stress -- --profile soak --output soak.json

# custom shapes
./shifu qualify:journal-stress -- --frames 500000 --readers 4 --output run.json
./shifu qualify:journal-stress -- --duration-seconds 1800 --readers 3
```

The runner stamps `KUNGFU_QUALIFICATION_GIT_HEAD` / `_GIT_DIRTY` into the
receipt. To drive the binary directly (for example on a host where the core is
already built), the target is `yijinjing_journal_stress`:

```bash
cmake --build <build-dir> --target yijinjing_journal_stress
yijinjing_journal_stress --profile smoke --output smoke.json
```

The target is gated behind core tests (`KUNGFU_WITH_CORE_TESTS=ON` ->
`YIJINJING_BUILD_TESTS=ON`).

Exit code `0` means `verdict=clean` (or `injected_detected`, see below).
`--output` refuses to overwrite an existing file. The JSON receipt
(`schema: kungfu.journal-stress.v1`) records host facts, the writer report, and
each reader's violations, mirroring the `mmap_qualification` receipt culture.

## Proving it is not vacuously green

The harness must be able to fail, or a clean run means nothing.

- **Checker self-test (wired into ctest, portable):**

  ```bash
  yijinjing_journal_stress --self-test-checker
  ```

  Feeds the checker known-bad frame streams (torn body, wrong magic, short
  frame, gap, backward seq) and asserts each is flagged. This is the
  `yijinjing_journal_stress_checker` ctest; the multi-process run is *not* a
  default ctest (it is minutes long and POSIX-only).

- **End-to-end injection (proves the cross-process path surfaces faults):** the
  writer can emit one deliberately broken frame partway through a real run. The
  harness must then report `verdict=injected_detected`; a clean run under
  injection is itself a failure.

  ```bash
  yijinjing_journal_stress --frames 20000 --readers 3 --inject corrupt-body
  yijinjing_journal_stress --frames 20000 --readers 3 --inject gap
  yijinjing_journal_stress --frames 20000 --readers 3 --inject duplicate
  yijinjing_journal_stress --frames 20000 --readers 3 --inject reorder
  ```

  These injections are harness-private payload/sequence corruptions written
  through the real writer; they never touch the shipped publication path and are
  never a default test.

- **Gold-standard memory-ordering control (manual, documented):** to prove the
  harness would catch a *real* KF-ADR-019f86da-4f90-7179-a900-c40bdb498910 regression, rebuild libyijinjing with a
  single release store downgraded to relaxed — for example, change
  `frame::publish_data_length` (`include/kungfu/yijinjing/journal/frame.h`) or
  `page::set_last_frame_position` (`src/journal/page.cpp`) to
  `std::memory_order_relaxed` — then run the harness un-injected on Apple
  Silicon or another weak-memory host and expect `torn_body` violations. This
  miscompiled library is a diagnostic only and must never be merged.

## Platforms

The multi-process modes use POSIX `fork`; off POSIX the binary prints a skip
notice and exits 0. Weak-memory hosts (Apple Silicon, ARM) are the primary
targets for the real KF-ADR-019f86da-4f90-7179-a900-c40bdb498910 exposure. Per the heavy-validation-is-local
principle, the soak run is driven on the local hosts rather than added as CI
weight; only the portable checker self-test is a default gate.
