---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/910]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/910
qualification_refs: [scripts/check-shifu-documentation-contract.mjs, scripts/shifu-documentation-runtime.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: shifu-documentation-protocol
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82: Documentation Protocol and provider boundary

- Status: accepted and implemented
- Date: 2026-07-15
- Scope: project documentation submission, canonical roots, provider seams,
  diagnostics, and validation receipts
- Related: [SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011](./SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011.md),
  [SHIFU-ADR-019f86da-4f90-78f2-9256-43ef0fe3c58b](./SHIFU-ADR-019f86da-4f90-78f2-9256-43ef0fe3c58b.md),
  and [KF-ADR-019f86da-4f90-7f1b-87cd-06e3787a116a](./KF-ADR-019f86da-4f90-7f1b-87cd-06e3787a116a.md)

## Context

Kungfu already has deterministic Markdown, link, anchor, directory-authority,
metadata, ADR, vocabulary, executable-example, and release-admission checks.
Those checks are intentionally project-specific. They know Kungfu's document
taxonomy, metadata profiles, decision registry, Gate catalog, and Buildchain
bindings.

Shifu needs a project-independent way to receive those authorities without
copying their meanings into the launcher. A second validator that inferred
roles from paths or interpreted arbitrary prose would create a competing
authority and would still be unable to distinguish machine evidence, human
review, non-claims, and waivers.

## Decision

Shifu owns a versioned Documentation Protocol. A project submits one
`shifu.documentation-project/v1` object containing declared content and
contract roots, separate document and verification profiles, typed providers,
human and agent routes, and fixed safety policies. The project owns every
instance. Shifu owns only the schema, canonicalization, stable diagnostics,
computed roots, and validation receipt.

Document roles and verification modes are separate dimensions. A decision or
guide can require machine checks, human review, both, or neither because it is
explicitly a non-claim. V1 verification modes are `machine`, `human`, `mixed`,
and `non-claim`; they do not collapse into a generic "validated" bit.

Providers have one of four kinds: `subject`, `claim`, `probe`, or `artifact`.
Each provider names an exact repository-relative source path, one declared
root, its authority, document profile, verification profile, visibility, and
format. Lifecycle is explicit (`active`, `deprecated`, or `retired`), as is
current evidence state (`current`, `waived`, `stale`, or `invalidated`). A
waiver carries its reason, owner, and expiry; retired, stale, and invalidated
providers cannot enter a current route. Glob selectors are not provider
sources. Two providers cannot claim
the same kind and source path as separate authorities.

Probe providers may only reference a Shifu Gate registry. Documentation
validation never executes a command, Markdown fence, or provider hook. A later
qualification stage may select and execute declared probes through the Gate
contract, preserving its argv, capability, cost, policy, and receipt boundary.

Canonicalization sorts object keys and identity-bearing collections, uses
exact POSIX repository paths, and computes separate SHA-256 roots for:

- the protocol and profile contract;
- provider and route content;
- the complete normalized submission.

`shifu docs validate` emits a versioned diagnostic receipt. That receipt is
always `qualifying: false` and `selfCertified: false`: schema and reference
validity do not prove prose truth, human fitness, probe success, or release
admission. A project cannot change `receiptAuthority` from `shifu` and mint its
own passing receipt.

Unknown v1 fields are rejected. Additive optional fields may extend v1 only
when their absence preserves current meaning. Removals, new required fields,
or changed profile, root, provider, route, policy, or canonicalization meaning
require v2.

## Authority boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| Project | domain documents, profiles, provider instances, routes, selected obligations | Shifu canonicalization or receipt truth |
| Shifu | protocol, diagnostics, canonical roots, validation receipt | project semantics or arbitrary prose truth |
| Product runtime | future read-only documentation pack projection | authoring or requalification |
| Buildchain | exact build/release attestation | documentation policy or semantic reinterpretation |
| Human review | clarity, purpose, and contested semantic judgment | machine-result rewriting |

## Current Kungfu projection

`shifu.documentation.json` maps the existing `docs.contract.json`, document
metadata contract and registry, ADR registry, Shifu Gate registry, and pinned
Buildchain input into the protocol. Those sources remain authoritative. The
submission is a compatibility map and cannot replace or weaken their existing
checks.

The initial CLI surface is deliberately narrow:

```text
shifu docs contract
shifu docs schema submission|receipt
shifu docs validate [--submission FILE|-] [--json]
shifu docs show [--submission FILE] [--json]
```

The graph, impact, context, pack, and qualification surfaces remain later
stages. They must consume these roots and provider seams rather than invent a
parallel submission format.

## Consequences

- A second project can declare its own providers and routes without modifying
  Shifu's engine or importing Kungfu-specific identifiers.
- Invalid paths, root escapes, duplicate authority, provider broadening,
  visibility broadening, unknown profiles, and self-certified receipts fail
  with stable diagnostics.
- Existing `docs:check`, ADR audit, Gate, and Buildchain behavior remains in
  place while migration proceeds; compatibility does not become a second
  authority.
- Passing validation proves only protocol conformance and deterministic roots.
  Evidence execution, human review, content truth, and release admission stay
  explicit obligations.

## Alternatives considered

- **Move Kungfu's complete documentation validator into Shifu now** — rejected:
  it would hard-code one project's taxonomy before the protocol boundary is
  stable.
- **Infer profiles from directory names** — rejected: paths are routing inputs,
  not universal document or verification semantics.
- **Allow provider glob patterns** — rejected: broad selectors can silently
  acquire new authority as a repository grows.
- **Treat schema validity as qualification** — rejected: it would turn a
  self-declared map into false evidence.
- **Let Buildchain own documentation semantics** — rejected: Buildchain can
  attest exact roots and executions, but cannot author or reinterpret project
  claims.
