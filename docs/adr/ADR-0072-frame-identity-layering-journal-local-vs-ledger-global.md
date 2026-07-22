---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0072
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/740]
qualification_refs: [framework/core/src/libkungfu/tests/durable_ingest_tests.cpp]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-13
theme: frame-identity-layering
confidence: medium
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0072: frame identity layering — journal-local frame uid, ledger-global stream position

- Status: accepted; Phase 1 implemented, Phase 2 confirmed and documented
- Date: 2026-07-13
- Category: runtime architecture / journal identity / durability
- Related: [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md)
  (journal wire epoch), [ADR-0053](ADR-0053-self-contained-episode-bundles.md)
  (frame_uid is writer-local; byte-exact import),
  [ADR-0043](ADR-0043-episode-identity-sealed-content-root.md)
  (Episode content root identity),
  [ADR-0068](ADR-0068-tiered-durability-and-crash-recovery.md)
  (tiered durability; stream_position)

## Context

v4 is repositioning the journal. In the trading era the journal was a
short-lived IPC substrate: [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md)
states it plainly — the container "is **not a persistence format that must be
read forever**; it is an IPC substrate plus a short-lived record that is
regenerated per run and archived raw." Under that assumption a journal could be
exported and discarded daily, and `page_id` reset with it.

Real-world agent work changes the premise: the **local ledger is kept for the
long term**. A frame's identity must survive for the whole life of the ledger,
not just one run.

`frame_uid` was designed for the short-lived premise and does not meet the new
one. It is a writer-local artifact
([ADR-0053](ADR-0053-self-contained-episode-bundles.md)):

```text
frame_uid = (location_uid xor dest_id) << 32
          | ((page_id<<24 & 0xFF000000 | page_frame_nb & 0x00FFFFFF) xor nano_hashed(writer_start))
```

Three problems, all consequences of packing three jobs into 64 probabilistic
bits under the short-lived premise:

1. **page is 8 bits — a deterministic collision.** Only the low 8 bits of
   `page_id` survive. A single journal that writes past 256 pages
   (256 x default 16 MB = **4 GB**) wraps: page 257 reuses page 1's slot, and a
   long-running single writer then produces a colliding `frame_uid`. This is
   deterministic, not probabilistic, and only stayed hidden because journals
   were discarded before reaching that size.
2. **32-bit session salt — probabilistic.** Cross-session uniqueness rests on
   `nano_hashed(writer_start)`, a 32-bit hash. Birthday-bound collision across
   N writer sessions of the same (source, dest); acceptable for a discardable
   buffer, not for a permanent ledger.
3. **`(source xor dest)` is redundant.** `source`, `dest`, and `initial_source`
   are already explicit `frame_header` fields; nothing decodes the packed
   `frame_uid` bits back to them. The high 32 bits are wasted (and XOR loses
   direction).

The key realization: **permanent global uniqueness should not be `frame_uid`'s
job, and Kungfu already builds it elsewhere.**

- `stream_position { stream_id, container_epoch, sequence, frame_uid }`
  (`durability.h`) is a **structural, monotonic** logical identity — its comment
  says physical page ids and offsets are "deliberately absent." The durable tier
  enforces strict contiguity (`durable_ingest` rejects unless
  `sequence == last.sequence + 1`, with non-zero stream_id/epoch/sequence). This
  is deterministic uniqueness, not probabilistic.
- The **Episode content root** ([ADR-0043](ADR-0043-episode-identity-sealed-content-root.md))
  is a content-addressed identity over a frame set; it does not rely on
  `frame_uid` being globally unique.

## Decision: frame identity is layered

Identity has two layers, and each has one owner.

1. **Journal-local identity — `frame_uid`.** Unique **within one journal**, used
   for in-journal frame lookup, `trigger_frame_uid` causal links, and the frame
   checksum. It is not, and does not become, a permanent or cross-journal global
   id. This affirms [ADR-0053](ADR-0053-self-contained-episode-bundles.md):
   `frame_uid` is writer-local and preserved byte-exact on import.

2. **Ledger-global identity — Episode content root + `stream_position`.**
   Permanent, cross-journal, deterministic uniqueness lives here:
   `(stream_id, container_epoch, sequence)` as the structural monotonic
   coordinate, and the Episode content root
   ([ADR-0043](ADR-0043-episode-identity-sealed-content-root.md)) as the
   portable content-addressed identity. This is where "the ledger is permanent"
   is enforced, not in the raw journal.

The container stays a short-lived substrate as
[ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md) describes;
**permanence is the Episode/ledger layer's responsibility, not the journal's.**
This resolves the tension without overturning the epoch mechanism.

### Phase 1 — make `frame_uid` deterministically journal-local (pre-stable window)

Status: implemented in `dev/v4/v4.0`. `writer::current_frame_uid()` now encodes
`(page_id << 32) | in-page frame_nb`; the `frame_header` field `frame_uid` was
renamed to `journal_frame_uid`, advancing `journal_format_epoch`. Phase 2 (the
authoritative ledger-global identity) is still pending.

The page 8-bit wrap is a real, deterministic bug once a journal is long-lived.
Restructure `frame_uid`'s low bits to a structural, collision-free encoding
within one journal — the **full** `page_id` plus in-page `frame_nb`, both of
which are persistently monotonic on disk — and drop the probabilistic salt and
the redundant `(source xor dest)`. The result is deterministic uniqueness within
a journal; it does not attempt cross-journal global uniqueness (that is layer 2).

This is a semantic change to `frame_uid`, so per
[ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md) rule 4 it
must version by renaming/retyping, advancing `journal_format_epoch`. It also
re-touches the frame checksum and the Episode content root
([ADR-0043](ADR-0043-episode-identity-sealed-content-root.md)); new frames use
the new encoding, old frames are preserved byte-exact
([ADR-0053](ADR-0053-self-contained-episode-bundles.md)), and the epoch versions
the two.

**The pre-stable window is the enabler.** Advancing the epoch before v4 stable
means there is no published long-lived ledger to convert, so ADR-0062's deferred
offline converter is not yet owed. After stable, this same change would owe a
converter and become far more expensive. This is the last low-cost window.

### Phase 2 — authoritative ledger-global identity

Status: confirmed and documented in `dev/v4/v4.0`. Phase 2 is a specification
milestone, not new runtime code: grounding the codebase showed the authoritative,
crash-safe, monotonic assignment mechanism **already exists** in the durable tier,
so the deliverable is to name the authority, state the contract any future
producer must follow, and pin the guarantee with a regression test — not to build
a second counter.

**Where the coordinate is assigned.**

- `stream_id` and `container_epoch` are the **container/writer identity**. They are
  fixed when the durable stream is opened (`ingest_options.stream_id` /
  `container_epoch`, both required non-zero) and every appended record and
  checkpoint is validated against them (`durable_ingest`
  rejects a mismatch). They are assigned once per stream container, upstream of
  ingest, and never re-derived per frame.
- `sequence` is the **monotonic ledger coordinate**, and the durable tier is its
  single authority. The authority is the persisted `durable_watermark`: it is
  written into the double-slot, magic + CRC + version checkpoint on every barrier
  and restored on restart (`load_checkpoint`). On `append` the durable tier
  computes the authoritative next value —
  `expected = pending ? pending.sequence + 1 : durable_watermark.sequence + 1` —
  and admits a record only when its `sequence` equals `expected` (else
  `durable_position_gap`). Because the watermark is crash-safe and persistent,
  assignment resumes at `watermark + 1` after a restart and a sequence at or below
  the durable watermark can never be re-issued or regressed. This is deterministic,
  not probabilistic.

**Contract for producers.** The durable-tier watermark is authoritative. Any
upstream producer that eventually drives live durable ingest must derive
`sequence` from that authority (query it via `status().durable_watermark` and
append `watermark + 1`, anchored contiguously within the `(stream_id,
container_epoch)` container), and must **not** invent an independent counter. The
shared `append` path deliberately stays validate-mode rather than becoming an
assigner: it also serves byte-exact import / replay
([ADR-0053](ADR-0053-self-contained-episode-bundles.md)), where the sequence is
supplied by the source Episode and must be preserved exactly, so the durable tier
validates the caller's coordinate against the authoritative watermark instead of
overwriting it.

**What ledger consumers key on.** Permanent, cross-journal identity is
`(Episode content root, stream_position = (stream_id, container_epoch, sequence))`
— the Episode content root ([ADR-0043](ADR-0043-episode-identity-sealed-content-root.md))
for content-addressed membership and the structural `stream_position` for the
monotonic coordinate. Consumers do **not** key permanence on `frame_uid`; per
Phase 1 `frame_uid` is journal-local (in-journal lookup, `trigger_frame_uid`
causal links, frame checksum) and the Episode manifest treats it accordingly
(within-view dedup and causal links, never as the permanent ledger key).

Regression coverage: `durable_ingest_tests.cpp`
(`sequence assignment authority is crash-safe and monotonic (ADR-0072 Phase 2)`)
pins that assignment resumes at `watermark + 1` across restart and that an
already-durable sequence cannot be re-issued or regressed; existing restart,
rollover, and sealed-segment tests cover the crash-safe persistence of the
watermark itself.

## Alternatives considered

- **Expand `frame_uid` to a permanent global id (128-bit or global registry).**
  Rejected. Widening a hash only defers the birthday collision — it is still
  probabilistic, not structural, so it does not permanently eliminate the risk.
  It also duplicates the Episode content-root identity and breaks
  [ADR-0053](ADR-0053-self-contained-episode-bundles.md) (writer-local),
  [ADR-0043](ADR-0043-episode-identity-sealed-content-root.md) (root membership),
  and [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md)
  (wire epoch), and changes the frame checksum.
- **Leave `frame_uid` as-is.** Rejected. The page 8-bit wrap is deterministic
  and surfaces the moment a single journal is long-lived past 4 GB.
- **Make the journal itself the permanent ledger format.** Rejected. It
  contradicts ADR-0062's substrate rationale and re-implements the
  content-addressed permanence the Episode layer already provides.

## Consequences

- Positive: permanence rests on a structural, deterministic coordinate that
  already exists and is already enforced; `frame_uid`'s scope shrinks to what it
  can actually guarantee (journal-local); the page 8-bit deterministic wrap is
  removed; the layer split makes future readers stop expecting `frame_uid` to be
  a global key.
- Cost: Phase 1 advances `journal_format_epoch` and re-touches checksum and
  Episode root; it must land before stable to avoid owing an offline converter.
- Scope: this ADR is the layering decision; the concrete `frame_uid` bit layout
  and the `stream_position` assignment authority are specified in Phase 1/2 work.

## Open questions

- Exact Phase 1 bit layout: `page_id` and `frame_nb` widths within the 64-bit
  field (e.g. 32/32 gives 64 EB per journal), and whether any bits are reserved.
- ~~Where `stream_id` / `container_epoch` / `sequence` are authoritatively
  assigned today (durable_ingest enforces contiguity but the assigner is
  upstream) — Phase 2 must make the monotonic assignment authoritative and
  crash-safe.~~ Resolved in Phase 2: the durable tier's persisted
  `durable_watermark` is the crash-safe monotonic authority for `sequence`;
  `stream_id` / `container_epoch` are container/writer identity fixed at stream
  open. Live producers must derive `sequence` from the watermark rather than
  invent a counter; the shared `append` path stays validate-mode to preserve
  byte-exact import.
- Whether `trigger_frame_uid` causal links need any ledger-level projection to
  `stream_position` for cross-journal causality, or stay journal-local.
