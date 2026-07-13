---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0056
decision_status: accepted
implementation_status: implemented
implementation_commits: [b7b0f2ce6776d19d7bcd12046870827f4f417fb0]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/572]
closure_commit: b7b0f2ce6776d19d7bcd12046870827f4f417fb0
review_state: maintainer-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-11
theme: legacy-journal-cli-retirement
confidence: high
evidence_grade: A
last_reviewed: 2026-07-11
---

# ADR-0056: journal lifecycle management belongs to Storage and Episode boundaries

- Status: accepted; implemented
- Date: 2026-07-11
- Category: runtime storage / CLI / fact lifecycle
- Related: [ADR-0018](ADR-0018-runtime-storage-service-architecture.md),
  [ADR-0033](ADR-0033-episode-causal-segment-object.md),
  [ADR-0042](ADR-0042-episode-atomic-safety-and-qualification.md), and
  [ADR-0055](ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md)

## Context

The Python CLI still exposed `kungfu journal clean`, `archive`, and
`list-archive` after the semantic Session surface was retired. Those commands
treated journal pages as loose files: `clean` globbed and removed every matching
page, while `archive` copied frames into date-based KFA directories and then
pruned live journals and logs. They did not preserve Episode closure, manifests,
content-store reachability, fsck evidence, an atomic plan/apply boundary, or a
deletion receipt.

The implementation also kept an otherwise unused `ArchiveSink`, KFA prefix,
generic prune helpers, a top-level CLI `archive_dir`, and an `archive_dir` field
in the Storage layout response. Keeping that second lifecycle path would make
the Storage/Episode authority decision optional in practice.

## Decision

1. The legacy `journal` CLI group is retired without aliases or a compatibility
   facade. The yijinjing journal reader, writer, mmap layout, replay engine, and
   capability SDK ledger remain product foundations; only the file-oriented
   lifecycle management surface is removed.
2. KFA archive assembly and direct journal-page pruning are removed, together
   with their exclusive Python helpers and layout fields. Existing files in a
   user's `archive/` directory are left untouched. Kungfu does not silently
   convert or delete them.
3. Inspection uses Episode-aware or proof-carrying surfaces: `kungfu query`,
   `kungfu storage query`, the capability SDK ledger, and the journal inspection
   view. Export, verification, and repair use `kungfu storage export`, `fsck`,
   and `repair`.
4. `storage gc --dry-run` and `storage compact --dry-run` remain planning
   surfaces in this release. They are not represented as executable retention.
   A future destructive retention operation must be owned by Storage, require
   explicit plan and `--dry-run`/`--execute` phases, preserve Episode integrity,
   and emit a deletion receipt. It must not revive `journal clean`.
5. Log retention is a separate operational concern. It must not be coupled to
   journal authority through a combined archive command.

## Explicit boundary

Backtest startup may clear the backtest location's own ephemeral scratch
journals before execution. That mode-local initialization is not retention of a
retained live Episode and is not exposed as an operator command. Any expansion
of that exception to live/data/replay facts requires a new decision and Storage
ownership.

## Enforcement

`scripts/check-journal-authority-boundary.mjs` blocks the retired command,
ArchiveSink/KFA/prune implementation, legacy layout fields, Session surfaces,
and destructive Python CLI code that names journal paths. The journal-manager
extension has a real TypeScript check in both its build and the shared source
gate, so ReplayAnchor contract drift cannot be hidden by esbuild transpilation.

## Consequences

- Journal remains the append-only data plane; Episode and Storage own lifecycle
  semantics above it.
- There is no built-in command that destructively cleans retained journal facts
  in this release. This is an intentional fail-closed gap, not an implied
  archive feature.
- Existing KFA archives become unmanaged legacy artifacts. Users decide whether
  to retain or remove them outside Kungfu; source upgrades never mutate them.
- The public CLI loses pre-stable commands and the Storage layout loses a
  non-authoritative `archive_dir` field. KFD-1 records this as a pre-release
  breaking cleanup of the `kungfu-cli` and runtime storage surfaces.
