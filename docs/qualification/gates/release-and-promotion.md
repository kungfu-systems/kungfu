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
- **Current source:** .github/workflows/affected-native-pr.yml (candidate_preflight; every dev pull request and merge-group candidate before any expensive queue job); .github/workflows/adr-release-gate.yml (adr-release; dev pull request); .github/workflows/build.yml (build; alpha or release pull request).
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
- **Current source:** .github/workflows/affected-native-pr.yml (candidate_preflight; every dev pull request and merge-group candidate before any expensive queue job); .github/workflows/buildchain-validate.yml (promotion-rehearsal; pull request or channel push); .github/workflows/release-new-version.yml (promotion-contract; merged alpha or release pull request, or manual source-locked dry-run measurement).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.promotion-rehearsal -->

<a id="release-artifact-admission"></a>
<!-- gate-doc:release.artifact-admission -->
## Release artifact admission (`release.artifact-admission`)

- **Problem:** Requires build status, three platform artifacts, release passport, and KFD witnesses.
- **Protects:** release regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.buildchain.artifact-admission`; execution requires the declared remote controller capability.
- **Dependencies:** `governance.promotion-rehearsal`.
- **Platforms and runner:** linux; capabilities `buildchain-release`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain release.artifact-admission --profile <profile>`; reproduce with `./shifu gate run release.artifact-admission` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/release-new-version.yml (promote; merged alpha or release pull request, or manual source-locked dry-run measurement).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:release.artifact-admission -->

The handler executes once in the Linux promotion controller. Its admitted
payload remains cross-platform: the controller still requires exact Linux,
macOS, and Windows artifacts before the Gate passes.

### Continuity claim evidence boundary

The Agent Work contract owns three distinct validation profiles: a one-minute
continuity smoke, a matched long-task comparison, and a public animation.
Buildchain is a binding authority for evidence already produced by Kungfu
qualification, not the semantic authority for the benchmark or its verdict.

A smoke is preparatory only and cannot pass `FO10` or support a long-term or
comparative superiority claim. A public animation is a projection and must
bind an exact retained report. When release or marketing copy publishes a
comparative continuity claim, the Release Passport must bind the exact release
artifact, published copy, fixture, provider/Agent/version/configuration, latest
native baseline identity and capabilities, reset method, oracle, raw report,
public projection, limitations, and independent review.

An ordinary patch release that publishes no comparative claim does not rerun
the matched long-task comparison merely for Buildchain admission. The normal
release profile still enforces `FO9`, `FO10`, and every other applicable
blocking obligation. The executable schema and negative fixtures are in
`framework/agent-work/kungfu-agent-work-state.contract.json` and
`framework/agent-work/fixtures/continuity-evidence-cases.json`.

<a id="layers-release"></a>
<!-- gate-doc:layers.release -->
## Seven-layer publication verdict (`layers.release`)

- **Problem:** Aggregates exact three-platform qualification and public publication coordinates for all seven layers.
- **Protects:** a release from claiming seven usable layers when any exact artifact, required platform, six-budget measurement, installer-uninstall proof, or immutable public coordinate is absent.
- **Action:** `./shifu layers:qualify:release -- --evidence-root product/release/qualification/publication-set/evidence --publication-report product/release/qualification/layer-publication-report.json --report product/release/qualification/layer-release-report.json`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux; capabilities `publication-evidence`.
- **Pass:** one fail-closed seven-row verdict binds clean-source three-host reports to the exact immutable public coordinates, then emits required task evidence and a source-bound Gate receipt.
- **Failure or skip:** divergent portable reports, a missing or duplicate platform, non-numeric budget, absent uninstall proof, digest mismatch, mutable or local coordinate, missing capability, or missing evidence is non-qualifying.
- **Evidence:** required `kungfu.layer-qualification.release-gate-evidence/v1` pointers, `product/release/qualification/layer-publication-report.json`, `product/release/qualification/layer-release-report.json`, and the unified Gate receipt.
- **Diagnosis:** `./shifu gate explain layers.release --profile release-promotion`; inspect the publication report, discovered host reports, release report, and receipt without rerunning publication.
- **Cost:** light; timeout 300 seconds.
- **Current source:** .github/workflows/publish-layer-artifacts.yml (verify-publication; manually executed public layer publication)
- **Retirement:** remove only after all seven layers leave the release policy or a replacement Gate preserves exact artifacts, three-platform evidence, public-coordinate binding, and promotion-profile coverage.
<!-- /gate-doc:layers.release -->
