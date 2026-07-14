# Kungfu Gate measurement coverage

This report is generated from
[`measurement-coverage.json`](measurement-coverage.json). Do not hand-edit the
generated block.

A measured observation is an immutable result from one clean source revision;
it does not update when later code changes. Re-run the Gate and register its new
receipt when its implementation or expected cost changes. Any Gate outside the
frozen 2026-07-14 adoption baseline must have a passing observation for every
declared platform before the catalog check succeeds.

<!-- BEGIN GENERATED GATE MEASUREMENTS -->
| Gate | Coverage | Source-bound observations |
| --- | --- | --- |
| `gate.catalog` | measured | [linux: 433 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json)<br>[macos: 694 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json)<br>[windows: 2008 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json) |
| `governance.dco` | adoption baseline | — |
| `governance.adr-delivery` | adoption baseline | — |
| `governance.buildchain-config` | adoption baseline | — |
| `governance.promotion-rehearsal` | adoption baseline | — |
| `source.acceptance` | adoption baseline | — |
| `source.changed-scope` | adoption baseline | — |
| `source.whole-tree` | adoption baseline | — |
| `docs.contracts` | adoption baseline | — |
| `docs.prose` | adoption baseline | — |
| `docs.external-links` | adoption baseline | — |
| `shifu.workspace` | adoption baseline | — |
| `product.distribution` | adoption baseline | — |
| `product.verify-full` | adoption baseline | — |
| `product.verify-fuzz` | adoption baseline | — |
| `release.artifact-admission` | adoption baseline | — |
| `layers.contract` | measured | [linux: 387 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json)<br>[macos: 705 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json)<br>[windows: 2011 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json) |
| `layers.format` | measured | [linux: 2660 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json)<br>[macos: 4787 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json)<br>[windows: 8263 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json) |
| `layers.sdk` | measured | [linux: 10505 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json)<br>[macos: 14200 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json)<br>[windows: 18834 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json) |
| `layers.surfaces` | measured | [linux: 9979 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/linux-x64.raw/layer-artifact-gate-receipt.json)<br>[macos: 23536 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/macos-arm64.raw/layer-artifact-gate-receipt.json)<br>[windows: 32821 ms @ c4ba70d95](../evidence/layer-gates/c4ba70d95/windows-x64.raw/layer-artifact-gate-receipt.json) |
| `layers.release` | adoption baseline | — |
| `episode.smoke` | adoption baseline | — |
| `episode.release` | adoption baseline | — |
| `embedding.membranes` | adoption baseline | — |
| `mmap.contracts` | adoption baseline | — |
| `mmap.performance` | adoption baseline | — |
| `durability.contracts` | adoption baseline | — |
| `state-service.contracts` | adoption baseline | — |
| `profile.suite` | adoption baseline | — |
| `profile.lifecycle` | adoption baseline | — |
| `profile.agent-sdk` | adoption baseline | — |
| `profile.kfd3` | adoption baseline | — |
| `runtime.durable-ingest` | adoption baseline | — |
| `runtime.projection-bootstrap` | adoption baseline | — |
| `runtime.crash-recovery` | adoption baseline | — |
| `runtime.errors` | adoption baseline | — |
| `toolchain.cpp-modules` | adoption baseline | — |
| `toolchain.libwasm-cache` | adoption baseline | — |
<!-- END GENERATED GATE MEASUREMENTS -->
