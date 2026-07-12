# ADR-0062: the journal container epoch is derived from its layout, and cross-epoch replay is offline conversion

- Status: accepted; implemented
- Date: 2026-07-11
- Category: (b) mechanism / governance — data-format enforcement
- Subsystem: `libyijinjing` journal (`page_header` / `frame_header`), yijinjing schema
- Related: [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md) (parent policy —
  released closed-layout compatibility baseline; hot path speaks one epoch, cold
  path carries explicit migration/decode), [ADR-0001](ADR-0001-yijinjing-publish-barrier.md)
  (the page/frame publish barrier this format must not disturb),
  [ADR-0058](ADR-0058-yijinjing-explicit-mapping-policies.md) (the page-open
  policies that gate who may initialize a page),
  [ADR-0028](ADR-0028-hash-taxonomy-and-integrity-algorithms.md) (a layout
  fingerprint is a distinct hash surface, not a frame checksum or content hash),
  [ADR-0029](ADR-0029-frame-checksum-v2-crc32c.md),
  [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md)

## Context

The journal *container* — the `page_header` and `frame_header` binary layouts
that yijinjing mmaps and publishes — carries a single version integer
`__JOURNAL_VERSION__` (in `journal/common.h`, currently `4`). It is the format
epoch for the whole container, covering both headers.

The mechanics today:

- A writer stamps `version`, `page_header_length` (`= sizeof(page_header)`),
  `page_size`, and `frame_header_length` (`= sizeof(frame_header)`) into a page
  only when it first initializes a *virgin* page (`page::load`).
- Any process opening an *existing* page runs three hard checks in `page::load`
  and throws `journal_error` on the first mismatch: `version`,
  `page_header_length`, `frame_header_length` (and then `page_size`). There is no
  in-place adaptation and no migration.

This correctly serves the container's primary role — a same-machine mmap IPC
substrate where all peers come from one binary, one epoch, one `sizeof`. Two
different-epoch peers sharing one page must never proceed, so a hard refusal is
the only safe behavior, and ADR-0008 already ratifies this stance at the policy
level ("hot path speaks one schema layout epoch"). What ADR-0008 does *not*
specify is the enforcement mechanism, and two gaps exist below its policy:

1. **The epoch is a hand-edited constant and is blind to size-preserving layout
   changes.** The two `*_length` checks only catch changes that alter
   `sizeof(page_header)` or `sizeof(frame_header)`. A size-preserving change —
   reusing a field, an equal-width retype, a reorder that keeps `sizeof` equal —
   passes all three runtime checks with the epoch unchanged, and old data is then
   silently misread. `frame_header` is more exposed still: it has no version
   field of its own and is guarded solely by `frame_header_length`. This directly
   threatens ADR-0008's "released v4+ data is not silently stranded."

2. **The read path claims a cross-epoch capability it does not have.**
   `assemble::read_bytes` contains a branch that skips frames from a
   version-mismatched page and warns. Under the current `page::load` contract
   that branch is unreachable: the reader's page acquisition
   (`journal::load_page` → `page::load`) refuses a mismatched page before the
   assembler can skip it. The code reads as if mixed-epoch replay degrades
   gracefully; it does not.

## Decision

This ADR operationalizes ADR-0008 for the journal container. It changes no wire
or POD layout and adds no hot-path adapter.

1. **One closed epoch.** The container format is a single closed epoch. It is
   deliberately not self-describing and not online-compatible. Mixed-epoch mmap
   peers are never permitted.

2. **Hard refusal stays the hot-path contract.** A page whose stored epoch
   differs from the running epoch is refused at load, never adapted in place.
   This is the existing behavior, ratified here.

3. **The epoch is derived from the layout, not hand-maintained.** The epoch is a
   compile-time function of a *layout fingerprint* over the `page_header` and
   `frame_header` field set and layout (folded via `boost::hana::accessors`,
   mixing each field's name and type token together with `sizeof`/`alignof` of
   each header). Any edit to either layout necessarily changes the fingerprint,
   hence the epoch; pages written under the old layout carry the old epoch and
   are refused by rule 2 automatically. This closes gap (1) by construction,
   including the size-preserving and `frame_header` cases: an unversioned layout
   change is not possible, because there is no separate version to forget. The
   epoch is machine-only — it is never read by a human and carries no ordering or
   release meaning — so it is intentionally an opaque derived value, not a
   legible monotonic integer.

   The fingerprint is a build-identity hash and is a separate surface from the
   frame checksum (ADR-0029) and content hashes (ADR-0028); it is never written
   into a frame body. Its derivation and a `static_assert` that it is a
   well-formed compile-time constant live beside the existing container
   invariants in the anonymous namespace at the top of `page.cpp` (which already
   `static_assert`s alignment and lock-free atomicity for the publication
   tokens), so the layout contract is enforced in one place.

4. **Layout is binary layout; a pure semantic reinterpretation must rename.** The
   fingerprint catches every change to field name, type, order, or size. It
   cannot catch a change that keeps a field's name and type but redefines its
   meaning (for example, reinterpreting a timestamp field's unit). No layout
   hash can. The governing rule is therefore a convention: **a change to a
   field's meaning must change its name or type**, so that a semantic break
   becomes a fingerprint break and the epoch advances with it. This bound is
   stated so the derived epoch is not mistaken for a semantic guarantee.

5. **Cross-epoch replay is offline conversion, exclusively.** Reading historical
   journals written under an older epoch is served by an explicit offline
   converter that decodes old-epoch pages and emits current-epoch facts or an
   export. This is the concrete realization of ADR-0008's "cold-path
   import/export/replay/fsck can carry explicit migrations or decode paths," and
   it discharges "released v4+ data is not silently stranded" without smuggling a
   hidden adapter into the zero-copy hot path (ADR-0008 replacement criterion 6).
   Online readers never translate across epochs.

6. **The read path is made honest.** The unreachable skip-mismatched-page branch
   in `assemble::read_bytes` is removed, so hard refusal is the single, truthful
   read-path semantics. If mixed-epoch cold replay is wanted later, it is built as
   the offline converter of (5) on an explicit epoch-probing path — not
   reintroduced as tolerance inside the live assembler.

7. **The offline converter is deferred; the standing contract is
   archive-and-read-with-its-own-binary.** This ADR sanctions the offline
   converter as *the* path for cross-epoch replay but does not build it now.
   Until it exists, the contract is firm: an old-epoch journal is archived as raw
   bytes and read only by a runtime of its own epoch; a newer-epoch runtime that
   meets an old-epoch page refuses it (rule 2). The converter's build trigger is
   concrete: **the first epoch advance that would affect already-released v4
   journals.** Deferral is valid only while no such advance has shipped;
   pre-stable-release baseline cleanups that advance the epoch (permitted by
   ADR-0008) do not trigger it. This keeps the deferral inside ADR-0008's
   "released v4+ data is not silently stranded" obligation: the recourse (raw
   archive + own-epoch binary) is declared and non-silent, and the converter
   becomes required precisely when that recourse stops being enough.

## Rationale

The container is not a persistence format that must be read forever by evolving
code; it is an IPC substrate plus a short-lived record that is regenerated per
run and archived raw. Its value comes from being dumb, fixed-width, and
zero-copy. The failure mode worth engineering against is not "we cannot read old
data online" — that is intended — but "we changed the layout and did not say so."
Deriving the epoch from the layout removes the last place a human could fail to
say so: the machine says it, every time, for free.

Because the epoch has no human reader, it need not be legible or monotonic.
Trading legibility for a derivation that cannot be forgotten is the right
exchange here — reliability over cleverness, mechanism over discipline.

## Consequences

- Any change to `page_header` or `frame_header` layout — additive, subtractive,
  reordering, retyping, or size-preserving reinterpretation — changes the epoch
  automatically; old-epoch pages are refused without any code edit or reviewer
  vigilance. A deliberate rename is required to version a pure semantic change
  (rule 4).
- The epoch value is an opaque derived number. Anything that wants a
  human-legible release identifier for the journal format must derive it
  elsewhere (for example in the release tag), not read the epoch.
- The fingerprint must be computed from platform-stable inputs so one payload has
  the same epoch on every target. The container already uses fixed-width fields
  and `aligned(8)`; enum fields must keep fixed underlying types, and nothing
  platform-dependent (pointer or `long` sizes) may enter a header or the
  fingerprint.
- Historical journals across an epoch boundary are not readable by a new-epoch
  runtime online. Until the deferred converter is built (rule 7), their data is
  reached by running their own epoch's binary against the raw archive.
- `assemble::read_bytes` no longer carries a dead cross-epoch branch; the read
  path's behavior matches its code.
- No hot-path cost, no wire/POD layout change, no change to the ADR-0001
  publication barrier or the ADR-0058 page-open policies. `page_size` remains a
  per-page allocation parameter and is not part of the epoch.

## Alternatives considered

- **Keep a legible monotonic `__JOURNAL_VERSION__` and pair it with a
  fingerprint `static_assert`.** A layout change would break the assertion and
  force the developer to advance both the integer and the checked-in fingerprint.
  Rejected: it keeps a human in the loop for a value no human consumes, and the
  assertion-and-remember step is exactly the discipline the derived epoch
  removes. Legibility has no consumer at the container layer.
- **Make the reader epoch-tolerant (skip mismatched pages, warn).** Rejected: it
  puts a hidden translation in the zero-copy hot path (violates ADR-0008
  criterion 6) and is unsafe for mmap IPC, where a mismatch means two
  incompatible binaries are sharing memory. Cross-epoch reading belongs off the
  hot path.
- **A self-describing / variable-length container header.** Rejected for the
  container: it imposes decode cost on every page open and invites false
  confidence that old data is safe online. The evolvable representation already
  exists one layer up for payloads (`.fbs`/`.bfbs`, ADR-0047); the container
  stays closed POD.
- **Give `frame_header` its own version field.** Not adopted: the derived epoch
  already covers both headers; a second field would add a thing to keep in sync
  without adding safety.

## Verification

- A build-time check: mutating any `page_header` / `frame_header` field in a
  scratch build must change the derived epoch (and a paired page written before
  the change must fail to load after it); an unrelated change must not.
- Confirm the claim in gap (2) with a small harness (write a page, rewrite its
  header epoch, drive the reader) so the removal of the `assemble` skip branch is
  grounded on a demonstrated-unreachable path rather than inspection.
- Confirm the fingerprint is identical across macOS, Linux, and Windows targets
  for the same layout.
- Existing container invariants remain: the `page.cpp` alignment / lock-free
  `static_assert`s and the `page::load` runtime `*_length` / `page_size` checks
  are unchanged.

## Implementation

Landed on `dev/v4/v4.0` in two changes: the derived epoch (`journal_format_epoch`
in `journal/layout_fingerprint.h`, replacing the `__JOURNAL_VERSION__` macro), and
the removal of the now-unreachable `assemble::read_bytes` cross-epoch branch. The
verification items are discharged:

- The build-time check holds: a `static_assert` beside the `page.cpp` container
  invariants forces epoch evaluation, and
  `test_corrupt_page_header_facts_are_rejected` gained a `version` case proving
  `page::load` rejects a mismatched epoch.
- Gap (2) is discharged by exhaustive enumeration rather than a live harness:
  every assignment to a reader's current page in `journal.cpp` originates from
  `page::load`, which throws on an epoch mismatch, so a mismatched page can never
  reach the assembler. A live "reader reaches the branch" harness is impossible
  precisely because `page::load` refuses the page first.
- Cross-platform identity holds by construction: every `page_header` /
  `frame_header` field is fixed-width (`uint32_t`, `uint64_t`, `int32_t`,
  `int64_t`, and `PageStatus` / `FrameDataType`, both `: int8_t`), so
  `sizeof` / `alignof` and the derived epoch are platform-invariant. Linux CI
  builds and runs the fingerprint constexpr green as second-compiler evidence. If
  a future field adopts a platform-variable type (pointer, `long`, unfixed enum),
  this invariant breaks and must be re-established.

## Replacement Criteria

A replacement design is acceptable only if it preserves:

1. one closed, non-self-describing container epoch on the hot path;
2. hard refusal (never in-place adaptation) of a mismatched page in the live
   read/write path;
3. a compile-time guarantee that a layout change cannot ship without an epoch
   advance;
4. cross-epoch reading kept off the zero-copy hot path (offline converter or
   equivalent explicit cold path);
5. no dead code that implies a cross-epoch capability the hot path lacks.
