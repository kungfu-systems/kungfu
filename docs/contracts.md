# Contracts — what kungfu actually guarantees

What you can rely on, stated as contracts you can verify, with each one's current
maturity. This is a *verify*-plane document: every entry says **what is
guaranteed → where to verify it → how mature the guarantee is**. For what is
*not* yet guaranteed, see [`known-limits.md`](known-limits.md); for the data
model these contracts are about, see [`event-model.md`](event-model.md).

## Frame publication is tear-free (single-writer / multi-reader)

**Guarantee.** A reader never observes a frame before its payload is fully
written — no torn or stale frames — on both strong-memory (x86) and weak-memory
(ARM / Apple Silicon) targets. The writer publishes the `length` token last with
a release store; readers gate on it with an acquire load before reading the
payload.

**Verify.** Two things you can check in this repository: the implementation in
[`frame.h`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h)
(`publish_data_length()` release / `acquire_length()` acquire) and
[`writer.cpp`](../framework/core/src/libyijinjing/src/journal/writer.cpp); and
the decision plus reported stress-test results in
[ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)
(0 tears across hundreds of millions of reads on arm64 and x86). Note: the
standalone stress harness that produced those numbers is not shipped in this
repository — you can read the implementation and the reported results, but
re-running that specific proof from the repo alone is not currently possible.

**Maturity.** `stable` — implemented, and stress-validated on both architectures
per the results reported in ADR-0001.

## The longfist binary layout is the cross-language / on-disk contract

**Guarantee.** The same in-memory bytes are read by C++, Python, and Node without
parsing, and the same bytes are what is persisted to the journal. The layout
*is* the ABI: a consumer speaks a layout, it does not negotiate one. The schema
is a declared FlatBuffers definition
([`*.fbs`](../framework/core/src/libkungfu/include/kungfu/longfist/fb)) generated for all
three languages, not a C++-internal secret.

**Verify.** [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)
(the layout as the true invariant) and
[ADR-0002](../framework/core/docs/adr/ADR-0002-longfist-flatbuffers-runtime-schema.md)
(the FlatBuffers migration); the schema files under
[`longfist/fb/`](../framework/core/src/libkungfu/include/kungfu/longfist/fb).

**Maturity.** The layout-as-contract is `stable`. The **enforcement** that lets
an external consumer rely on a stated compatibility *window* (CI checks against
breaking changes, a runtime ≥ schema load gate, cross-version replay tests) is
**not yet built** — see [`known-limits.md`](known-limits.md#compatibility-governance-is-designed-not-yet-enforced).
Until then: treat compatibility as per-minor, and verify against the layout, not
a version number.

## Replay runs on the same runtime as live

**Guarantee.** Recorded journals are re-read on the *same* runtime and the *same*
semantics as live — there is no separate replay engine. Combined with the
nanosecond `gen_time` and the `trigger_frame_uid` causal links in each frame
(see [`event-model.md`](event-model.md)), a recorded stream reproduces with high
precision.

**Verify.** [`replay_writer.cpp`](../framework/core/src/libkungfu/src/yijinjing/journal/replay_writer.cpp)
and the shared journal runtime under
[`yijinjing/`](../framework/core/src/libkungfu/src/yijinjing).

**Maturity.** `stable` for the mechanism (same-runtime replay). The precise
determinism boundary — what is and is not reproducible across machines and
runtime versions — is not yet written as a tested baseline; treat cross-version /
cross-machine bit-exactness as unverified until then
(see [`known-limits.md`](known-limits.md)).

## How to read a guarantee here

A contract is only as strong as its maturity tag. `stable` means implemented and
checkable today against the cited source. Anything weaker names exactly what is
missing and links to where it is tracked — so you can tell a guarantee you can
build on from an intention that is still being built, without reading the source
to find out.
