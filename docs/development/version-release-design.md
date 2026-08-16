# Version & Release Mechanism — Design Rationale

> Audience: maintainers evaluating, extending, or considering replacing
> this mechanism. Read this before concluding it is "legacy scaffolding".

## Why this document exists

At a glance the version/release setup looks like ordinary boilerplate: `lerna` plus a few
thin GitHub workflows that delegate release-candidate build and promotion to Buildchain.
It is easy to read the code in seconds and conclude "this is replaceable scaffolding —
just swap it for changesets / semantic-release."

That conclusion is wrong, and the reason it is wrong is **not in the code** — it is in the
*orchestration intent*, which no single file reveals. This document records that intent so
the mechanism is not mistaken for replaceable boilerplate.

## Core principle: the machine fits the human

Version management here is designed around **human cognition**, not tool convenience. The
governing constraint inherited from the original channel-based release machinery is:

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

### Product maturity and GitHub discovery are separate axes

Three independent values must not be collapsed into one boolean:

1. **Product maturity and prerelease channel** come from the SemVer tag (for
   example `v4.0.0-alpha.2`), the protected `alpha` channel, catalog entries,
   Release Passport, compatibility promises, support matrix, and public risk
   documentation. An Alpha remains an Alpha at all of those authorities.
2. **GitHub `prerelease` metadata** is a repository-host presentation field.
   Every public Kungfu product release, including an Alpha, is deliberately
   published with `draft=false` and `prerelease=false`. This value is not a
   maturity claim and does not weaken an Alpha warning or support boundary.
3. **GitHub Latest** is the discovery pointer used by `/releases/latest` and
   `/releases/latest/download/...`. Every Kungfu product publication explicitly
   sets `make_latest=true`. Native component tags such as `shifu-v*` and
   `xinfa-v*` explicitly set `make_latest=false`; they are independently
   installable components, not the repository's product discovery authority.

The publication tail normalizes Alpha product metadata inside the same final
publication-commit command that binds the public authority. A read-only gate
then requires `/releases/latest` to name the newest public Kungfu product and
requires `/releases/latest/download/buildchain.release.json` to resolve to that
release's exact Publication Bundle. A component release, a missing bundle, a
redirect to another tag, or mismatched product/tag/channel fields fails closed.

**The pipeline is asymmetric by design.** `dev` remains the fast integration
zone: it runs a lightweight source and ADR-delivery gate rather than the full
release build across three full-product platforms plus a bounded Linux ARM64
Core lane. Feature PRs must nevertheless arrive in a bounded
state (`stage-ready` or an `implemented` candidate); ordinary non-architecture
fixes use an explicit ADR-neutral path. The expensive, un-cheatable trust
pipeline and weak-centralization described below begin at `dev → alpha`, where
the first real-binary prerelease is produced. This separates *fast development
integration* from *release qualification* without allowing half-described
architecture work to accumulate silently. The same light gate validates the
common deprecation authority on `dev`; protected Alpha and stable candidates
also fail when an applicable entry is removal-due without qualified removal,
restored support, or one exact bounded Warrant. See
[`deprecation-lifecycle.md`](deprecation-lifecycle.md).

**2. The git tag is the artifact; the `package.json` version is a downstream projection.**
What carries meaning is the tag — an immutable object pinning a commit, representing "this
state is frozen and committed to." The version string inside `package.json` is merely an
npm-ecosystem projection; if it drifts it is a cosmetic mismatch, not a functional fault.

The tag is also a transport coordinate, not the semantic identity of candidate
history. The versioned release-provenance contract roots source content with an
explicit algorithm and relates the candidate to its development Cut, prior Alpha,
qualification, approval, and authority Facts. Exact commit, tree, ancestry, parent
count, and parent order remain independently rooted observations. Merge, linear,
flattened, reordered-parent, and ff-only delivery therefore cannot silently rewrite
the declared history. Historical v1 objects retain their original roots and verifier;
v1-to-v2 migration appends an explicit `succeeds` relation and rooted receipt.

**3. A release tag carries weight = code-freeze ⊗ binary distribution, performed
atomically.** kungfu ships **prebuilt cross-platform binaries** (node-pre-gyp artifacts via
`prebuilt.libkungfu.cc`, plus the assembled `kungfu` runtime), not source for users to compile. For such
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
native release `verify` (three full-product builds, the Linux ARM64 Core lane,
automated QA, and code signing) is green, status checks are
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
native release build + review), not any one developer's unilateral call — which also removes
the "must not make a mistake" pressure from any individual. Developers have more say but no
unilateral authority — and that constraint deliberately includes the maintainers
themselves.

**Continuity comparison claims use exact, conditional evidence.** Kungfu
qualification owns the smoke/comparison/projection semantics and verdict.
Buildchain only binds the evidence to the exact candidate and public copy. A
published comparative continuity claim therefore carries its fixture, runner
and native-baseline identities, reset method, oracle, raw report, projection,
limitations, and independent review in the Release Passport. A patch with no
comparative claim does not inherit an expensive matched-comparison obligation;
its normal release profile still has to satisfy the applicable `FO9` and
`FO10` correctness gates.

## The tag itself projects a deeper invariant: the yijinjing schema layout

Point 2 said the `package.json` version is a downstream projection of the git tag. The tag
is not the bottom of that chain. For a system whose product *is* a zero-copy, cross-language,
on-disk journal, the real compatibility contract is the **yijinjing schema binary layout** —
the in-memory and on-journal representation that C++, Python, and Node read without parsing.
A git tag, a floating channel ref, and a `package.json` version are all projections of "which
yijinjing schema layout this artifact speaks."

The two contracts fail differently. A version-string drift is cosmetic (point 2). A
yijinjing-schema-layout change is not: because the layout *is* the ABI (zero-copy means the struct
memory order is the wire order), a consumer compiled against one layout cannot read another
by comparing version numbers or by feature detection — only by speaking the same layout, or
by an explicit, evolution-aware decode in a non-zero-copy path. The layout is therefore the
invariant the version machinery exists to protect; the release-line refs are how that
protection is published and audited, not the thing being protected. How that invariant may
evolve, and how released v4+ journals stay replayable, is its own decision — see
[KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265](../adr/KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md).

## Stable v4 schema epochs must stay maintainable

A released v4 schema epoch is not a disposable implementation detail. Once a v4
line is stable, users may have journals, exports, extensions, and runtime facts
written against that layout. A production release closes one patch and opens the
next on the *same* line; it never means "this schema epoch no longer matters."
This follows from the invariant above, not from taste.

**Why the mechanism must keep stable v4 epochs maintainable.** Each released
minor line can pin a yijinjing schema layout epoch. Because the layout is the
ABI, a hot-path reader cannot transparently negotiate arbitrary layouts the way a
self-describing file reader can. Zero-copy is precisely the refusal to pay that
translation on the hot path. The consequence is structural: Kungfu must either
keep the released epoch patchable or provide an explicit cold-path migration /
decode route for v4+ data. The channel topology provides the branch isolation;
[KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265](../adr/KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md) defines the v4 baseline boundary.

**What the mechanism guarantees, and what it does not.** The mechanism does not
promise compatibility with pre-v4 layouts or APIs. It does guarantee that, once
v4 is stable, the project cannot silently strand v4+ users by changing the
schema without a maintenance or migration path. Who performs long-term
maintenance, and whether it is free, is a separate, allocatable question. The
design constraint is that the toolchain not close the road. Keeping a v4+ epoch
maintainable requires:

- **branch isolation** — a fix on a released line does not require rebasing onto newer lines
  (satisfied by the channel topology);
- **a permissive license** — anyone holding the code may take on the burden (satisfied,
  Apache-2.0);
- **a self-consistent layout world** — a deployment on one released schema epoch is not forced to interop
  with another epoch's layout on the hot path;
- **reproducible builds from self-archivable inputs** — a released line must still build years
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

## ADR implementation and release admissibility

Channel promotion is also the settlement mechanism for ADR implementation
truth. The three channels deliberately answer different questions:

| Boundary | Question | Machine result |
|---|---|---|
| feature → `dev` | Is this change a coherent integration unit? | `stage-ready`, `implemented` candidate, or explicit ADR-neutral non-feature change |
| `dev` → `alpha` | What ADR progress did this fully built candidate establish? | progress settlement matching changed ADR projections, or explicit no-progress reason |
| `alpha` → `release` | Is every accepted architecture obligation accounted for? | implemented and qualified, not applicable, or exact-release admin waiver |

The PR template carries exactly one JSON manifest inside the
`kungfu-adr-release:v1` marker. Version intent still comes from branch direction;
the manifest does **not** ask a contributor to choose major/minor/patch. It
declares the architecture delivery boundary that the PR already claims to
cross.

### Development manifests

A feature PR uses `dev-delivery`:

```json
{
  "schema": "kungfu.adr-release-pr/v1",
  "kind": "dev-delivery",
  "intent": "stage-ready",
  "adrs": ["KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca"],
  "summary": "Complete the bounded projection durability stage",
  "verification": ["durability contract tests"]
}
```

`stage-ready` is a PR integration disposition, not the ADR value `staged`. An
ADR may remain `partial` after a coherent stage lands. `implemented` means the
development branch contains an implementation-complete candidate; alpha still
settles the claim after full qualification.

Non-feature work uses `adr-neutral` with a meaningful reason. Feature branches
cannot use that form, and an ADR-neutral PR cannot modify ADR records.

### Alpha settlement manifests

The promotion PR lists the ADR projections established by the complete dev
delta:

```json
{
  "schema": "kungfu.adr-release-pr/v1",
  "kind": "alpha-settlement",
  "progress": [
    {
      "adr": "KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca",
      "to": "staged",
      "summary": "All durability stages are integrated; release qualification remains"
    }
  ]
}
```

If the promotion contains fixes only, it uses
`no_adr_progress_reason` instead of an empty or misleading progress list. The
Buildchain candidate job runs this settlement gate after the full build and
release qualification and retains the resulting report beside the other
qualification evidence.

### Stable admission and waivers

A stable PR declares the exact candidate version:

```json
{
  "schema": "kungfu.adr-release-pr/v1",
  "kind": "stable-admission",
  "release": "4.0.0"
}
```

The gate enumerates every accepted Core and Shifu ADR. `implemented` requires
qualification references; `not-applicable` is admitted; every other state is a
blocker unless `docs/adr-release-waivers.json` contains a waiver for the exact
release and exact blocker conditions. A waiver records reason, risk,
mitigation, an allowlisted release administrator, the current stable PR, and an
expiry equal to that release. The waiver ledger has a dedicated CODEOWNER, so a
GitHub admin bypass or an unreviewed field edit is not a waiver. Waivers appear
in `kungfu.adr-release-report/v1` and never roll forward automatically.

Both namespaces are canonical in [`docs/adr/`](../adr) and pass the same gate;
Shifu ownership is not a release exemption. Before preparing a stable
promotion, run `./shifu adr:audit -- --release stable` for a side-effect-free
inventory of every admitted and blocked record. The command does not apply
waivers because waivers are exact-release, reviewed PR evidence; the promotion
gate remains their authority.

The machine guarantees that stable has no *unaccounted* accepted decision. It
does not replace semantic review: reviewers decide whether code fulfills the
ADR and whether residual risk deserves a waiver. See
[KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2](../adr/KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2.md)
and the [document metadata contract](document-metadata.md).

The gate also evaluates
`framework/deprecation/deprecation-registry.json`. ADR delivery waivers do not
waive deprecation debt. At the first eligible Alpha or stable release, an
applicable entry must have qualified removal evidence, explicit restored
support, or an exact native Warrant projection whose date and release bounds
cover that candidate. The same source and protected-release audit treats class
defaults as lower bounds, resolves classification provenance against the Core,
CLI, or deterministic kind authority, and rejects dates or product versions
beyond the candidate context. The sole retained pre-stable CLI 0/0 settlement
is exact-entry-bound historical evidence, not a reusable release exception.
The definition of eligibility, surface defaults, and history-retention rules
are in the
[deprecation lifecycle](deprecation-lifecycle.md).

### Side-effect-free promotion rehearsal

The product-specific tail boundary is documented in
[`publication-closure.md`](publication-closure.md). Buildchain supplies the
sealed candidate and owns the publication transaction; Kungfu checks its exact
manifest, asset, channel, installer, and KFD closure without minting a second
upgrade admission authority.

Kungfu does not need to publish an alpha or stable release to test its side of
the promotion contract. `./shifu release:promotion:rehearse` executes committed
positive and fail-closed fixtures for both channels, validates the real GitHub
workflow wiring and immutable Buildchain contract locks, checks every declared
release-passport input, and reports current stable ADR readiness. The command
also proves that tracked files, branches, and tags remain unchanged. It never
receives release credentials and contains no version bump, tag, push, package
publish, or GitHub Release operation.

The ordinary `Buildchain Validate` workflow runs this rehearsal on a
GitHub-hosted runner after Buildchain configuration validation. On a future
merged alpha or stable promotion PR, `Release - New Version` runs the same
rehearsal against the actual immutable PR event before the Buildchain reusable
promotion job. Buildchain promotion has an explicit `needs` edge to that
preflight, so contract drift or ADR-admission failure blocks publication before
release credentials are exposed to the reusable job.

This boundary is deliberately precise. The rehearsal proves Kungfu's event,
evidence, channel routing, Buildchain lock, and workflow-consumer contract. It
does not claim to execute or emulate Buildchain's internal publication engine;
the first controlled alpha remains the black-box integration proof for that
implementation.

For a local report:

```bash
./shifu release:promotion:rehearse -- \
  --report product/release/qualification/release-promotion-rehearsal.json
```

The report schema is `kungfu.release-promotion-rehearsal/v1`; its executable
contract is `docs/release-promotion-rehearsal.contract.json`.

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
2. **Zero developer version declaration** — version intent remains inferred
   from branch flow. A bounded ADR delivery declaration may describe
   architecture progress, but it must not ask contributors to choose semantic
   version impact.
3. **Un-cheatable pipeline** — release-worthiness enforced by non-bypassable gates, not by
   judgment or honor.
4. **Weak-centralization** — no single actor can unilaterally cut a release; a release is
   the promotion of a user-validated prerelease.

If a candidate cannot preserve all four, it is a downgrade for this project, however
"standard" it may be.

## Pointers

- Active Buildchain workflows:
  `.github/workflows/buildchain-validate.yml`, `.github/workflows/build.yml`, and
  `.github/workflows/release-new-version.yml`.
- Release-candidate build and promotion logic:
  `kungfu-systems/buildchain` reusable workflows and release-passport tooling.
- Build & toolchain dependencies: see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
  (a dedicated source-to-binary `buildchain` doc is planned — see [`MAP.md`](../MAP.md)).
- The compatibility invariant below the tag (yijinjing schema layout), its v4+
  schema-evolution policy, and the stable-epoch maintenance rationale:
  `docs/adr/KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md`.
