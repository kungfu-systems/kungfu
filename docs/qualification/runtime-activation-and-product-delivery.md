---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: release-gate-contract
review_state: self-reviewed
sensitivity: public
sources: [architecture-decisions, local-files, executable-probe]
period: 2026-07-14
theme: runtime-activation-and-product-delivery
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# Runtime activation and product-delivery qualification

This gate closes KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c Stage 7 for the current source revision and named
platform. It composes existing authorities instead of creating another runtime
or release system. A passing report binds raw suite hashes, source coordinates,
the frozen product, full verification, the app artifact, and the Shifu local
artifact catalog.

## Acceptance matrix

| Boundary | Machine evidence | Passing meaning |
| --- | --- | --- |
| daemonless storage | `activation-core` | storage-only invocation constructs no activation client |
| no-fork seam | `activation-core` | `CoordinatorEngine` accepts a direct request with subprocess construction forbidden |
| live activation and recovery | `activation-core` | exact-cut readiness, first-call serialization, generation replacement, crash window, lease expiry, and idle drain remain fenced |
| on-demand self-maintenance | `activation-core` | concurrent activation starts one supervisor, 100 start/stop rounds retire routes, idle exit cannot overwrite a replacement, and unknown or PID-reused processes are never signalled |
| readiness publication | `activation-core` | native durability/projection authorities establish the requested cut before coordinates are atomically published |
| Profile/KFX action admission | `profile-action-admission` | live-required callbacks run only after a matching broker receipt; storage-only callbacks stay daemonless |
| language/product parity | `runtime-surface-parity` | CLI, GUI, Python, Node, libkungfu declarations, and KFX use the canonical registry/status vocabulary |
| bounded performance report | `activation-performance` | synthetic daemonless, cold, warm, and replacement paths report latency/resource observations without an SLO claim |
| real product smoke | `product-runtime-smoke` | a frozen CLI uses a temporary home for daemonless status, cold/warm process-live ensure, restart, and clean stop |
| product artifacts | `product-distribution`, `product-verification`, `product-catalog` | the Mac distribution, full Core/Episode verification, app build artifact, and local catalog all succeed |

The full command is:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

Alpha and release pull requests enter the same complete command through the
Buildchain heavy-build verify adapter in `.github/workflows/build.yml`. The
release qualification dispatcher adds
`--retain product/release/qualification/runtime-activation`, so the uploaded
Buildchain artifact contains both `report.json` and `raw-logs.jsonl.gz`. The gzip member is
newline-delimited JSON: each row binds the suite id, raw log path, byte count,
SHA-256, and base64-preserved output. The report records the bundle SHA-256 and
per-suite member manifest; a report without the adjacent bundle is not complete
retained release evidence.

The subsequent
[zero-burden desktop gate](zero-burden-desktop-runtime.md) verifies this retained
pair together with live Peer evidence, then binds Agent Session and frontend
recovery results into the final cross-layer report. Runtime qualification stays
the authority for runtime and product-artifact claims; the aggregate gate does
not reimplement them.

The current retained complete product report is the
[Darwin arm64 `b325b9739` evidence](evidence/runtime-activation/b325b9739/README.md).
Its machine report and compressed raw logs bind the latest-dev clean source
tree, refreshed KFD release evidence, all eight passing suites, and the
claim/non-claim boundary below. The
[`8643f1187`](evidence/runtime-activation/8643f1187/README.md),
[`527652f13`](evidence/runtime-activation/527652f13/README.md),
[`080f330db`](evidence/runtime-activation/080f330db/README.md),
[`fea9ea4ae`](evidence/runtime-activation/fea9ea4ae/README.md), and
[`fb1574844`](evidence/runtime-activation/fb1574844/README.md) reports remain as
historical evidence from prior `dev/v4/v4.0` synchronization points.

Plan-only inspection is:

```sh
./shifu runtime:qualify -- --mode dry-run
```

An execute report is `passed` only when the source tree was clean at suite
execution and every Core and product suite passed. `--with-product` is not an
optional success shortcut: omitting it makes the report `unqualified`.

## Readiness descriptor boundary

`publish_native_readiness_evidence` validates the contract plus exact
workspace, runtime-home, and data-root identity. It builds a live-required
operation requirement, calls the existing native durability and projection
authorities, validates the returned readiness and minimum cut, and only then
atomically replaces the workspace descriptor. A failed authority or lagging cut
leaves any prior descriptor unchanged.

The descriptor remains coordinates, not proof. Discovery validates its binding,
and every live consumer reconstructs and invokes the native authorities again.
PID liveness, a responsive route, a GUI window, and descriptor bytes cannot
establish semantic readiness.

## Performance interpretation

The synthetic workload separates daemonless planning/invocation, first cold
activation, warm generation reuse, and replacement recovery. The product smoke
separately records real frozen-CLI timings for daemonless planning/status,
cold/warm ensure, restart, and stop in a temporary workspace. Reports preserve
sample counts, median/p95/maximum observations where repeated, and a process
resource snapshot.

These numbers are diagnostic observations, not a release SLO. Schema
validation, filesystem state, hardware, cache state, and process startup are
part of the observed envelope. Performance never permits skipping readiness,
generation fencing, durability reconciliation, or cleanup.

## Supported claim and non-claims

A retained passing report supports only this statement:

> On the named source revision and platform, the process-host implementation
> preserved the contract's daemonless, no-fork engine, exact-cut activation,
> crash/restart, action-admission, and product-artifact boundaries under the
> recorded suites.

It does not establish:

- a production `EmbeddedRuntimeHost`, thread model, or external executor ABI;
- distributed election, cross-machine leases, replication, or HA;
- physical-host restart, device loss, or sudden-power-loss qualification;
- default-on production durability/projection candidate profiles;
- a universal cold/warm/recovery latency or resource SLO;
- interactive GUI-window behavior on a headless build runner; or
- Linux/Windows product qualification from a Mac report.

Linux and Windows remain contract/CI surfaces until each platform retains its
own complete product report. Interactive GUI launch remains a manual display
check; `verify --full --with-app` proves the build artifact and frozen CLI smoke,
not pixels or desktop lifecycle.

## AI provenance

`ai_provenance`: this contract was drafted by the visible GPT-5 model family
through Codex on 2026-07-14 from KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c, the runtime contract, deterministic
suites, and the Shifu product workflow. The model had no invisible evidence for
unexecuted platforms or physical-host failures; those remain explicit
non-claims. Maintainer review can replace this attribution when the document is
substantively re-authored.
