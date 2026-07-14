# Source, documentation, and governance gates

These gates protect source shape, contribution and ADR policy, documentation, and the control plane itself.

Each section is bound to the registry id by the catalog meta gate.

<a id="gate-catalog"></a>
<!-- gate-doc:gate.catalog -->
## Gate catalog integrity (`gate.catalog`)

- **Problem:** Keeps the registry, matrix, gate docs, task actions, and workflow bindings consistent.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:gate-catalog`
- **Dependencies:** none.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain gate.catalog --profile <profile>`; reproduce with `./shifu gate run gate.catalog` on a capable runner.
- **Cost:** light; timeout 120 seconds.
- **Current source:** .github/workflows/source-acceptance.yml (source-acceptance; dev pull request); .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/build.yml (build; alpha or release pull request); .github/workflows/release-new-version.yml (promotion-contract; merged alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:gate.catalog -->

<a id="governance-dco"></a>
<!-- gate-doc:governance.dco -->
## DCO sign-off (`governance.dco`)

- **Problem:** Rejects pull-request commits without a valid Signed-off-by trailer.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.workflow.dco`; execution requires the declared remote controller capability.
- **Dependencies:** none.
- **Platforms and runner:** linux; capabilities `github-event`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain governance.dco --profile <profile>`; reproduce with `./shifu gate run governance.dco` on a capable runner.
- **Cost:** light; timeout 120 seconds.
- **Current source:** .github/workflows/dco.yml (signoff; all pull requests).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.dco -->

<a id="governance-buildchain-config"></a>
<!-- gate-doc:governance.buildchain-config -->
## Buildchain lifecycle configuration (`governance.buildchain-config`)

- **Problem:** Validates version state and required lifecycle declarations.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.workflow.buildchain-config`; execution requires the declared remote controller capability.
- **Dependencies:** none.
- **Platforms and runner:** linux; capabilities `buildchain-cli`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain governance.buildchain-config --profile <profile>`; reproduce with `./shifu gate run governance.buildchain-config` on a capable runner.
- **Cost:** light; timeout 120 seconds.
- **Current source:** .github/workflows/buildchain-validate.yml (validate; pull request or channel push); .github/workflows/release-new-version.yml (promote; merged alpha or release pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.buildchain-config -->

<a id="source-acceptance"></a>
<!-- gate-doc:source.acceptance -->
## Build-free source acceptance (`source.acceptance`)

- **Problem:** Runs the immutable dev source gate without compiler or release lifecycles.
- **Protects:** source regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:source`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain source.acceptance --profile <profile>`; reproduce with `./shifu gate run source.acceptance` on a capable runner.
- **Cost:** light; timeout 900 seconds.
- **Current source:** .github/workflows/source-acceptance.yml (source-acceptance; dev pull request).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:source.acceptance -->

<a id="source-changed-scope"></a>
<!-- gate-doc:source.changed-scope -->
## Changed-scope developer check (`source.changed-scope`)

- **Problem:** Checks changed source plus shared contract and tooling tests.
- **Protects:** source regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain source.changed-scope --profile <profile>`; reproduce with `./shifu gate run source.changed-scope` on a capable runner.
- **Cost:** light; timeout 1200 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:source.changed-scope -->

<a id="source-whole-tree"></a>
<!-- gate-doc:source.whole-tree -->
## Whole-tree developer check (`source.whole-tree`)

- **Problem:** Runs repository-wide lint, format, Rust, contract, docs, SDK, and tooling checks.
- **Protects:** source regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:all`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`, `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain source.whole-tree --profile <profile>`; reproduce with `./shifu gate run source.whole-tree` on a capable runner.
- **Cost:** heavy; timeout 2400 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:source.whole-tree -->

<a id="docs-contracts"></a>
<!-- gate-doc:docs.contracts -->
## Documentation structure and contracts (`docs.contracts`)

- **Problem:** Checks Markdown, links, metadata, ADR projections, examples, and toolchain pins.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:check:readonly`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.contracts --profile <profile>`; reproduce with `./shifu gate run docs.contracts` on a capable runner.
- **Cost:** light; timeout 600 seconds.
- **Current source:** .github/workflows/docs-check.yml (docs-check; dev pull request touching declared documentation paths); .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/docs-external-links.yml (external-links; daily or manual).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.contracts -->

<a id="docs-prose"></a>
<!-- gate-doc:docs.prose -->
## Required documentation prose policy (`docs.prose`)

- **Problem:** Applies qualified objective prose rules that block pull requests.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:prose:required`
- **Dependencies:** `docs.contracts`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.prose --profile <profile>`; reproduce with `./shifu gate run docs.prose` on a capable runner.
- **Cost:** light; timeout 600 seconds.
- **Current source:** .github/workflows/docs-check.yml (docs-check; dev pull request touching declared documentation paths).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.prose -->

<a id="docs-external-links"></a>
<!-- gate-doc:docs.external-links -->
## External documentation links (`docs.external-links`)

- **Problem:** Checks remote URLs separately from deterministic source acceptance.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:check:external`
- **Dependencies:** `docs.contracts`.
- **Platforms and runner:** linux; capabilities `network`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.external-links --profile <profile>`; reproduce with `./shifu gate run docs.external-links` on a capable runner.
- **Cost:** light; timeout 900 seconds.
- **Current source:** .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/docs-external-links.yml (external-links; daily or manual).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.external-links -->

<a id="shifu-workspace"></a>
<!-- gate-doc:shifu.workspace -->
## Shifu workspace matrix (`shifu.workspace`)

- **Problem:** Formats, lints, tests, release-builds, and smokes Shifu on three hosted OSes.
- **Protects:** toolchain regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:shifu-workspace`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain shifu.workspace --profile <profile>`; reproduce with `./shifu gate run shifu.workspace` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/shifu-ci.yml (check; channel pull request touching crates/**).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:shifu.workspace -->
