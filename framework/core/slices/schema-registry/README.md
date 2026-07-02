# Schema-registry slice

**Probe statement.** This slice pins "decodable without the runtime that wrote
it": events carry only an opaque `msg_type` on the wire, and the bundle's
format pieces — content-addressed schema blobs (`schemas/<sha256>.bfbs`) plus
per-run manifest bindings (`schema_bindings`) — are enough for an independent
tool to print named, typed fields through FlatBuffers runtime reflection. The
decoder links no generated code and no compiled type registry; a red run means
the self-describing-format promise regressed, or the schema-binding format
drifted from what the decoder understands.

## Design (ratified)

- **Carrier**: FlatBuffers reflection schemas (`.bfbs`), generalizing the
  existing open-layer mechanism — one mechanism, not two.
- **Binding**: one `msg_type → schema` binding per run, recorded in the run
  manifest (the trust root). Schema evolution happens between runs; two runs
  binding different versions of the same type coexist and both decode.
- **Blobs**: schemas are content-addressed like any other committed content;
  the decoder re-verifies the hash before trusting a blob.
- **Allocation**: `msg_type` numbers come from `docs/msg-type-ranges.md`;
  this slice uses `20021` (FB) and `20022` (Json).
- **Boundary**: Json events are registered (`schema_kind=json`) but not
  schema-verified in v0; legacy closed-set POD frames are out of scope by
  design and the manifest says so.

## Run

```bash
slices/schema-registry/run.sh [build-dir]
```

Two producer runs (schema v1, then v2 which adds a field) each emit a journal
plus a bundle; the decoder decodes both from their bundles alone. The script
asserts the named fields appear, the v2-only field appears only in the v2
output, and the two runs bound different schema hashes.
