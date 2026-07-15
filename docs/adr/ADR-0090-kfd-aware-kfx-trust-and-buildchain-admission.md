---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0090
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/571, https://github.com/kungfu-systems/kungfu/pull/568, https://github.com/kungfu-systems/kungfu/pull/731, https://github.com/kungfu-systems/kungfu/pull/734, https://github.com/kungfu-systems/kungfu/pull/906, https://github.com/kungfu-systems/kungfu/pull/922, https://github.com/kungfu-systems/kungfu/pull/942]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: kfd-aware-kfx-trust-buildchain-admission
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0090: KFX admission consumes KFD facts and exact Buildchain attestations

- Status: accepted; implementation partial
- Date: 2026-07-15
- Category: KFX trust / KFD / supply chain / capability admission
- Parent: [ADR-0088](ADR-0088-core-native-multisurface-kfx-runtime.md)
- Related: [ADR-0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md),
  [ADR-0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md),
  [ADR-0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md),
  [ADR-0073](ADR-0073-buildchain-adr-release-admissibility.md),
  [ADR-0075](ADR-0075-profile-level-kfd3-qualification.md),
  and [ADR-0083](ADR-0083-core-system-kfx-profile-kfx-capability-boundary.md)

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
issuer, publisher, contract, expiry, revocation, and ADR-0052 qualification
bindings; and
returns one deterministic `kungfu.kfx-trust-report/v1` and
`kungfu.kfx-admission-plan/v1`. The report binds the registry snapshot and all
dependency roots. The plan binds the report root and defines the root a future
mutation receipt must consume. Python CLI and the public Node/API Storage
capability shared by GUI, TUI, KFX, and Agent consumers project the same Core
result without re-evaluating trust; this slice does not add a presentation-owned
badge or trust override.

KFD qualification is not accepted from an attestation's self-reported claim
list. The slice requires an existing fresh, purpose-bound ADR-0052 assessment;
its assessment key, report hash, query proof, contract world, policy, and fact
surface roots become report dependencies, and its report hash must equal the
declared qualification root. KFX therefore projects operation admission from
the durable KFD lifecycle rather than creating a competing evaluator.

Implementation remains partial at this stage: Core validates a supplied pinned
verifier result but does not execute or authenticate the Buildchain verifier;
`assess` does not install, activate, mutate Profile state, or persist the full
ADR-0052 Assessment Episode lifecycle. Those later mutation paths must consume
the exact report, plan, package, and dependency roots frozen here rather than
creating a second KFD evaluator.

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
