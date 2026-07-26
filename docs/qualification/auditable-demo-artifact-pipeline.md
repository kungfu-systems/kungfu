---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-07-25
theme: auditable-demo-artifact-pipeline
doc_type: engineering-evidence
sources: [local-files, executable-probe, official-upstream, user-consensus]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-25
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
| Buildchain Gate | `3a93cc3ce87fd8c5239c5199f705fb14b55c7808` (`v3.0.1-alpha.4` protected release source) |
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

The corresponding repairs landed through independently approved protected PRs
`#1492`, `#1497`, `#1500`, `#1503`, `#1504`, `#1505`, `#1506`, `#1507`,
`#1515`, `#1529`, and `#1546`.
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

Exact-source Alpha preflight run `30205776472` initially failed only while the
macOS runner timed out downloading the pinned Rust toolchain from
`rsproxy.cn`; Linux, Windows, and all early source contracts had passed. Its
failed-job rerun retained the same run id and source SHA, then passed all three
platform probes and the aggregate exact-source receipt.

The final qualified run below must use direct GitHub Artifact transfer and
contains no production deployment step.

This document remains `draft` until a protected Kungfu source has completed a
real Gate and selective render run and the exact artifact coordinates are
projected here and into the managed README block. GitHub Artifacts are
expiring evidence, not a production media deployment.
