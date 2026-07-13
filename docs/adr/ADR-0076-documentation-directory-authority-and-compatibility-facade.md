---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0076
decision_status: accepted
implementation_status: not-started
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: ongoing
theme: documentation-directory-authority-and-compatibility-facade
confidence: high
evidence_grade: A
last_reviewed: 2026-07-13
---

# ADR-0076: Documentation directory authority and compatibility facade

- Status: accepted
- Date: 2026-07-13
- Scope: public documentation topology, navigation authority, metadata routing,
  publication reachability, and inbound-link compatibility
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

Moving files without a compatibility policy would break inbound GitHub links.
Keeping canonical content at both old and new paths would preserve links but
create two authorities. A hierarchy therefore needs both a canonical placement
rule and a bounded compatibility representation that cannot regain semantic
ownership.

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

Each responsibility directory has a `README.md` index. The root guide links to
every index, and canonical pages link directly to canonical pages.

Former flat `docs/*.md` paths are temporary `document-redirect` compatibility
documents. A redirect:

- declares exactly one repository-relative `moved_to` target;
- points directly to an existing canonical document below a section directory;
- cannot chain through another redirect;
- cannot carry decision, implementation, or independent lifecycle authority;
- may remain unreachable from canonical navigation because its purpose is to
  receive old inbound links.

`docs.contract.json` is the executable topology authority. The documentation
gate rejects undeclared canonical directories, new flat canonical pages,
missing section routes, invalid or stale redirects, and canonical links that
route through the compatibility facade.

## Consequences

- Readers and agents can browse by responsibility before consulting the
  exhaustive question map.
- Maintainers have a deterministic placement rule and cannot silently recreate
  the flat root.
- Existing inbound repository links continue to resolve without creating a
  second content or metadata authority.
- The root directory still contains small compatibility files during the
  transition. They are deliberately non-canonical and may be retired only when
  a publication layer provides equivalent redirects and measured inbound-link
  compatibility no longer requires the repository facade.
- Moving a document now requires updating its section index and machine
  contracts, which adds bounded ceremony in exchange for long-term clarity.

## Qualification

Implementation qualification must prove document conservation, direct
canonical navigation, old-path compatibility, metadata authority uniqueness,
publication reachability, and negative fixtures for flat placement, redirect
chains, and canonical-to-redirect links.
