---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0076
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/745, https://github.com/kungfu-systems/kungfu/pull/746, https://github.com/kungfu-systems/kungfu/pull/750]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/750
qualification_refs: [docs.contract.json, scripts/check-docs.test.mjs, scripts/document-metadata-contract.test.mjs]
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: ongoing
theme: documentation-directory-authority
confidence: high
evidence_grade: A
last_reviewed: 2026-07-13
---

# ADR-0076: Documentation directory authority

- Status: accepted and implemented
- Date: 2026-07-13
- Scope: public documentation topology, navigation authority, metadata routing,
  and publication reachability
- Related: [ADR-0074](ADR-0074-canonical-adr-authority-and-lifecycle-audit.md)
  establishes the unified architecture-decision authority used by this
  hierarchy.

## Context

Kungfu's public documentation grew from a small set of pages into dozens of
concept, guide, architecture, profile, qualification, development, and research
documents. `docs/README.md` and `docs/MAP.md` provided reader routes, but almost
every canonical page still lived directly under `docs/`. The physical layout no
longer expressed ownership, made placement depend on maintainer memory, and
made a directory listing harder to use as the product surface expanded.

Kungfu has not published an alpha release or established an external
documentation-path contract. Preserving speculative compatibility paths would
therefore create a real maintenance surface for users and links that do not yet
exist. The repository should express the intended information architecture
directly and acquire compatibility obligations only when a released surface
actually creates them.

## Decision

`docs/README.md` and `docs/MAP.md` are the only canonical Markdown entry files
at the `docs/` root. Canonical documents live under responsibility directories:

- `concepts/` owns the product mental model and vocabulary;
- `guides/` owns task-oriented use and operation;
- `architecture/` owns current system structure;
- `profiles/` owns domain and agent-work compositions above the neutral core;
- `qualification/` owns guarantees, limits, and retained evidence;
- `development/` owns construction, toolchain, versioning, release, and docs
  governance;
- `research/` owns spikes and measured options that are not operative guidance;
- `adr/` and `shifu/` retain their existing decision and development-contract
  authorities.

Repository-local design, qualification, and development documents formerly
stored under `framework/core/docs/` move into the same responsibility
directories. The old Core docs root and the former `docs/shifu/adr/` root are
retired completely: they contain no Markdown redirects, indexes, or secondary
metadata authorities.

Each responsibility directory has a `README.md` index. The root guide links to
every index, and canonical pages link directly to canonical pages.

No other Markdown file may exist directly under `docs/`. Former flat paths are
removed, not represented by redirect documents. If a future released
publication surface establishes stable inbound URLs, redirects belong to that
publication layer and require their own measured compatibility policy; they do
not recreate a second Markdown surface in the source repository.

`docs.contract.json` is the executable topology authority. The documentation
gate rejects undeclared canonical directories, every undeclared root Markdown
page, missing section routes, and any Markdown under a retired documentation
root.

## Consequences

- Readers and agents can browse by responsibility before consulting the
  exhaustive question map.
- Maintainers have a deterministic placement rule and cannot silently recreate
  the flat root.
- The repository carries no speculative redirect inventory or duplicate path
  surface before a release creates a compatibility obligation.
- A future release may deliberately establish stable publication URLs, but
  that decision must define ownership, measurement, and retirement separately.
- Moving a document now requires updating its section index and machine
  contracts, which adds bounded ceremony in exchange for long-term clarity.

## Qualification

Implementation qualification must prove document conservation, direct
canonical navigation, metadata authority uniqueness, publication reachability,
and negative fixtures for every undeclared or retired-root Markdown path.

PR [#745](https://github.com/kungfu-systems/kungfu/pull/745) implements the
canonical moves, section indexes, metadata routing, publication graph, and
initial placement fixtures. PR
[#746](https://github.com/kungfu-systems/kungfu/pull/746) removes the
speculative compatibility facade, makes the root rule absolute, and strengthens
the retired ADR-root fixtures. PR
[#750](https://github.com/kungfu-systems/kungfu/pull/750) moves the remaining
Core documents and retained qualification evidence into this taxonomy, removes
the ADR redirect trees, and makes both retired roots fail closed. The
deterministic documentation gate is the retained qualification surface.
