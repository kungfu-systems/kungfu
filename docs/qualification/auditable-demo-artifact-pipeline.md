---
metadata_schema: kungfu.document-metadata/v1
document_status: stable
period: 2026-07-25
theme: auditable-demo-artifact-pipeline
doc_type: engineering-evidence
sources: [local-files, executable-probe, official-upstream, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-27
ai_provenance: GPT-5 via Codex on 2026-07-25; based on checked-in Kungfu, Buildchain, and build-images source plus protected GitHub workflow evidence visible to this task; no production deployment or unobserved runtime is claimed
---

# Auditable Demo Artifact Pipeline

This pipeline turns one exact retained Kungfu Linux build artifact into a
small, public-safe demonstration without rebuilding the product or granting a
demo process publication authority.

The required path is:

```text
Buildchain producer-owned artifact coordinate
-> checked-in Kungfu exact-output adapter
-> exact installed `kungfu agent brief` execution
-> complete transcript + public projection + literal scene
-> Buildchain Gate and immutable renderer smoke
-> content-addressed qualified Gate bundle
-> exact Release Passport
```

Full MP4, WebM, GIF, and poster rendering is a second, selective job. It can
start only from the exact passing Gate bundle. Disabling full rendering never
disables the Gate.

## Frozen toolchain boundary

| Component | Immutable coordinate |
| --- | --- |
| Demo renderer | `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:cb5e1dec368d21c7d4e8baded99ac75f12f7eff0d19505751888cf974086efa6` |
| Renderer release | `build-images v1.3.0-alpha.16` |
| Buildchain Gate | `2123ee9c76013f09888d3a01543e66762a6b5819` (`v3.0.2-alpha.5`, auditable Demo plus Linux GitHub Artifact Attestation) |
| Consumer adapter | `scripts/auditable-demo-adapter.py` from the exact qualified Kungfu source SHA |

Buildchain's reusable build emits
`buildchain.github-artifact-coordinate-set/v1`. Kungfu accepts the Linux row
only when repository, run id, run attempt, source SHA, platform id, artifact
id, name, upload digest, URL, and expiry all match the current workflow run.
The Actions API is then used only to detect drift from that producer-owned
coordinate.

## Adapter claim boundary

The adapter opens exactly one release qualification root, rejects unsafe
archive members, validates the retained layer, live-Peer, runtime activation,
zero-burden, and invariant reports, and executes the installed archive's
declared launcher with `kungfu agent brief` in a disposable home directory.

Its public evidence class is
`exact-installed-artifact-agent-brief/v1`. It claims only that the exact
retained Linux artifact executed its installed launcher and that the resulting
transcript, projection, and scene passed the Gate. It does not claim:

- cross-run continuity;
- provider migration;
- macOS execution;
- durability or performance; or
- FO10 completion.

## Retained evidence

The Gate and optional media are ordinary GitHub Artifacts with explicit ids,
names, archive digests, URLs, roots, and expiries. A separate
`kungfu.auditable-demo.release-passport/v1` document binds those coordinates
to the exact source SHA, Buildchain SHA, renderer digest, workflow run, claim
boundary, and a canonical payload root.

## Fail-closed qualification record

The protected and manually dispatched runs were used as executable probes.
Each blocking signal was repaired at its owning boundary rather than bypassed:

- Run `30169179696` rejected a missing exact-source preflight receipt.
- Run `30169246020` exposed hosted-runner Rust mirror TLS failure.
- Run `30169439213` and run `30174217514` exposed the original package-size
  breach and then the retired `assignment` command in installed smoke.
- Run `30175240748` exposed an inherited embedded-Node variant marker.
- Run `30177108755` exposed Human and Agent help-root divergence.
- Run `30178806617` rejected an unqualified missing diagnostics field.
- Run `30180137847` reached 71 of 72 release checks and rejected
  package-manager-induced source mode drift.
- Run `30181124335` completed release qualification but was cancelled when a
  manual evidence build reached the separately governed S3 relay path.
- Run `30182763118` completed the exact build and direct GitHub Artifact
  transfer, then rejected equivalent GitHub expiry timestamps expressed with
  different fractional-second precision.
- Run `30185774420` completed the exact build, direct GitHub Artifact transfer,
  and coordinate resolution, then failed inside the required checked-in
  consumer adapter because the reusable Buildchain runtime had not bound its
  sanitized environment object to `spawnSync`.
- Run `30189805076` completed the exact Linux build and GitHub Artifact upload,
  installed and executed the retained product, then failed closed because the
  real `kungfu agent brief` stdout exceeded Buildchain's 80-line-per-cue
  projection bound.
- Run `30195697999` completed the new exact build, uploaded source artifact
  `8631822103`, verified its producer-owned digest, and then failed before
  adapter execution because the protected Buildchain v3 runtime passed an
  undefined `env` binding to `spawnSync`. Diagnostic artifact `8631839439`
  retained the failure independently from the 699 MB source payload.
- Run `30206241930` attempt 1 passed the exact-source preflight, product build,
  and full release verification, then failed closed while uploading the
  required 699 MB GitHub Artifact. The upload reported an Azure Blob
  authentication failure after 603,979,776 bytes and later progress through
  629,145,600 bytes, but no partial source artifact was admitted; the required
  Gate, selective render, and Passport therefore remained skipped.
  [Buildchain issue #1932](https://github.com/kungfu-systems/buildchain/issues/1932)
  retains the reusable upload-reliability gap, while a failed-job rerun
  preserves the same workflow run and exact source identity.
- Run `30206241930` attempt 2 successfully retained exact source artifact
  `8634682036` after the failed upload, then failed closed when the controller
  could not recover that prior-attempt artifact. The reusable workflow had
  pinned `actions/download-artifact@v7.0.0` without the explicit GitHub token
  required to enter REST mode across attempts.
  [Buildchain issue #1935](https://github.com/kungfu-systems/buildchain/issues/1935)
  retained the cross-attempt defect.
- Run `30216301917` completed exact-source preflight, the Linux build, the
  required release qualification, and same-run artifact resolution. The
  required Gate then rejected a root mismatch between the adapter bundle and
  the renderer's normalized input set before any media or Passport could be
  admitted. Diagnostic artifact `8636763753` retained the failure independently
  from the 699 MB source payload.
  [Buildchain issue #1940](https://github.com/kungfu-systems/buildchain/issues/1940)
  retained the reusable normalization defect.
- Run `30225695823` completed the exact Linux build, forced S3 relay, required
  Gate, and selective media render, then failed closed while binding the
  Release Passport. `actions/upload-artifact` exposed a raw 64-hex digest while
  the same-run Actions API exposed the equivalent canonical `sha256:<hex>`
  coordinate. [Kungfu issue #1579](https://github.com/kungfu-systems/kungfu/issues/1579)
  retained the provider-representation defect; no Passport artifact was
  admitted.

The corresponding repairs landed through independently approved protected PRs
`#1492`, `#1497`, `#1500`, `#1503`, `#1504`, `#1505`, `#1506`, `#1507`,
`#1515`, `#1529`, `#1546`, and `#1564`.
Buildchain PRs `#1875`, `#1876`, and `#1877` repaired the executable adapter
path, promoted the protected Alpha channel, and released
`v2.14.19-alpha.5`; the current protected consumer then advanced to
`v3.0.1-alpha.2`, where the same binding bug remained on the v3 line.
Buildchain PRs `#1896`, `#1898`, `#1897`, `#1900`, `#1902`, and `#1901`
ported the correction and its executable regression test to v3, closed the
protected source and version-state inputs, and released `v3.0.1-alpha.4` at
exact source `3a93cc3ce87fd8c5239c5199f705fb14b55c7808`. Kungfu PR `#1546`
then pinned that immutable release into protected source
`3c9aa7ece4f5953270d964795659957c066ec0c8`.
Buildchain PR `#1936` supplied explicit same-repository authentication to all
cross-attempt artifact downloads and added a closed-world contract test.
Protected Alpha promotion then released `v3.0.2-alpha.1` at exact tag commit
`bfe43b0fe5577f15d2af01bc542de8a8ce587457`; Kungfu PR `#1564` pinned that
release and contract digest into protected source.
Buildchain PRs `#1941`, `#1942`, `#1943`, and `#1944` aligned the Gate with the
renderer-normalized input contract, reconciled protected v3 Alpha state,
promoted the repair, and released `v3.0.2-alpha.2` at exact tag commit
`625384b4927222022a2cd0758399afbf9333ccdc`. Kungfu PR `#1571` then pinned
that immutable runtime while preserving the required Gate, selective render,
and no-production-deployment boundary.
Kungfu PR `#1581` normalized the provider-specific raw digest before the
same-run API comparison, kept malformed or genuinely mismatched coordinates
fail-closed, and passed the verified canonical API digest into the Passport.

Earlier exact-source Alpha preflight run `30205776472` initially failed only while the
macOS runner timed out downloading the pinned Rust toolchain from
`rsproxy.cn`; Linux, Windows, and all early source contracts had passed. Its
failed-job rerun retained the same run id and source SHA, then passed all three
platform probes and the aggregate exact-source receipt.

## Qualified exact-output run

Protected source `0c584fc0e6446a07a5bdb1462738ffab47dddadb` passed
three-platform exact-source Alpha preflight run
[`30230804584`](https://github.com/kungfu-systems/kungfu/actions/runs/30230804584).
Manual Build run
[`30230901970`](https://github.com/kungfu-systems/kungfu/actions/runs/30230901970)
then used Buildchain's governed `s3-to-github-artifacts` relay, completed the
Linux release build and verification, passed the required demo Gate, rendered
the selective media, and bound the Release Passport.

| Evidence | Exact coordinate | Content root |
| --- | --- | --- |
| Linux source artifact | [`8640708681`](https://github.com/kungfu-systems/kungfu/actions/runs/30230901970/artifacts/8640708681), `sha256:c7a721a54491d62edc9dcc904da27577e6366266226dc8b5b61d088d34613431` | producer-owned release artifact |
| Required Gate | [`8640731842`](https://github.com/kungfu-systems/kungfu/actions/runs/30230901970/artifacts/8640731842), `sha256:f1c4f976f149a473fc1c56a21c9b976ddecff748d591fe7d31d9eb9c33a449e4` | `sha256:7587c9bc315f49f88e11152d5387ff13a4fe606ef6ba97be8f70c5995aebf2d6` |
| Selective media | [`8640746864`](https://github.com/kungfu-systems/kungfu/actions/runs/30230901970/artifacts/8640746864), `sha256:794bf5a229311de642b3e313ecf92a31e22717239d1d3bdb95fc2058c8adeb40` | `sha256:ee95e4c65effd4edea98a4355595fe8c9eb3291f1966cb6e46f6fad6a8caab21` |
| Release Passport | [`8640755422`](https://github.com/kungfu-systems/kungfu/actions/runs/30230901970/artifacts/8640755422), `sha256:f968bc0046f529e07ca5be03da1001ffdd642a3581118ded405ed46461793a24` | `sha256:0c44a9618fd4114340ca460a6fd7e3a391ada4c7a540d76b4136c3173373391e` |

The frozen Buildchain verifier at
`625384b4927222022a2cd0758399afbf9333ccdc` independently verified the
downloaded Gate root. Every media checksum and the Kungfu Passport canonical
root also verified after each GitHub Artifact ZIP matched its Actions API
digest. The Passport limits publication to `github-artifacts-only`, records
`productionDeployment: false`, and expires with the retained Artifacts; the
committed GIF and public-evidence projection preserve the qualified,
public-safe claim without turning expiring evidence into a production
deployment claim.
