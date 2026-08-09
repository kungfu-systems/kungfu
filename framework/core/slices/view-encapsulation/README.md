# view-encapsulation slice

**Proof:** all C++ FlatBuffers / reflection access lives behind one
runtime-independent chokepoint — `kungfu::view` ([KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc](../../../../docs/adr/KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc.md)). The open-layer
`.bfbs`-reflection projection round-trips a frame to SQLite and back through the
`kungfu::view` public API alone, and no code outside the `kungfu::view` module
names a raw `flatbuffers::` / `reflection::` symbol.

**What a red run means:**

- **`view_encapsulation_probe` fails** — the sole-access-point API regressed:
  the thin/full projection roundtrip, the schema-evolution (`evolve` +
  `alter_add_missing`) path, or the untrusted-input verifier
  (`from_bytes` / `verify_table`) no longer behaves as the pre-migration
  `fb_projector` free functions did. The probe compiles `src/view/schema.cpp`
  directly and links **neither `yijinjing` nor `libkungfu`** — only the
  directory-wide FlatBuffers + SQLite. That it builds without the runtime is the
  boundary claim: the view module depends on nothing above it and is a swappable
  detail.

- **The boundary guard fails** — a raw `flatbuffers::` / `reflection::` symbol or
  header include reappeared outside `kungfu::view`
  (`src/libkungfu/check-view-boundary.mjs`). The `.bfbs` dangling-view bug is
  only structurally unrepresentable while FlatBuffers stays behind this one
  interface.

**Design invariants pinned:**

- The `.bfbs` bytes and their reflection view share one lifetime: `schema_handle`
  co-owns the bytes (`shared_ptr<const std::string>`) and never hands out a bare
  `reflection::Schema *`, so a dropped-buffer / dangling-view is unrepresentable.
- Untrusted `.bfbs` input is verified (`VerifySchemaBuffer`) at the load boundary
  before any access.
- The POD hot-path regime (`kungfu/view/pod.h`) stays zero-cost and is not
  exercised here — it carries no FlatBuffers and compiles to the identical
  pointer-plus-offset load as a direct `frame->data<T>()` read.

**Run:** `node run.mjs [build-dir]` (built under `-DKUNGFU_WITH_SLICES=ON`).
