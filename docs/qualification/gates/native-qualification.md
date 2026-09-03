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
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:layers.contract -->

<a id="layers-format"></a>
<!-- gate-doc:layers.format -->
## Portable format artifact qualification (`layers.format`)

- **Problem:** Packs and qualifies the exact portable format specification artifact.
- **Protects:** a source-level format claim from passing while the archive actually shipped to users is stale, oversized, or incomplete.
- **Action:** `./shifu layers:gate:format`
- **Dependencies:** `layers.contract`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the exact packed format artifact passes all six numeric budgets and writes both its qualification report and required task evidence.
- **Failure or skip:** pack, qualification, dependency, capability, artifact, or task-evidence failure is non-qualifying; an explicit Gate run remains diagnostic rather than promotion authorization.
- **Evidence:** unified source-bound Gate receipt, required `kungfu.layer-qualification.gate-evidence/v1` pointers, and `product/release/qualification/layer-format-report.json`.
- **Diagnosis:** `./shifu gate explain layers.format --profile alpha-pr`; plan with `./shifu gate plan alpha-pr --platform <platform>` before reproducing on a capable host.
- **Cost:** heavy; timeout 900 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation)
- **Retirement:** remove only after the portable artifact is retired or a replacement Gate preserves exact archive, budget, report, profile, and workflow-binding coverage.
<!-- /gate-doc:layers.format -->

<a id="layers-sdk"></a>
<!-- gate-doc:layers.sdk -->
## SDK artifact qualification (`layers.sdk`)

- **Problem:** Packs and qualifies exact Python, npm, and Cargo SDK artifacts.
- **Protects:** SDK source tests from masking broken wheels, npm archives, Cargo crates, dependency closure, or platform-specific installability.
- **Action:** `./shifu layers:gate:sdk`
- **Dependencies:** `layers.contract`.
- **Platforms and runner:** linux, macos, windows; capabilities `native-toolchain`, `product-artifacts`, `rust`.
- **Pass:** every exact SDK archive passes install, smoke, independence, and six-budget qualification and produces required task evidence.
- **Failure or skip:** any missing platform artifact, unavailable required capability, stale archive, budget failure, or missing evidence is non-qualifying.
- **Evidence:** unified source-bound Gate receipt, required `kungfu.layer-qualification.gate-evidence/v1` pointers, and `product/release/qualification/layer-sdk-report.json` per platform.
- **Diagnosis:** `./shifu gate explain layers.sdk --profile alpha-pr`; plan with `./shifu gate plan alpha-pr --platform <platform>` before reproducing on a capable host.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation)
- **Retirement:** remove only after all SDK delivery surfaces are retired or a replacement Gate preserves exact archives, install smokes, budgets, platform coverage, and receipts.
<!-- /gate-doc:layers.sdk -->

<a id="layers-surfaces"></a>
<!-- gate-doc:layers.surfaces -->
## Product surface artifact qualification (`layers.surfaces`)

- **Problem:** Qualifies exact CLI, GUI, and assembled distribution artifacts.
- **Protects:** product entrypoints from being declared usable when their exact bundles, installers, or uninstall paths fail on a supported host.
- **Action:** `./shifu layers:gate:surfaces`
- **Dependencies:** `layers.contract`.
- **Platforms and runner:** linux, macos, windows; capabilities `product-artifacts`.
- **Pass:** the exact CLI, GUI, and assembled distribution pass independence, six-budget, installer, and uninstall qualification with required task evidence.
- **Failure or skip:** any missing product surface, platform report, installer-uninstall proof, budget, or evidence pointer is non-qualifying.
- **Evidence:** unified source-bound Gate receipt, required `kungfu.layer-qualification.gate-evidence/v1` pointers, and `product/release/qualification/layer-surface-report.json` per platform.
- **Diagnosis:** `./shifu gate explain layers.surfaces --profile alpha-pr`; plan with `./shifu gate plan alpha-pr --platform <platform>` before reproducing on a capable host.
- **Cost:** heavy; timeout 900 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation)
- **Retirement:** remove only after all three product surfaces are retired or a replacement Gate preserves exact bundles, installer-uninstall proof, budgets, platform coverage, and receipts.
<!-- /gate-doc:layers.surfaces -->

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
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation); .github/workflows/linux-arm64-alpha-qualification.yml (artifact; alpha or release pull request, or isolated manual Linux ARM64 qualification)
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
- **Cost:** heavy; timeout 64800 seconds.
- **Current source:** .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation); .github/workflows/linux-arm64-alpha-qualification.yml (artifact; alpha or release pull request, or isolated manual Linux ARM64 qualification)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:episode.release -->

The registered action remains the conservative `mvp-baseline-v1` default for
manual Gate runs. The Build workflow selects a checked-in execution profile
from [`execution-profiles.json`](execution-profiles.json): alpha uses
`mvp-smoke-v1`, release-candidate uses `mvp-candidate-v1`, and full-patrol keeps
the complete baseline. The unified layer receipt records the selected profile,
effective ceilings, reserve, fuzz duration, and policy digest.

The dedicated native Linux ARM64 Hub CLI lane selects the explicit
`hub-cli` artifact scope. It retains source fuzzing, live-Peer and runtime
activation, Episode and ADR evidence, portable-format qualification, and
source/native/runtime invariants. Desktop zero-burden evidence, assembled
desktop surfaces, and cross-language SDK packages remain owned by the full
Product matrix; their absence from a headless-only runner is not converted
into a false product failure or a product-wide qualification claim.

The standalone Gate ceilings cover their complete declared actions rather than
the shorter profile-specific reuse path: the smoke ceiling includes all four
contention widths, while the release ceiling matches the checked-in
`full-patrol` Episode ceiling. These budgets do not reduce seeds, checkpoints,
workers, platform coverage, or correctness assertions.

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
