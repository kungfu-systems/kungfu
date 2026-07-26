# Kungfu portable format authority

This bundle is the deterministic, content-addressed distribution surface for
Kungfu's `.kungfu` format authorities. It lets a human, agent, site, or
independent tool inspect the exact current composition, reader contract,
compatibility tuple, migration graph, and retained vectors without treating
the package as a new semantic owner.

Start with `manifest.json`:

- `normative.root` binds every normative generated artifact;
- `artifacts.*.artifact_root` binds exact distributed bytes;
- `artifacts.*.source_roots` bind those bytes back to their owning sources;
- `normative.status` and `non_claims` state the current pre-release boundary;
- `history` separates historical material from current authority routes.

The current public object is the **Episode**: a bounded causal unit whose Facts,
Artifacts, Manifest, Receipts, dependencies, and verification roots can be
inspected, sealed, exported, replayed, recovered, and used to support
Decisions. The portable format composes the independently owned protocols that
make that object durable; it is not one mega-schema, directory layout, npm
package, or website.

## Machine authority routes

- `authority.json` — composition boundary and authority status.
- `registry.json` — protocol owners and exact source roots.
- `capabilities.json` and `reader-matrix.json` — bounded reader behavior.
- `compatibility.json` and `migration.json` — per-axis compatibility,
  append-only v4 alpha baseline, successor identity, repair, and refusal.
- `vectors/index.json` — qualified retained evidence across every compatibility
  axis and all required-reader outcomes.

The installed package also includes a stdlib-only Python reader under
`reference-readers/python/`. It verifies every rooted artifact and retained
vector without importing Kungfu runtime or monorepo code.

## Human context

- [Kungfu CLI handbook](handbooks/cli.md)
- [Node binding handbook](handbooks/node.md)
- [Python binding handbook](handbooks/python.md)
- [The `.kungfu` Format Contract](../../../docs/architecture/kungfu-format-contract.md)
- [The Episode](../../../docs/concepts/the-episode.md)
- [Episode Object Model](../../../docs/concepts/episode-object-model.md)
- [Event Model](../../../docs/architecture/event-model.md)
- [Product Layers](../../../docs/concepts/product-layers.md)
- [Known Limits](../../../docs/qualification/known-limits.md)

The historical Spec 0.1 prose is retained under `history/` for audit only. It
does not define current reader or compatibility behavior.
