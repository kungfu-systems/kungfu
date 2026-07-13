# Native and qualification gates

These independently named qualification tasks remain visible even when current channel profiles leave them off or cover them inside an aggregate verify command.

Each section is bound to the registry id by the catalog meta gate.

<a id="layers-contract"></a>
<!-- gate-doc:layers.contract -->
## Layer qualification contract (`layers.contract`)

- **Problem:** Checks Core, SDK, product independence, and registered source surfaces.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu layers:qualify`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain layers.contract --profile <profile>`; reproduce with `./shifu gate run layers.contract` on a capable runner.
- **Cost:** light; timeout 900 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:layers.contract -->

<a id="episode-smoke"></a>
<!-- gate-doc:episode.smoke -->
## Episode qualification smoke (`episode.smoke`)

- **Problem:** Runs mvp-smoke-v1 and verifies required semantic dimensions.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu episode:qualify -- --profile mvp-smoke-v1`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `product-artifacts`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain episode.smoke --profile <profile>`; reproduce with `./shifu gate run episode.smoke` on a capable runner.
- **Cost:** heavy; timeout 900 seconds.
- **Current source:** .github/workflows/build.yml (build; alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:episode.smoke -->

<a id="episode-release"></a>
<!-- gate-doc:episode.release -->
## Episode release evidence (`episode.release`)

- **Problem:** Produces the self-contained Episode release evidence envelope.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu episode:qualify:release -- --output product/release/qualification/episode-release-evidence.json`
- **Dependencies:** `episode.smoke`.
- **Platforms and runner:** linux, macos, windows; capabilities `product-artifacts`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `product/release/qualification/episode-release-evidence.json`.
- **Diagnosis:** `./shifu gate explain episode.release --profile <profile>`; reproduce with `./shifu gate run episode.release` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/build.yml (build; alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:episode.release -->

<a id="embedding-membranes"></a>
<!-- gate-doc:embedding.membranes -->
## Embedding membrane qualification (`embedding.membranes`)

- **Problem:** Builds and runs language, storage, and libwasm membrane consumers.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu qualify:embedding-membranes`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`, `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain embedding.membranes --profile <profile>`; reproduce with `./shifu gate run embedding.membranes` on a capable runner.
- **Cost:** heavy; timeout 5400 seconds.
- **Current source:** .github/workflows/embedding-membrane-spike.yml (native-membrane; same-repo channel PR touching membrane paths).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:embedding.membranes -->

<a id="mmap-contracts"></a>
<!-- gate-doc:mmap.contracts -->
## mmap native contract tests (`mmap.contracts`)

- **Problem:** Runs yijinjing mmap and content-hash native contract binaries.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:mmap`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain mmap.contracts --profile <profile>`; reproduce with `./shifu gate run mmap.contracts` on a capable runner.
- **Cost:** heavy; timeout 1200 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:mmap.contracts -->

<a id="mmap-performance"></a>
<!-- gate-doc:mmap.performance -->
## mmap performance qualification (`mmap.performance`)

- **Problem:** Builds the evidence target and records bounded mmap measurements.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu qualify:mmap -- --profile smoke --output build/gate-artifacts/mmap-smoke.json`
- **Dependencies:** `mmap.contracts`.
- **Platforms and runner:** linux, macos; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `build/gate-artifacts/mmap-smoke.json`.
- **Diagnosis:** `./shifu gate explain mmap.performance --profile <profile>`; reproduce with `./shifu gate run mmap.performance` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:mmap.performance -->

<a id="durability-contracts"></a>
<!-- gate-doc:durability.contracts -->
## Durability contract tests (`durability.contracts`)

- **Problem:** Runs native and Python durability contracts against built Core artifacts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:durability-contract`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain durability.contracts --profile <profile>`; reproduce with `./shifu gate run durability.contracts` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:durability.contracts -->

<a id="state-service-contracts"></a>
<!-- gate-doc:state-service.contracts -->
## State service contract tests (`state-service.contracts`)

- **Problem:** Builds and runs state-service native and binding contracts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:state-service`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain state-service.contracts --profile <profile>`; reproduce with `./shifu gate run state-service.contracts` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:state-service.contracts -->

<a id="profile-suite"></a>
<!-- gate-doc:profile.suite -->
## KFX Profile Suite contracts (`profile.suite`)

- **Problem:** Runs Node and Python Profile Suite contract fixtures.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:kfx-profile-suite`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain profile.suite --profile <profile>`; reproduce with `./shifu gate run profile.suite` on a capable runner.
- **Cost:** light; timeout 900 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:profile.suite -->

<a id="profile-lifecycle"></a>
<!-- gate-doc:profile.lifecycle -->
## Profile lifecycle native tests (`profile.lifecycle`)

- **Problem:** Builds and runs the Profile lifecycle native contract target.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:profile-lifecycle`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain profile.lifecycle --profile <profile>`; reproduce with `./shifu gate run profile.lifecycle` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:profile.lifecycle -->

<a id="profile-agent-sdk"></a>
<!-- gate-doc:profile.agent-sdk -->
## Agent Profile SDK tests (`profile.agent-sdk`)

- **Problem:** Runs installed Python Agent Profile SDK and composition tests.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:agent-profile-sdk`
- **Dependencies:** `profile.lifecycle`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain profile.agent-sdk --profile <profile>`; reproduce with `./shifu gate run profile.agent-sdk` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:profile.agent-sdk -->

<a id="profile-kfd3"></a>
<!-- gate-doc:profile.kfd3 -->
## Profile KFD-3 qualification (`profile.kfd3`)

- **Problem:** Qualifies the Profile-level KFD-3 capability and evidence surface.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:profile-kfd3-qualification`
- **Dependencies:** `profile.agent-sdk`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain profile.kfd3 --profile <profile>`; reproduce with `./shifu gate run profile.kfd3` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:profile.kfd3 -->

<a id="runtime-durable-ingest"></a>
<!-- gate-doc:runtime.durable-ingest -->
## Durable ingest tests (`runtime.durable-ingest`)

- **Problem:** Builds and runs the durable-ingest native contract target.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:durable-ingest`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain runtime.durable-ingest --profile <profile>`; reproduce with `./shifu gate run runtime.durable-ingest` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:runtime.durable-ingest -->

<a id="runtime-projection-bootstrap"></a>
<!-- gate-doc:runtime.projection-bootstrap -->
## Projection bootstrap tests (`runtime.projection-bootstrap`)

- **Problem:** Builds and runs projection bootstrap recovery contracts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:projection-bootstrap`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain runtime.projection-bootstrap --profile <profile>`; reproduce with `./shifu gate run runtime.projection-bootstrap` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:runtime.projection-bootstrap -->

<a id="runtime-crash-recovery"></a>
<!-- gate-doc:runtime.crash-recovery -->
## Crash recovery tests (`runtime.crash-recovery`)

- **Problem:** Builds and runs restart, repair, and crash-recovery contracts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:crash-recovery`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain runtime.crash-recovery --profile <profile>`; reproduce with `./shifu gate run runtime.crash-recovery` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:runtime.crash-recovery -->

<a id="runtime-errors"></a>
<!-- gate-doc:runtime.errors -->
## Runtime error contract tests (`runtime.errors`)

- **Problem:** Runs native and Python runtime error contracts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu test:runtime-errors`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain runtime.errors --profile <profile>`; reproduce with `./shifu gate run runtime.errors` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:runtime.errors -->

<a id="toolchain-cpp-modules"></a>
<!-- gate-doc:toolchain.cpp-modules -->
## C++ modules qualification (`toolchain.cpp-modules`)

- **Problem:** Measures and verifies compiler module and header fallback contracts.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu qualify:cpp-modules`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain toolchain.cpp-modules --profile <profile>`; reproduce with `./shifu gate run toolchain.cpp-modules` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:toolchain.cpp-modules -->

<a id="toolchain-libwasm-cache"></a>
<!-- gate-doc:toolchain.libwasm-cache -->
## libwasm Cargo cache qualification (`toolchain.libwasm-cache`)

- **Problem:** Builds libwasm adapters twice and verifies cache reuse and equivalence.
- **Protects:** qualification regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu qualify:libwasm-cache`
- **Dependencies:** `product.distribution`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`, `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain toolchain.libwasm-cache --profile <profile>`; reproduce with `./shifu gate run toolchain.libwasm-cache` on a capable runner.
- **Cost:** heavy; timeout 3600 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:toolchain.libwasm-cache -->
