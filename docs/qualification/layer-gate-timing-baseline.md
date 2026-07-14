---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-07-14
theme: layer-gate-timing-baseline
doc_type: engineering-evidence
sources: [local-files]
confidence: medium
sensitivity: internal
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-14
ai_provenance: GPT-5 via Codex on 2026-07-14; visible local source, lifecycle logs, Gate receipt, qualification reports, and host identity; Linux and Windows authoritative runs have not yet executed
---

# Layer Gate timing baseline

This document is the source-bound timing record for the ADR-0049 Layers Gate
budget work. It deliberately separates measured wall time from configured Gate
timeouts. It remains a draft until native Linux and Windows measurements exist
for the same frozen tuple.

## Frozen measurement tuple

| Input | Frozen value |
| --- | --- |
| Source SHA | `6afd4d121b3658b1d37e1b3fffc43d54dd2ddd31` |
| Source state | clean |
| Gate registry | `sha256:26716c1b1979fa3789f35caf5db97dae103462a7e02aebd4f4026b0ea2923526` |
| Portable-off profile | `sha256:251ecdb33a34b770a6fbd40b0b05c5c8c0d629a06d9144e6d2d89c9c8e70258b` |
| Buildchain contract lock | `sha256:19dd7c50cb86936d2ce009a92eb33b18b35919a481831d323089523ad44e8c4a` |
| Optional dependencies | disabled |
| Buildchain source build | enabled |
| Native build | enabled |
| Compiler cache | disabled with `CCACHE_DISABLE=1` |
| Fuzz duration | unshortened current default, `90s` per target |

The cache class is **cold repository-local outputs with warm global dependency
download caches**. Each authoritative host must start from a new clean checkout
without repository-local `node_modules`, native build outputs, or product
artifacts. Global pnpm, Conan, Cargo, uv, and equivalent download caches may be
warm and must be declared. This is not a full-network-cold claim.

## Authoritative results

| Host | Install | Distribution build | Verify + fuzz | Layer Gate run | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| macOS arm64 | 9.32s | 372.42s | 326.74s | 45.332s | pass |
| Linux x86_64 | pending | pending | pending | pending | not run |
| Windows x86_64 | pending | pending | pending | pending | not run |

The macOS measured compute total is `753.812s` when the four phases are summed.
That number excludes checkout/worktree creation, evidence transfer, queueing,
and workflow setup overhead. It is not yet an alpha or release-candidate
critical-path claim because the other two native hosts are missing.

### macOS arm64

- Host: macOS 26.5.2 (`25F84`), `arm64`, `Mac13,2`, 20 logical CPUs,
  128 GiB memory.
- Runtime/toolchain: Node 22.22.3, fnm 1.39.0, uv 0.11.23, Buildchain
  2.12.1-alpha.4, AppleClang 21, CMake 4.3.2, Conan 2.29.1, Cargo 1.95.0.
- Install: `9.32s` wall, 949 packages reused and zero downloaded by pnpm.
- Distribution: `372.42s` wall; CLI archive, desktop DMG, and desktop ZIP were
  built and the installed-layout smoke passed.
- Verification: `326.74s` wall, `39/39` passed. All three fuzz targets ran for
  90 seconds and reported no crash.
- Gate run: `45.332s` receipt duration, all selected and dependent Gates pass.

| Gate | Measured duration | Status |
| --- | ---: | --- |
| `gate.catalog` | 0.660s | pass |
| `layers.contract` | 0.764s | pass |
| `layers.format` | 4.525s | pass |
| `layers.sdk` | 15.918s | pass |
| `layers.surfaces` | 23.464s | pass |

The source-bound compact record is
[`evidence/layer-gates/6afd4d121/macos-arm64-authoritative.json`](evidence/layer-gates/6afd4d121/macos-arm64-authoritative.json).
It retains receipt/report digests, artifact sizes, tracked raw log paths, and
raw log digests. The generated receipt reports `qualifying: false`: this was an
explicit diagnostic Gate run on a capable native host, not promotion authority.

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

These attempts are prerequisite debugging evidence, not comparable performance
samples. The policy must not use them as runtime observations.

## Budget interpretation boundary

Configured Gate timeouts are safety ceilings and are not timing evidence. No
shorter fuzz, soak, performance, or artifact qualification parameter is chosen
in this draft. Parameter and policy work begins only after Linux and Windows
complete on the frozen tuple and the three-host alpha and release-candidate
critical paths can be reconstructed.

## Remaining work

1. Run the same install, distribution, verify/fuzz, and combined Gate sequence
   on `agent-120` Linux without installing or changing host-global tooling.
2. Run it under supervision on manual-only `DARKHERO` Windows without changing
   live OBS, streaming, service, or machine configuration.
3. Add fixed workflow overhead and artifact/evidence transfer measurements.
4. Reconstruct three-platform alpha and release-candidate critical paths, then
   identify budget consumers without weakening deterministic checks.
