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
| Buildchain Gate | `3a93cc3ce87fd8c5239c5199f705fb14b55c7808` (`v3.0.1-alpha.4` immutable release tag) |
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

This document remains `draft` until a protected Kungfu source has completed a
real Gate and selective render run and the exact artifact coordinates are
projected here and into the managed README block. GitHub Artifacts are
expiring evidence, not a production media deployment.
