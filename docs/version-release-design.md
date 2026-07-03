# Version & Release Mechanism — Design Rationale

> Audience: maintainers evaluating, extending, or considering replacing
> this mechanism. Read this before concluding it is "legacy scaffolding".

## Why this document exists

At a glance the version/release setup looks like ordinary boilerplate: `lerna` plus a few
thin GitHub workflows that delegate to `kungfu-systems/workflows` and
`kungfu-systems/action-bump-version`. It is easy to read the code in seconds and conclude
"this is replaceable scaffolding — just swap it for changesets / semantic-release."

That conclusion is wrong, and the reason it is wrong is **not in the code** — it is in the
*orchestration intent*, which no single file reveals. This document records that intent so
the mechanism is not mistaken for replaceable boilerplate.

## Core principle: the machine fits the human

Version management here is designed around **human cognition**, not tool convenience. The
governing constraint (see the `action-bump-version` README):

> Contributors are generally not fluent with git / npm / lerna / GitHub internals. The
> pipeline must not require any of them to perform high-level tool operations. Releasing
> should be a human action that needs no scripts or commands, and version metadata must be
> maintained automatically to avoid human error.

This matters *most* precisely because the contributor pool is junior-heavy and
high-turnover — that is a reason to invest in the mechanism, not to skip it. A
declaration-based scheme would route the most judgment-heavy task (deciding the semantic
impact of a change) to the least reliable people.

## How it works (the non-obvious part)

**1. Branch channels encode version intent.** Work flows through channels
`dev → alpha → release → main` (each named `{channel}/v{major}/v{major}.{minor}`). The
*direction of a merged PR* determines the bump, automatically:

| PR merge | resulting bump |
|---|---|
| `dev → alpha` | prerelease (`x.y.z-alpha.N`) |
| `alpha → release` | patch (the formal release) |
| `release → main` | preminor (opens a new minor line + channels) |
| `main` (manual dispatch + `confirm`) | premajor |

A developer never decides "major vs minor" — the branch topology decides. **The version
judgment is hidden inside an action the developer already performs** (advancing a PR to the
next channel). No changeset files, no commit-message conventions, no manual `version`
command.

**The pipeline is asymmetric by design.** `dev` is the developer's free zone — feature
branches merge straight into `dev/v{major}/v{major}.{minor}` with no channel gate (branch
protection on `dev` requires no review). The un-cheatable trust pipeline and the
weak-centralization described below begin only at `dev → alpha`, where the first
real-binary prerelease is produced. This deliberately separates *development freedom* (fast
iteration inside dev) from *release rigor* (everything from alpha onward is gated):
**getting to the point of freezing is free; the freeze itself is strict.**

**2. The git tag is the artifact; the `package.json` version is a downstream projection.**
What carries meaning is the tag — an immutable object pinning a commit, representing "this
state is frozen and committed to." The version string inside `package.json` is merely an
npm-ecosystem projection; if it drifts it is a cosmetic mismatch, not a functional fault.

**3. A release tag carries weight = code-freeze ⊗ binary distribution, performed
atomically.** kungfu ships **prebuilt cross-platform binaries** (node-pre-gyp artifacts via
`prebuilt.libkungfu.cc`, plus the frozen `kungfu` runtime), not source for users to compile. For such
a project, a tag that does *not* guarantee the corresponding binaries are built and
distributed is an empty promise (users see `v1.0` but cannot download a `v1.0` binary). The
`alpha → release` merge therefore performs tag + full-platform build + distribution as **one
action**, so the tag has weight: *tag exists ⇒ the matching binaries exist and correspond
to it.*

> This is the key difference from source-distributed ecosystems (Go modules, Cargo /
> crates.io, Python sdist). There, "tag = frozen source" suffices because the distributed
> artifact *is* the source; they structurally never face the binary-atomicity problem.
> kungfu does, because it distributes binaries.

**4. "Worthy of being frozen" is defined by an un-cheatable pipeline, not by judgment.** A
state becomes a release only by passing the channel pipeline with machine-enforced gates
(branch protection with `isAdminEnforced=true`, not bypassable even by admins): the
three-platform `verify` (build + automated QA + code signing) is green, status checks are
strict (not stale), review is required (code-owner on the release channel), and
conversations are resolved. The mechanism deliberately makes **no judgment about whether the
code is "good"** — that is not reliably decidable, by humans or machines. It replaces an
undecidable *quality* question with a decidable *process* one: *did this state pass, without
any way to cheat, every required check?* Quality is guaranteed by the pipeline's
un-bypassability, not asserted by a person.

**5. Weak-centralization: no single point can unilaterally cut a release.** A release is the
promotion of an alpha that real users have already exercised; over the last validated alpha
the release introduces no new code (the `patch` bump only advances the version string). A
release is therefore a **consensus** produced by the pipeline (developers + real users +
three-platform build + review), not any one developer's unilateral call — which also removes
the "must not make a mistake" pressure from any individual. Developers have more say but no
unilateral authority — and that constraint deliberately includes the maintainers
themselves.

## The tag itself projects a deeper invariant: the longfist layout

Point 2 said the `package.json` version is a downstream projection of the git tag. The tag
is not the bottom of that chain. For a system whose product *is* a zero-copy, cross-language,
on-disk journal, the real compatibility contract is the **longfist binary layout** — the
in-memory and on-journal representation that C++, Python, and Node read without parsing. A
git tag, a floating channel ref, and a `package.json` version are all projections of "which
longfist layout this artifact speaks."

The two contracts fail differently. A version-string drift is cosmetic (point 2). A
longfist-layout change is not: because the layout *is* the ABI (zero-copy means the struct
memory order is the wire order), a consumer compiled against one layout cannot read another
by comparing version numbers or by feature detection — only by speaking the same layout, or
by an explicit, evolution-aware decode in a non-zero-copy path. The layout is therefore the
invariant the version machinery exists to protect; the release-line refs are how that
protection is published and audited, not the thing being protected. How that invariant may
evolve, and how old journals stay replayable, is its own decision — see
[ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md).

## Minor lines are long-lived and are never force-retired

A minor line (`v1.0`, `v1.1`, …) is not a release window that closes; it is a long-running
product train that can accrue many patches (`v1.0.0` … `v1.0.1234`). A production release
closes one patch and opens the next on the *same* line; it never means "this minor is done."
This follows from the invariant above, not from taste.

**Why the mechanism must keep every minor maintainable.** Each minor line pins a longfist
layout epoch. Because the layout is the ABI, a deployment running the `v1.0` layout cannot be
transparently migrated to a newer layout the way a source-distributed or self-describing-file
system can re-read old data: zero-copy is precisely the refusal to pay that translation on
the hot path. The consequence is structural — kungfu cannot rely on "one latest binary reads
all past layouts" for its hot path, so it must be able to keep an old layout epoch (an old
minor line) alive and patchable in parallel with newer lines. The channel topology already
provides this: each `{channel}/v{major}/v{major}.{minor}` line is an independent branch set,
so a fix on `v1.0` never has to touch `v3.x`. (The persisted/replay path bounds the cost:
there FlatBuffers' additive schema evolution lets a newer reader decode an older layout off
the hot path — see ADR-0008.)

**What the mechanism guarantees, and what it does not.** The mechanism guarantees the
*possibility* of perpetual support for any minor that still has users: it must never
*foreclose* the ability to maintain an old line. Who performs that maintenance, and whether
it is free, is a separate, allocatable question — it may be the core team under a paid
support tier, a third party, or the users themselves. The design constraint is only that the
toolchain not close that road. Keeping a minor maintainable-by-anyone requires:

- **branch isolation** — a fix on an old line does not require rebasing onto newer lines
  (satisfied by the channel topology);
- **a permissive license** — anyone holding the code may take on the burden (satisfied,
  Apache-2.0);
- **a self-consistent layout world** — a deployment on one minor is not forced to interop
  with another minor's layout (satisfied by per-minor layout pinning);
- **reproducible builds from self-archivable inputs** — an old line must still build years
  later without depending on a service that may be gone; this is the standing requirement
  behind the build mirror/cache work, and the parts that lean on third-party-controlled
  substrate (vendor SDKs, hosted runner images) are where it is only partially met;
- **no hard coupling to a kungfu-operated service** at build or run time — convenience
  artifacts (e.g. prebuilt `libnode`) must keep a documented from-source fallback so a CDN
  going away does not foreclose a self-maintainer.

This places kungfu's version strategy in the lineage of long-tail industrial maintenance
(consortium-maintained long-term kernels, distribution back-ports, paid extended support)
rather than the forced-EOL model of developer-tooling releases. The mechanism's job is to
keep that option open; it does not, by itself, decide who pays to use it.

## Why not changesets / semantic-release / standard tools

All mainstream version tools share one hidden axiom: **version intent must be explicitly
declared / translated by a human** — changeset files, `feat:` / `BREAKING CHANGE:` commit
conventions, manual keyword selection. The declaration is itself a burden, an error site,
and a training requirement. These tools are optimized for **stranger collaboration**
(open-source monorepos) where you genuinely *cannot* assume a workflow, so explicit
declaration is the only option available to them.

kungfu's context is the opposite: a controlled, channelled workflow with junior /
high-turnover contributors. Here a declaration-based tool is actively *worse* — it routes
the highest-judgment task to the least reliable people. kungfu instead **reads** intent from
the branch-flow developers already perform, requiring zero extra declaration. The value
lives in the orchestration (binary ⊗ freeze atomicity, channel-encoded intent,
weak-centralization), which a *generic, packageable* tool structurally cannot provide — a
general-purpose tool must not impose one specific workflow.

(For balance: a platform *can* absorb a thin, universal opinion — the GitHub Pull Request
itself was once exactly such an addition on top of raw git. The standing bet here is that
this orchestration is thick and workflow-specific enough to remain the project's own for a
long time. GitHub "immutable releases" — GA in 2026 — is a first step toward binding a tag
to a release, but it still leaves both the *worthiness* judgment and the *atomic production*
of binaries to the user.)

## Replacement criteria (non-goals)

Before replacing this mechanism with any "standard" tool, verify the replacement preserves
the following — most standard tools silently drop them:

1. **Binary ⊗ freeze atomicity** — a tag must still guarantee the matching prebuilt
   binaries are produced and distributed, not left to a separate, driftable step.
2. **Zero developer declaration** — version intent inferred from the workflow developers
   already perform, not hand-written per change.
3. **Un-cheatable pipeline** — release-worthiness enforced by non-bypassable gates, not by
   judgment or honor.
4. **Weak-centralization** — no single actor can unilaterally cut a release; a release is
   the promotion of a user-validated prerelease.

If a candidate cannot preserve all four, it is a downgrade for this project, however
"standard" it may be.

## Pointers

- Thin workflows:
  `.github/workflows/{bump-major-version,bump-minor-version,release-new-version,release-verify}.yml`
  → reusable workflows in `kungfu-systems/workflows`.
- Bump / release / publish logic and branch-protection setup:
  `kungfu-systems/action-bump-version` (its README documents the full channel rules and the
  original design goals).
- Build & toolchain dependencies: see [`CONTRIBUTING.md`](../CONTRIBUTING.md)
  (a dedicated source-to-binary `buildchain` doc is planned — see [`MAP.md`](MAP.md)).
- The compatibility invariant below the tag (longfist layout), its schema-evolution policy,
  and the minor-maintenance rationale:
  `framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md`.
