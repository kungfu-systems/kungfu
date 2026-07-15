# Xinfa

Xinfa is **The Verified Context Compiler for Human-Agent Software
Development**. It compiles declared project sources into one deterministic,
drift-aware Context IR. Human documentation routes and Agent task routes consume
the same cut, node status, provenance, evidence, and authority root; later
bounded task capsules and distributable context packs build on that authority.

Xinfa is an independent product incubated in this repository. Its source
location is not an ownership boundary: it has its own `xinfa` CLI, `xinfa.*`
protocol namespace, version, release tag, artifacts, state, cache, license,
and extraction manifest. The core binary has no Kungfu or Shifu runtime
dependency; its closed public-registry dependency allowlist rejects path, git,
private, and monorepo-relative dependencies.

## Authority

| Layer | Owns | Does not own |
| --- | --- | --- |
| Project | source documents, domain semantics, provider instances, route intent | Context IR or compiler receipts |
| Shifu | project submission protocol, conformance diagnostics, Gate execution, thin invocation adapters | a second Context IR, graph, selector, pack, or capsule compiler |
| Xinfa | Context IR, graph and impact semantics, selection, pack/capsule formats, compiler provenance | project truth, runtime facts, or release attestation |
| Kungfu | product adapters and read-only consumption of public Xinfa artifacts | Xinfa schemas, state, version, or compiler internals |
| Buildchain | exact artifact and release attestation | authoring or compiler semantics |

The dependency direction is Project sources → public submission contracts →
Xinfa compiler → public Xinfa artifacts → product adapters. Shifu may validate
and invoke that path, but it may not compile a parallel graph or pack.

## Development and standalone proof

Use the repository entrypoint while Xinfa is incubated here:

```sh
./shifu xinfa:build
./shifu xinfa:check
./shifu xinfa:standalone
```

The standalone qualification copies only the files listed in
`extraction-manifest.json` into a clean temporary directory, removes host
product environment variables, builds and tests the copied crate, and verifies
the stable CLI contract. The first retained receipt is
[`qualification/standalone-smoke-v1.json`](qualification/standalone-smoke-v1.json).
The extraction itself builds with ordinary Cargo:

```sh
cargo build --locked --manifest-path Cargo.toml
./target/debug/xinfa --version
./target/debug/xinfa contract --json
./target/debug/xinfa schema project
./target/debug/xinfa validate --project fixtures/project-alpha.json --json
./target/debug/xinfa canonicalize --project fixtures/project-alpha.json --json
./target/debug/xinfa compile --project fixtures/project-alpha.json --json
./target/debug/xinfa diagnose --json
```

Runtime state defaults to project-local `.xinfa`. Set `XINFA_STATE_HOME` and
`XINFA_CACHE_HOME` explicitly to relocate state or cache. Diagnostic commands
are read-only and do not create either directory.

The current slice freezes product identity plus the minimal
`xinfa.project/v1` → `xinfa.context-ir/v1` compiler. It validates exact provider
paths, fail-closed visibility, typed nodes/relations, declared-dependency drift,
and dual-reader route parity. It does not yet implement traversal, natural
language claim extraction, Pack/Capsule selection, product adapters,
publishing, or a stable release claim.
