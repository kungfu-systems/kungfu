# Xinfa source architecture

This page is the source-level map for contributors working on Xinfa. The public
protocols and product boundary remain documented in [README.md](README.md);
this page explains where an implementation change belongs and which proofs
must move with it.

## Data flow and host boundary

```text
project / inventory / Episode submission
                  |
                  v
        project validation + Context IR
                  |
          +-------+---------+
          |                 |
          v                 v
   Repository Pack     Episode admission
          |                 |
          v                 v
      immutable Atlas <-----+
          |
      +---+------------+
      |                |
      v                v
 route resolution   bounded projections

native CLI -> native I/O adapter ----+
                                      +-> the same compiler core
WASM host  -> in-memory repository ---+
```

The compiler core owns semantics and deterministic bytes. Native filesystem
access and the WebAssembly JSON-edge host are adapters. Neither adapter may
reimplement validation, Pack, Atlas, route, projection, or Episode semantics.

## Module map

| Module | Owns | Must not own |
| --- | --- | --- |
| `lib.rs` | public crate facade, project normalization, Context IR compilation, stable JSON and digest primitives | filesystem access or product-specific orchestration |
| `project_validation.rs` | ordered validation of project headers, roots, providers, nodes, graph edges, routes, and policies | normalization, compilation, or host I/O |
| `pack.rs` | repository source abstraction and Pack construction facade | native paths or Atlas identity |
| `pack/source.rs` | source admission, sensitive/generated path rejection, and exact provider inventory | Pack verification or impact |
| `pack/verification.rs` | portable Pack inspection and artifact verification | repository reads |
| `pack/impact.rs` | changed-source and reverse-dependency impact calculation | source acquisition |
| `atlas.rs` | immutable Atlas wrapping/import, manifest and receipt verification, diff, and impact | source discovery or route selection |
| `resolver.rs` | task-envelope validation and exact route resolution | Task Chart selection or ambient route fallback |
| `projection.rs` | Task Chart, Human, and GUI projections plus bounded expansion | Atlas mutation or source acquisition |
| `episode.rs` | typed Episode units, review chart, and successor Atlas compilation | journal-native root recomputation or runtime storage |
| `episode/admission.rs` | sealed provider, claims, qualification, path, and root admission | successor project mutation |
| `semantic_project.rs` | exact Shifu surface inventory to Xinfa project materialization | filesystem discovery or Shifu policy |
| `native_io.rs` | path-safe native reads, verified artifact loading, and synchronized writes | compiler semantics |
| `command.rs` | host-neutral command classification, option validation, and schema lookup | filesystem or in-memory repository execution |
| `cli.rs` | native process presentation, environment diagnostics, stdin/filesystem delegation, and exit status | duplicate command grammar or compiler semantics |
| `engine.rs` | JSON-edge request/response ABI and in-memory repository adapter | duplicate command grammar or native filesystem assumptions |
| `main.rs` | thin native binary entry | business logic |

## Change recipes

### Change project validation

1. Update the appropriate validator in `project_validation.rs`.
2. Preserve diagnostic sorting and, unless the protocol intentionally changes,
   existing diagnostic codes, paths, and messages.
3. Add or update a negative fixture and its exact expected diagnostics.
4. Run `./shifu xinfa:check` and `./shifu xinfa:standalone`.

### Add or change a command

1. Declare its grammar once in `command.rs`.
2. Implement semantic work in the owning core module.
3. Keep `cli.rs` and `engine.rs` limited to their host capabilities.
4. Add parser coverage and native/WASM parity evidence; update the product
   contract and schemas only when the public surface intentionally changes.

### Change Pack, Atlas, or Episode bytes

Treat this as a compatibility change, not an internal refactor. Review the
schema-set manifest, golden artifacts, route-root contract, standalone receipt,
WASM qualification, and Project Cut evidence. An unexplained Root or byte
change is a failure.

### Change native filesystem behavior

Keep repository-relative path validation in the semantic core and host path
safety in `native_io.rs`. Cover traversal, symlink, incomplete artifact, and
write-boundary behavior. The WASM engine must remain filesystem-independent.

## Structural invariants

- JSON is the public edge representation; deterministic semantic operations
  remain shared behind Native and WASM adapters.
- Stable JSON recursively orders object keys by UTF-8 bytes and ends with one
  LF before hashing.
- Route resolution must return one admitted route or fail visibly; array order
  and lexical signal alone are never authority.
- Pack verification is portable and offline. Atlas verification wraps, but
  does not reinterpret, the embedded Pack bytes.
- Episode admission verifies provider and qualification evidence but never
  recomputes a journal-native Episode root.
- Generated projections cannot feed the same source cut back into the compiler.
- The crate remains extraction-first and has no Kungfu or Shifu dependency.

## Proof ladder

Use the repository entrypoint for all checks:

```sh
./shifu xinfa:check
./shifu xinfa:wasm:check
./shifu xinfa:standalone
./shifu xinfa:dogfood
./shifu check:source
```

For a behavior-preserving refactor, compare the retained roots, receipts,
goldens, command results, and WebAssembly qualification before and after the
change. A green formatter or unit suite alone is not sufficient evidence.
