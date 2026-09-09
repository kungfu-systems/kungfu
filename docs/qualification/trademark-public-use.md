# Trademark public-use qualification

This qualification keeps four states separate:

1. the brand signature is implemented in source and public copy;
2. a release has the surfaces needed to make a public-use record;
3. downloadable software is actually available through those surfaces; and
4. any legal conclusion about first use or registration is made outside this
   engineering contract.

The exact source-identifying signature is **Kungfu UNGFU™**, paired with
**Never Guess. Facts Unfold.** Kungfu remains the product name. UNGFU is not a
second product, runtime, package, CLI, domain, KFD layer, Buildchain component,
or libkungfu replacement.

## Current state

Kungfu `v4.0.0-alpha.1` is the first public v4 Alpha. Its public acquisition
and product evidence supports the engineering `releasedSoftwareUseClaim` for
that exact release. The status does not make a legal first-use-date,
registration, ownership, specimen-sufficiency, or filing conclusion. Source
code, a pull-request preview, staging, a screenshot without a real acquisition
path, and a Coming Soon page still do not satisfy this gate.

The public machine-readable current state is
`https://kungfu.tech/.well-known/kungfu-release-status.json`. An installed
artifact explains or verifies it with:

```sh
kungfu release status
kungfu release verify <file-or-https-url>
kungfu release explain
```

Use `--json` for an Agent. The stable output distinguishes a verified current
release, a verified unavailable state, and rejected partial or stale evidence,
then names both the proof and its non-claims.

The repository-owned release requirements live in
[`kungfu-trademark-public-use.contract.json`](../../product/release/kungfu-trademark-public-use.contract.json).
Source acceptance runs `scripts/check-trademark-public-use.mjs` and its negative
fixtures. The governing decision is
[KF-ADR-019f8cc4-e796-7b0e-9a16-50c08614e848](../adr/KF-ADR-019f8cc4-e796-7b0e-9a16-50c08614e848.md).

## Source-implemented product surfaces

The assembled Rust front door and the Python compatibility path now render
`kungfu --version` as two stable lines: the existing version remains the first
line, and **Kungfu UNGFU™ · Never Guess. Facts Unfold.** is the second. Readers
that need only the version continue to consume the first non-empty line.

The packaged desktop app sets a native About panel for **Kungfu** with
**Kungfu UNGFU™** as its secondary signature and **Never Guess. Facts Unfold.**
as its credits line. Kungfu is the application name.

These source-implemented surfaces are not release evidence by themselves. The
static contract keeps a preparation-state baseline; the synthesized public
release status and evidence index bind the observed product surface to the
reviewed `v4.0.0-alpha.1` coordinate.

## Gate used by the first and later public releases

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

## Release evidence bundle

The reviewed evidence shape is
[`kungfu-ungfu-release-evidence.schema.json`](../../product/release/kungfu-ungfu-release-evidence.schema.json).
It deliberately keeps three layers separate:

1. the filing-oriented public acquisition/product specimen pair;
2. released-capability truth for each selected Class 9 plan; and
3. supporting public brand history, which is never treated as primary
   acquisition or product evidence.

The committed
[`kungfu-ungfu-release-evidence.candidate.json`](../../product/release/kungfu-ungfu-release-evidence.candidate.json)
is only a preparation file. It contains no public acquisition, product, Class 9
record, use claim, date claim, or legal conclusion. Generate another
preparation file with:

```sh
./shifu ungfu:evidence -- --prepare \
  --output .buildchain/release-evidence/ungfu-public-use.json
```

At the exact Alpha cut, the protected release path completes one Buildchain
activation transaction in this order:

1. qualify the immutable candidate;
2. publish the artifacts;
3. seal the Release Passport;
4. merge and publish the exact site source;
5. read back the public status and acquisition surfaces; and
6. synthesize released evidence from the resulting receipt set.

Every receipt binds the same product and site source SHAs, artifact root,
version, tag, channel, and production environment. A failed phase records its
state and stops later phases; a retry may replay only the same roots. Changed
roots fail closed. Shadow mode exercises the complete transaction but always
sets `releasedUseClaim=false`.

Windows Alpha qualification accepts the exact unsigned PE installer and
application bytes. It relies on signed-channel and digest/root verification and
does not require or claim Authenticode certification or a Windows publisher
identity.

The final synthesis command accepts the authoritative receipt set, not a
hand-authored candidate:

```sh
node scripts/prepare-ungfu-release-evidence.mjs --release \
  --receipts .buildchain/release-activation/receipt-set.json \
  --output .buildchain/release-evidence/ungfu-public-use.json \
  --readback --json
```

It rejects preparation state, placeholders, Coming Soon, preview, staging and
private URLs, 404 acquisition actions, future dates, partial source SHAs,
unqualified Class 9 plans, missing or stale receipts, and any mismatch among
source, version, tag, channel, deployment coordinate, product qualification,
and signed artifact roots.

The site projection owns the acquisition half. Only after a signed Alpha
installer publication is imported does `/install/` render one
`data-ungfu-release-acquisition` block containing **Kungfu UNGFU™**, a plain
downloadable-software description, exact version/channel, and the working
installer action. It also emits an immutable acquisition HTML page and JSON
index below `/evidence/ungfu/alpha/<version>/<channel-root>/`. The pre-release
page emits none of those released-evidence surfaces.

The product half is the public
`kungfu.cli-installed-product-qualification/v1` asset produced from the
installed release archive. It records the observed two-line `kungfu --version`
identity and archive root. The final evidence index must bind that root and
every selected Class 9 capability check to the same release as the site.
Buildchain validates the five-receipt activation set, retains the receipt set
and synthesized product-owned index in controller evidence, and never upgrades
a candidate document into released proof by inference.

Passing these engineering checks records only public observations. It does not
select a filing date, determine first use, establish ownership, assess specimen
sufficiency, or replace counsel review.

## US Class 9 filing-readiness profile

The contract records an engineering candidate for a possible Section 1(a)
application. The `v4.0.0-alpha.1` publication satisfies only the engineering
availability precondition; it is not a legal conclusion. Counsel must still
confirm the final identification text, application basis, first-use dates,
ownership, and specimen sufficiency.

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
plan, and executable negative tests. Each release claiming public use must
prove one source-bound real acquisition and product-surface pair plus released
capability evidence for every selected Class 9 identification. Production
publication and any legal conclusion remain separate explicit review gates.
