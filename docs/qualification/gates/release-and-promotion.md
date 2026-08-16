# Release and promotion gates

These gates admit a change or artifact to a channel. Publication and tag mutation are release actions, not Gate actions.

Each section is bound to the registry id by the catalog meta gate.

## Required development delivery Warrant

Targeted development delivery is two-phase. Source acceptance and the
base-independent affected-closure descriptor run first. Once the exact PR head
is ready and approved, Buildchain may select it for a TTL-bounded
**provisional** Warrant with a fencing token. Other PRs continue source work and
CI, but they cannot acquire queue admission ahead of that active Warrant.

Only the provisional owner runs the expensive native command. Buildchain
composes the immutable PR head with the current protected dev head, heartbeats
the lease while Kungfu runs both affected-native partitions and any selected
SDK, Shifu-workspace, or KFD gates, and fails closed on source drift, conflicts,
heartbeat loss, cancellation, timeout, or native failure. A successful command
publishes the existing `affected-native / linux` required context for that exact
source head; Buildchain then atomically binds its native proof and upgrades the
same fenced generation to a **qualified** Warrant before entering GitHub's merge
queue. `Queue admission lease` remains non-successful until that upgrade.

The proof identity is bound to semantic source, affected closure, dependency
graph, toolchain, and shard evidence. Dev-base or replay movement is classified
separately: a graph-known non-overlapping delta reuses the proof, while overlap
or an unknown graph triggers a bounded fresh native attempt. The merge-group
workflow independently requires the qualified Warrant and revalidates or reuses
the exact source-bound proof against its replay. A protected terminal workflow
closes the Warrant after an authoritative merge, cancellation, failure, or
supersession. A transient dequeue cannot close a fresh live holder, and a later
candidate remains queued. Expired holders are retained behind their exact fence
until the old worker is proven stopped and that generation is settled; only
then may the next deterministic candidate be selected.

`workflow_run`, ready-label, and review events recover targeted delivery. An
executing targeted manual dispatch uses the same required path; dry-run manual
dispatch and cadence patrol remain outside Warrant mutation.

This mechanism grants neither approval nor publication authority and does not
weaken branch protection or enable paid runner campaigns. Shared AWS Windows Burst and macOS campaigns remain
separately governed and disabled unless explicitly activated by their own
resource authority.

## Exact-source Alpha preflight

Every push to the development channel produces a four-platform
`kungfu.alpha-promotion-preflight-receipt/v1` before an immutable Alpha pull
request can enter the expensive Buildchain, embedding, or Shifu matrices. The
aggregate receipt binds the exact commit and Git tree plus the relevant
workflow, Gate, toolchain, and policy roots. A seven-day age limit and any root
drift fail closed.

Receipt reuse is deliberately narrow: it admits only source and early platform
probes. Signing, notarization, credentials, publication, release artifacts, and
the full product qualification remain fresh. Required promotion matrices use
fail-fast and cancel stale runs for the same pull request. The manual Build
workflow and preflight workflow expose an explicit diagnostic mode that keeps
all platform lanes running.

### Topology-independent candidate provenance

The candidate provenance v2 object accepts zero or more observed Git parents.
Its semantic root binds an algorithm-tagged transport-neutral content root and
explicit `derived-from`, `acknowledges`, `has-content`, `qualified-by`,
`approved-by`, `authorized-by`, and `implements-contract` relations. Git commit
and tree OIDs and any parent sequence are retained in a separately rooted
`projected-as` observation; they cannot supply or override those semantic roots.

The v1 reader remains fail-closed and byte-compatible. Migration never rewrites
the predecessor: it emits one independently verifiable v2 successor, a rooted
`succeeds` relation, and a migration receipt binding both object and projection
roots. This producer/API stage grants no publication or admission-default
authority and does not change release workflow topology.

### Fresh GitHub-hosted functional matrix

Formal Alpha and Release candidates execute credential-free Linux x64, Linux
ARM64, macOS ARM64, and Windows x64 build and qualification lanes on the fixed
GitHub-hosted images `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, and
`windows-2022`. Each candidate therefore starts from an isolated workspace;
self-hosted workspace history, retained toolchains, and runner inventory state
cannot alter formal release routing or qualification prerequisites.
Formal lanes fetch the immutable source directly from GitHub instead of probing
LAN or runner-local mirrors that are unreachable from hosted infrastructure.
They also omit organization-level private Cargo registries and remote Shifu
cache profiles; public/default dependency endpoints and checked-in portable
profiles are the only inputs allowed on the formal hosted boundary.

Buildchain still seals exact-source unsigned artifacts and detached signing
requests in the functional matrix. Signing and notarization execute only in
their protected credential authority, while finalization, publication, and
activation independently verify the returned source-bound receipts. Moving
the functional matrix does not move credentials or collapse those authorities.

The exact-source Dev Verify that Candidate Patrol consumes uses the same fresh
hosted Linux x64, macOS ARM64, and Windows x64 boundary, so an offline
self-hosted diagnostic runner cannot prevent creation of the next Alpha
candidate. The version-line projection still retains the exact-label
self-hosted platform matrix for explicit diagnostics. The manual macOS
overflow controller also retains its independent self-hosted and GitHub-hosted
candidate identities, always with `publish-channel: none`; neither path is the
default formal Alpha route. Explicit self-hosted or custom diagnostics may
still opt into the bounded checkout-cache policy and private acceleration
variables.

### Queue-aware macOS overflow

The manual `Alpha macOS queue-aware overflow` controller keeps the self-hosted
macOS ARM64 lane as the primary hot-cache route and starts a GitHub-hosted
candidate only when one of four source-bound conditions holds:

- a trusted repository runner inventory observation reports no exact-label
  self-hosted runner online;
- the retained self-hosted workspace contains an existing signing-result import
  destination that would make the Buildchain import non-idempotent;
- the observed macOS queue exceeds the initial 25-minute budget; or
- a supplied predicted remaining queue exceeds that budget and is accompanied
  by an exact `sha256` prediction root.

The two candidates have independent concurrency identities and both run the
same exact source SHA with the same exact Alpha preflight receipt. They are
build-and-verify candidates only: `publish-channel` is always `none` and no
release-candidate passport is requested. Any declared signing request remains
owned by Buildchain's protected authority; Kungfu has no caller-owned signing
tail. The existing Alpha promotion workflow remains the only publication
authority.

The runner-inventory credential is projected only into the protected
default-branch controller invocation. Before using it, the controller action
checks that the checked-out source is clean and exactly equals the workflow
SHA. Candidate and review-ref invocations receive no inventory credential, and
the receipt retains only the de-identified observation. An online runner
remains online while busy, so ordinary contention still uses the queue
threshold. Missing permissions or an unavailable inventory API cannot assert
an outage and therefore falls back to the existing queue policy.

After overflow, the controller may cancel the self-hosted candidate only while
its platform job is still queued and only after the hosted platform job exposes
a real runner name. A self-hosted platform job that has acquired a runner is
allowed to finish. The final
`kungfu.alpha-macos-overflow-receipt/v1` records source and preflight identity,
queue and acquisition times, runner labels, workspace-health result, fallback
reason, candidate conclusions, cancellation ordering, and the selected
publish-none winner. Diagnostic mode may shorten the threshold or force an
unhealthy fixture for bounded workflow qualification; production dispatches
retain the 25-minute default.

<a id="governance-adr-delivery"></a>
<!-- gate-doc:governance.adr-delivery -->
## ADR delivery admissibility (`governance.adr-delivery`)

- **Problem:** Checks the applicable ADR delivery and promotion declaration.
- **Protects:** release regressions or due, invalid, or unexplained deprecation debt from becoming an unexplained green profile or release claim.
- **Action:** `./shifu adr:release:gate -- --allow-non-pr --github-event --report product/release/qualification/adr-release-admissibility.json`
- **Dependencies:** none.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, the deprecation registry is valid, applicable protected candidates have no unresolved due entry, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; artifacts `product/release/qualification/adr-release-admissibility.json`.
- **Diagnosis:** `./shifu gate explain governance.adr-delivery --profile <profile>`; reproduce with `./shifu gate run governance.adr-delivery` on a capable runner.
- **Cost:** light; timeout 180 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (candidate_preflight; every dev pull request and merge-group candidate before any expensive queue job); .github/workflows/build.yml (build; alpha or release pull request, or a manual exact-source publish-none macOS candidate under the queue-aware overflow controller). The standalone .github/workflows/adr-release-gate.yml remains manual-only diagnostic evidence.
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
- **Current source:** .github/workflows/affected-native-pr.yml (candidate_preflight; every dev pull request and merge-group candidate before any expensive queue job); .github/workflows/buildchain-validate.yml (promotion-rehearsal; pull requests except dev/v*/v*, or alpha/release channel push); .github/workflows/release-new-version.yml (promotion-contract; merged alpha or release pull request, or manual source-locked dry-run measurement).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.promotion-rehearsal -->

<a id="release-artifact-admission"></a>
<!-- gate-doc:release.artifact-admission -->
## Release artifact admission (`release.artifact-admission`)

- **Problem:** Requires build status, three full-product platform payloads, one exact Linux ARM64 Core payload, one authoritative signed and notarized macOS credential-island payload, release passport, and KFD witnesses.
- **Protects:** release regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.buildchain.artifact-admission`; execution requires the declared remote controller capability.
- **Dependencies:** `governance.promotion-rehearsal`.
- **Platforms and runner:** linux; capabilities `buildchain-release`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain release.artifact-admission --profile <profile>`; reproduce with `./shifu gate run release.artifact-admission` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/release-new-version.yml (promote; merged alpha or release pull request, or manual source-locked dry-run measurement); .github/workflows/release-new-version.yml (recover; manual recovery of one verified sealed Alpha candidate without product rebuild).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:release.artifact-admission -->

### GitHub product discovery metadata gate

GitHub Release presentation metadata is not the Alpha maturity authority.
SemVer, the protected channel, catalog, Release Passport, compatibility and
support documents retain that role. All public Kungfu product releases,
including `vX.Y.Z-alpha.N`, must read back as `draft=false` and
`prerelease=false`, and the publication operation must explicitly make the
product GitHub Latest. Shifu, Xinfa, and other component-tag publication paths
must explicitly opt out with `make_latest=false` (the `gh` CLI spelling is
`--latest=false`).

After a real product promotion, `.github/workflows/release-new-version.yml`
runs `./shifu release:github:latest:verify`. The gate implemented by
`scripts/github-release-policy.mjs` enumerates public product releases and
requires `/releases/latest` to identify the newest one. It then follows
`/releases/latest/download/buildchain.release.json`, requires its first bounded
redirect to equal the selected release asset URL, and validates the Publication
Bundle's Kungfu product repository, product name, exact tag/ref/version, and
retained Alpha or release channel. The gate is read-only; a missing or
component-owned Latest pointer, an unexpected redirect, duplicate/missing
bundle, or identity drift is non-qualifying.

The handler executes once in the Linux promotion controller. Its admitted
payload remains cross-platform: the controller still requires exact Linux x64,
Linux ARM64 Core, macOS ARM64, and Windows x64 artifacts before the Gate passes. It separately
requires the source-bound macOS credential-island DMG, ZIP, and accepted
signing/notarization evidence; the signing credentials never enter a functional
build runner.

### One-command update claim evidence boundary

Before custom publish evidence is written, Kungfu admission reads every
downloaded platform payload and the exact Buildchain release-candidate passport.
For each advertised update tuple it requires a fresh native-packaged
previous-public-to-candidate campaign whose canonical root binds the one
`kungfu update` invocation, channel and passport roots, source and artifact
identity, local install-source owner, final receipt and version, `kungfu run
agent`, activation behavior, public documentation, and every required ordinary
fault.

The custom publish evidence embeds the admitted campaign roots, channel-index
roots, recomputed release-passport root, and bounded campaign summaries for the
Release Passport. Missing or stale evidence, source/platform/owner/root drift,
source-fixture or simulated evidence, incomplete smoke/fault/docs coverage, or
power-loss/tamper/uninterrupted-work overclaims are non-qualifying. Archive and
Homebrew source fixtures exercise mechanics, but cannot advertise an official
channel or Formula.

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
- **Diagnosis:** `./shifu gate explain layers.release`; inspect the publication report, discovered host reports, release report, and receipt without rerunning publication.
- **Cost:** light; timeout 300 seconds.
- **Current source:** .github/workflows/publish-layer-artifacts.yml (verify-publication; manually executed public layer publication)
- **Retirement:** remove only after all seven layers leave the layer-publication policy or a replacement Gate preserves exact artifacts, three-platform evidence, and public-coordinate binding. This post-publication Gate is deliberately outside the pre-publication product `release-promotion` profile.
<!-- /gate-doc:layers.release -->
