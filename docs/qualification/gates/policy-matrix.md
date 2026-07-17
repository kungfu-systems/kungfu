# Kungfu Gate policy matrix

This table is generated from [`shifu.gates.json`](../../../shifu.gates.json).
Do not hand-edit the generated block. A mode applies when the corresponding
[workflow activation](workflow-bindings.json) matches.

- `required`: blocks the profile.
- `advisory`: runs and remains visible without blocking.
- `off`: not selected by the current profile.

<!-- BEGIN GENERATED GATE MATRIX -->
| Gate | Cost | dev-pr | dev-patrol | alpha-pr | release-pr | measurement | release-promotion |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: |
| [`gate.catalog`](source-and-governance.md#gate-catalog) | light | required | required | required | required | advisory | required |
| [`governance.dco`](source-and-governance.md#governance-dco) | light | required | off | required | required | off | off |
| [`governance.adr-delivery`](release-and-promotion.md#governance-adr-delivery) | light | required | off | required | required | advisory | off |
| [`governance.buildchain-config`](source-and-governance.md#governance-buildchain-config) | light | required | off | required | required | off | required |
| [`governance.promotion-rehearsal`](release-and-promotion.md#governance-promotion-rehearsal) | light | required | off | required | required | advisory | required |
| [`source.acceptance`](source-and-governance.md#source-acceptance) | light | required | off | off | off | advisory | off |
| [`source.changed-scope`](source-and-governance.md#source-changed-scope) | heavy | required | off | off | off | advisory | off |
| [`source.whole-tree`](source-and-governance.md#source-whole-tree) | heavy | off | off | off | off | advisory | off |
| [`docs.contracts`](source-and-governance.md#docs-contracts) | light | required | advisory | off | off | advisory | off |
| [`docs.prose`](source-and-governance.md#docs-prose) | light | required | off | off | off | advisory | off |
| [`docs.external-links`](source-and-governance.md#docs-external-links) | light | off | advisory | off | off | advisory | off |
| [`shifu.workspace`](source-and-governance.md#shifu-workspace) | heavy | required | off | required | required | advisory | off |
| [`product.distribution`](build-and-runtime.md#product-distribution) | heavy | off | off | required | required | advisory | off |
| [`product.verify-full`](build-and-runtime.md#product-verify-full) | heavy | off | required | off | off | advisory | off |
| [`product.verify-fuzz`](build-and-runtime.md#product-verify-fuzz) | heavy | off | off | required | required | advisory | off |
| [`release.artifact-admission`](release-and-promotion.md#release-artifact-admission) | heavy | off | off | off | off | off | required |
| [`layers.contract`](native-qualification.md#layers-contract) | light | off | off | required | required | advisory | off |
| [`layers.format`](native-qualification.md#layers-format) | heavy | off | off | required | required | advisory | off |
| [`layers.sdk`](native-qualification.md#layers-sdk) | heavy | off | off | required | required | advisory | off |
| [`layers.surfaces`](native-qualification.md#layers-surfaces) | heavy | off | off | required | required | advisory | off |
| [`layers.release`](release-and-promotion.md#layers-release) | light | off | off | off | off | advisory | required |
| [`episode.smoke`](native-qualification.md#episode-smoke) | heavy | off | off | required | required | advisory | off |
| [`episode.release`](native-qualification.md#episode-release) | heavy | off | off | required | required | advisory | off |
| [`embedding.membranes`](native-qualification.md#embedding-membranes) | heavy | off | off | required | required | advisory | off |
| [`mmap.contracts`](native-qualification.md#mmap-contracts) | heavy | off | off | off | off | advisory | off |
| [`mmap.performance`](native-qualification.md#mmap-performance) | heavy | off | off | off | off | advisory | off |
| [`durability.contracts`](native-qualification.md#durability-contracts) | heavy | off | off | off | off | advisory | off |
| [`state-service.contracts`](native-qualification.md#state-service-contracts) | heavy | off | off | off | off | advisory | off |
| [`profile.suite`](native-qualification.md#profile-suite) | light | off | off | off | off | advisory | off |
| [`profile.lifecycle`](native-qualification.md#profile-lifecycle) | heavy | off | off | off | off | advisory | off |
| [`profile.agent-sdk`](native-qualification.md#profile-agent-sdk) | heavy | off | off | off | off | advisory | off |
| [`profile.kfd3`](native-qualification.md#profile-kfd3) | heavy | off | off | off | off | advisory | off |
| [`runtime.durable-ingest`](native-qualification.md#runtime-durable-ingest) | heavy | off | off | off | off | advisory | off |
| [`runtime.projection-bootstrap`](native-qualification.md#runtime-projection-bootstrap) | heavy | off | off | off | off | advisory | off |
| [`runtime.crash-recovery`](native-qualification.md#runtime-crash-recovery) | heavy | off | off | off | off | advisory | off |
| [`runtime.errors`](native-qualification.md#runtime-errors) | heavy | off | off | off | off | advisory | off |
| [`toolchain.cpp-modules`](native-qualification.md#toolchain-cpp-modules) | heavy | off | off | off | off | advisory | off |
| [`toolchain.libwasm-cache`](native-qualification.md#toolchain-libwasm-cache) | heavy | off | off | off | off | advisory | off |

## Execution parameters (separate from Gate selection)

| Execution profile | Budget (s) | Upstream build (s) | Reserve (s) | Episode profile | Episode ceiling (s) | Fuzz seconds/target |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `alpha` | 5400 | 2400 | 600 | `mvp-smoke-v1` | 600 | 90 |
| `release-candidate` | 3600 | 900 | 600 | `mvp-candidate-v1` | 1200 | 90 |
| `full-patrol` | 23400 | 900 | 900 | `mvp-baseline-v1` | 19800 | 90 |

Evidence reuse: producer `pull-request platform build`; consumer `post-merge qualification on the exact producer tuple`; mismatch `fail-closed-and-rebuild`. Reuse key: `sourceRevision`, `platform`, `buildchainRuntime`, `gateRegistryDigest`, `toolchainDigest`, `artifactManifestDigest`.
<!-- END GENERATED GATE MATRIX -->
