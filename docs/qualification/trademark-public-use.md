# Trademark public-use qualification

This qualification keeps four states separate:

1. the brand signature is implemented in source and public copy;
2. a future release has the surfaces needed to make a public-use record;
3. downloadable software is actually available through those surfaces; and
4. any legal conclusion about first use or registration is made outside this
   engineering contract.

The exact source-identifying signature is **Kungfu UNGFU™**, paired with
**Never Guess. Facts Unfold.** Kungfu remains the product name. UNGFU is not a
second product, runtime, package, CLI, domain, KFD layer, Buildchain component,
or libkungfu replacement.

## Current state

Kungfu v4 is Coming Soon. Public release artifacts are not available, so the
repository does not claim released-software use or a first-use date. Source
code, a pull-request preview, staging, a screenshot without a real acquisition
path, and a Coming Soon page do not satisfy this gate.

The machine-readable current state and release requirements live in
[`kungfu-trademark-public-use.contract.json`](../../framework/release/kungfu-trademark-public-use.contract.json).
Source acceptance runs `scripts/check-trademark-public-use.mjs` and its negative
fixtures. The governing decision is
[KF-ADR-019f8cc4-e796-7b0e-9a16-50c08614e848](../adr/KF-ADR-019f8cc4-e796-7b0e-9a16-50c08614e848.md).

## Source-implemented product surfaces

The assembled Rust front door and the Python compatibility path now render
`kungfu --version` as two stable lines: the existing version remains the first
line, and **Kungfu UNGFU™ · Never Guess. Facts Unfold.** is the second. Readers
that need only the version continue to consume the first non-empty line.

The packaged desktop app sets a native About panel for **Kungfu Episodes** with
**Kungfu UNGFU™** as its secondary signature and **Never Guess. Facts Unfold.**
as its credits line. Kungfu Episodes remains the application name.

These are source-implemented product surfaces, not release evidence. The
contract records them separately from `currentState.productSurfaces`, which
remains empty until a real public artifact binds one of these surfaces to a
reviewed release coordinate.

## Gate for the first real public release

Before `releasedSoftwareUseClaim` can become true, one reviewable change must
provide both:

- a public download or package-install surface where **Kungfu UNGFU™** appears
  next to the real acquisition path; and
- at least one stable product-controlled surface—launch, About, or
  `kungfu --version`—that displays the exact mark.

The same release must also carry public capability evidence for every core US
Class 9 identification in the machine contract. A roadmap, source-only
implementation, test fixture, preview, staging deployment, or Coming Soon page
cannot stand in for a capability that users can exercise in the released
artifact.

The release gate does not rename the `kungfu` CLI, packages, repositories,
domains, KFD, Buildchain, or libkungfu. The signature identifies source; it does
not replace the product name.

## US Class 9 filing-readiness profile

The contract records an engineering candidate for a future Section 1(a)
application after a genuine public alpha exists. It is not a legal conclusion.
Counsel must still confirm the final identification text, application basis,
first-use dates, ownership, and specimen sufficiency.

The six core identifications cover:

- continuity of artificial-intelligence-agent work across sessions,
  interruptions, and handoffs;
- recording, storing, querying, inspecting, and replaying runtime event data
  and Agent work records;
- creating, exporting, importing, and verifying electronic Agent work records;
- downloadable workflow-management software;
- downloadable software-development tools; and
- a downloadable application programming interface.

Two additional identifications are conditional. Interactive inspection and
replay may be selected only when a released CLI, TUI, or GUI exposes that
capability. Downloadable plug-ins may be selected only when Kungfu distributes
at least one first-party downloadable KFX plug-in under the mark. Merely hosting
an extension API or allowing third parties to build plug-ins does not satisfy
that condition.

Each selected identification has a stable `planId`. The two distinct
`009-506` fill-ins remain separate through those ids even though they use the
same USPTO Term ID. The release evidence must reproduce the reviewed
identification exactly; a release PR cannot silently broaden or substitute the
filing plan.

## Per-identification capability evidence

Every core Class 9 evidence record must identify:

- the stable plan id, USPTO Term ID, and exact reviewed identification;
- status `released`, never planned or source-only;
- the public command or product surface that exercises the capability;
- a public URL, access date, and rendered evidence;
- the exact source repository and full source commit;
- the acquisition and product surface ids; and
- the deployment or release coordinate shared by all of those surfaces.

The strongest acquisition evidence is a public download or package-install page
that places **Kungfu UNGFU™**, a description of the downloadable software, and
the actual download or installation path together. The stable product surface
then shows the same mark from the matching artifact. Internal qualification
evidence supports the truthfulness of each goods claim, but does not replace
what the public can actually acquire and use.

## Public-safe evidence record

Record only public material. Each evidence record must include:

- stable acquisition-surface and product-surface identifiers;
- the public URL and access date;
- source repository and exact source commit;
- the deployment or release coordinate;
- rendered evidence showing the mark beside the acquisition path and in the
  selected product surface.

The acquisition surface, product surface, and evidence record must bind the
same deployment or release coordinate. The acquisition URL and rendered
evidence must be public HTTPS resources; local files, private-network hosts,
credentials in URLs, incomplete commit ids, future access dates, and unmatched
surface references fail closed.

Do not include private applications, searches, counsel correspondence, entity
records that are not already public, credentials, or unpublished release
coordinates. Do not infer or backdate a first-use date. A reviewer may confirm
that the engineering evidence is complete; that confirmation is not legal
advice, a registration claim, or a legal determination of first use.

## Review boundary

The implementation PR proves copy, ownership attribution, exact-mark surfaces,
protected repository/package/domain/CLI identities, the bounded Class 9 filing
plan, and executable negative tests. The future release PR proves one
source-bound real acquisition and product-surface pair plus released capability
evidence for every selected Class 9 identification. Production publication and
any legal conclusion remain separate explicit review gates.
