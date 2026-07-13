# Kungfu Gate policy matrix

This table is generated from [`shifu.gates.json`](../../../shifu.gates.json).
Do not hand-edit the generated block. A mode applies when the corresponding
[workflow activation](workflow-bindings.json) matches.

- `required`: blocks the profile.
- `advisory`: runs and remains visible without blocking.
- `off`: not selected by the current profile.

<!-- BEGIN GENERATED GATE MATRIX -->
| Gate | Cost | dev-pr | dev-patrol | alpha-pr | release-pr | release-promotion |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| [`gate.catalog`](source-and-governance.md#gate-catalog) | light | required | required | required | required | required |
| [`governance.dco`](source-and-governance.md#governance-dco) | light | required | off | required | required | off |
| [`governance.adr-delivery`](release-and-promotion.md#governance-adr-delivery) | light | required | off | required | required | off |
| [`governance.buildchain-config`](source-and-governance.md#governance-buildchain-config) | light | required | off | required | required | required |
| [`governance.promotion-rehearsal`](release-and-promotion.md#governance-promotion-rehearsal) | light | required | off | required | required | required |
| [`source.acceptance`](source-and-governance.md#source-acceptance) | light | required | off | off | off | off |
| [`source.changed-scope`](source-and-governance.md#source-changed-scope) | light | off | off | off | off | off |
| [`source.whole-tree`](source-and-governance.md#source-whole-tree) | heavy | off | off | off | off | off |
| [`docs.contracts`](source-and-governance.md#docs-contracts) | light | required | advisory | off | off | off |
| [`docs.prose`](source-and-governance.md#docs-prose) | light | required | off | off | off | off |
| [`docs.external-links`](source-and-governance.md#docs-external-links) | light | off | advisory | off | off | off |
| [`shifu.workspace`](source-and-governance.md#shifu-workspace) | heavy | required | off | required | required | off |
| [`product.distribution`](build-and-runtime.md#product-distribution) | heavy | off | off | required | required | off |
| [`product.verify-full`](build-and-runtime.md#product-verify-full) | heavy | off | required | off | off | off |
| [`product.verify-fuzz`](build-and-runtime.md#product-verify-fuzz) | heavy | off | off | required | required | off |
| [`release.artifact-admission`](release-and-promotion.md#release-artifact-admission) | heavy | off | off | off | off | required |
| [`layers.contract`](native-qualification.md#layers-contract) | light | off | off | off | off | off |
| [`episode.smoke`](native-qualification.md#episode-smoke) | heavy | off | off | required | required | off |
| [`episode.release`](native-qualification.md#episode-release) | heavy | off | off | required | required | off |
| [`embedding.membranes`](native-qualification.md#embedding-membranes) | heavy | off | off | required | required | off |
| [`mmap.contracts`](native-qualification.md#mmap-contracts) | heavy | off | off | off | off | off |
| [`mmap.performance`](native-qualification.md#mmap-performance) | heavy | off | off | off | off | off |
| [`durability.contracts`](native-qualification.md#durability-contracts) | heavy | off | off | off | off | off |
| [`state-service.contracts`](native-qualification.md#state-service-contracts) | heavy | off | off | off | off | off |
| [`profile.suite`](native-qualification.md#profile-suite) | light | off | off | off | off | off |
| [`profile.lifecycle`](native-qualification.md#profile-lifecycle) | heavy | off | off | off | off | off |
| [`profile.agent-sdk`](native-qualification.md#profile-agent-sdk) | heavy | off | off | off | off | off |
| [`profile.kfd3`](native-qualification.md#profile-kfd3) | heavy | off | off | off | off | off |
| [`runtime.durable-ingest`](native-qualification.md#runtime-durable-ingest) | heavy | off | off | off | off | off |
| [`runtime.projection-bootstrap`](native-qualification.md#runtime-projection-bootstrap) | heavy | off | off | off | off | off |
| [`runtime.crash-recovery`](native-qualification.md#runtime-crash-recovery) | heavy | off | off | off | off | off |
| [`runtime.errors`](native-qualification.md#runtime-errors) | heavy | off | off | off | off | off |
| [`toolchain.cpp-modules`](native-qualification.md#toolchain-cpp-modules) | heavy | off | off | off | off | off |
| [`toolchain.libwasm-cache`](native-qualification.md#toolchain-libwasm-cache) | heavy | off | off | off | off | off |
<!-- END GENERATED GATE MATRIX -->
