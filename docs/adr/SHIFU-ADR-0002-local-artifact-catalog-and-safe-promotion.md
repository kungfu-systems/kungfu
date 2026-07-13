---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0002
decision_status: accepted
implementation_status: partial
implementation_commits: [c0ae2970240ce3bb2ff2320065797899e28a69ea]
review_state: unreviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: shifu-local-artifact-catalog
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# SHIFU-ADR-0002: Local artifact catalog and safe promotion

- Status: accepted; development implementation
- Date: 2026-07-13
- Scope: Shifu launcher and locally registered Kungfu product artifacts
- Related: [ADR-0044](./ADR-0044-shifu-delegation-protocol.md) and
  [SHIFU-ADR-0001](./SHIFU-ADR-0001-cache-profile-contract-and-ownership.md)

## Context

Shifu has two local promotion paths. `self-update` replaces the installed Shifu
binary from checkout source, a release, or a launcher cache slot. `builds` and
`promote` list and install registered Kungfu product artifacts. Both paths
currently treat recency as authority: launcher slots use filesystem modification
time and product builds use timestamped slot names.

Recency is not Git history. A newer build time can belong to an older or
divergent feature branch. It can therefore silently replace a descendant that
was already installed. The existing records also expose different provenance:
product builds record branch and worktree, while Shifu generations record only
version, commit, channel, and archive time.

## Decision

Shifu owns one versioned local artifact catalog contract shared by launcher and
product promotion. Product-specific code remains responsible for building and
installing bytes; the shared substrate owns identity, provenance, Git relation,
candidate disposition, display, retention state, and promotion receipts.

Each record identifies its product, artifact kind, version, digest, source
commit, build-time branch, repository, worktree/build path, dirty state,
platform, timestamps, lifecycle state, and available promotion provenance.
Missing legacy fields remain explicit rather than inferred.

Candidate resolution compares the candidate commit with the installed commit:

- `same` is idempotent;
- one unique `descendant` may advance automatically;
- `ancestor`, `diverged`, `unknown`, ambiguous, and invalid artifacts are
  manual-only or unusable and never win through timestamp ordering;
- an explicit override names the artifact and acknowledges non-linear history;
- rollback-only generations never re-enter automatic candidate selection.

After a successful descendant promotion, strict ancestor build slots become
`superseded` and leave the automatic candidate pool. Implementations may remove
superseded build slots under their bounded retention policy. Rollback
generations remain a separate bounded ledger so pruning candidates does not
erase the immediate recovery path.

Human list output is compact by default but must remain identifying. Long
branches use middle truncation: preserve the branch-kind prefix, at least twelve
characters after it, and a useful suffix. `--no-truncate` prints full branch
names; `--verbose` adds full local paths and digests; `--json` emits the exact
catalog contract.

The canonical schema is
[`local-artifact-catalog-v1.schema.json`](../shifu/schema/local-artifact-catalog-v1.schema.json).
Local paths are allowed in explicitly local output. Portable or externally
reported receipts redact them to path digests.

## Compatibility

Legacy `meta.env` slots remain readable. New optional provenance keys are
additive. Missing repository, branch, digest, or installed-receipt fields yield
`unknown` relation and fail closed for automatic promotion. The catalog schema
major version changes if field meaning or candidate safety semantics change.

## Consequences

- Developers can distinguish builds without reconstructing worktree history.
- A newer wall-clock build cannot silently override Git ancestry.
- `self-update` and `builds/promote` share one mental model and test matrix.
- Local paths are diagnostic provenance, not portable identity.
- Existing cache directories remain disposable implementation storage; the
  catalog is evidence about artifacts, not a second source repository.

## Alternatives considered

- **Keep per-command metadata and improve formatting only** — rejected because
  the unsafe selection rule would remain duplicated.
- **Treat build time as the version order** — rejected because branches are not
  linearly ordered by time.
- **Delete all older artifacts after promotion** — rejected because candidates
  and rollback generations have different recovery responsibilities.
- **Always require an explicit artifact id** — rejected because a unique Git
  descendant is safe and should remain convenient.
