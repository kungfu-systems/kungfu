# Python SDK handbook

> **Staged surface.** The Python `kungfu-storage` source adapter and shared
> Episode/query/fsck/export fixture exist, but the package is not yet a
> published cross-platform release. There is no stable public `kungfu.ledger()`
> API, and this handbook deliberately does not invent one.

Python is a thin binding over the same versioned `libkungfu` storage contract
used by the native and Node surfaces. It must not redefine Episode identity,
causality, Cuts, query meaning, repair semantics, or Proof.

Current evidence and adoption boundaries:

- [Product Layers](../../../../docs/concepts/product-layers.md) — ecosystem package
  qualification and availability.
- [Adapters](../../../../docs/architecture/adapters.md) — the pybind11/native membrane.
- [Episode Object Model](../../../../docs/concepts/episode-object-model.md) — semantic
  authority.
- [SDK layer qualification](../../../../tests/qualification/layers/README.md) —
  the shared source and exact-artifact fixtures.

Until a published artifact and generated API reference exist, use the source
tree and qualification reports for evaluation. Do not copy illustrative method
names from older drafts into application code.
