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
last_reviewed: 2026-07-31
ai_provenance: GPT-5 via Codex on 2026-07-31; based on checked-in Kungfu, Buildchain, and build-images source plus protected GitHub workflow evidence visible to this task; this update adds the multi-demo capture-selection contract and v2 Passport projection without claiming production deployment or unobserved runtime
---

# Auditable Demo Artifact Pipeline

This pipeline turns one exact retained Kungfu Linux build artifact into a
small, public-safe demonstration without rebuilding the product or granting a
demo process publication authority.

The required path is:

```text
Buildchain producer-owned artifact coordinate
-> checked-in Kungfu exact-output adapter
-> exact installed `kungfu agent-work-lab autoplay` execution in a bounded PTY
-> bounded terminal capture + complete transcript + public projection + scene
-> Buildchain Gate and immutable terminal-replay renderer smoke
-> content-addressed qualified Gate bundle
-> exact Release Passport
```

Full MP4, WebM, GIF, and poster rendering is a second, selective job. It can
start only from the exact passing Gate bundle. Disabling full rendering never
disables the Gate.

## Multi-demo capture catalog

`framework/auditable-demo/catalog.json` is the checked-in capture-selection
contract. It declares a bounded exact argv, terminal dimensions and timeout,
completion sentinel, scene, evidence class, publication slug, claims, and
non-claims for each demo id. The adapter accepts `--demo-id ID`; omitting it
selects `agent-work-lab`, so the existing workflow and README hero remain
compatible. A manual Build workflow selects a registered command by setting
`auditable-demo-id` and enables media with `render-auditable-demo`; the workflow
passes the selected id as a literal bounded adapter argument and binds the same
id into the Release Passport.

The catalog is not a Release Passport, Work, Warrant, capability grant, or
runtime authority. Its own authority block declares an empty grant set. The
adapter executes the installed launcher with the selected argv directly,
without a shell, and the Passport binds both the complete catalog root and the
selected descriptor root. A new command is admissible only when it is
non-interactive, deterministic under the isolated environment, credential-free,
bounded to at most 60 seconds, and emits its declared completion sentinel.

Additional demos use a distinct id, evidence class, scene id, and site slug.
Exactly one catalog entry may be README-featured. Other qualified demos
materialize below
`docs/qualification/evidence/auditable-demo/<site-slug>/<passport-root>/`;
they cannot replace the README managed block.

## Frozen toolchain boundary

| Component | Immutable coordinate |
| --- | --- |
| Demo renderer | `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:06141e3d01a13e6d44766d3acc115ca07c58443f59840f313ecd938b2b0c138c` |
| Renderer release | [`v1.3.0-alpha.19`](https://github.com/kungfu-systems/build-images/releases/tag/v1.3.0-alpha.19), exact source `0dc471bfdec50e06afd12493a279d3c0056dae1f`, containing protected merge `f6bccf6ecb5753386a502a335748c6a0b1ecb7a9` |
| Buildchain Gate | `d43e6574432bc0b1ae9d1d0557f8ccc4785fa2e4` (Buildchain PR `#2092`, bounded literal multi-demo adapter arguments) |
| Consumer adapter | `scripts/auditable-demo-adapter.py` from the exact qualified Kungfu source SHA |

Buildchain's reusable build emits
`buildchain.github-artifact-coordinate-set/v1`. Kungfu accepts the Linux row
only when repository, run id, run attempt, source SHA, platform id, artifact
id, name, upload digest, URL, and expiry all match the current workflow run.
The Actions API is then used only to detect drift from that producer-owned
coordinate.

## Adapter claim boundary

The adapter opens exactly one release qualification root, rejects unsafe or
unbounded archive members, validates the retained layer, live-Peer, runtime
activation, zero-burden, and invariant reports, resolves one catalog demo, and
executes the installed archive's declared launcher with the selected exact argv
in a disposable home directory and a real catalog-bounded PTY. The default
selection remains `kungfu agent-work-lab autoplay` at `150x36`. The isolated process removes
`NO_COLOR`, sets `FORCE_COLOR=3`, and declares `TERM=xterm-256color` plus
`COLORTERM=truecolor` so the capture retains the installed TUI's ANSI styling.
The capture is limited to 60 seconds, 4 MiB, and 10,000 quantized events. A
successful result requires one valid `KUNGFU_TUI_DEMO_COMPLETE` payload and
exit status zero.

Its public evidence class is
`exact-installed-artifact-agent-work-lab-autoplay/v1`. It claims only that the
exact retained Linux artifact executed its installed autoplay command in the
bounded PTY and that the resulting capture, transcript, projection, and scene
passed the Gate. Terminal bytes remain volatile observations, not Work,
authorization, or publication authority. It does not claim:

- cross-run continuity;
- provider migration;
- macOS execution;
- durability or performance; or
- FO10 completion.

First-party identity, System identity, KFD compliance, Product System
metadata, local bundle presence, package metadata, registry history, scan
output, and standalone generation are explicitly non-authoritative. Execution
or publication authority must still come from the exact Release Passport,
Core policy, Work or Warrant, an explicit capability grant, and runtime
isolation.

## Retained evidence

The Gate and optional media are ordinary GitHub Artifacts with explicit ids,
names, archive digests, URLs, roots, and expiries. A separate
`kungfu.auditable-demo.release-passport/v2` document binds those coordinates
to the exact source SHA, Buildchain SHA, renderer digest, workflow run, selected
demo id, catalog and descriptor roots, claim boundary, and a canonical payload
root. Historical v1 public evidence remains readable; new materialization emits
`kungfu.auditable-demo.public-evidence/v2`.

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
- Run `30482879859` rejected an unsupported archive symlink before executing
  the installed Agent Work Lab autoplay command. The adapter repair admitted
  only bounded internal links, retained the closed-world member policy, and
  continued to reject absolute, escaping, dangling, special, or cyclic
  archive members.
- Run `30487194091` attempts 1 and 2 were externally cancelled while the
  self-hosted Linux runner was verifying the exact artifact. In both cases the
  runner service remained healthy and a separately governed Dev or Alpha job
  immediately occupied the shared runner. No cancelled attempt was treated as
  Gate, media, or Passport evidence.
- Run `30493581324` attempt 1 completed the GitHub-hosted exact Linux build,
  full release verification, S3 relay, and source artifact upload, then was
  externally cancelled while downstream demo jobs were still pending. Its
  failed-job rerun exposed two independent fail-closed boundaries: the demo
  resolver originally required the retained producer coordinate to come from
  the current attempt, and the separately requested Phase B consumer rejected
  an archive symlink. The resolver now admits an exact producer coordinate
  only from the same run and a positive attempt no later than the current
  attempt. Phase B remains outside the animation qualification and is disabled
  for the final autoplay evidence run.
- Run `30500101593` completed the exact GitHub-hosted Linux build, full release
  verification, S3 relay, source artifact upload, and same-run coordinate
  resolution. The required Gate then rejected the real Python terminfo symlink
  `runtime/python/share/terminfo/1/1178 -> ../a/adm1178` before execution.
  Diagnostic artifact `8744879954` retained the exact failure. The adapter now
  resolves a symlink target from its member directory, admits parent-relative
  targets only when their lexical normalization remains under the single
  archive root, and still performs a strict post-extraction root and
  regular-file check.
- Run `30505553839` attempt 1 failed closed while the exact Linux build was
  fetching the pinned Rust toolchain from `rsproxy.cn`. Attempt 2 completed the
  build, release verification, S3 relay, source artifact `8746696896`, and
  same-run coordinate resolution, then rejected the installed autoplay because
  it emitted no completion sentinel. Diagnostic artifact `8746723862`
  preserved the bounded failure independently from the 663 MB source payload.
- Run `30510623806` was cancelled before heavy qualification after a local
  installed-runtime probe proved that the canonical Agent Work Lab result is
  `qualified`, not `passed`. The adapter and its negative fixtures were
  corrected before another source-bound build was allowed to mint evidence.
- Run `30510920125` completed exact-source preflight `30510802683`, the Linux
  build, full release verification, S3 relay, source artifact `8748304680`,
  controller finalization, and same-run coordinate resolution. The required
  Gate then rejected the installed TUI before rendering because its bundle
  resolved `@kungfu-tech/core/package.json`, a workspace-only package graph
  absent from the CLI archive. Diagnostic artifact `8748335784` retained exit
  status zero and a bounded, control-code-stripped PTY tail. The TUI now treats
  its already established `KUNGFU_DIR` as the packaged runtime authority before
  consulting any source-workspace package.
- Run `30515043301` completed exact-source preflight `30514867268`, the Linux
  build, full release verification, S3 relay, source artifact `8749855057`,
  controller finalization, and same-run coordinate resolution. The required
  Gate then exposed the Linux PTY EOF convention: after the final slave closed,
  `os.read` returned `EIO` before `process.poll()` observed child exit.
  Diagnostic artifact `8749886414` retained the failure. The adapter now maps
  only `errno.EIO` at the PTY read boundary to EOF and continues to propagate
  every other I/O error.
- Run `30519116408` completed the exact Linux build, full release verification,
  S3 relay, and source artifact
  [`8752068275`](https://github.com/kungfu-systems/kungfu/actions/runs/30519116408/artifacts/8752068275)
  with Actions API digest
  `sha256:6813e8de632bda3a7645e41d92dcae3713d47eb3c6a7089b4e991dda09ac2f09`.
  The required Gate then rejected the canonical terminal completion sentinel:
  the installed Agent Work Lab autoplay correctly reported `qualified`, while
  the Buildchain validator still required `passed`. Diagnostic artifact
  [`8752121487`](https://github.com/kungfu-systems/kungfu/actions/runs/30519116408/artifacts/8752121487)
  retained that mismatch. Buildchain issue `#2057` and PR `#2059` replace that
  stale compatibility rule with the exact `qualified` contract and retain a
  negative fixture proving that `passed` is no longer accepted.
- Run `30525890727` completed exact-source preflight `30525658876`, the Linux
  build, full release verification, S3 relay, source artifact
  [`8755155597`](https://github.com/kungfu-systems/kungfu/actions/runs/30525890727/artifacts/8755155597),
  and the required Gate. The Gate retained artifact
  [`8755230406`](https://github.com/kungfu-systems/kungfu/actions/runs/30525890727/artifacts/8755230406)
  with Actions API digest
  `sha256:4dce3d82e90801048e2c3014f4d9a086d81d5213cd6494d4ac075b8ab7cf74d1`
  and canonical root
  `sha256:393366f8598963f15590ea3b73d3703520edb259a7060edd7727b28928e0d61b`.
  Selective rendering then failed closed because the independently released
  renderer still required the retired `passed` sentinel. Build-images issue
  `#331` and PRs `#332`, `#333`, and `#334` aligned the renderer and its
  negative fixture, promoted the repair, and finalized
  `v1.3.0-alpha.18`; the immutable digest above is the qualified replacement.

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

## Current qualified Agent Work Lab autoplay run

Protected source `b48d30166e26dfceb873d1057e1db3c3e00c3385` passed
four-platform exact-source Alpha preflight run
[`30536447336`](https://github.com/kungfu-systems/kungfu/actions/runs/30536447336).
Manual Build run
[`30536659808`](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808)
then used exact Buildchain source
`3272608ba28ef714fe710dd8da99d00fdeb4c619`, completed the Linux release
build and full verification, transferred the payload through the governed S3
relay, passed the required Agent Work Lab autoplay Gate, rendered the selective
media with the immutable renderer above, and bound one Release Passport.

| Evidence | Exact coordinate | Content root |
| --- | --- | --- |
| Linux source artifact | [`8759349858`](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759349858), `sha256:90beda7586eac4dc0745f20e98d6f9b694b237fe159f81b45a316f3fe3645612` | producer-owned release artifact |
| Required Gate | [`8759425334`](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759425334), `sha256:44f9b3ec57447b8c6f5e314945791a97de52f176fbd1e1724ad1e9af6e8d6bf9` | `sha256:31a259eccd3a4f093eaad2be01bc6def399b1653a010a6949c0bf8fa903bd54b` |
| Selective media | [`8759470968`](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759470968), `sha256:92ca003632a2c0fdc2584d2d6ec928f4ced045a58a30400f792dfb0da1bc51d4` | `sha256:7fafb048c7133291602643beeb702bea58763863e533d696d6bc962f66e5981b` |
| Release Passport | [`8759489175`](https://github.com/kungfu-systems/kungfu/actions/runs/30536659808/artifacts/8759489175), `sha256:72c1169f8d21e2ad5c2975507e14990b552a2419961e56883f231e6e0c0172f8` | `sha256:0ff4cc1ef018544ad752eb08cf2fec205fe8d1bbedeb41b0111566732919b5e7` |

The downloaded Gate, media, and Passport ZIPs matched their Actions API
digests. Every Gate and media member matched its retained checksum; the Gate
and media checksum-file roots matched the Passport; and the Passport canonical
payload root independently verified. The committed README GIF and public
evidence projection were materialized only from those verified bytes. The
Passport grants no execution or publication authority from first-party or
System identity, KFD compliance, Product System metadata, package metadata,
registry history, scan output, or standalone generation, and records
`productionDeployment: false`.

## Historical qualified exact-output run

The following retained run proves the earlier
`exact-installed-artifact-agent-brief/v1` evidence class. It is preserved for
rollback and audit, but it does not qualify the Agent Work Lab autoplay
animation and cannot update the new README or site projection.

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
