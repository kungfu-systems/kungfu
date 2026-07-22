---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0043
decision_status: proposed
implementation_status: not-started
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0043: Episode identity is two layers — a local coordinate plus a sealed content root committed in the manifest

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) Episode identity — the relation between the local
  `episode_id` and content identity, the hash-root composition algorithm over
  an Episode's owned material, when identity is defined, and how it is
  recorded and verified at the manifest trust boundary.
- Subsystem: `libyijinjing` `episode_manifest` record family and store, the
  `libkungfu` runtime storage service Episode operations, storage fsck,
  export/import and future sync/dedup semantics.
- Related: ADR-0033 defines Episode as the first-class causal segment object
  and requires the manifest to record "hash roots or sync roots needed by
  fsck/export/import"; ADR-0034 puts the manifest records in the yijinjing
  journal; ADR-0041 makes the POD journal plus one typed fold the trust
  boundary and defers "deep Episode identity and hash-root composition" to
  this ADR; ADR-0042 defines atomic safety and explicitly leaves "selecting
  the final Episode id or hash-root composition algorithm" out of scope —
  this ADR closes that deferral. ADR-0040 provides the content-addressed
  store the root builds on; ADR-0023/0028 define frame checksum and content
  hash boundaries. The sync-root linear chain
  (`kungfu.sync-root/v1`) is the composition precedent this ADR follows.

## Context

Every storage decision so far organizes around Episode (ADR-0033), and the
manifest is the object's trust boundary (ADR-0041): the journal of POD claims
is what fsck, export/import, and sync trust to answer "what is this Episode."
What is still undefined is identity itself:

- `episode_id` is a caller-chosen `uint64`, the primary key of every manifest
  record. It is a **coordinate inside one data root**, not evidence: nothing
  ties it to the claims it labels, so two stores can disagree about what
  "Episode 5" is and no verifier can tell.
- The manifest records per-frame checksums (ADR-0023) and per-ref content
  hashes (ADR-0040), so each *individual* claim is checkable, but there is no
  commitment to the *whole* — nothing states "this exact sequence of claims,
  and nothing else, is Episode 5."
- Export/import, dedup, and future sync need an equality judgment that
  survives moving an Episode between runtime dirs. Without a content
  identity, "same Episode" degenerates to "same local number", which is
  exactly the kind of unverifiable coordinate ADR-0033 rejects as the user
  fact object.

The roadmap's framing is a git-commit-like storage object: atomic,
independently verifiable, addressable by content. This ADR decides the
identity layer of that framing; it deliberately does not redesign lifecycle,
layout, retention, or transport.

## Decision

### 1. Identity is two layers: coordinate and content root

- **`episode_id` stays the local lifecycle coordinate.** It is how a live,
  open Episode is addressed inside one data root (all v1 records key on it;
  that does not change). It makes no cross-store claim.
- **The content identity of a sealed Episode is its root: one hash chained
  over the Episode's owned claim sequence** (composition in decision 3). Two
  sealed Episodes are the same Episode exactly when their roots are equal
  (same algorithm). The root is the unit of cross-runtime-dir equality,
  import idempotence/dedup, and future sync reconciliation.
- The analogy is git's ref vs commit id: the coordinate names a line of work
  while it moves; the root names the sealed result wherever it travels.

### 2. Identity is defined at seal, not before

- A hash root is defined **only for sealed Episodes** (terminal
  `EpisodeClosed`: Ended or Aborted). An open Episode has only its
  coordinate; its claim sequence is still growing, so any root over it would
  be a moving target presented as identity.
- This is the publication contract's last step (fact before claim,
  trust-boundary §3.2): after the seal verifies its claims and appends
  `EpisodeClosed`, the writer computes the root over the recorded claim
  sequence and appends it as the final claim. A crash between seal and root
  leaves a sealed Episode with an **absent** root — tolerated and reported
  honestly (decision 5); it never leaves a root without its facts.
- Rolling / per-segment roots for open Episodes are explicitly not in v1.

### 3. The root is a linear chain over the owned claim records, hashed
   journal-native

The composition follows the proven sync-root paradigm (linear chain,
`kungfu.sync-root/v1`) but hashes the records journal-natively — each covered
record contributes its fixed-layout field bytes in declaration order, with no
JSON canonicalization inside the trust boundary (ADR-0041's discipline: JSON
is edge-only).

**Coverage.** For one Episode, in manifest append order, the root covers the
owned claim records:

- the first `EpisodeOpen` (identity and provenance claims);
- every `EpisodeFrameAttached` (each carries the frame's uid, times,
  carrier/source/dest, length, and ADR-0023 checksums — so the root commits
  transitively to frame content);
- every `EpisodeRefAttached` (each carries `ref_id` and `ref_hash` — so the
  root commits transitively to payload bytes through the ADR-0040
  content-addressed store);
- the terminal `EpisodeClosed` (outcome, end time, claimed counts).

Duplicates stay in: the journal's append order — including duplicate or
conflicting claims — is the authority for *what was claimed* (ADR-0041 fold
semantics), and the root is a commitment to exactly that.

**Exclusions, each for a reason:**

- `EpisodeHeartbeat` records: liveness/watermark telemetry, not claims about
  owned material. Excluding them keeps identity insensitive to operational
  noise (an Episode's identity does not depend on how often it pulsed).
- Manifest frame provenance (`manifest_frame_uid`, `manifest_gen_time`, page
  placement): storage coordinates of the *manifest journal itself*. They
  necessarily change when records are re-appended into another store, and
  identity must survive that (decision 4).
- Unknown / newer-schema records and the root record itself.

**Per-record commitment and chain.** Each covered record contributes a
commitment hashed over its field bytes in declaration order — scalar and
enum fields as their in-memory little-endian bytes, fixed char arrays as
their full zero-filled extent, `schema_version` included. Struct padding
never enters the hash, so the commitment does not depend on compiler layout
or uninitialized bytes. The chain is
`link_i = H(domain || index || link_{i-1} || commitment_i)` with a fixed
domain tag (`kungfu.episode-root-link/v1`) and an all-zero initial link, the
same convention as the sync root. The root is the last link. The exact link
preimage is pinned by the record's `schema_version` and proved by fixtures;
changing it is a schema-version change, never a silent edit.

**Local ids are inside the root — deliberately.** `episode_id`,
`parent_episode_id`, `location_uid`, and frame uids are fields of the covered
records and therefore part of identity. The root is a commitment to the
manifest's claims *as recorded*, and those claims are expressed in local
coordinates. Consequence: identity is invariant under **verbatim migration**
(export/import that preserves the claim records byte-for-byte yields the same
root — the invariance sync and dedup need), but **renumbering is a new
identity** (an import that rewrites `episode_id` produces different claims,
hence a different root). Store-independent "portable identity" that survives
renumbering would require hash-based parent/dependency references — a
content-addressed DAG — which conflicts with v1's lifecycle (children may
open, and be claimed against, while the parent is still open and has no root
yet). That revision stays explicitly out of scope; payload-level dedup is
already store-wide through the content store regardless.

### 4. The root is a recorded claim, verified by fsck

- A new manifest record type commits the root:

  ```text
  EpisodeRootCommitted (new carrier type, additive to the ADR-0034 family)
    schema_version        pins layout AND composition semantics
    episode_id            the sealed Episode this root names
    location_uid          writer provenance
    commit_time
    covered_record_count  claims covered (open + frames + refs + close)
    algorithm             content-hash algorithm name ("sha256" today)
    root_value            bare lowercase hex of the root
  ```

  ADR-0041 required a schema-version ADR before extending the record set;
  this is that ADR. The addition is additive: no existing record's layout or
  meaning changes, and readers that predate it preserve it as an unknown
  record without folding it (the ADR-0041 unknown-record contract).
- **fsck recomputes and verifies.** For a sealed Episode with a root record,
  fsck recomputes the chain from the typed fold and compares: mismatch is a
  manifest-integrity failure (`episode_root_mismatch`, status failed) — the
  trust boundary itself is lying about identity. When the Episode's fold saw
  unknown/newer records, fsck reports the root as **unverifiable** instead of
  guessing (a v1 verifier must not fail a v2 writer's root over records it
  cannot canonicalize — honest degradation per ADR-0042).
- **inspect reports identity.** `episode_inspect` exposes the recorded root,
  the recomputed root, and the match verdict, so identity is inspectable
  without a monitoring stack.

### 5. Absence is honest, not an error

- Episodes sealed before this ADR, and seals interrupted between
  `EpisodeClosed` and the root append, have no root record. They remain valid
  sealed Episodes; inspect/fsck report `root: absent` (with the recomputed
  value available from the fold), never a failure. Greenfield seals always
  append the root; there is no backfill obligation in this ADR (an explicit
  maintenance/repair op may add roots later under ADR-0042's
  evidence-preserving rules).
- `advertised_capabilities ⊆ evidence_safe_capabilities` (ADR-0042) applies:
  operations that *require* committed identity (future sync/dedup admission)
  treat an absent root as that capability being unavailable, not as license
  to invent one.

### 6. Algorithm and evolution

- The algorithm is named in the record (`sha256` today; BLAKE3 is already in
  the supported content-hash vocabulary as a candidate successor). Identity
  comparisons are `(algorithm, root_value)` pairs; equality across different
  algorithms is undefined — reconciliation across an algorithm migration
  recomputes rather than assumes.
- The composition (coverage, ordering, link preimage) is pinned by the root
  record's `schema_version`. Any change — adding a covered record type,
  changing exclusions, changing the chain — increments it and states the
  migration rule; mixed populations are expected and handled by reading the
  version from the record.

## Consequences

- A sealed Episode finally *is* something: a verifiable content identity that
  travels with its records, closing the loop ADR-0033 opened when it named
  hash roots part of the trust boundary.
- Export/import gains an equality/idempotence judgment (same root = same
  Episode; skip or verify on re-import), which the import-manifest migration
  and future sync/maintenance cards build on instead of inventing.
- fsck can now catch whole-Episode substitution/reordering, not only
  per-claim corruption: the root binds the sequence, the checksums bind the
  parts.
- The seal path does more work (fold + chain over the Episode's records);
  seal is rare and the cost is linear in the Episode's claim count.
- Renumbering imports are a new identity by construction; tools that need
  cross-store dedup under renumbering must wait for (or motivate) the
  portable-identity revision, documented above as out of scope.

## First delivery (thin slice)

1. `EpisodeRootCommitted` record type (additive), fold support (root fields
   on the typed current view), and the chain computation over the typed fold.
2. Seal path (`end` / `abort` / `recover`) computes and appends the root
   after `EpisodeClosed`, under the existing writer guard.
3. `episode_inspect` exposes recorded/recomputed/match; fsck verifies
   (mismatch → failed; unknown-records → unverifiable; absent → reported).
4. Fixtures: determinism (re-fold ⇒ same root), sensitivity (any covered
   claim changes ⇒ root changes; heartbeats do not), crash-shape (sealed
   without root stays healthy with `root: absent`), and cross-store
   invariance (re-appending the same claims in a fresh runtime dir ⇒ same
   root).

## Explicitly out of scope

- Portable identity under renumbering (hash-based parent/dependency
  references, content-addressed Episode DAG).
- Rolling or per-segment roots for open Episodes.
- Root backfill for historical Episodes and any repair/maintenance op that
  appends roots retroactively.
- Export/import bundle format changes and the import-manifest record
  migration (separate card; it consumes this identity).
- Remote sync transport, fleet reconciliation, retention/GC.

## Alternatives considered

- **Content-addressed `episode_id` (replace the coordinate).** Rejected: an
  open Episode has no final content, every v1 record keys on the id, and a
  live workflow needs a stable address before identity exists. Two layers
  match the object's lifecycle.
- **Derived-only root (compute on demand, never record).** Rejected: the
  trust boundary must *record* identity (ADR-0033), otherwise export/import
  has nothing recorded to verify against and "identity" silently becomes
  whatever the local verifier computes today.
- **Reuse `EpisodeRefAttached` with a new ref kind to carry the root.**
  Rejected: a root is a claim about the Episode itself, not an attached
  external reference; overloading the ref record is exactly the field
  overloading ADR-0041 forbids without a schema ADR — and once writing a
  schema ADR, the honest shape is a first-class record.
- **JSON-canonicalized commitments (reuse sync-root entry hashing as-is).**
  Rejected: it would reintroduce JSON as internal currency inside the trust
  boundary, the drift ADR-0041 exists to eliminate. The chain shape is
  reused; the commitment is journal-native POD bytes.
- **Exclude local ids from the root for portability.** Rejected for v1: it
  requires hash-based parent references (parents may still be open when
  children claim them) and a canonical renumbering story; the honest v1
  contract is verbatim-migration invariance with renumbering as new identity.
- **Include heartbeats.** Rejected: identity would depend on liveness noise;
  no trust claim is lost by excluding them.

## Residual risk

- Field-byte hashing assumes fixed char arrays are zero-filled past their
  content (the `copy_string` write path guarantees this) and that scalar
  endianness stays little-endian across supported platforms; the determinism
  fixtures must catch drift. Whole-struct raw-byte hashing was rejected during
  implementation because these records are pack(8), not byte-packed, and their
  padding is not deterministically initialized.
- The unknown-record "unverifiable" rule means a v1 verifier cannot catch a
  malicious root written alongside v2 records; verification strength follows
  reader schema coverage. This is inherent to forward compatibility and is
  reported, not hidden.
- Two commitment paradigms now exist (JSON-entry sync root for import
  manifests, POD-byte Episode root). They serve different boundaries; the
  import-manifest migration should converge its commitments toward
  journal-native records rather than the reverse.
- Seal-time fold cost grows with Episode size; unacceptable growth would
  motivate an incremental chain carried in the writer, which the composition
  already permits (linear chain is prefix-incremental) without a schema
  change.
