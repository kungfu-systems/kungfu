---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---

# Design note: journal page sizing, max-frame, and Episode-aware reclamation

- Status: design judgment (note, not a decision record)
- Date: 2026-07-11
- Anchors: [ADR-0033](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md)
  (Episode as causal segment), [ADR-0034](../framework/core/docs/adr/ADR-0034-yijinjing-episode-manifest-journal.md)
  (append-only manifest journal). Related: [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)
  (publish barrier), [ADR-0024](../framework/core/docs/adr/ADR-0024-location-role-and-journal-page-policy.md)
  (page size is storage policy), [ADR-0055](../framework/core/docs/adr/ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md)
  / [ADR-0056](../framework/core/docs/adr/ADR-0056-retire-legacy-journal-cli-lifecycle-tools.md)
  (journal lifecycle belongs to Storage/Episode), [ADR-0058](../framework/core/docs/adr/ADR-0058-yijinjing-explicit-mapping-policies.md)
  (mapping / page-open policies), and [`episode-object-model.md`](episode-object-model.md)
  (whose "Physical Shape" section names the Episode-aware physical layout as
  future work).

## Why this note exists

`episode-object-model.md` records that "the full Episode-aware physical journal
layout is still future work," and sketches a target of
`Episode -> segment allocation domain -> mmap pages -> frames`. That open item
invites a recurring proposal: make journal pages variable-length (and/or
per-Episode) so that partly-filled pages do not waste space, with a garbage
collector to reclaim them.

This note records the judgment that resulted from verifying how Episodes map to
pages today, so the future layout work does not adopt variable-length live pages
for the wrong reason. It constrains the design; it does not itself change code.

## Verified current mapping (the facts)

- A journal is a per-`(location, dest_id)` append stream. Pages live at
  `journal/{role}/{namespace}/{name}/{mode}/{dest_id}.{page_id}.journal`
  (`locator::layout_directory`, `page::resolve_page_path`). Raw mmap pages are
  shared append blocks, not Episode-owned objects.
- An Episode is a bounded causal segment, not a physical page owner. The Episode
  manifest names the included frames as `frame_ranges` over the shared channel
  journals (ADR-0033/0034). The physical shape is three parts: shared event
  journals, one append-only Episode manifest journal, and a content-addressed
  payload store. Multiple Episodes share a channel's pages; a long Episode spans
  many pages. There is no per-Episode page or file today.
- Consequently there is no "last page of an Episode" today. Closing an Episode
  leaves no partial page: the channel keeps appending the next Episode's frames
  into the same page. The only partial tails are the live page of each active
  channel and the final page of a channel that stops being written — bounded by
  channel count, not Episode count.
- Those partial tails cost almost no physical space on the primary platforms.
  Page files are created with `ftruncate` (POSIX) without writing zeros, so the
  unwritten tail is a sparse hole: `ls` shows the nominal size, `du` shows only
  the written bytes. Windows uses `SetEndOfFile` without `FSCTL_SET_SPARSE`, so
  the tail there is not sparse and is the one place the waste is physically real.

## Judgment

1. **Trailing-page waste is not a per-Episode property, and on POSIX it is not a
   physical-space problem.** It is one sparse partial tail per idle channel. Do
   not treat it as a live-format problem or size the format around it. The one
   concrete fix worth doing for space is to mark page files sparse on Windows
   (`FSCTL_SET_SPARSE`), which is format-preserving.

2. **Live pages stay fixed-capacity and sparse; they are never variable-length
   or growable under readers.** The lock-free tail-read contract (ADR-0001)
   depends on a stable mapping and fixed page geometry (`address_border` derives
   from `page_size`). Resizing a page that readers are concurrently tailing
   reopens the publication-barrier synchronization that ADR-0001 closed, and a
   live append page cannot be sized to its final content because the future is
   unknown.

3. **Variable page size at *creation* is sanctioned only to serve the max-frame
   bound.** A frame larger than the page body can never be written, so
   `page_size` is each channel's maximum frame size. When a channel must carry an
   occasional large frame, the new page created at rollover may be sized
   `max(policy_default, round_up(incoming_frame))`. This is decided once, at
   creation, and readers already discover the size from the page header
   (`reader_policy::peer` / `discover_page_size`), so it does not touch
   live-mapping stability. This is the only reason to vary page size, and it is
   orthogonal to space reclamation.

4. **Episode-aware space efficiency is packing, not per-Episode pages.** The
   Episode model already anticipates and rejects one-page-per-Episode: "small
   Episodes may share provider blocks if the manifest and fsck proofs remain
   unambiguous." The future `segment allocation domain` should therefore let many
   small Episodes share a page's segments (packing), with the manifest naming
   each Episode's frame/segment range. Per-Episode variable-length pages would
   fight this share-blocks intent, not serve it.

5. **Reclamation is tombstone then cold-path physical GC, owned by
   Storage/Episode.** The model already separates a logical tombstone from
   physical garbage collection. Physical reclamation belongs to the
   Storage/Episode cold path (ADR-0055/0056), and its unit is a whole
   page/segment once every Episode referencing it is tombstoned. It is not
   achieved by shrinking live pages.

6. **Any page-geometry change must preserve manifest coordinates.** The manifest
   records `frame_ranges` as segment/page coordinates. Variable-at-creation
   sizing, cold compaction, and any truncate-on-seal must keep those coordinates
   valid or rewrite them transactionally. In particular, the current exact
   `header->page_size == requested` check in `page::load` must become
   reader-discovers-from-header before any sealed page is truncated, so a shrunk
   page still loads.

## Explicitly rejected

Per-Episode or variable-length **live** pages introduced to reclaim
trailing-page space. On POSIX the space is already sparse (near-zero physical);
the approach fights the ADR-0001 stable-mapping contract and the model's
share-blocks intent; and a live append page cannot be pre-sized to its content.
Space efficiency is packing plus cold GC; page-size variation is reserved for
the max-frame bound at creation time.

## Follow-ups

- Confirm the sparse assumption on the actual target filesystems with `du`
  versus `ls` on a real data home; add the Windows `FSCTL_SET_SPARSE` marking if
  Windows tails are shown to consume clusters.
- Decide ADR-0024's fate: implement a real per-`(role, channel)` size policy in
  `find_page_size` (which currently ignores `location` and `dest_id`), or drop
  the vestigial parameters so the code stops implying a policy that does not
  exist.
- When the `segment allocation domain` is designed, treat this note's judgments
  2–6 as constraints: packing over per-Episode pages, cold-path GC over live
  shrink, and transactional manifest-coordinate preservation.
- The journal *container format* epoch (page/frame header layout) is governed
  separately from page sizing by
  [ADR-0062](../framework/core/docs/adr/ADR-0062-journal-container-epoch-and-offline-conversion.md);
  page size is a per-page allocation parameter and is not part of the format
  epoch.
