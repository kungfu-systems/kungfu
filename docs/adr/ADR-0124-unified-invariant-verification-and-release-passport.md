---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0124
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1147]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1147
qualification_refs: [framework/invariant/kungfu-invariant-system.contract.json, framework/invariant/kungfu-invariant.registry.json, scripts/kungfu-invariant.test.mjs, scripts/run-release-qualification.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-20
theme: invariant-verification-system
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-20; based on repository contracts, tests, and user-authorized design constraints; no claim about unpublished release artifacts or unobserved third-party implementations
---

# ADR-0124: Invariants use one authority-bound verification and release-passport system

- Status: accepted and implemented by the bounded delivery and closure evidence above
- Date: 2026-07-20
- Category: contract worlds, qualification, evolution, and release admission
- Related: [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md),
  [ADR-0121](ADR-0121-portable-fact-root-canonical-encoding.md),
  [ADR-0033](ADR-0033-episode-causal-segment-object.md),
  [ADR-0042](ADR-0042-episode-atomic-safety-and-qualification.md), and
  [ADR-0073](ADR-0073-buildchain-adr-release-admissibility.md).

## Context

Fact and Episode already had strong but separate proof paths. Fact had a
machine contract, negative fixtures, exact canonical-root conformance,
multiprocess CAS, rebuild and import checks. Episode had causal closure,
sealed identity, a typed qualification result, an independent semantic oracle,
fault campaigns, and release evidence. None of those individual mechanisms
answered the cross-domain questions an agent or release gate needs:

- Which invariants exist, who owns their meaning, and where is that meaning?
- Is a claim constitutional, a versioned protocol, a profile property, or a
  selected policy?
- Is the evidence merely declared, falsifiable, independently conformant,
  qualified, release-enforced, or battle-tested?
- Did the exact source and checker run on every claimed platform and profile?
- Does the evidence qualify an implementation, one Episode object, or a
  destination admission action?
- If semantics changed, what successor interprets old objects and what must be
  requalified?

Copying Fact and Episode rules into one central file would make that file a
second semantic authority and create exactly the drift the system is intended
to prevent.

## Decision

Kungfu adopts one cross-domain invariant verification system with a deliberately
thin authority boundary.

### Domain contracts own meaning

Fact meaning remains in the Fact Cut Kernel contract and its Fact-owned model.
Episode meaning remains in the Episode invariant contract backed by the
yijinjing manifest journal and the typed C++ fold/fsck boundary. The unified
registry stores content-addressed JSON pointers into those documents. A label
in the registry is navigation, not a restatement of the rule.

Every strong (`constitutional` or `protocol`) entry binds an abstract-model root
and a refinement root. Replacing a backend, carrier, codec, fold, or storage
mechanism without renewing that binding is a source failure, not an invisible
implementation detail.

### Stability and evidence maturity are orthogonal

The closed stability vocabulary is:

```text
constitutional | protocol | profile | policy
```

The separately ordered evidence maturity vocabulary is:

```text
declared
  -> falsifiable
  -> independently-conformant
  -> qualified
  -> release-enforced
  -> battle-tested
```

A qualified profile does not become a constitutional proof, and a
constitutional declaration does not become qualified merely because its class
is strong.

### Verdicts are exact

The only invariant verdicts are `verified`, `falsified`, `unqualified`, and
`not-applicable`. A timeout, missing toolchain, stale source, stale checker,
invalid witness, or absent required platform is `unqualified`. It is never a
pass. `not-applicable` requires an explicit registry exclusion; an ordinary
skip cannot produce it.

The evidence envelope binds the authoritative pointer root, source revision
and tree, dirty state, invariant-system and registry roots, checker root,
layer, platform, profile, stdout/stderr roots, exact verdict, and residual risk.
Volatile observation time and duration do not participate in semantic roots.

### Object receipts are not implementation passports

An implementation Invariant Passport aggregates checker evidence and enforces
the declared platform/layer matrix. An Episode object qualification receipt
instead binds one exact typed Episode qualification result, its subject root,
contract root, checker root, safe capabilities, contractions, blockers, and
residual risk. The receipt is read-only and becomes stale when any of those
roots changes.

The existing Episode admission receipt remains a third object: it proves a
destination-owned acceptance decision. Admission, object qualification, and
implementation qualification cannot substitute for one another.

### Evolution is an explicit successor operation

Changing an authoritative pointer root is a semantic change even if an id and
label remain the same. Every changed invariant must carry a successor
declaration with semantic diff, old-object interpretation, migration, rollback,
and requalification. Constitutional and protocol successors additionally state
abstract-model and refinement impact. Old evidence remains attached to the old
root and may not be relabeled.

### Release admission consumes the passport

The release qualification runs the same public invariant entry on macOS,
Linux, and Windows, retains evidence under `product/release/qualification`, and
aggregates the exact matrix into a clean-source implementation passport.
Buildchain receives the passport as a consumer-owned evidence object and adds
an invariant section to the Release Passport. Missing, stale, falsified,
unqualified, tampered, dirty, or incomplete evidence fails closed.

## Public surface

The source and agent entry is:

```sh
./shifu invariant:verify -- --list --json
./shifu invariant:verify -- --domain fact --level source --json
./shifu invariant:verify -- --domain episode --level source,native,runtime --json
```

The contract is also discoverable through the ordinary shipped contract
registry as `invariant-system`.

## Consequences

- Fact and Episode checks share one evidence and release vocabulary without
  sharing or copying domain semantics.
- A human summary and JSON output render the same structured result.
- Mechanism replacement and semantic evolution become independently visible
  release responsibilities.
- Cross-platform claims cost cross-platform evidence; a local success can
  remain useful without being promoted beyond its scope.
- The registry and frozen runtime artifacts are KFD-1 welded surfaces.

## Falsification gates

The system is unacceptable if any of these mutations passes:

- alter an authoritative source while retaining its registered root;
- remove a strong invariant's model or refinement binding;
- use `passed`, `skipped`, or an unknown verdict;
- omit a required platform, layer, or checker and still produce `verified`;
- tamper with an evidence, object-receipt, or passport preimage;
- change a checker or object while reusing its old receipt;
- change constitutional/protocol semantics without successor model and
  refinement impact;
- use an Episode admission receipt as an Episode object proof.

## Explicit non-claims

- Bounded enumeration and property tests are not mathematical completeness.
- The first registry covers Fact and Episode; it is not a universal ontology.
- A source-only run is not a release-qualified implementation.
- Object qualification does not re-execute external side effects.
- Release admission does not create a production release by itself.

## Residual risk

The current cross-platform matrix is tied to the declared macOS ARM64, Linux
x64, and Windows x64 release profiles. A new platform, domain, checker class, or
distributed authority needs an explicit registry and release-policy change.
Long-running production operation remains a separate basis for the
`battle-tested` maturity level.
