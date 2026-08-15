---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/571, https://github.com/kungfu-systems/kungfu/pull/568, https://github.com/kungfu-systems/kungfu/pull/731, https://github.com/kungfu-systems/kungfu/pull/734, https://github.com/kungfu-systems/kungfu/pull/906, https://github.com/kungfu-systems/kungfu/pull/922, https://github.com/kungfu-systems/kungfu/pull/942, https://github.com/kungfu-systems/kungfu/pull/975, https://github.com/kungfu-systems/kungfu/pull/1704, https://github.com/kungfu-systems/kungfu/pull/1718, https://github.com/kungfu-systems/kungfu/pull/1728, https://github.com/kungfu-systems/kungfu/pull/1744, https://github.com/kungfu-systems/kungfu/pull/1771, https://github.com/kungfu-systems/kungfu/pull/1784, https://github.com/kungfu-systems/kungfu/pull/3140]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1784
qualification_refs: [framework/core/src/libkungfu/tests/fixtures/native_kfx_contract/buildchain-2.13.0-alpha.0-envelope.json, framework/core/src/libkungfu/tests/native_kfx_contract_tests.cpp, framework/core/tests/python/test_native_kfx_contract.py, framework/core/tests/storage-node-binding.test.js, framework/api/tests/storage.test.ts, framework/kfx/tooling/run-identity-neutral-terminal-qualification.mjs, docs/qualification/kfx-identity-neutral-terminal.md, framework/core/src/libkungfu/tests/native_kfx_service_host_tests.cpp, framework/kfx/evidence/kfd-10/runtime-warrant-adopter.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: kfd-aware-kfx-trust-buildchain-admission
confidence: high
evidence_grade: B
last_reviewed: 2026-08-15
---

# KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab: KFX admission consumes KFD facts and exact Buildchain attestations

- Status: accepted; implemented and terminal-qualified
- Date: 2026-07-15
- Category: KFX trust / KFD / supply chain / capability admission
- Parent: [KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e](KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e.md)
- Related: [KF-ADR-019f86da-4f90-79f1-8716-aca36b142847](KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md),
  [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md),
  [KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302](KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md),
  [KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2](KF-ADR-019f86da-4f90-7b6b-ae6d-76cea57487f2.md),
  [KF-ADR-019f86da-4f90-712d-b871-24090476e338](KF-ADR-019f86da-4f90-712d-b871-24090476e338.md),
  and [KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708](KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708.md)

## Context

Treating every third-party KFX as equally unknown discards valuable evidence.
A package with a verifiable publisher, exact source and dependency closure,
reproducible Buildchain plan, qualification evidence, and sealed artifact root
is materially different from an arbitrary directory or archive.

The opposite shortcut is also unsafe. Build provenance does not prove that a
package is appropriate for every workspace, that requested capabilities are
necessary, or that runtime behavior will remain healthy. Profile KFD-3 proves
human/agent interface parity, not arbitrary code safety. First-party bundling
does not by itself grant Core authority.

Kungfu therefore needs an evidence-bearing admission model rather than a
single `trusted` boolean.

The partial baseline is the existing KFD-1/KFD-2 fact and assessment machinery,
Profile KFD-3 qualification, Product assembly authority, and Buildchain release
evidence. They are not yet joined into an exact-artifact KFX admission report or
policy matrix. This documentation change makes that missing join explicit; it
does not confer a new trust grade on any package.

PR #906 freezes the native trust-grade vocabulary and requires package,
policy, capability, source, build-plan, artifact, and qualification roots in
the contract seam. Its validators reject malformed or unsupported contract
inputs, but they do not verify Buildchain attestations, produce a KFD-2
TrustReport, or authorize capabilities. Exact-artifact admission therefore
remains a subsequent implementation stage.

PR #922 separates runtime placement tiers from admission grades, carries the
declared trust-input roots into deterministic native plans, and proves that a
Product role cannot elevate an untrusted runtime tier. It still does not verify
Buildchain attestations, produce a KFD-2 TrustReport, authorize capabilities,
or grant Product System authority.

The current native admission slice adds a read-only Core `assess` operation. It
consumes the exact `kungfu-buildchain-artifact-verification` v1 result plus
independently supplied, schema-closed trust inputs and policy; checks package,
source, dependency, build-plan, toolchain, artifact, qualification, verifier,
issuer, publisher, contract, expiry, revocation, and KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 qualification
bindings; and
returns one deterministic `kungfu.kfx-trust-report/v1` and
`kungfu.kfx-admission-plan/v1`. The report binds the registry snapshot and all
dependency roots. The plan binds the report root and defines the root a future
mutation receipt must consume. Python CLI and the public Node/API Storage
capability shared by GUI, TUI, KFX, and Agent consumers project the same Core
result without re-evaluating trust; this slice does not add a presentation-owned
badge or trust override.

KFD qualification is not accepted from an attestation's self-reported claim
list. The slice requires an existing fresh, purpose-bound KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment;
its assessment key, report hash, query proof, contract world, policy, and fact
surface roots become report dependencies, and its report hash must equal the
declared qualification root. KFX therefore projects operation admission from
the durable KFD lifecycle rather than creating a competing evaluator.

PR #975 retains an envelope produced by the published
`@kungfu-tech/buildchain@2.13.0-alpha.0` package and proves one exact projection
and Core report root across the native C++, Python/CLI, Node binding, and public
Storage API edges. This is provider-to-consumer round-trip evidence for the
existing read-only admission slice; it does not widen the mutation or Product
System authority non-claims below.

PR #1704, reconciled from source PR #1624, binds the semantic registry and
lifecycle plans to declared trust, capability, version, dependency, and exact
Buildchain roots. Shared fixtures and the machine-readable qualification
receipt prove deterministic Core, Python, Node, and API projections. The stage
consumes the existing admission evidence; it does not authenticate a new
verifier or confer Product System authority.

Implementation remains partial at this stage: Core validates a supplied pinned
verifier result but does not execute or authenticate the Buildchain verifier;
`assess` does not install, activate, mutate Profile state, or persist the full
KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 Assessment Episode lifecycle. Those later mutation paths must consume
the exact report, plan, package, and dependency roots frozen here rather than
creating a second KFD evaluator.

PR #1718 makes that consumption mandatory for every native registry mutation.
Core recomputes the Release Passport and admission roots, then requires a
purpose-bound Work/Warrant that also binds policy, capability, approval,
package/dependency, receipt-dependency, and expected-Cut roots before any side
effect. KFD fitness can reduce policy-defined friction but cannot authorize a
mutation, and first-party or Product/System identity supplies no ambient grant.
Pinned-verifier authentication, runtime capability enforcement, and terminal
identity-neutral qualification remain later stages, so implementation remains
partial.

PR #1728 makes KFD eligibility explicitly non-authorizing at runtime. Core
intersects requested capabilities with both the exact package declaration and
its embedded policy ceiling, requires explicit approvals for high-consequence
capabilities, and binds the resulting grant to the Passport, policy,
Work/Warrant, package, and prior Cut. Product System remains assembly metadata;
first-party identity and KFD fitness provide no implicit grant. Runtime
confinement and launch reauthorization reject any package, policy, capability,
Cut, revision, generation, Warrant, or replay drift. Pinned-verifier
authentication and terminal identity-neutral qualification remain later
stages, so implementation remains partial.

PR #1744 closes the remaining identity-neutral admission shortcuts. KFD
conformance is retained only as policy eligibility evidence and can neither
select a runtime tier nor mint a capability. Product System roles are inert
assembly/distribution/default-install/update/presentation metadata. Bundled and
external packages traverse the same exact Release Passport, Core policy,
Work/Warrant, capability-grant, approval, Cut, generation, and isolation
checks; self-labels, self-signed or sibling Passports, replay, and post-plan
mutation fail closed. Recursive dogfood and the terminal qualification remain
outside this stage, so implementation remains partial.

The identity-neutral terminal campaign proves that KFD eligibility and exact
artifact identity remain evidence, not permission. Product-bundled and
ecosystem-equivalent inputs produce the same decision and roots; missing
Warrants, high-consequence grants, false System/first-party claims,
self-signed or sibling Passports, replay, expiry, revocation, policy drift,
capability broadening, and post-plan mutation all fail closed before execution.
Accepted operations retain exact Passport, policy, Work, Warrant, capability,
host, Episode, Settlement, CAS, and Cut roots.

PR #3140 adds a KFD-10 adopter witness that consumes those exact facts without
making KFD a runtime authority. KFD eligibility cannot issue, renew, recover,
or settle a Runtime Warrant; Core verifies the lease generation, fencing,
holder, purpose, attenuated capabilities, heartbeat, expiry, revocation, and
roots. The manifest evidence remains draft and cannot activate an adopter or
broaden its privileges.

## Decision

### 1. KFD-1 records trust inputs; KFD-2 judges fitness at a cut

Core validates immutable trust inputs including package and Suite roots,
publisher identity, source root, dependency closure, build-plan root,
toolchain identity, artifact root, qualification evidence, requested
capabilities, Product assembly policy, Workspace policy, and relevant runtime
history.

A KFD-2 assessment binds those inputs to a purpose and cut, such as install,
automatic update, activation in one workspace, elevated host placement, or a
specific capability grant. It returns a TrustReport and residual risk. It does
not make the package universally safe.

### 2. Buildchain certification is an exact-artifact attestation

A Buildchain KFD attestation is valuable only when its signed/sealed evidence
closes over the exact package root Kungfu is considering. Version labels,
repository names, branch names, or a certificate for a sibling build are
insufficient.

The consumed envelope must bind at least source root, dependency closure,
build-plan/toolchain identity, artifact root, qualification references,
publisher/issuer, contract version, and revocation/expiry semantics. Kungfu
verifies the envelope through a pinned verifier contract and records the
verdict as an admission input and receipt dependency.

### 3. Trust grades reduce friction without collapsing authority

The first contract exposes four user-facing grades:

| Grade | Meaning | Default effect |
| --- | --- | --- |
| `unverified` | origin or exact bytes are not established | inspect only; explicit approval for mutation/execution |
| `identity-verified` | publisher and exact artifact identity are verified | reduced origin warnings; capability review remains |
| `kfd-attested` | exact artifact has accepted Buildchain/KFD provenance and qualification evidence | policy may pre-authorize install, same-capability update, or constrained activation |
| `product-system` | Product assembly explicitly assigns a System KFX role to an eligible exact root | product policy may grant declared system capabilities |

`kfd-attested` is not `product-system`. A package cannot self-declare either
grade. System role comes only from Product assembly authority and may require,
but is not created by, Buildchain attestation.

### 4. Admission is operation- and capability-specific

Trust affects separate decisions: inspect, install, update, enable, activate,
host placement, and each capability grant. A higher grade may remove repeated
warnings, permit automatic verification, allow same-envelope updates, or use a
less restrictive eligible host. It never grants undeclared permissions.

Any capability expansion, publisher change, dependency-closure change,
Product/Workspace policy change, expired/revoked attestation, or different
content root requires a new plan and assessment. High-consequence network,
process, filesystem, credential, or Core mutation capabilities remain governed
by explicit policy even for a KFD-attested package.

### 5. Runtime evidence can degrade local admission

Crashes, receipt violations, capability denials, schema drift, or behavior that
contradicts declared policy become new facts. They may degrade or suspend local
activation while retaining the original build attestation as a historical fact.
Kungfu does not rewrite Buildchain's claim; it issues a newer purpose-bound
assessment.

Unknown or unavailable evidence fails visibly. Cached assessments carry their
dependency roots and become stale when any relevant input changes.

### 6. Every surface sees the same report

GUI badges, TUI indicators, CLI JSON, and agent capability discovery are
projections of the same Core TrustReport and admission receipt. A GUI cannot
upgrade an unverified package privately, and an agent cannot bypass approval by
calling a lower Python or Node installer.

## Acceptance gates

- An attestation for any non-identical artifact, dependency closure, toolchain,
  publisher, or contract version is rejected.
- `kfd-attested` packages receive the policy-defined reduced-friction path, while
  an equivalent unverified package does not.
- New capabilities force a new plan and cannot inherit an old approval.
- A manifest `system: true` or equivalent self-claim never grants System KFX
  authority.
- GUI, TUI, CLI, and agent clients return the same grade, report root,
  constraints, required approvals, and receipt identity.
- Runtime failure can suspend activation without erasing or falsifying the
  original Buildchain evidence.

## Consequences

- Buildchain evidence becomes an operational product input rather than a badge
  that users must interpret manually.
- Unknown extensions remain usable through explicit, constrained admission.
- A multidimensional report and policy matrix add complexity, but avoid both
  blanket distrust and unsafe first-party shortcuts.
- Buildchain and Kungfu retain separate responsibilities: Buildchain attests
  how exact bytes were produced; Kungfu decides whether those facts are fit for
  the requested local action.

## Rejected alternatives

- **Trust every signed package equally.** Rejected because identity is not
  build closure, capability fitness, or runtime health.
- **Treat Buildchain KFD as universal safety certification.** Rejected because
  assessment remains purpose-, cut-, and policy-bound.
- **Make all third-party KFX follow the same warning path.** Rejected because it
  discards high-value, machine-verifiable evidence.
- **Let first-party manifests self-elevate.** Rejected because bundling and
  System authority belong to Product assembly.

## Version impact and non-claims

The first trust-report and admission-grade contract is additive and
pre-release. It does not promise malware detection, formal verification,
revocation infrastructure beyond the declared verifier contract, or safety for
arbitrary in-process native code.
