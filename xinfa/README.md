# Xinfa

Xinfa is **The Verified Context Compiler for Human-Agent Software
Development**. It compiles declared project sources into one deterministic,
drift-aware Context IR, a portable Repository Context Pack, and one immutable,
cut-bound `xinfa.atlas/v1`. Human
documentation routes and Agent task routes consume the same cut, node status,
provenance, evidence, omissions, expansion handles, and Atlas root; later
bounded projections build on that authority. `xinfa.task-chart/v1` is the
canonical task/role/budget selection object; `xinfa context` is its direct
Agent-facing alias, not a second context authority.

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
./shifu xinfa:dogfood
```

The standalone qualification copies only the files listed in
`extraction-manifest.json` into a clean temporary directory, removes host
product environment variables, builds and tests the copied crate, and verifies
the stable CLI contract. The first retained receipt is
[`qualification/standalone-smoke-v1.json`](qualification/standalone-smoke-v1.json).
`xinfa:dogfood` exercises the tracked [project submission](../.xinfa/project.json)
through three independent entry paths: the extracted standalone binary, the
Shifu Documentation Protocol adapter, and Kungfu's read-only Human/Agent/GUI
consumer. Shifu validates its named submission before delegating compilation
and verification to the public Xinfa CLI; it does not implement a second
compiler. Kungfu similarly invokes only public `verify`, `read`, and `context`
commands, then materializes derived files into a new output directory without
overwriting human-owned prose.

The dogfood fault campaign changes implementation evidence and expressive
`non-claim` prose separately, rejects `.xinfa/generated/**` feedback, and
models explicit acceptance as a new managed source cut plus successor Atlas.
Its retained result is
[`qualification/shifu-kungfu-dogfood-v1.json`](qualification/shifu-kungfu-dogfood-v1.json).
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
./target/debug/xinfa read --atlas atlas --route small.human --intent "understand runtime" --surface human --max-hops 2 --json
./target/debug/xinfa read --atlas atlas --route small.human --intent "understand runtime" --surface gui --max-hops 2 --json
./target/debug/xinfa chart create --atlas atlas --route small.agent --task "change runtime greeting" --role implementer --budget 2048 --json
./target/debug/xinfa context --atlas atlas --route small.agent --task "change runtime greeting" --role implementer --budget 2048 --json
./target/debug/xinfa chart inspect --chart task-chart.json --json
./target/debug/xinfa chart verify --chart task-chart.json --atlas atlas --json
./target/debug/xinfa expand --atlas atlas --view task-chart.json --handle sha256:... --budget 1024 --json
./target/debug/xinfa diagnose --json
```

`xinfa atlas compile` is the primary object boundary. It emits an Atlas
directory containing `atlas.json`, capability-equivalent `views/human.json`
and `views/agent.json`, manifest and receipt artifacts, plus the exact legacy
Context Pack trio under `compatibility/context-pack-v1/`. `atlas_root` is the
identity of the new immutable object; it is deliberately distinct from the
embedded Pack root. Both derived views bind the same Atlas root, cut, status,
evidence, omissions, and expansion handles.

The basic `xinfa.atlas-view/v1` files remain byte-stable Atlas-directory
artifacts. Bounded readers are additive, disposable projections compiled on
demand:

- `xinfa.human-view/v1` resolves an intent-aware landing and declared
  relationships within `--max-hops`;
- `xinfa.task-chart/v1` selects route authority in deterministic dependency
  order within an explicit token budget and embeds exact selected source
  payloads plus `why_included` and source roots;
- `xinfa.gui-view/v1` projects summary, detail relationships, status, and stable
  expansion handles for an interactive consumer.

All three carry the same parity block: `atlas_root`, cut/root, route status and
authority root, evidence, Atlas omissions, and source roots. Presentation bytes
and selection omissions may differ. A budget that cannot carry required
authority returns `status=degraded` with explicit omissions; it never presents
silent truncation as a complete context. `xinfa expand` verifies the handle and
predecessor projection and refuses to switch Atlas root or cut. A changed cut
requires compiling an explicit successor projection.

Projection recipes are versioned under `.xinfa/projection-recipes/`. Generated
materializations belong under `.xinfa/generated/`, never overwrite human-owned
prose, and are excluded from provider input even when a manifest names them.
Acceptance means copying or editing content into a managed source path,
declaring a new source cut, and compiling a successor Atlas; no command promotes
derived bytes into the current cut.

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
Repository Context Pack and bounded projection compilers. It validates exact provider paths,
fail-closed visibility, typed nodes/relations, declared-dependency drift,
bidirectional coverage, impact closure, dual-reader route parity, bounded human
navigation, Task Chart budgets, GUI expansion, and generated-feedback
exclusion. It does not implement natural-language claim extraction, embeddings,
native CAS/incremental compilation, arbitrary provider execution, product
adapters, publishing, or a stable release claim.
