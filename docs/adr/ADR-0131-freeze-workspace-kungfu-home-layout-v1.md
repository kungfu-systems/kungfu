---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0131
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1207]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: workspace-kungfu-home-layout-v1
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
---

# ADR-0131: Freeze workspace `.kungfu` home layout v1

- Status: accepted; implementation staged in PR #1207
- Date: 2026-07-21
- Category: workspace persistence / compatibility
- Related:
  [ADR-0018](ADR-0018-runtime-storage-service-architecture.md),
  [ADR-0033](ADR-0033-episode-causal-segment-object.md),
  [ADR-0034](ADR-0034-yijinjing-episode-manifest-journal.md),
  [ADR-0035](ADR-0035-workspace-local-kungfu-data-home.md),
  [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md),
  [ADR-0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md)

## Context

ADR-0035 made workspace-local `.kungfu/` the default fact-ledger home, but the
home had no complete, machine-readable persistence inventory. The existing
`kungfu.workspace.episode-layout/v1` projection covered the storage kernel and
some coordinator paths while omitting observed product roots such as
`skill-manager`, `agent-session`, `skill-context`, `db`, `nn`, `map`, `log`,
`ownership`, `backtest`, and `first-party.json`. It also did not distinguish
restart-critical bytes from process state or rebuildable caches.

Two adjacent format surfaces were similarly implicit. The journal epoch was
derived from the C++ header layout but not pinned to a reviewed declaration, and
`first-party.json` carried only `version: 1`, unlike other home JSON envelopes
with a schema identity.

This decision freezes the first complete layout. “Durable” here means that
deleting the path can lose accepted workspace state, source material, trust
configuration, or continuity evidence. It does not by itself promise a
particular fsync profile or mean that Git tracks the path. “Ephemeral” means
process-local coordination that may be removed after its owner exits. “Cache”
means reconstructible diagnostics, projection, or compiled state whose
authority lives elsewhere.

## Decision

### 1. The v1 layout is the following declared inventory

Container rows declare stable path ownership. A more specific child row
overrides the container persistence class.

| Path relative to `.kungfu/` | Persistence | Authority / purpose |
| --- | --- | --- |
| `.gitignore` | durable | workspace publication and local-state exclusion policy |
| `config.json` | durable | workspace configuration override |
| `first-party.json` | durable | build-generated KFX trust manifest |
| `extensions/` | durable | installed workspace KFX packages |
| `inbox/` | durable | local source material not yet admitted |
| `dataset/` | durable | workspace datasets |
| `backtest/` | durable | workspace backtest results |
| `backups/` | durable | runtime recovery backups |
| `private/` | durable | ignored workspace-private material |
| `cache/` | cache | rebuildable workspace cache |
| `locks/` | ephemeral | workspace advisory locks |
| `projections/` | cache | rebuildable workspace projections |
| `contract/` | durable | portable workspace contract input |
| `missions/` | durable | low-frequency workspace mission input |
| `skills/` | durable | installed workspace skills |
| `skill-bindings/` | durable | workspace skill enablement bindings |
| `episodes/` | durable | sealed Git-provider Episode material, when that provider is selected |
| `project-cuts/` | durable | published Project Cut material |
| `runtime/` | durable container | live runtime tree; child declarations control deletion policy |
| `runtime/journal/<layout>/<role>/<namespace>/<name>/<mode>/*.journal` | durable | yijinjing event, Fact, and Episode authority |
| `runtime/db/` | durable | yijinjing database layout |
| `runtime/nn/` | ephemeral | process communication endpoints |
| `runtime/map/` | ephemeral | shared-memory mappings |
| `runtime/log/` | cache | runtime diagnostic logs |
| `runtime/ownership/` | ephemeral | live writer/reader ownership locks |
| `runtime/coordinator/` | durable container | continuity tree; child declarations control deletion policy |
| `runtime/coordinator/state.json` | durable | runtime continuity state |
| `runtime/coordinator/assessments.json` | durable | continuity assessment facts |
| `runtime/coordinator/runtime-continuity.json` | durable | runtime continuity record |
| `runtime/coordinator/continuity-locks/` | ephemeral | live continuity lock table |
| `runtime/coordinator/continuity-locks/locks.guard` | ephemeral | lock-table advisory guard |
| `runtime/coordinator/coordinator.pid` | ephemeral | live process identity |
| `runtime/coordinator/coordinator.log` | cache | coordinator diagnostics |
| `runtime/skill-manager/default.json` | durable | skill installation and enablement state |
| `runtime/agent-session/` | durable | agent session and capsule continuity state |
| `runtime/skill-context/<profile>.json` | cache | compiled skill context |
| `runtime/project-cut-go/` | cache | rebuildable local Project Cut coordination context |
| `runtime/episode-provider/` | ephemeral | live Git Episode provider leases |
| `runtime/full-evidence/` | durable | admitted full Episode evidence receipts |
| `runtime/rewind/` | durable | Rewind run bundles and retained evidence |
| `runtime/work/` | durable | work-store schema bindings and manifests; work facts remain in the journal |
| `runtime/agent/` | durable | workspace agent policy |
| `runtime/skill-audit.jsonl` | durable | workspace skill audit trail |
| `runtime/sources/sources.json` | durable | workspace source registry |
| `runtime/peers/<peer-id>/` | durable container | peer launch, identity, readiness, and continuity state |
| `runtime/peers/<peer-id>/peer.log` | cache | peer diagnostics |
| `runtime/peers/<peer-id>/locks/` | ephemeral | live peer lifecycle locks |
| `runtime/coordination/` | ephemeral | same-host named lock table and guard |
| `runtime/admission/` | durable | Episode admission state and receipts |
| `runtime/fact-durable-admission/` | durable | durable Fact ingest state and receipts |
| `runtime/receipts/libwasm/` | durable | runtime qualification and execution receipts |
| `runtime/master/master.pid` | ephemeral | legacy coordinator process identity |
| `runtime/storage/` | durable container | runtime storage service tree |
| `runtime/storage/manifests/<hash-prefix>/<sha256>` | durable | accepted manifest entry documents |
| `runtime/storage/payloads/<hash-prefix>/<sha256>` | durable | content-addressed payload bodies |
| `runtime/storage/schemas/<hash-prefix>/<sha256>` | durable | content-addressed schemas |
| `runtime/storage/rocksdb/` | durable | optional authoritative provider database |
| `runtime/storage/backend-binding.json` | durable | authoritative provider selection |
| `runtime/storage/backend-switch-state.json` | durable | in-progress provider migration state |
| `runtime/storage/backend-switch-receipts/` | durable | provider migration receipts |
| `runtime/storage/backend-switch.lock` | ephemeral | live provider migration operation lock |
| `runtime/storage/backend-authority.lock` | ephemeral | live provider authority lock |
| `runtime/storage/projections/*.sqlite` | cache | rebuildable query projections |
| `runtime/remotes/<source-id>/runtime/` | durable | accepted source mirrors |
| `runtime/atlas/store/` | durable | locally accepted Atlas mirror |

The typed `entries` array in `kungfu.workspace.episode-layout/v1` is the
machine-readable ownership-root projection of this table; the existing `paths`
object retains the more specific journal, mirror, and content-addressed path
patterns. Existing `paths`, `episodes`, and `ownership` fields remain valid.
`entries` and `coverage` are additive v1 fields; no existing reader needs to
consume them.

`coverage` always inspects the explicit runtime, storage, and coordinator
namespaces. For the standard `<home>/runtime` placement it also inspects the
immediate home namespace. A nonstandard runtime never causes its unrelated
parent or the separately declared home to be scanned. An observed unknown name
is conservatively reported as an
`unclassified_durable_candidate`; it is never guessed to be disposable.
`kungfu storage layout --verify --json` exits non-zero while such a candidate
exists. Dynamic names below declared pattern roots remain governed by the
pattern declaration.

### 2. Compatibility inside v1 is additive-only

Within layout v1:

- a new optional path, JSON field, or typed entry may be added with an explicit
  persistence class and authority;
- existing paths, field names, persistence classes, and meanings may not be
  renamed, removed, narrowed, or reinterpreted;
- making a cache or ephemeral path durable is a semantic change because old
  cleanup tools may delete it;
- a breaking change requires layout v2, an explicit migration and rollback
  path, retained fixtures, and a reader refusal or negotiated compatibility
  rule. It never silently reuses v1.

The contract describes path and recovery semantics. Strong write durability is
still governed by the separately qualified durability profiles.

### 3. Journal wire v1 has a declared epoch

The v1 `page_header` plus `frame_header` layout is declared as:

```text
journal_format_epoch = 0xe3b24c8d (3820113037)
```

The compiler still derives a fingerprint from every reflected field name, type,
order, size, and alignment. A `static_assert` now requires that derived value
to equal the declaration. A header edit therefore fails the build with an
instruction to declare a new epoch and provide the migration path. This
strengthens ADR-0062: derivation detects drift; the declaration makes accepting
that drift an explicit compatibility decision. Live readers still refuse
cross-epoch pages and no wire bytes change in this freeze.

### 4. `first-party.json` has one schema identity

The manifest envelope is:

```json
{
  "schema": "kungfu.first-party-manifest/v1",
  "version": 1,
  "keys": {}
}
```

The build generator, TypeScript type, KFX contract validator, standalone JSON
Schema, and consumers use the same schema string. A different or unknown schema
fails closed and grants no first-party trust. For read compatibility only, the
consumer recognizes the exact pre-freeze envelope (`version: 1`, object
`keys`, no `schema`) and normalizes it to this schema before validation. Every
newly generated or rewritten manifest carries the explicit schema, so existing
homes retain their trust set without perpetuating schema-less writes.

### 5. `.kungfu` and `.xinfa` remain separate authority roots

ADR-0097 section 7 remains in force. The concise boundary is:

- `.xinfa/` is the Git-published Xinfa semantic/provider input surface:
  project declarations, policies, routes, projection recipes, promoted
  manifests, Project Cut manifests, and reviewed submissions.
- `.kungfu/` is the workspace Fact/Episode/runtime surface. Live journals,
  locks, payload CAS, private/raw input, runtime mirrors, projections, caches,
  and process state never move into `.xinfa/`.
- Xinfa declarations and promoted input manifests never move into ignored
  `.kungfu/runtime/`.

There is one deliberate nuance. ADR-0097 permits low-frequency, selected
Git-provider material under `.kungfu/`, including `.kungfu/episodes/`,
`.kungfu/project-cuts/`, and the local `.kungfu/.gitignore`. Those tracked
publication artifacts are not live runtime storage and do not collapse the two
roots. All ordinary home data remains ignored; `.kungfu/runtime/`, private
material, caches, and temporary Episode staging are explicitly ignored.

### 6. `.xinfa` tracked/ignored audit and target classification

The 2026-07-21 audit found 869 tracked files using 556 MiB:

| Subtree | Tracked files | Size | Target class |
| --- | ---: | ---: | --- |
| `project.json`, `dogfood-project.json`, `product-documentation-pack.json` | 3 | 48 KiB | tracked semantic declarations |
| `projection-recipes/` | 1 | 4 KiB | tracked recipe |
| `manifests/` | 95 | 380 KiB | tracked promoted manifests / Project Cuts |
| `submissions/` | 10 | 628 KiB | tracked reviewed submissions |
| `baselines/sha256/` | 760 | 555 MiB | ignored immutable store in the target policy; currently tracked legacy debt |

Future `.xinfa/generated/`, `.xinfa/cache/`, `.xinfa/indexes/`, and
`.xinfa/tmp/` are ignored generated state. `baselines/sha256/` is also an
immutable store under ADR-0097 and belongs in the ignored class once a
replacement fetch, integrity, offline-recovery, and retention policy exists.
This ADR does not remove its 760 already tracked files: doing so without that
recovery design would break existing cuts and Stage-0 inspection. The migration
requires a separate decision and goal.

## Verification

- Build the mmap tests: the declared epoch assertion and retained
  `journal-wire-v1.json` fixture must agree.
- Run the typed storage tests: all required entry classes must be present, and
  an injected unknown runtime directory must make `coverage.complete` false.
- Run `kungfu storage layout --verify --json` against a workspace home. Unknown
  top-level, runtime, storage, or coordinator roots must fail closed.
- Generate a first-party manifest and validate it against both
  `firstPartyManifestSchema` and
  `framework/kfx/schema/first-party-manifest.schema.json`.
- Run the existing Python/Node storage parity and TUI KFX parity tests.

## Consequences

- Embedders and agents can make restart, cleanup, backup, and migration choices
  from one typed inventory instead of naming conventions.
- New roots require an explicit persistence decision; unknown roots are treated
  as possible durable data.
- v1 now carries a real compatibility cost. That cost is intentional: layout
  stability is part of the workspace fact contract.
- The `.xinfa` baseline size debt is visible and classified without performing
  an unsafe storage migration in this change.
