---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0008
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1006, https://github.com/kungfu-systems/kungfu/pull/1010, https://github.com/kungfu-systems/kungfu/pull/1011, https://github.com/kungfu-systems/kungfu/pull/1012, https://github.com/kungfu-systems/kungfu/pull/1037]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1012
qualification_refs: [scripts/shifu-documentation-surfaces.test.mjs, scripts/verify-agent-pack.mjs, scripts/documentation-product-pack.test.mjs, scripts/shifu-documentation-consumers.test.mjs, scripts/shifu-documentation-qualification.test.mjs, docs/qualification/documentation-control-plane.json, scripts/check-shifu-documentation-contract.mjs, scripts/source-acceptance.mjs, xinfa/src/lib.rs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: human-surface-closure
confidence: high
evidence_grade: B
last_reviewed: 2026-07-18
---

# SHIFU-ADR-0008: Human surface closure and Xinfa impact authority

- Status: accepted
- Date: 2026-07-17
- Scope: repository human surfaces, authoring lifecycles, implementation
  bindings, KFD-1 drift, and KFD-3 route inputs
- Related: [SHIFU-ADR-0006](./SHIFU-ADR-0006-documentation-protocol-and-provider-boundary.md),
  [ADR-0093](./ADR-0093-xinfa-dual-first-verified-context-contract.md), and
  [ADR-0095](./ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md)

## Context

The Documentation Protocol accepts exact project-owned providers, but its first
Kungfu submission described only a small set of canonical documentation
authorities. That compatibility map did not close every tracked README, guide,
runbook, ADR, research record, example, CLI help surface, GUI message, recovery
message, or Agent entrypoint. A new file could therefore remain outside the
control plane even though the existing project-specific documentation checks
were green.

Xinfa already owns the canonical Context IR, Atlas compiler, revision-aware
dependencies, impact calculation, and dual-first route parity. Reimplementing
those semantics inside Shifu would create a second graph and make KFD-1 depend
on which command happened to run.

## Decision

Shifu owns a project-independent human-surface policy and deterministic
inventory adapter. A project classifies every discovered tracked text surface
as `generated`, `managed-block`, `authored`, `historical-append-only`, or
`non-claim`; each class declares its document profile, verification profile,
visibility, owner, and waiver state. Product copy and machine-facing help that
do not use text-document extensions enter through explicit exact paths.
Discovery finds candidates but never grants authority. The resulting provider
manifest contains only exact repository-relative paths, their byte revisions,
and stable node identities. An eligible unclassified surface, unknown route
entrypoint, duplicate identity, or non-exact path fails closed.

Shifu does not own a documentation truth graph. The adapter submits document
and explicitly bound subject, claim, implementation, probe, or evidence nodes
to Xinfa's public project contract. A binding carries the target's observed
revision and the document's expected revision dependency. Xinfa alone compiles
the Atlas, propagates stale or invalidated status, computes bounded impact, and
projects routes. Shifu receipts retain both inventory and Xinfa roots and remain
diagnostic and non-qualifying.

Human and Agent routes are inputs over the same generated node set. This slice
requires exact node-set parity; later task-specific selection may present a
bounded subset only through Xinfa and must retain the same authority root, cut,
status, evidence, and invalidations.

## Authoring boundary

- Generated documents may be replaced only by their declared generator.
- Managed blocks may be refreshed only inside declared machine-owned regions.
- Authored documents require human or mixed review for semantic changes.
- Historical records are append-only; later conclusions supersede rather than
  rewrite their evidence.
- Non-claims remain readable and discoverable but cannot be promoted to
  current evidence by prose similarity or schema validity.

The inventory and graph may diagnose any class. They do not authorize an Agent
to rewrite authored or historical prose.

## Consequences

- Adding a tracked human-readable file without a classification fails source
  acceptance instead of silently widening an ungoverned corpus.
- Documentation-only and implementation- or evidence-bound changes have deterministic roots
  and queryable impact without asking every consumer to scan the repository.
- Initial implementation bindings are intentionally explicit and bounded.
  Missing semantic edges remain visible migration debt rather than inferred
  relationships.
- Existing Kungfu `docs:check` remains authoritative for project taxonomy,
  metadata, links, and executable examples. The Shifu adapter composes it; it
  does not reinterpret or weaken it.
- Product delivery selects one content-addressed public Xinfa Atlas, stages its
  exact bytes during assembly, and exposes only a verifying read-only runtime.
  The existing Agent onboarding pack remains an owned compatibility alias for
  onboarding documents and skills, not a Context IR, selector, or compiler.
- Buildchain consumes a project-owned KFD-1 documentation witness. It binds the
  immutable release target and artifact bytes to Atlas, pack, cut, claim-graph,
  manifest, and qualification roots while retaining only attestation authority.
- The generic compiler is qualified against engineering and publication-shaped
  consumers. Their lifecycle and route differences are declarations; neither
  adds Kungfu fields nor modifies Xinfa source.

## Alternatives considered

- **Treat only `README.md` and `docs/**` as documentation** — rejected because
  product copy, help, recovery, examples, Agent surfaces, and operational
  records are also human-readable authority surfaces.
- **Infer claim and implementation edges from prose or filenames** — rejected
  because discovery cannot safely grant semantic authority.
- **Build a Shifu graph beside Xinfa** — rejected because roots, impact, stale
  propagation, and route parity would diverge.
- **Auto-rewrite every stale document** — rejected because detection is not
  authorization and most semantic prose requires review.
