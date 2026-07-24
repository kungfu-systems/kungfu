---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-07-14
theme: layer-gate-timing-baseline
doc_type: engineering-evidence
sources: [local-files]
confidence: high
sensitivity: internal
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-15
ai_provenance: GPT-5 via Codex on 2026-07-15; visible local source, three-host lifecycle logs, hosted CI logs, Gate receipts, qualification reports, and host identity; no private publication state inspected
---

# Layer Gate timing baseline

This document is the source-bound timing record for the [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](../adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md) Layers Gate
budget work. It deliberately separates measured wall time from configured Gate
timeouts. All three hosts are complete on the final baseline tuple. Linux's
full Episode release stage is retained as a censored over-budget observation:
it exceeded its declared 1800-second Gate ceiling while still processing the
first seed's 100,000-episode accumulation checkpoint.

## Frozen measurement tuple

| Input | Frozen value |
| --- | --- |
| Source SHA | `c4ba70d9542d42bbd75ddd9dd4c7ff079f4570fa` |
| Source state | clean |
| Gate registry | `sha256:26716c1b1979fa3789f35caf5db97dae103462a7e02aebd4f4026b0ea2923526` |
| Portable-off profile | `sha256:251ecdb33a34b770a6fbd40b0b05c5c8c0d629a06d9144e6d2d89c9c8e70258b` |
| Buildchain contract lock | `sha256:19dd7c50cb86936d2ce009a92eb33b18b35919a481831d323089523ad44e8c4a` |
| Optional dependencies | disabled |
| Buildchain source build | enabled |
| Native build | enabled |
| Compiler cache | disabled with `CCACHE_DISABLE=1` |
| Fuzz duration | unshortened current default, `90s` per target |
| Qualification temporary storage | repository-scoped `.buildchain/tmp` |

The cache class is **cold repository-local outputs with warm global dependency
download caches**. Each authoritative host must start from a new clean checkout
without repository-local `node_modules`, native build outputs, or product
artifacts. Global pnpm, Conan, Cargo, uv, and equivalent download caches may be
warm and must be declared. This is not a full-network-cold claim.

## Frozen native execution protocol

Every host uses Node `22.22.3` from `.node-version`, pnpm `11.7.0` from
`packageManager`, the checked-in Shifu launcher, and these environment values:

```text
SHIFU_CACHE_PROFILE_REF=docs/shifu/qualification-portable-off.cache-profile.json
SHIFU_CACHE_PROFILE_DIGEST=sha256:251ecdb33a34b770a6fbd40b0b05c5c8c0d629a06d9144e6d2d89c9c8e70258b
SHIFU_CACHE_SCOPE=self-hosted-runner
KUNGFU_BUILDCHAIN_NO_OPTIONAL=1
KUNGFU_BUILDCHAIN_SOURCE_BUILD=1
SHIFU_NATIVE=1
SHIFU_REQUIRE_MSVC=1
CCACHE_DISABLE=1
KUNGFU_FUZZ_SECONDS=90
TMPDIR=<worktree>/.buildchain/tmp
TEMP=<worktree>/.buildchain/tmp
TMP=<worktree>/.buildchain/tmp
```

Before installation, the host must prove the source SHA and the three raw-file
SHA-256 values in the frozen tuple, record host/tool versions and available
space, and show an empty `git status --short`. A missing pinned tool stops the
run; the baseline protocol does not install or upgrade host-global tooling.

The measured stages are intentionally separate even though
`scripts/run-release-qualification.mjs` normally dispatches them in one
process. Separate monotonic wall timers preserve the exact stage order while
making the budget reconstruction auditable:

1. `node scripts/buildchain-install.mjs`
2. `node scripts/run-shifu-lifecycle.mjs cache-apply dist`
3. `node scripts/run-shifu-lifecycle.mjs cache-apply verify --fuzz`
4. Linux only: `cache-apply episode:qualify:release` with the canonical output
   path from `scripts/run-release-qualification.mjs`.
5. Linux only: `cache-apply adr:release:gate -- --github-event --allow-non-pr`
   with the canonical report path.
6. `cache-apply gate run layers.format layers.sdk layers.surfaces` with all four
   declared capabilities and the canonical receipt path.

Steps 4 and 5 are Linux-only because that is the current release workflow
contract. Omitting them would understate the end-to-end alpha and
release-candidate path. The combined Gate run supplies authoritative per-Gate
durations for `gate.catalog`, `layers.contract`, `layers.format`, `layers.sdk`,
and `layers.surfaces` without rerunning them individually.

### Linux adapter

The authoritative checkout lives on the `agent-120` NVMe under
`/data/worktrees/kungfu/` and uses a dedicated tmux session. The host-specific
`KUNGFU_BUILD_JOBS=12` cap is part of the declared environment: it prevents the
known 32-way LTO memory oversubscription and is not a qualification shortcut.
Each command is wrapped with `/usr/bin/time -p`, with stdout, stderr, exit code,
and timing retained under
`.buildchain/measurements/linux-c4ba70d9542d/`. Linux also uses a new empty
repository-local `CONAN_HOME`; this makes Conan cold rather than inheriting the
runner service's shared cache. No runner service or persistent host
configuration is changed.

### Windows adapter

The authoritative checkout uses a dedicated DARKHERO worktree and native
PowerShell. A `System.Diagnostics.Stopwatch` wraps each native command and
appends elapsed seconds and exit status to the corresponding log. The command
body remains the same Node dispatcher; it selects `shifu.cmd` on `win32`, so no
Git Bash assumption is introduced. The existing effective build concurrency is
recorded rather than changed during baseline discovery.

DARKHERO is manual-only and OBS-sensitive. The run requires a confirmed idle
window and supervision; it must not alter OBS, services, MSVC installation,
registry, power policy, network configuration, or runner configuration.

### Evidence collection

After every stage, record the exit status and stop on the first failure. A
successful host record contains the raw logs, receipt and report digests,
artifact names and byte sizes, final clean/dirty source state, and the exact
effective environment. Evidence transfer to the control host is timed
separately from compute. Files remain on the source host until their received
digests match; cleanup is a later explicit operation and is not part of the
baseline run.

## Authoritative results

| Host | Install | Distribution build | Verify + fuzz | Layer Gate run | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| macOS arm64 | 10.81s | 406.97s | 330.05s | 44.48s | pass |
| Linux x86_64 | 1.83s | 671.30s | 372.21s | 24.23s | layer pass; full Episode censored |
| Windows x86_64 | 12.637s | 520.455s | 443.176s | 64.477s | pass |

The macOS measured compute total is `792.31s`; Windows is `1040.745s`. Both
exclude checkout/worktree creation, evidence transfer, queueing, and workflow
setup overhead. Linux consumed `1045.34s` before the full Episode release stage
and therefore had only `754.66s` left under the alpha budget before any Gate or
workflow overhead. The full Episode stage was still incomplete after
`1872.53s`; the observed path had already reached `2942.25s` including ADR and
Layer Gates.

### macOS arm64

- Host: macOS 26.5.2 (`25F84`), `arm64`, `Mac13,2`, 20 logical CPUs,
  128 GiB memory.
- Runtime/toolchain: Node 22.22.3, fnm 1.39.0, uv 0.11.23, Buildchain
  2.12.1-alpha.4, AppleClang 21, CMake 4.3.2, Conan 2.29.1, Cargo 1.95.0.
- Install: `10.81s` wall.
- Distribution: `406.97s` wall; CLI archive, desktop DMG, and desktop ZIP were
  built and the installed-layout smoke passed.
- Verification: `330.05s` wall, `39/39` passed. All three fuzz targets ran for
  90 seconds and reported no crash.
- Gate command: `44.48s` wall and `43.923s` receipt duration; all selected and
  dependent Gates pass.

| Gate | Measured duration | Status |
| --- | ---: | --- |
| `gate.catalog` | 0.694s | pass |
| `layers.contract` | 0.705s | pass |
| `layers.format` | 4.787s | pass |
| `layers.sdk` | 14.200s | pass |
| `layers.surfaces` | 23.536s | pass |

The source-bound compact record is
[`evidence/layer-gates/c4ba70d95/macos-arm64-authoritative.json`](evidence/layer-gates/c4ba70d95/macos-arm64-authoritative.json).
It retains receipt/report digests, artifact sizes, tracked raw log paths, and
raw log digests. The generated receipt reports `qualifying: false`: this was an
explicit diagnostic Gate run on a capable native host, not promotion authority.

### Windows x64

- Host: DARKHERO, Windows 11 `10.0.26200`, AMD Ryzen 9 9950X3D, 16 cores / 32
  logical CPUs, approximately 93 GiB memory.
- Runtime/toolchain: Node 22.22.3, pnpm 11.7.0, fnm 1.39.0, uv 0.11.21,
  CMake 4.3.3, Cargo 1.96.0, and the discovered Visual Studio MSVC toolchain.
- Install `12.637s`; distribution `520.455s`; verify/fuzz `443.176s`; Gate
  command `64.477s`. Every stage exited zero.
- The ten non-qualification release artifacts total `1,284,178,212` bytes.

The compact record is
[`evidence/layer-gates/c4ba70d95/windows-x64-authoritative.json`](evidence/layer-gates/c4ba70d95/windows-x64-authoritative.json).
The 39.6 MiB distribution stdout is retained losslessly as gzip so the Git
evidence remains reviewable without discarding raw output.

### Linux x64

- Host: agent-120 on `/data` NVMe; a repository-local empty Conan home makes the
  native dependency build cold. Install is `1.83s`; distribution is `671.30s`.
- `verify --fuzz` is `372.21s` and passes after the qualification temporary
  directory is moved from the host's mechanical-disk `/tmp` to `.buildchain/tmp`.
- The full `mvp-baseline-v1` release evidence was still in the first seed's
  10,000-to-100,000 accumulation writer at the declared 1800-second Gate
  ceiling. It was terminated as an unqualified censored observation and exited
  after `1872.53s`; no completion time is inferred.
- ADR admission took `0.15s` and was not applicable outside a PR. The Layer
  Gate command took `24.23s` (`23.966s` receipt duration); all five selected or
  dependent Gates passed.
- The compact record is
  [`evidence/layer-gates/c4ba70d95/linux-x64-authoritative.json`](evidence/layer-gates/c4ba70d95/linux-x64-authoritative.json).
  Raw logs include both the alpha-budget crossing and Gate-ceiling process and
  progress snapshots.

## Excluded and prerequisite runs

The authoritative run followed several non-baseline attempts. They are not
silently averaged into the result:

- Two early distribution attempts failed immediately because exact libnode
  alpha.16 platform packages were not yet available from the configured
  dependency source.
- Subsequent development attempts exposed missing or mismatched exact esbuild
  platform binaries for SDK, TUI, GUI, and electron-builder subprocesses. The
  distribution staging was repaired before freezing the authoritative SHA.
- A clean pre-final run passed distribution but generated pybind stubs that did
  not match the committed tree. Two small source/stub ownership corrections
  were committed, and the clean authoritative source was advanced to
  `6afd4d121`.
- A command routed through the optional-installing `shifu` bootstrap was
  rejected as an invalid measurement because it did not preserve the declared
  no-optional profile.
- Linux `2a41a9627` built and passed all sanitizer/fuzz targets but failed
  `38/39` because Episode smoke exceeded the wrapper's 300-second timeout. The
  retained process revealed that `os.tmpdir()` resolved to `/tmp` on a spinning
  WDC disk, while the canonical worktree was on Samsung NVMe. The same complete
  smoke profile passed in `109.26s` when `TMPDIR/TEMP/TMP` pointed to
  `.buildchain/tmp`; this led to the source-bound `c4ba70d95` fix and full rerun.
- Earlier same-source Linux and Windows scouts that failed on shared Conan
  permissions, Windows esbuild package layout, or Windows-only POSIX fixture IO
  are retained as excluded debugging evidence. They are not averaged into the
  baseline.

These attempts are prerequisite debugging evidence, not comparable performance
samples. The policy must not use them as runtime observations.

## Budget interpretation boundary

Configured Gate timeouts are safety ceilings and are not timing evidence. The
completed deterministic Layer Gates are small relative to native distribution
and verify/fuzz. The full Episode release profile is the variance-dominant
stage. It cannot be part of the recurring alpha path and cannot complete inside
its own current Gate ceiling. The selected policy therefore preserves all
deterministic semantic, artifact-identity, sanitizer, and fuzz checks while
bounding only the Episode seeds and accumulation/contention counts:

| Execution profile | End-to-end budget | Upstream allowance | Reserve | Episode workload |
| --- | ---: | ---: | ---: | --- |
| `alpha` | 5400s | 2400s | 600s | `mvp-smoke-v1` |
| `release-candidate` | 3600s | 900s | 600s | `mvp-candidate-v1` |
| `full-patrol` | 14400s | 900s | 900s | unchanged `mvp-baseline-v1` |

The original alpha figures were anchored to the slowest measured upstream host
(`673.13s` Linux install plus distribution) with additional setup allowance.
The first exact-source hosted acceptance run then measured `1467s` inside the
qualification process because runtime activation intentionally rebuilds and
verifies the complete product distribution. That raised the execution
allowance from `810s` to `1710s`.

GitHub run `29410685685` later exercised the expanded exact-source product gate
on hosted Linux. Install plus build consumed `2086s`; the qualification wrapper
then ran for `1751s`, reached the native upgrade evidence stage with all prior
stages passing, and failed only because it exceeded the `1710s` execution
allowance. The revised alpha profile reserves `2400s` for upstream work and
`600s` for transfer and variance, leaving a `2400s` qualification execution
allowance inside a `5400s` end-to-end budget. It does not skip or shorten any
gate, fuzz target, or Episode workload.
The release profile adds the measured 10,000 accumulation checkpoint while the
100,000 checkpoint and three-seed soak remain available in full-patrol. The
workflow summary fails when qualification exceeds the budget after subtracting
both upstream allowance and reserve.

## Evidence boundary

Checkout, queueing, and hosted artifact-transfer time were not measured and
remain inside each profile's explicit reserve. Final acceptance therefore
requires a clean-source three-host run of the selected profile; the baseline
alone is evidence for parameter selection, not proof that the tuned source
meets the budgets.
