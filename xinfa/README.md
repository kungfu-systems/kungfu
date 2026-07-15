# Xinfa

Xinfa is **The Verified Context Compiler for Human-Agent Software
Development**. It compiles declared project sources into one deterministic,
drift-aware Context IR, a portable Repository Context Pack, and one immutable,
cut-bound `xinfa.atlas/v1`. Human
documentation routes and Agent task routes consume the same cut, node status,
provenance, evidence, omissions, expansion handles, and Atlas root; later
bounded task capsules build on that authority.

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
| Xinfa | Atlas identity, Context IR, graph and impact semantics, selection, pack/capsule formats, compiler provenance | project truth, runtime facts, or release attestation |
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
./shifu xinfa:fix
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
./target/debug/xinfa compile --project fixtures/repository-small/project.json --output pack --json
./target/debug/xinfa inspect --pack pack --json
./target/debug/xinfa verify --pack pack --json
./target/debug/xinfa impact --since pack --project fixtures/repository-small/project.json --json
./target/debug/xinfa atlas compile --project fixtures/repository-small/project.json --output atlas --json
./target/debug/xinfa atlas inspect --atlas atlas --json
./target/debug/xinfa atlas verify --atlas atlas --json
./target/debug/xinfa atlas diff --before atlas --after atlas --json
./target/debug/xinfa atlas impact --since atlas --project fixtures/repository-small-next/project.json --json
./target/debug/xinfa atlas compile --pack atlas/compatibility/context-pack-v1 --output imported-atlas --json
./target/debug/xinfa diagnose --json
```

`xinfa atlas compile` is the primary object boundary. It emits an Atlas
directory containing `atlas.json`, capability-equivalent `views/human.json`
and `views/agent.json`, manifest and receipt artifacts, plus the exact legacy
Context Pack trio under `compatibility/context-pack-v1/`. `atlas_root` is the
identity of the new immutable object; it is deliberately distinct from the
embedded Pack root. Both derived views bind the same Atlas root, cut, status,
evidence, omissions, and expansion handles.

The compatibility form of `compile` without `--output` emits
`xinfa.context-ir/v1`. Supplying `--output` compiles a
`xinfa.context-pack/v1` directory containing `pack.json`, `manifest.json`, and
`receipt.json`. Publication is atomic and refuses to overwrite an existing
directory. Pack compilation defaults to `public`; `--visibility internal` or
`private` is required to broaden the explicit cut. The compiler embeds UTF-8
payloads and reads only exact files declared by `exact-file-manifest`
providers, rejects provider-root
drift, symlinks, path escapes, sensitive path classes, unsupported providers,
and files larger than the v1 4 MiB bound, and never executes repository text or
hooks.

The pre-existing top-level `compile`, `inspect --pack`, `verify --pack`, and
`impact --since PACK` commands remain compatibility surfaces. Their
`xinfa.context-pack/v1` bytes and roots are unchanged. Atlas compilation wraps
a newly compiled or already verified Pack as an `immutable-input`; it never
renames or reinterprets the Pack as an Atlas. In terminology: **The Atlas
project compiles a Xinfa Atlas**. The repository/project name and the compiled
primitive are not equivalent identities.

Pack artifacts contain repository-relative paths only. They can be moved to a
different directory and verified offline. `impact --since` compares the prior
pack with a freshly compiled project cut and returns the changed source set plus
the explainable affected node, claim, document, and route closure. Expressive
`non-claim` changes may affect their reading route, but do not create claim
drift. V1 does not write a compiler cache; any future cache remains derived
state and cannot change these roots.

Runtime state defaults to project-local `.xinfa`. Set `XINFA_STATE_HOME` and
`XINFA_CACHE_HOME` explicitly to relocate state or cache. Diagnostic commands
are read-only and do not create either directory.

The current slice freezes product identity, the immutable `xinfa.atlas/v1`
primitive and `atlas_root`, the
`xinfa.project/v1` → `xinfa.context-ir/v1` contract, and the first deterministic
Repository Context Pack compiler. It validates exact provider paths,
fail-closed visibility, typed nodes/relations, declared-dependency drift,
bidirectional coverage, impact closure, and dual-reader route parity. It does
not implement natural-language claim extraction, task-specific Capsule
selection, arbitrary provider execution, product adapters, publishing, or a
stable release claim.
