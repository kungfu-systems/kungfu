# libkungfu portable format surface

This package is the pre-release aggregation surface for a portable Kungfu fact
artifact. It proves that one versioned manifest can route a consumer to format
prose, schemas, capabilities, conformance material, and language handbooks.

> **Walking-skeleton status.** The manifest pipeline is active, but the bundled
> Spec 0.1 prose predates Kungfu's Episode-centered object model and is not the
> current normative `.kungfu` contract. The language handbooks are staged and
> must not invent APIs or availability ahead of their owning packages.

The current public object is the **Episode**: a bounded causal unit whose Facts,
Artifacts, Manifest, Receipts, dependencies, and verification roots can be
inspected, sealed, exported, replayed, recovered, and used to support
Decisions. Portable format work must preserve that authority rather than
creating a second run-, session-, library-, or website-owned truth.

## Start with current authority

- [The Episode](../../../docs/the-episode.md) — public execution model.
- [Episode Object Model](../../../docs/episode-object-model.md) — lifecycle,
  manifest authority, portability, and maturity.
- [Event Model](../../../docs/event-model.md) — journal, frames, schemas, and
  Replay mechanics.
- [Product Layers](../../../docs/product-layers.md) — the staged `.kungfu`
  format/spec product boundary.
- [Known Limits](../../../docs/known-limits.md) — absent release and
  compatibility guarantees.

## Bundle inputs

- [Format Spec 0.1 draft](format-spec.md) — retained historical input for the
  walking skeleton; explicitly non-normative.
- [Kungfu CLI handbook](handbooks/cli.md) — current source-backed command
  routes and maturity.
- [Python SDK handbook](handbooks/python.md) and
  [Node SDK handbook](handbooks/node.md) — staged ecosystem surfaces without
  illustrative fictional APIs.

The format remains valuable because portable evidence should outlive a runtime,
library, UI, or documentation host. That goal does not make the current 0.1
draft a stable compatibility promise. Promotion requires a dedicated format
decision, a complete schema and conformance contract, executable readers, and
retained cross-version evidence.
