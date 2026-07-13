# Release and promotion gates

These gates admit a change or artifact to a channel. Publication and tag mutation are release actions, not Gate actions.

Each section is bound to the registry id by the catalog meta gate.

<a id="governance-adr-delivery"></a>
<!-- gate-doc:governance.adr-delivery -->
## ADR delivery admissibility (`governance.adr-delivery`)

- **Problem:** Checks the applicable ADR delivery and promotion declaration.
- **Protects:** release regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu adr:release:gate -- --allow-non-pr --github-event --report product/release/qualification/adr-release-admissibility.json`
- **Dependencies:** none.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `product/release/qualification/adr-release-admissibility.json`.
- **Diagnosis:** `./shifu gate explain governance.adr-delivery --profile <profile>`; reproduce with `./shifu gate run governance.adr-delivery` on a capable runner.
- **Cost:** light; timeout 180 seconds.
- **Current source:** .github/workflows/adr-release-gate.yml (adr-release; dev pull request); .github/workflows/build.yml (build; alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.adr-delivery -->

<a id="governance-promotion-rehearsal"></a>
<!-- gate-doc:governance.promotion-rehearsal -->
## Promotion contract rehearsal (`governance.promotion-rehearsal`)

- **Problem:** Rehearses alpha and stable promotion admission without publishing.
- **Protects:** release regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu release:promotion:rehearse -- --github-event --report product/release/qualification/release-promotion-rehearsal.json`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `product/release/qualification/release-promotion-rehearsal.json`.
- **Diagnosis:** `./shifu gate explain governance.promotion-rehearsal --profile <profile>`; reproduce with `./shifu gate run governance.promotion-rehearsal` on a capable runner.
- **Cost:** light; timeout 180 seconds.
- **Current source:** .github/workflows/buildchain-validate.yml (promotion-rehearsal; pull request or channel push); .github/workflows/release-new-version.yml (promotion-contract; merged alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.promotion-rehearsal -->

<a id="release-artifact-admission"></a>
<!-- gate-doc:release.artifact-admission -->
## Release artifact admission (`release.artifact-admission`)

- **Problem:** Requires build status, three platform artifacts, release passport, and KFD witnesses.
- **Protects:** release regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.buildchain.artifact-admission`; execution requires the declared remote controller capability.
- **Dependencies:** `governance.promotion-rehearsal`.
- **Platforms and runner:** linux, macos, windows; capabilities `buildchain-release`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain release.artifact-admission --profile <profile>`; reproduce with `./shifu gate run release.artifact-admission` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/release-new-version.yml (promote; merged alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:release.artifact-admission -->
