# Start with the portable format boundary

You are at **Orient**, the first of five reading levels. You only need one
decision here: are you rendering Kungfu documentation, or directly operating
on the portable format?

## Choose the package

Use `@kungfu-tech/site` when you are building a human or agent site. It carries
an integrity-bound copy of this complete reader journey and exposes page and
guide models. A site consumer does not need a Kungfu monorepo checkout.

Use `@kungfu-tech/spec` when your program must inspect or verify authority,
invoke `kungfu-spec`, run the independent Python reader, inspect conformance
vectors, or operate on a portable bundle.

The Site package explains those direct Spec operations, but it does not claim
to export the Spec CLI, Node API, or Python reader itself.

## Know the boundary

`@kungfu-tech/spec` is a deterministic projection of accepted `.kungfu`
authorities. It is not a new semantic owner. Its current portable authority is
explicitly **pre-release**:

- `manifest.normative.root` binds the complete normative projection;
- each `artifacts.*.artifact_root` binds exact distributed bytes;
- each `artifacts.*.source_roots` points back to the owning source;
- compatibility is decided from the Spec axes and reader contract, not npm
  semver;
- historical Spec 0.1 prose is audit material, not the current format spec.

## Continue only as far as you need

1. [Verify your first installed authority](quickstart.md).
2. Then choose a task: [Node API](api.md), [Spec CLI](cli.md), or
   [independent Python reader](python-reader.md).
3. Read [conformance evidence](conformance.md) when you need to interpret
   outcomes, and use the [complete reference](reference.md) only when you need
   the full contract map.

Next: [Verify your first installed authority](quickstart.md)
