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

Automatic Agent admission starts with `xinfa.task-envelope/v1` and
`xinfa route resolve`. The project declares route `resolution` intent
(subjects, capabilities, owners, roles, Mission tracks, and bounded lexical
terms); Xinfa verifies that declaration against one exact Atlas and emits a
content-addressed `xinfa.route-resolution/v1` receipt. Only unique structured
evidence may select a route. Objective text and embeddings may break a tie but
may not decide authority, visibility, required capability, or the active cut.
Missing evidence is `ambiguous` or `degraded` with candidates, omissions, and a
next action; it is never silently replaced by the first route.

Xinfa is an independent semantic authority incubated in this repository. Its
source location is not an ownership boundary: it retains its own `xinfa.*`
protocol namespace, version, state, cache, license, and extraction manifest.
The Rust library has no Kungfu or Shifu dependency; its closed public-registry
dependency allowlist rejects path, git, private, and monorepo-relative
dependencies. `kungfu-trunk` links that library in one direction and exposes it
only as `kungfu xinfa`. The thin physical `xinfa` binary remains a
source-development and extraction oracle, not a separately packaged engine or
second terminal-user entrypoint.

The same Rust authority also compiles to the checked-in
[`engine/xinfa.wasm`](engine/xinfa.wasm). Its
[`manifest.json`](engine/manifest.json) binds the exact source-tree hash,
WebAssembly SHA-256, Rust version, and byte size. This engine is the default
source-checkout execution path and a packaged verification artifact; the
native `kungfu-trunk` remains the only production receipt-minting authority.

## Agent discovery and help

Agents working in this repository start from
[`AGENTS.md`](../AGENTS.md) and the task-oriented
[`Verified Context for Agents`](../docs/guides/xinfa-agent-context.md) guide.
The source-checkout compiler entrypoint is `./shifu xinfa`; Shifu documentation
commands remain thin adapters over the Xinfa Atlas, route-resolution, and Task
Chart contracts. Installed products use `kungfu xinfa`; `kungfu agent docs`
continues to verify and read the precompiled product documentation Atlas.

For installed machine consumers, `kungfu xinfa contract --json` is the product
discovery root. `kungfu xinfa schema task-envelope`,
`kungfu xinfa schema route-resolution`, and
`kungfu xinfa schema task-chart` print the exact current schemas. Automatic
invocation requires a coordinator to create and resolve the structured task
envelope and bind the verified roots. A Go card, Agent instruction, Skill, or
Episode alone does not execute Xinfa.

## Authority

| Layer | Owns | Does not own |
| --- | --- | --- |
| Project | source documents, domain semantics, provider instances, route intent | Context IR or compiler receipts |
| Shifu | project submission protocol, conformance diagnostics, Gate execution, thin invocation adapters | a second Context IR, graph, selector, pack, or capsule compiler |
| Xinfa | Atlas identity, Context IR, graph and impact semantics, selection, pack/capsule formats, compiler provenance | project truth, runtime facts, or release attestation |
| Kungfu | the single public executable, thin product adapters, and consumption of public Xinfa artifacts | Xinfa schemas, state, version, or compiler internals |
| Buildchain | exact artifact and release attestation | authoring or compiler semantics |

The dependency direction is Project sources → public submission contracts →
Xinfa compiler → public Xinfa artifacts → product adapters. Shifu may validate
and invoke that path, but it may not compile a parallel graph or pack.

## Schema-set authority

[`schema-set-manifest-v1.json`](schema-set-manifest-v1.json) is the public,
versioned inventory for every supported Xinfa JSON Schema. Each member binds
its repository-relative path, public `$id`, and exact file-byte SHA-256. The
manifest also publishes a complete schema-set root and named root subsets used
by immutable product objects. External verifiers can pin the digest of this one
manifest instead of inferring authority from the repository layout.

Schema-set roots hash parsed JSON with object keys ordered by UTF-8 bytes,
arrays retained in declared order, no insignificant whitespace, and one final
LF. Member digests continue to bind the original file bytes. The named
`xinfa.atlas-schema-set/v1` root is the authority used by Atlas objects and is
welded to the retained repository-small Atlas golden. Producer code reads that
published root; it does not reconstruct an order from `serde_json` internals.

After an intentional schema change, refresh and review the manifest with:

```sh
./shifu xinfa:schema-set:write
./shifu xinfa:schema-set:check
```

The normal Xinfa check and standalone extraction both fail if a schema is
unlisted, a member digest or `$id` drifts, a named subset changes, or the Atlas
root no longer matches its retained golden. Changing that root is therefore an
explicit compatibility decision, never a side effect of a compiler toolchain.

## Route-root authority

[`contract/route-root-authority-v1.json`](contract/route-root-authority-v1.json)
is the normative clean-room contract for the two roots carried by every
compiled route. The compiler first validates the raw project, then normalizes
routes by id and sorts each route's `nodes`, `entrypoints`, and optional
`resolution` arrays by ascending UTF-8 bytes. Duplicate route or node ids,
unknown selected nodes, visibility broadening, and Human/Agent parity conflicts
fail before any root is emitted.

`routeRoot` hashes only the normalized source route declaration: `id`,
`audience`, `parityGroup`, `visibility`, `nodes`, `entrypoints`, and optional
`resolution`. Generated `authorityRoot`, `routeRoot`, and `status` fields are
not inputs. `authorityRoot` hashes an array in normalized `route.nodes` order;
each entry contains the selected node's `id`, declared `revision`, and derived
`verification.status`. Claim, document, implementation, and evidence nodes use
the same rule. Provider and source coordinates affect a selected route through
the node revision, while the enclosing Context IR authority root separately
binds every complete node, edge, and cut.

Both hashes use compact JSON whose object keys are recursively sorted by UTF-8
bytes, followed by one LF, then SHA-256 with the `sha256:` prefix. Nodes absent
from `route.nodes` are excluded from that route's authority root; they remain
in the enclosing Context IR and Pack authority. Context Pack identity binds the
compiled routes and both route roots, and Atlas identity in turn binds the
verified Pack bytes and published Atlas schema root.

The product-owned
[`route-root-authority-v1.json`](fixtures/golden/route-root-authority-v1.json)
fixture shows the exact canonical route, selected-node array, and expected
roots. Its adversarial cases prove ordering independence, explicit exclusion,
missing-node rejection, duplicate rejection, and fail-closed conflicting
authority. This fixture and the reference implementation run in
`./shifu xinfa:check` and the standalone extraction.

## Context-quality qualification

[`context-quality-corpus-v1.json`](fixtures/golden/context-quality-corpus-v1.json)
is the versioned gold corpus for bounded Agent context. It currently covers 31
tasks, eleven non-isomorphic route families, and six scenario families. Every case
declares structured route intent, critical and optional source oracles, a token
budget, and a maximum expansion bound. The corpus checker freezes the breadth
and quality ratchets; it rejects all-surface fallback routes and any silent
threshold weakening.

The deterministic qualifier resolves the task envelope and compiles a bounded
context through the public Xinfa CLI. It measures critical-source recall,
required omissions, irrelevant-context token ratio, ambiguity, degradation,
stale-root detection, human correction, fallback, token cost, and expansion
hops. It also injects a stale Atlas root, unknown required authority, and a
one-token budget for every case. No LLM or embedding judge decides correctness.

To reproduce the retained
[`context-quality-v1.json`](qualification/context-quality-v1.json) receipt
from the current checkout:

```sh
./shifu xinfa:quality --write
```

The repository CI runs the same end-to-end proof from a clean checkout with
`./shifu xinfa:quality --check`; it first compiles the
current tracked Documentation Atlas and then requires the newly generated
receipt bytes to equal the retained receipt.

## Development and component proof

Use the repository entrypoint while Xinfa is incubated here:

```sh
./shifu xinfa --version
./shifu xinfa contract --json
./shifu xinfa:build
./shifu xinfa:check
./shifu xinfa:fix
./shifu xinfa:standalone
./shifu xinfa:dogfood
```

`./shifu xinfa <args>` is the source-development authority. Shifu verifies the
checked-in engine hash and current `xinfa/src` tree hash, then executes it
through the zero-npm-dependency Node host without compiling Rust. A stale or
missing engine is rejected with a warning before Shifu falls back to the
existing explicit trunk, locked Cargo-run linked trunk, and assembled trunk
chain. The Node host only loads exact input bytes, moves request/response bytes
through the JSON-edge ABI, and atomically publishes returned files; all Xinfa
semantics remain Rust.

Rebuild and qualify the engine with:

```sh
./shifu xinfa:wasm:build
./shifu xinfa:wasm:check
```

The qualification rebuilds with pinned Rust 1.95.0, requires exact wasm byte
identity, and compares native and wasm Pack/Atlas outputs and receipts over the
retained repository fixtures. `xinfa:build` retains the thin native development
binary as an extraction and differential oracle; production callers must not
use its physical `target/debug/xinfa` output.

The component qualification copies only the files listed in
`extraction-manifest.json` into a clean temporary directory, removes host
product environment variables, builds and tests the copied crate, links the
original source through a temporary `kungfu-trunk`, and verifies byte-for-byte
CLI parity with the extracted development binary. The retained receipt keeps
its existing schema identity at
[`qualification/standalone-smoke-v1.json`](qualification/standalone-smoke-v1.json).
`xinfa:dogfood` exercises the tracked [dogfood project submission](../.xinfa/dogfood-project.json).
The repository-wide [semantic project declaration](../.xinfa/project.json) is
materialized from Shifu's exact filesystem inventory by the public
`xinfa project materialize --inventory FILE|- --json` command. Project files
declare discovery, classifications, bindings, and routes; Xinfa alone derives
nodes, edges, provider revision, route node sets, and the materialized project
root.
through three independent entry paths: the extracted development binary, the
linked trunk component reached by the Shifu Documentation Protocol adapter,
and Kungfu's read-only Human/Agent/GUI consumer. Shifu validates its named
submission before delegating compilation and verification to Xinfa; it does
not implement a second compiler. Kungfu similarly invokes only public
`verify`, `read`, and `context` commands, then materializes derived files into
a new output directory without overwriting human-owned prose.

The dogfood fault campaign changes implementation evidence and expressive
`non-claim` prose separately, rejects `.xinfa/generated/**` feedback, and
models explicit acceptance as a new managed source cut plus successor Atlas.
Its retained result is
[`qualification/shifu-kungfu-dogfood-v1.json`](qualification/shifu-kungfu-dogfood-v1.json).
The extraction itself deliberately builds and invokes its copied physical
development binary. This proves crate separability and differential parity; it
is not a packaged product boundary or repository source entry:

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
./target/debug/xinfa route resolve --atlas atlas --task task-envelope.json --json
./target/debug/xinfa atlas compile --pack atlas/compatibility/context-pack-v1 --output imported-atlas --json
./target/debug/xinfa episode compile --before atlas --project fixtures/repository-small/project.json --submission evidence/episode-submission.json --output successor-atlas --json
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

`xinfa episode compile` is the additive Episode evidence boundary. It accepts
only a repository-relative `xinfa.episode-provider-submission/v1`, a verified
predecessor Atlas, and public `git-workspace-jsonl/v1` segment files accompanied
by matching `cpp-typed-fold-fsck` qualification bytes. Xinfa verifies the
public provider, qualification, JSONL, and root contracts but never recomputes
the journal-native Episode root. Explicit Mission/Go declarations,
proof/receipt references, and review findings become sourced typed units in a
new declared cut before the ordinary Repository Pack → Atlas compiler runs.

The command performs a deterministic full rebuild on every invocation, so
cache deletion and an incremental request have the same root-producing path.
Its `xinfa.episode-compile-receipt/v1` embeds a `xinfa.review-chart/v1` binding
the predecessor/result Atlas roots, admitted Episode roots, impact, omissions,
and stale or conflicted evidence. Reordered Episode declarations do not change
the result. Open, unknown, unqualified, private, missing, generated, runtime,
and raw-transcript inputs fail before source closure; unlisted JSONL records do
not become facts merely because they were present in an Episode.

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

The route-resolution receipt is the required predecessor of an automatically
created Task Chart. Explicit `--route` remains a compatibility input, but an
adapter must express it as `requested_route` in the task envelope and retain the
resolver receipt. A compatibility adapter may not choose a route by array order
or hide an ambiguity failure.

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
