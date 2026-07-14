---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0078
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/772, https://github.com/kungfu-systems/kungfu/pull/802]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-13
theme: minimal-generic-core-closure
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0078: The minimal generic `.kungfu` core closure — libkungfu owns generic maintenance/self-describing primitives; domain interpretation stays in outer rings; expose generic frame decode and frame checksum on the membrane

- Status: accepted (criterion + direction); implementation **partial** — the line
  (Decision 1), the primitive **exposure** (Decision 2, on pybind + membrane C
  ABI v3 + the Rust wrapper), and the outer-ring **de-duplication** (Decision 3 —
  `rewind` decode + `atlas` checksum call the exposed primitives) have all landed;
  the remaining item is cross-membrane enum-representation symmetry (see Follow-up)
- Date: 2026-07-13
- Category: layering / native-core closure / embedding membrane
- Related: [ADR-0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md)
  (higher layers add convenience never authority; the native core owns the
  **generic** runtime-fact lifecycle, the application owns its domain),
  [ADR-0071](ADR-0071-cli-language-split-and-membrane-diagnostic-surface.md)
  (grow the embedding membrane's read-only surface rather than rewrite commands),
  [ADR-0039](ADR-0039-unified-view-interface-encapsulates-flatbuffers.md)
  (the unified view interface encapsulates FlatBuffers; `.bfbs` reflection is the
  one seam), [choose-your-kungfu](../guides/choose-your-kungfu.md) (the adoption contract).

## Context

ADR-0049 is explicit: *the application owns its **domain**—agents, trades,
simulations…; the native core owns the **generic** runtime-fact lifecycle:
ordering, Episodes, storage, replay, query, verification, recovery, and export.*
"generic" is the load-bearing word. `choose-your-kungfu.md` promises that a user
who links `libkungfu` — with no Python, Node, Rust host, or Electron — can
maintain their own `.kungfu` data.

A 2026-07-13 grounding scan surfaced a boundary question and two concrete
defects:

- **The generic primitives already exist in libkungfu C++.** `.bfbs`-reflection
  frame decode is `kungfu::view::schema_handle::decode_json(buf,len) ->
  table_codec_result{ok,json,error}` (`framework/core/src/libkungfu/include/kungfu/view/schema.h`,
  ADR-0039 — the one reflection seam), producing structured fields from any
  open-layer frame given its schema, with no domain knowledge. Whole-frame and
  payload integrity are `checksum_frame` / `checksum_payload`
  (`framework/core/src/libkungfu/src/runtime/action_recorder.cpp`). These are in
  the public `include/` tree, so an **in-tree C++ consumer already reaches them**.
- **Outer rings re-implement those generic primitives.** `rewind`'s Python
  `BundleDecoder` (`framework/core/src/python/kungfu/rewind/replay.py`) is a pure
  Python `reflection_fb` re-implementation of `decode_json` (its own comment
  states it decodes "an arbitrary kfx schema, not just the subset Rewind uses").
  `atlas`'s Python `_crc32c_*` / `_fnv1a64_*` / `_checksum_frame`
  (`framework/core/src/python/kungfu/atlas/store.py`) re-implement the C++
  checksums and additionally **hard-code the `frame_header` field layout** — a
  fragile duplication that must be kept in lock-step with C++ by hand.
- **The primitives are not reachable off the C++ ring.** The embedding-membrane
  C ABI (`native_storage`) exposes only ~17 domain storage operations and **no**
  generic decode/checksum entry; pybind exposes `verify_flatbuffer_payload`,
  `compile_schema`, `checksum_payload`, and the action-envelope codec, but **not**
  `decode_json` or `checksum_frame`. So Python, Rust, and cross-process consumers
  cannot call the generic primitives and re-implement them instead.

The question this raises — and the thing that must be decided before any code
moves — is *where the line is*: which capabilities are the generic core's, and
which are domain extensions that must **not** be pulled into libkungfu.

## Decision

### 1. The line: minimal generic closure vs domain extension

`libkungfu` owns the **minimal closed set of generic `.kungfu` maintenance and
self-describing primitives**, and only those:

- ordering; Episode lifecycle; storage; generic fact query; integrity
  verification (including frame/payload **checksum** and fsck); recovery; generic
  bundle **export**; generic **replay / historical-cut** of the fact/Episode
  model; and the schema-driven generic **frame decode** (`.bfbs` reflection).

The **domain interpretation** of frames is a **domain extension** and lives in the
outer rings (language SDKs, CLI/TUI, or a consumer's own C/C++/Rust/Python code),
built **on** the membrane, in any language:

- `rewind` (agent execution causal trees), `work` (work-item projections),
  `atlas` (mission/goal imports and projections), `profile` (composition /
  validation / planning), `mission-control` (projection assembly / scoring).
  agents, work, and atlas are exactly the "domains" ADR-0049 says the application
  owns.

These domain folds are **not** migrated into libkungfu. Schema-specific
`flatc`-generated accessors (e.g. `work`'s typed event accessors) are legitimate
domain products and also stay in the outer rings. **This is what makes the
membrane meaningful**: libkungfu is a minimal generic substrate; each domain
builds its own fold on top. Pulling every domain fold into the core would
recreate a monolith and make the membrane pointless.

### 2. Expose the two missing generic primitives on the membrane

Expose, as **narrow, versioned, read-only** entries — via **both** pybind **and**
the embedding-membrane C ABI, continuing ADR-0071's grow-the-membrane /
`storage_fsck` v2 pattern:

- `schema_handle::decode_json` — generic frame (+ its schema) → structured
  fields (JSON blob), so any language can decode any `.kungfu` frame without
  re-implementing reflection.
- `checksum_frame` — whole-frame integrity (`checksum_payload` is already on
  pybind and rides the same surface).

Exposing on the C ABI (not only pybind) is deliberate: the ring closure must hold
for Rust and cross-process consumers, not only Python and in-tree C++.

### 3. De-duplicate the outer-ring re-implementations

- `rewind`'s Python `BundleDecoder` reflection → call the exposed `decode_json`.
- `atlas`'s Python checksum re-implementation → call the exposed C++
  `checksum_frame` / `checksum_payload`, removing the hand-mirrored `frame_header`
  layout.

Only the **generic primitive call** moves; the domain fold logic around it stays
in the outer ring.

## Consequences

- **Positive**: outer rings stop re-implementing generic primitives (removing the
  fragile hand-mirrored `frame_header` layout in `atlas`); non-C++ consumers reach
  the generic self-describing closure through one narrow contract face; the
  `libkungfu`-only C/C++ story that ADR-0049 promises is made reachable off the
  in-tree path.
- **Cost / maintenance surface**: two new narrow, versioned, read-only membrane +
  pybind entries. They must stay generic (frame-in / structured-out; bytes-in /
  checksum-out) and read-only, so the contract face does not balloon back into a
  god object.
- **Explicit non-goals**: do **not** migrate domain folds (`rewind` / `work` /
  `atlas` / `profile` / `mission-control`) or `flatc`-generated domain accessors
  into libkungfu — that is correct placement per ADR-0049, not debt.

## Alternatives considered

1. **Migrate the domain folds (`rewind`/`work`/`atlas`) into libkungfu.**
   Rejected: bloats the core, defeats the membrane's purpose, and violates
   ADR-0049 — agents/work/atlas are *domains*, which the application owns, not the
   generic core.
2. **Leave the Python re-implementations as they are.** Rejected: a DRY and
   ring-law violation (an outer ring re-implementing a generic primitive); the
   `atlas` checksum hard-codes the `frame_header` layout and is fragile; and
   non-C++ consumers, unable to reach the primitives, would keep re-implementing.
3. **Expose via pybind only.** Rejected: leaves Rust and cross-process consumers
   unable to reach generic decode/checksum, so the ring closure would hold only
   for Python and in-tree C++.
4. **Widen the membrane to mirror the whole domain surface.** Rejected: recreates
   a god object — exactly what ADR-0071's membrane discipline forbids.

## Follow-up

- **Landed (exposure delivery, PR #772)**: Decision 1 (the line, documented here)
  and Decision 2 (expose the two generic primitives) — `decode_json` →
  `decode_flatbuffer_payload_json` (pybind) + `decode_frame_json` (membrane C ABI
  v3), and `checksum_frame` on pybind + the C ABI, both mirrored in the
  `kungfu-embedding` Rust wrapper (ABI v3, `CAP_GENERIC_CODEC`).
- **Landed (de-dup delivery, this PR)**: Decision 3 — `rewind` `BundleDecoder`
  decodes through `decode_flatbuffer_payload_json` (filling absent strings with
  `None` for contract parity) and `atlas` store checksums call `checksum_frame` /
  `checksum_payload`; the hand-rolled reflection walk, crc32c/fnv1a tables, and
  `frame_header` layout packing are removed, with the domain folds left in the
  outer rings. The grounding-surfaced prerequisite is met by opting `frame_header`
  into a read-only zero-copy Python buffer protocol, and the decode primitive now
  takes `enum_as_int` (integer enum form matching the three reflection decoders —
  Python `BundleDecoder`, TS `ReflectionDecoder`, the generated accessors) and
  `object_name` (decode a specific table, not just the `.bfbs` root). Validated by
  old-vs-native checksum equivalence (both algorithms) and rewind field-by-field
  parity against the generated-accessor oracle, on **all three hosts** — Mac
  (arm64), agent-120 (Linux x86_64), and DARKHERO (Windows x86_64) — full build
  plus equivalence tests. The earlier Windows RocksDB source-build blocker is
  resolved (RocksDB now resolves from the qualified Conan cache, no GitHub clone).
- **Remaining follow-up**: cross-membrane enum representation symmetry. The de-dup
  makes the pybind `decode_flatbuffer_payload_json` emit integer enums
  (`enum_as_int`); the C ABI `decode_frame_json` and its Rust mirror still emit
  enum identifiers. A follow-up should give those membranes the same integer-enum
  form so the generic decode primitive reads identically across all three
  membranes. `implementation_status` stays `partial` until that symmetry lands.
