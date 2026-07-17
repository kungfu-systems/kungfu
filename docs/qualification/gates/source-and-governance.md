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
- **Current source:** .github/workflows/source-acceptance.yml (source-acceptance; dev pull request); .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/build.yml (build; alpha or release pull request); .github/workflows/release-new-version.yml (promotion-contract; merged alpha or release pull request, or manual source-locked dry-run measurement).
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
- **Current source:** .github/workflows/buildchain-validate.yml (validate; pull request or channel push); .github/workflows/release-new-version.yml (promote; merged alpha or release pull request, or manual source-locked dry-run measurement).
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
## Affected Core native developer check (`source.changed-scope`)

- **Problem:** Resolves changed Core paths through the architecture authority and compiles, links, and tests the bounded native impact closure.
- **Protects:** template instantiation, link, public-header propagation and
  native contract regressions that the deliberately build-free source gate
  cannot observe.
- **Action:** `./shifu core:affected -- --execute`
- **Dependencies:** `gate.catalog`, `source.acceptance`.
- **Platforms and runner:** linux; capabilities `native-toolchain`.
- **Pass:** the resolver validates the authority, selects a supported minimal
  profile, and the selected configure/compile/link/CTest closure passes.
- **Failure or skip:** unclassified Core files, missing target/test evidence,
  stale authority, unsupported profiles, native failures, timeout or receipt
  drift are non-qualifying. A planner error never means "no native impact".
- **Evidence:** the unified Gate receipt plus
  `kungfu.core-affected-native-receipt/v1` and raw per-step logs under
  `product/qualification/affected-native/`. The receipt binds exact source,
  architecture digests, toolchain, targets/tests, duration and honest cache
  facts. The retained `kungfu.core-affected-native-plan/v1` is created before
  dependency bootstrap; execution rejects a different source HEAD, authority
  digest, or plan digest.
- **Portable cache:** native plans produce separate Buildchain
  `buildchain.portable-dev-cache-manifest/v1` dependency and compiler layers.
  Pinned Actions cache restore/save only transports the declared roots;
  Buildchain owns exact keys, compatible restore prefixes, and receipts. The
  exact root binds source and plan while compatibility also requires the same
  hosted image, platform/architecture, toolchain, lock set, profile, and roots.
  Exact or compatible restores still run the current configure/build/CTest
  closure. Misses run and record the cold path; per-run ccache statistics are
  retained beside the provider receipts so an exact restore cannot be confused
  with effective compiler hits. The dev-only affected-native configure disables
  C++ module dependency scanning because the current closure declares no module
  sources; this avoids uncached scan work without changing alpha/release build
  semantics. Contradictory or foreign-key evidence fails closed. Successful
  native changes on `dev/v*/v*` also run this exact job after merge, placing a
  compatible baseline in the base-branch cache scope. Pull-request and current
  default-branch merge-group refs can restore that baseline while retaining
  source-bound exact keys and always rerunning configure/build/CTest. PR-scoped
  saves remain useful for same-PR reruns but are not treated as merge-queue
  baselines.
- **Diagnosis:** inspect without building with `./shifu core:affected -- --base
  <base> --head <head> --json`; run mutation fixtures with `./shifu
  core:affected -- --self-test`.
- **Cost:** heavy; timeout 1500 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (affected-native; every development pull request and merge group, plus post-merge dev pushes that seed the base-branch cache scope; outside-Core changes produce a passed tier-none receipt so the required check never deadlocks)
- **Source-first orchestration:** the workflow first runs the build-free source
  planner with `node scripts/run-core-affected-native.mjs --plan-out <path>
  --json`. A non-empty, source-bound plan then enters the registered action; a
  tier-none plan writes the same receipt directly without installing
  Buildchain, Conan, or the workspace.
- **Retirement:** remove only with a replacement that consumes the same
  architecture authority and preserves changed-path completeness, raw native
  evidence and the alpha/release responsibility split.
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
- **Platforms and runner:** linux; capabilities `docker`, `node`.
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
