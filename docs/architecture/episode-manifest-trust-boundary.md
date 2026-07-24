# Episode manifest trust boundary: field-to-claim map, fold semantics, and the writer/recovery contract

This document is the KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae stage gate artifact. It proves the existing
KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692 v1 record family can express every trust-boundary claim KF-ADR-019f86da-4f90-791c-9b90-4888cca36327
assigns to the Episode manifest, defines the deterministic typed fold
semantics that stage 1 implements, and specifies the manifest writer
ownership and crash-recovery contract that stage 2 must fixture-test before
any automatic lifecycle wiring lands.

Authority order: the append-only yijinjing journal of POD records is the
authority; the typed C++ fold is the canonical in-memory derivation; JSON is
an edge projection only (CLI, export, binding return values).

## 1. Field-to-claim map (KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692 v1 records → KF-ADR-019f86da-4f90-791c-9b90-4888cca36327/0041 claims)

The v1 record family (`framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/types.h`):

| Record | Tag | Key fields |
| --- | ---: | --- |
| `EpisodeOpen` | 10801 | `schema_version`, `episode_id`, `parent_episode_id`, `root_trigger_frame_uid`, `location_uid`, `begin_time`, `title[64]`, `actor[64]`, `source[64]` |
| `EpisodeHeartbeat` | 10802 | `schema_version`, `episode_id`, `location_uid`, `update_time`, `last_frame_uid`, `frame_count`, `note[64]` |
| `EpisodeFrameAttached` | 10803 | `schema_version`, `episode_id`, `location_uid`, `frame_uid`, `trigger_frame_uid`, `stream_id`, `gen_time`, `trigger_time`, `carrier_type`, `source`, `dest`, `data_length`, `integrity_version`, `payload_checksum`, `frame_checksum` |
| `EpisodeRefAttached` | 10804 | `schema_version`, `episode_id`, `location_uid`, `ref_kind`, `ref_uid`, `update_time`, `ref_id[128]`, `ref_hash[128]` |
| `EpisodeClosed` | 10805 | `schema_version`, `episode_id`, `location_uid`, `status`, `end_time`, `last_frame_uid`, `frame_count`, `reason[64]` |

Mapping each KF-ADR-019f86da-4f90-791c-9b90-4888cca36327 trust-boundary claim onto that record set:

| Trust-boundary claim | Carried by | Verdict |
| --- | --- | --- |
| Episode identity | `EpisodeOpen.episode_id` (u64, primary key of the object); every subsequent record repeats `episode_id` | representable |
| Manifest version | `schema_version` (u32) present on every record; store-level constant `kungfu.episode.manifest/v1` | representable |
| open / sealed / tombstoned status | presence of `EpisodeOpen` = open; `EpisodeClosed.status` ∈ {Ended, Aborted, Tombstoned}. Tombstone is a later `EpisodeClosed` append with `status=Tombstoned`, never an in-place edit | representable (fold rule §2.3) |
| frame membership | one `EpisodeFrameAttached` per frame, id-level (`frame_uid`), carrying the frame receipt (checksums, integrity version, stream, times). Range-compressed membership is a future optimization, not required for the claim | representable |
| payload inventory + content hashes | `EpisodeRefAttached` with `ref_kind=Payload`; `ref_hash` is the content identity and the resolution key: fsck resolves the ref through the KF-ADR-019f86da-4f90-738c-b372-e509976f69ff immutable `content_store` (namespace `payloads`) by this hash; `ref_id` is an edge label recording the bytes' runtime-relative origin, with no resolution role. Canonical `ref_hash` form is `<algo>:<hex>` (e.g. `sha256:...`, written by `episode_lifecycle.attach_payload_ref`); bare hex from earlier producers is accepted as the store's default algorithm. Per-frame payload checksums additionally live on `EpisodeFrameAttached.payload_checksum` | representable; hash-algo prefix is a producer convention, not a schema change |
| schema inventory | `EpisodeRefAttached` with `ref_kind=Schema` (`ref_id` = schema id, `ref_hash` = `.bfbs` content hash) | representable |
| source and location provenance | `EpisodeOpen.source` / `actor` / `title`; `location_uid` on every record | representable |
| declared dependency Episode ids | `EpisodeOpen.parent_episode_id` plus `EpisodeRefAttached` with `ref_kind=Episode` (`ref_uid` = episode id, optional `ref_id`/`ref_hash` for externally-held Episodes) | representable |
| declared external input frames | `EpisodeRefAttached` with `ref_kind=InputFrame` (`ref_uid` = frame uid); `EpisodeOpen.root_trigger_frame_uid` for the opening trigger | representable |
| causal closure (KF-ADR-019f86da-4f90-791c-9b90-4888cca36327 core invariant) | derivable: `EpisodeFrameAttached.trigger_frame_uid` edges must resolve inside the Episode's frame set or be declared as `InputFrame` refs / Episode dependencies. Closure is a checked property of the fold, not a stored field | representable (checked, not stored) |
| rebuildable projection / query indexes | not stored in the manifest by design — projections are derived from the journal and verified against it (KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae point 5) | n/a (satisfied structurally) |
| hash roots / sync roots for fsck/export/import | **delivered by KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9**: `EpisodeRootCommitted` (carrier `10806`, additive) records the sealed Episode's content root — a linear chain over the owned claim sequence — appended by the seal path as the final claim. fsck recomputes and verifies it; inspect exposes recorded/computed/match; absence (pre-KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9 data, or a crash between seal and root append) is reported honestly, never failed | representable (KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9) |

Conclusion required by KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae: the existing record set is sufficient for
every claim this slice needs. The one claim that was not representable in the
original v1 set (Episode hash/sync roots) has since been closed by KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9's
additive `EpisodeRootCommitted` record — the schema-version ADR this map
originally deferred to. Content-ref resolution (stage 4, delivered) resolves
through KF-ADR-019f86da-4f90-738c-b372-e509976f69ff's immutable `content_store` and changed no record layout.

## 2. Deterministic typed fold (stage 1 semantics)

The fold consumes the manifest journal in append order (journal frame order)
and derives one typed current view per `episode_id`. JSON appears only when
an edge (CLI/binding/export) renders the view.

### 2.1 Record decoding

- A manifest frame whose `carrier_type` matches a v1 record tag and whose
  `schema_version` ≤ 1 decodes into its typed POD record. Each decoded record
  keeps its manifest provenance (`manifest_frame_uid`, `manifest_gen_time`).
- A frame with an unrecognized `carrier_type` is an **unknown record**: it is
  preserved in the typed stream with provenance and carrier type, counted in
  totals, and never folded into any Episode view.
- A frame with a known `carrier_type` but `schema_version` > 1 is an
  **unknown-version record**: its layout cannot be assumed, so it is treated
  like an unknown record (no field, including `episode_id`, is decoded from
  it). Unknown/unknown-version records are counted on the typed fold and
  reported by fsck as `manifest_unknown_records` (stage 3). Either way a
  newer writer does not brick an older reader.

### 2.2 Fold order and grouping

- Records fold strictly in append order; the fold is a pure function of the
  journal content, so any two readers derive the same view.
- Records group by `episode_id`. A record whose `episode_id` is 0 folds
  nowhere (counted on the fold; fsck reports it as
  `manifest_record_episode_id_missing`, stage 3).
- Records may legitimately arrive for an `episode_id` with no `EpisodeOpen`
  (e.g. the open lives in a deleted page). The view exists with
  `opened=false` and status `dangling`; fsck reports `episode_open_missing`.

### 2.3 Duplicate and conflict rules

- `EpisodeOpen`: the **first** open wins the identity fields (id, parent,
  root trigger, times, title/actor/source, provenance). Later opens for the
  same id are counted; fsck reports `episode_open_duplicate`. Identity is
  immutable once appended — an append-only journal cannot re-open an object.
- `EpisodeHeartbeat`: each heartbeat overwrites the watermark fields
  (`update_time`, `last_frame_uid`, claimed `frame_count`); last wins.
- `EpisodeFrameAttached`: appended to the frame collection in order,
  including duplicates (the journal is the authority for what was claimed);
  the first attach of a `frame_uid` is the canonical membership, later
  duplicates are flagged (`episode_frame_duplicate` warning). `frame_uid` 0
  is malformed (`episode_frame_uid_missing` error).
- `EpisodeRefAttached`: appended in order; duplicate attachments remain
  visible claims in the collection (the journal records what was claimed);
  dedup/last-wins presentation and claim-restatement semantics are a stage 3
  fsck concern, not a fold rewrite.
- `EpisodeClosed`: each close applies in order; the **last** close wins the
  seal fields (`status`, `end_time`, `last_frame_uid`, claimed
  `frame_count`, `reason`). More than one close is reported
  (`episode_closed_duplicate` warning), except that a close whose status is
  `Tombstoned` following an `Ended`/`Aborted` seal is the intended
  append-only tombstone path (KF-ADR-019f86da-4f90-791c-9b90-4888cca36327): fsck reports it as
  `episode_tombstoned` (intentional) instead of `episode_closed_duplicate`
  (stage 3).

### 2.4 Derived summary fields

- `frame_count` / `ref_count` / `record_count` on the folded summary are
  **computed from the fold** (collection sizes), not from heartbeat/close
  claims. The claimed counts remain available on the typed view for stage 3
  fsck cross-checks (claimed vs actual mismatch detection).
- `status` derives: last close status if closed, else `open` if opened, else
  `dangling`.

### 2.5 Streaming and bounds

- The primitive read API is a streaming per-record visitor; the fold
  materializes per-Episode collections, so memory is bounded by the size of
  the Episodes being folded, never by JSON document assembly.
- `list`/`inspect`/`fsck` currently fold the whole manifest location; a
  bounded/windowed fold (by episode id set or time range) is an accepted
  follow-up before manifests grow beyond memory comfort. This is a
  documented residual, not a stage 1 blocker.

### 2.6 Edge JSON compatibility

The stage 1 slice keeps the v1 edge JSON shape byte-compatible for the
existing consumers (storage CLI, Python/Node bindings, export bundle,
projection rows): same keys, same values, same ordering semantics
(`list` returns descending `episode_id`; `inspect` returns records/frames/
refs in append order; fsck reports the same codes). The only intentional
differences are in pathological error states (duplicate opens now fold
first-wins instead of last-wins) — states that are already fsck errors.

## 3. Writer ownership and the cross-journal recovery contract (stage 2 spec)

### 3.1 Writer owner

The Episode manifest journal (`journal/system/storage/episode-manifest/live`)
belongs to the storage/catalog plane of one data root. Its writer owner is
**one logical manifest writer per data root**:

- Every manifest mutation goes through the `episode_manifest_store` write
  contract (open / heartbeat / attach-frame / attach-ref / seal). There is no
  alternate assembly path.
- The store must hold a **data-root-scoped writer guard** while appending: an
  advisory exclusive lock on a lock file next to the manifest location
  (acquire-or-fail, never blocking-wait-forever). A coordinator process and a
  daemonless CLI invocation contend on the same guard; the loser fails with
  an explicit `manifest_writer_busy` error instead of appending concurrently.
  This satisfies the yijinjing single-writer-per-location rule by mechanism
  rather than convention.
- Delivered (stage 2): every mutating store operation acquires the guard —
  an exclusive advisory lock (`flock` / `LockFileEx`) on `writer.lock` in the
  manifest journal directory (see `episode_manifest_writer_lock_path`) — and
  the loser fails with `manifest_writer_busy`. Reads never take the guard.
  The native store remains fail-fast. The public Episode CLI and
  `RuntimeEpisodeLifecycle` absorb only this exact pre-append error with a
  bounded exponential backoff and emit a retry receipt; all other errors run
  once and propagate.

### 3.2 Publication order: fact before claim

Event frames and manifest records live in different journals and are never
one atomic write. The contract orders them so a crash can only ever leave a
**missing claim**, never a **claim without its fact**:

```text
record event      1) append event frame (event journal, durable receipt)
                  2) append EpisodeFrameAttached (manifest journal)

attach payload    1) publish payload bytes through the content store
                     (put-if-absent; the file provider's payload write is
                     this publish)
                  2) append EpisodeRefAttached claiming id + hash

seal              1) verify every claim this writer made is durable
                  2) append EpisodeClosed
```

A sealed Episode may be reported healthy **only** when every attached
frame/ref is present and verified. An Episode interrupted before seal stays
`open` (later recoverable to `aborted`); it is never presented as complete.

### 3.3 Crash-state machine

States of one Episode as observed by recovery/fsck:

```text
Absent -> Open -> Active -> Sealed(Ended|Aborted) -> Tombstoned
                   |             (append-only; tombstone is a later close)
                   +-- crash --> recovered as Aborted, or resumed by owner
```

Enumerated crash points, each of which stage 2 must reproduce as a fixture
before automatic lifecycle wiring lands:

| # | Crash window | Journal state | Required recovery behavior |
| - | --- | --- | --- |
| C1 | before `EpisodeOpen` append completes | event frames may exist with no manifest object | facts without claims; fsck may report orphan frames as informational; no Episode exists |
| C2 | after open, before any attach | open, empty Episode | remains `open`; fsck reports it as interrupted/stale (no heartbeat), not failed |
| C3 | after event frame durable, before its `EpisodeFrameAttached` | fact present, claim missing | Episode stays unsealed; the owning writer may idempotently re-attach on resume (PK `episode_id`+`frame_uid` makes re-attach a detectable duplicate); a sealed Episode can never be in this state per §3.2 seal rule |
| C4 | after attaches, before close | open Episode with claims | recovery by the guard-holding owner: resume (same actor/source lease) or append `EpisodeClosed{status=Aborted, reason="recovered"}`; a non-owner must not close someone else's open Episode |
| C5 | torn manifest frame (crash mid-append in the manifest journal itself) | partial frame at journal tail | journal-level frame visibility/checksum rules make the torn tail invisible or detectable; the fold stops at the last valid frame; fsck reports the torn tail |
| C6 | after close appended | sealed | complete; stage 3 fsck cross-checks claimed vs actual counts and per-frame receipts |

Recovery is driven by the fold itself (the manifest journal is the recovery
log); there is no side state file. On writer start with the guard held:
fold → enumerate this location's `open` Episodes → resume or abort each per
C4. Episodes owned by other locations are reported, never mutated.

### 3.4 What stage 2 delivers (delivered)

- The data-root-scoped writer guard (acquire-or-fail) wired into the store's
  write contract, with a contention fixture: a held guard makes a concurrent
  writer fail with `manifest_writer_busy`, so appends never interleave.
- Crash fixtures C1–C6 as journal-state constructions (fixtures write the
  exact pre-crash record sequences; C5 strips the KF-ADR-019f86da-4f90-7179-a900-c40bdb498910 publication token
  of the last frame) with fsck/recovery assertions, in
  `tests/python/test_episode_manifest_recovery.py`.
- The recovery pass as the explicit `episode_recover` maintenance operation
  (store `recover()`, storage-service `episode_recover`, Python
  `service.episode_recover`): closes in-scope interrupted open Episodes as
  `aborted` with a declared reason; open Episodes owned by other locations
  are reported in `skipped_open`, never mutated.
- The public `storage episode recover --plan/--execute` control surface is
  fail-closed: it requires one stale open Episode, no terminal record, a known
  owner location, and an inactive event-stream writer. Execute then acquires
  that exact stream lease as a fence, revalidates the manifest facts, and only
  then invokes native recovery. Missing/unknown liveness or a racing live
  owner blocks the mutation.
- `RuntimeEpisodeLifecycle.guard()` covers provider execution, payload/bundle
  attachment, and close. Python exceptions, Ctrl-C, and SIGTERM attempt a
  bounded abort. SIGKILL, process crashes, and machine power loss cannot run
  process cleanup and remain explicit recovery cases.

## 4. Stage gates recap (KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae first delivery)

1. **Typed fold** — implemented against §2; edge JSON stable; no schema
   change.
2. **Writer/recovery** (delivered) — §3 native guard + crash fixtures, bounded
   high-level contention retry, whole-scope lifecycle cleanup, and fenced
   operator recovery. Native writes remain acquire-or-fail.
3. **Structural fsck** (delivered) — over the typed fold: seal claims verified
   against the folded actual (`episode_seal_frame_count_mismatch`,
   `episode_seal_last_frame_missing`), invalid close status, the intentional
   tombstone path, and unknown/unfolded record diagnostics. Deep verification
   (fsck `verify_frames`, episode scope, opt-in) re-opens the claimed event
   journals and verifies each attached frame receipt — presence, header
   fields, recomputed payload/frame checksums (KF-ADR-019f86da-4f90-7d72-bf9f-1d5913bbb0d5/0028) — failing a
   sealed Episode and degrading an open one, with the exact missing side
   reported.
4. **Content resolution** (delivered) — payload refs resolve through the
   KF-ADR-019f86da-4f90-738c-b372-e509976f69ff immutable `content_store` by `ref_hash` (verified read, full
   error taxonomy: missing / hash-mismatch / unaddressable / io), replacing
   the bespoke `payload_ref_exists` path probe. An unverified payload ref
   fails a sealed Episode and degrades an open one, mirroring the frame
   verification severity; producers publish bytes via content-store
   put-if-absent before appending the ref. Schema refs stay declared-only
   until schemas live in the store.
5. **Projection/query** (delivered) — rebuildable Episode SQLite projection
   (`storage/projections/episode-manifest.sqlite`) over the typed record
   stream via `cache::make_storage_ptr` on `EpisodeManifestDataTypes`, the
   same Hana closed-set → SQLite path as the source-registry projection.
   `episode_projection_rebuild` rebuilds it (EpisodeOpen replays first-wins to
   match the fold's immutable-identity rule); episode-scope fsck verifies it
   against distinct-primary-key journal counts — drift degrades, an absent
   projection is an honest distinct state, and the journal remains the only
   authority. The fold stays the fresh read path; the projection serves
   indexed / SQL access.
