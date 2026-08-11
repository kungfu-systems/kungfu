# Kungfu Skills

Kungfu Skills are the agent-facing capability layer above kfx. A skill teaches
Kungfu and the agent context how to manage, verify, explain, and govern a class
of delegated agent work. It may guide agent actions, but action is not its root
authority: kfx packages remain the governed runtime artifacts that execute UI,
runtime facets, and future tool surfaces.

This page describes the shipped v1 context surface and the staged v2 contract.
The original architecture decision is
[KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf](../adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md),
amended by
[KF-ADR-019fee22-e71d-7da9-8a44-9403c21a5d62](../adr/KF-ADR-019fee22-e71d-7da9-8a44-9403c21a5d62.md).

## Staged v2 definition contract

The v1 implementation remains readable as a compatibility projection. A v1
`sourceHash` covers `SKILL.md`; it is not a v2 package identity.
The v2 definition instead binds a stable key, immutable revision, and root over
the complete sorted content closure. It declares provenance, distribution and
Work scope, exact KFX/Profile dependencies, effects, proof, recovery,
compatibility, and explicit non-authority claims.

V2 has exactly three classes:

- `instruction-only`: instructions only; no dependency, capability, or effect;
- `operational`: Work-bound orchestration through separately admitted KFX;
- `domain`: Work-bound domain semantics from an admitted Profile contribution,
  with separately admitted KFX required for executable behavior.

Work remains the only selection, acceptance, and completion authority. KFX
remains capability and execution authority. Profile remains domain-meaning
authority. Loading, invoking, or retiring a Skill cannot rewrite historical
Work meaning. The v2 schema and rejection fixtures are checked by
`./shifu check:skill-contract-v2`.

## V2 registry and lifecycle authority

Python owns the only Skill lifecycle writer under
`<home>/skill-registry/v2`. A package install publishes the complete verified
closure to `payloads/sha256/<content-root>` and its exact definition to
`definitions/sha256/<definition-root>.json`, then atomically advances one
rooted `state.json` fold. Immutable payloads, definitions, receipts, state
snapshots, old revisions, and Work selection rows are retained.

Every mutation is a two-step machine protocol. Planning is read-only and binds
the current state root and generation, the affected Skill identity, the next
state root, rollback guidance, and recovery policy. Apply requires the exact
`planRoot`. A fenced writer replays the plan against the current fold, rejects
stale or concurrent callers, publishes verified immutable bytes before the
atomic state cut, and emits an idempotent receipt keyed by the plan root.

The lifecycle states `installed`, `enabled`, `selected`, `loaded`, `invoked`,
`suspended`, `retired`, and `historical` are distinct. Removing a Skill only
removes active references; it does not delete package bytes, old revisions,
receipts, Work bindings, facts, or KFX dependencies. New Work selections store
both the exact Work reference and its canonical root; a reference without its
root is insufficient for dependency admission. GUI focus or the currently
visible page is never lifecycle authority.

Python, Node, CLI, and Agent surfaces read the same rooted registry report.
Node and outer managers are thin readers and cannot publish registry state.
The v1 catalog/context projection reads active immutable payloads from this
registry while continuing to read legacy `<home>/skills` sources for
compatibility.

## The model

Keep four objects separate:

- **Skill source** — the user-authored directory. The minimum valid skill is a
  directory containing only `SKILL.md`.
- **Skill catalog** — a compact, machine-readable index generated from the
  source. This is what Kungfu injects into an agent invocation by default.
- **Skill context envelope** — the full prompt/tool payload that a manager passes
  to an agent run. It carries the filtered catalog, the on-demand `skill.read`
  tool declaration, and audit identifiers.
- **kfx package** — the runtime trust artifact. A skill may depend on, bundle, or
  reference several kfx packages, but those packages still install once into the
  kfx registry and keep their own trust tier.

In short:

```text
SKILL.md -> catalog -> context envelope -> agent
                         |
                         v
                    kfx trust gate
```

The agent sees skills. The runtime executes kfx.

This distinction is load-bearing:

```text
Generic agent skills teach agents how to act.
Kungfu Skills teach Kungfu how to make delegated agent work accountable.
```

A Kungfu Skill should therefore keep cost, state, proof, audit, and recovery in
view even when it contains operational instructions for an agent.

## Minimal valid skill

The lowest-friction user experience is intentionally small:

```text
trace-failure-investigator/
  SKILL.md
```

That directory is a valid Kungfu Skill. If no structured manifest is present,
Kungfu derives:

| Field | Derived from |
|---|---|
| `key` | directory name, normalized as a stable skill key |
| `title` | first level-one heading in `SKILL.md`, or the key |
| `description` | first non-heading paragraph |
| `triggers` | absent; the catalog marks the skill as weak-trigger/manual |
| `kfx` | empty list |
| `capabilities` | empty list |
| `kind` | `instruction-only` |

An instruction-only skill is fully valid: it may appear in the agent catalog and
may be loaded on demand as full instructions. It receives no runtime privilege,
does not install or execute kfx packages, and cannot access Kungfu capabilities
unless a later manifest explicitly declares and the runtime grants them.

## Progressive enhancement

A skill can grow without losing the simple `SKILL.md` entrypoint.

Small skills may use front matter:

```markdown
---
key: trace-failure-investigator
triggers:
  - trace failed
  - replay failed
kfx:
  - key: rewind-inspector
    role: trace-view
  - key: journal-manager
    role: evidence-view
capabilities:
  - rewind
  - ledger
---

# Trace Failure Investigator

Help an agent inspect a failed trace run, identify likely failure layers, and
produce a short audit note.
```

V2 packages add one explicit definition beside the declared content closure:

```text
trace-failure-investigator/
  SKILL.md
  skill-definition.json
```

The definition declares every payload member by relative path, byte count,
media type, and SHA-256 root. Undeclared files, missing members, symlinks, path
escape, path collisions, mutable identity, and incomplete closure roots fail
before staging. KFX package bodies are forbidden inside the Skill closure;
only exact KFX coordinates may appear in the definition.

## Skill packages and kfx dependencies

A skill can reference multiple kfx packages, but kfx remains deduplicated and
governed independently:

- A v2 definition retains exact KFX key, revision, and content root coordinates.
  Package bodies remain exclusively under the Core-native KFX registry.
- Removing a Skill marks its active references historical. It cannot remove
  shared KFX dependencies or reinterpret an older Work selection.
- A kfx package does not gain more authority because a skill referenced it.
- A third-party view kfx still runs under the sandboxed view tier.
- A third-party adapter/runtime facet is not made executable by being wrapped in
  a skill; it must satisfy the runtime trust policy for that facet.

This makes skill composition useful without creating a permission laundering
path.

## Dependency authority and invocation

`kungfu skill admit` is the single Skill-level composition edge over the
existing native authorities. Its default read-only plan binds the exact Skill
revision and definition root, Work reference and root, KFX plan and graph,
Profile suite/action plans, Core policy, Fact cut, host placement, requested
capabilities, TrustReport roots, and one capability-decision root. Instruction-
only Skills return `KF_SKILL_INSTRUCTION_ONLY_INERT` without calling a runtime
authority. Missing, stale, incompatible, untrusted, revoked, conflicting, and
unauthorized dependencies return stable `KF_SKILL_*` refusal codes plus a
specific recovery action; required refusals never partially activate a Skill.

Execution requires the exact printed `planRoot`. KFX dependencies are
re-authorized by the Core-native `authorize-host` operation at the dispatch
boundary; the selected host remains responsible for its host-specific action.
Profile contributions are planned and invoked by the admitted Profile action
runtime. Skill code owns neither execution path and cannot turn source text,
provenance, KFD attestation, or Agent confidence into a capability grant or
Product System identity. It also never copies or removes shared KFX payloads.

The rooted plan and invocation receipt carry identical capability decision,
TrustReport, Work, and audit identities to thin Agent, CLI, GUI, and TUI
projections. The Node reader verifies those identities without recomputing
trust. Audit records retain metadata and roots, not dependency payloads, and
explicitly state that selection, loading, or invocation is not Work completion.

## Skill catalog

The catalog is the compact agent-visible index. It is generated by the manager
from installed skill sources and dependency metadata.

Example:

```json
{
  "schema": "kungfu.skill-catalog/v1",
  "skills": [
    {
      "key": "trace-failure-investigator",
      "title": "Trace Failure Investigator",
      "description": "Help an agent inspect a failed trace run.",
      "kind": "instruction-only",
      "triggers": ["trace failed", "replay failed"],
      "capabilities": [],
      "kfx": [],
      "loadPolicy": "on-demand",
      "sourceHash": "sha256:..."
    }
  ]
}
```

The catalog is deliberately smaller than `SKILL.md`. It lets a model decide
which skill might apply without spending context on every full instruction file.

## Context envelope

Every agent invocation receives a context envelope built from the same schema,
whether the invocation starts in the Electron GUI or the `kungfu` CLI.

Example shape:

```json
{
  "schema": "kungfu.skill-context/v1",
  "session": {
    "source": "gui",
    "manager": "node",
    "profile": "default",
    "agent": "codex"
  },
  "kungfu": {
    "schema": "kungfu.environment/v1",
    "environment": "managed-run",
    "agentEntrypoint": "kungfu agent context --json"
  },
  "catalog": [
    {
      "key": "trace-failure-investigator",
      "title": "Trace Failure Investigator",
      "description": "Help an agent inspect a failed trace run.",
      "loadPolicy": "on-demand"
    }
  ],
  "tools": [
    {
      "name": "kungfu.skill.read",
      "description": "Load the full SKILL.md for a selected skill key."
    }
  ],
  "audit": {
    "runId": "...",
    "advertisedSkillsHash": "sha256:..."
  }
}
```

The default injection is the compact catalog plus the `kungfu.skill.read` tool.
Full `SKILL.md` content is loaded only when the agent selects a skill. Loading a
skill is an auditable event.

The `kungfu` field is the managed environment contract, but it must stay small.
It tells the agent only that it is running under Kungfu and gives the canonical
local entrypoint for discovery. It does not carry resolved config, command
lists, document lists, Skill roots, or kfx roots.

Agents that need more information call:

```sh
kungfu agent context --json
```

That command is the single local fact source for config, runtime paths, Skill
and kfx discovery, docs, and future Agent Onboarding Pack data. This keeps every
managed-run prompt compact while still letting an agent self-serve when it needs
to implement or debug a Kungfu Skill.

## Two manage modes

Kungfu must support two natural agent launch paths:

- **Node manage mode** — an agent session launched from the Electron GUI. The
  Node manager reads GUI profile state, current shell context, selected trace or
  work item, and installed skill metadata, then builds the same context envelope.
- **Python manage mode** — an agent session launched from the `kungfu` CLI. The
  Python manager reads CLI flags, working directory context, selected profile,
  and installed skill metadata, then builds the same context envelope.

Both modes share schemas and golden fixtures. They must not grow separate
product semantics. If a minimal `SKILL.md` produces one catalog entry in Python,
the Node manager must produce the equivalent entry.

## Repository placement

The implementation should use separate homes for shared contracts and runtime
glue:

```text
framework/skill/
  kungfu-skill.contract.json
  schema/
    skill.schema.json
    skill-catalog.schema.json
    skill-context.schema.json
    skill-dependencies.schema.json
    skill-manager.schema.json
  fixtures/
    minimal/SKILL.md
    with-frontmatter/SKILL.md
  src/
    parse-skill.ts
    build-catalog.ts
    build-context-envelope.ts

framework/core/src/python/kungfu/skill/
  parser.py
  catalog.py
  context.py
  authoring.py
  registry.py

framework/core/src/python/kungfu/cli/commands/skill.py

framework/gui/src/main/skill-context.ts

extensions/system/skill-manager/

developer/sdk/templates/skill/
```

`framework/skill` is the language-neutral contract home: the
`kungfu-skill.contract.json` wrapper, schema bundle, fixtures, and the
TypeScript reference implementation. Python and Node managers use that contract
from their natural runtime locations. Build/freeze copies it through the shared
KFD-1 contract registry, not through a skill-specific packaging path.

## CLI surface

The first CLI should be explicit and inspectable:

```sh
kungfu skill validate <path>
kungfu skill contract --json
kungfu skill schema [--name source|catalog|context|dependencies|manager|definitionV2|authoringSpecV1|authoringPlanV1|authoringReceiptV1] --json
kungfu skill author contract --json
kungfu skill author catalog [--path <dir>] --json
kungfu skill author inspect --spec <spec.json> [--path <dir>] --json
kungfu skill author scaffold --signals <signals.json> --spec <spec.json> \
  --workspace <path> --target <relative-path> \
  [--execute --expected-plan-root <root>] --json
kungfu skill author qualify <draft-path> --json
kungfu skill install <v2-package> [--execute --expected-plan-root <root>]
kungfu skill update <v2-package> [--execute --expected-plan-root <root>]
kungfu skill enable|load|invoke|suspend|retire|remove <key>
kungfu skill select <key> --work-ref <exact-work-ref> --work-root <exact-work-root>
kungfu skill admit <key> --work-ref <ref> --work-root <root> --cut-root <root> \
  --policy-root <root> --host <host> [--execute --expected-plan-root <root>]
kungfu skill rollback <key> --target-revision <n>
kungfu skill inspect [key] --json
kungfu skill diff <key> --left <n> --right <n> --json
kungfu skill history [key] --json
kungfu skill diagnose --json
kungfu skill list [--path <dir>] [--json]
kungfu skill catalog [--path <dir>] [--json]
kungfu skill context [--path <dir>] [--source cli|gui|test] [--manager python|node]
kungfu skill verify --provider <claude|codex> --path <dir> [--manager python|node]
kungfu skill read <key-or-path> [--path <dir>]
kungfu skill deps <key-or-path> [--path <dir>] [--json]
kungfu skill audit --run-id <id>
kungfu skill explain <key-or-path>
```

Mutation commands print a plan by default and write nothing. `--execute`
requires the exact printed `--expected-plan-root`; a stale basis fails visibly.
`catalog` is the compact agent-visible catalog before full skill
loading. `context` wraps that catalog in the same envelope shape used by Python
and Node manage modes. `deps` prints the binding/resolution state. The Node
manager also builds a `kungfu.skill-manager/v1` document for GUI use, joining
installed skills with the same kfx dependency binding semantics as the Python
CLI and summarizing resolved, unresolved, and unresolved-required dependencies
before an agent process starts. `verify` runs a real provider through
`managed-run`, asks it to echo the advertised
schema, first skill key, and `advertisedSkillsHash`, then checks the Rewind
`response.json` evidence. Use `--manager node` to build the envelope through
the Node manager path used by the Electron GUI. `read` is the operation the
agent tool uses to load the full `SKILL.md` after selection. `audit` reads the
Skill audit sidecar from a managed-run bundle or a standalone audit file.
`contract` and `schema` expose the same KFD-1 Skill contract and schema bundle
that Python and Node managers validate against.

`author` is the Agent-first creation boundary. `catalog` emits the exact root
used for mandatory deduplication; `inspect` classifies exact and plausible
candidates from that root. `scaffold` independently recomputes the bounded
`kungfu agent skill-advisory` result and writes only when it is `auto-draft`,
the catalog root is current, the target is a new relative path under the exact
workspace, and the approved plan root still matches. The generated package is
deterministic `workspace-local` `instruction-only` content with no KFX/Profile
dependencies or effects. Its receipt binds the decision, catalog, target, file,
definition, content, and qualification roots plus rollback guidance. Install,
enablement, activation, KFX/Profile admission, capability, credential, network,
external write, shared mutation, publication, and Work completion remain
separate blocked actions.

`admit` produces the dependency authority plan by default. Profile bindings use
`--profile-source PROFILE_ID=PATH` plus optional
`--profile-input PROFILE_ID:ACTION=JSON_FILE`; KFX discovery can receive an
exact native request through `--kfx-request`. `--execute` rechecks the KFX host
authorization and invokes admitted Profile contributions, then emits a rooted,
metadata-only audit receipt. It does not execute arbitrary host code on behalf
of KFX and does not claim Work completion.

The SDK may add:

```sh
kungfu sdk create skill <name>
```

which creates only:

```text
<name>/
  SKILL.md
```

## GUI surface

The GUI exposes a first-party system view, `skill-manager`, rather than folding
every skill concern into the existing kfx manager. Electron main writes the Node
manager document to `KF_SKILL_MANAGER_FILE`, and the renderer exposes it through
`shell.info.skillManager`. The first view slice shows:

- installed skills and their generated catalog entries;
- declared kfx dependencies and whether each dependency is installed;
- resolved/unresolved dependency counts, including unresolved required kfx;
- shared kfx registry paths and package coordinates for resolved dependencies;
- which capabilities a skill requests;

Later slices should add:

- full `SKILL.md` for inspection;
- trust/provenance state and source hashes beyond the catalog hash;
- audit events: advertised, loaded, dependency invoked, and install/update.

The kfx manager remains the extension/package manager. The skill manager is the
agent capability manager.

## Audit and provenance

Kungfu must record at least these events:

- skill installed, updated, removed;
- catalog generated and advertised to an agent run;
- full `SKILL.md` loaded through `kungfu.skill.read`;
- kfx dependency invoked as part of a skill flow;
- validation failure or trust refusal.

Provenance should include source path or source URL, version, source hash, any
packaged kfx artifact hashes, and the generated catalog hash. When Buildchain
provenance is available, the skill record should carry the build passport or
release reference rather than inventing a parallel trust story.

Audit is part of the work fact model, not a loose application log. Skill
advertisement, full instruction loading, dependency invocation, and trust
refusal should be recordable by the journal-backed responsibility layer so a
later user or agent can explain why a skill influenced a work decision.

The first audit slice records:

- `SkillAdvertised` in the managed-run bundle when Python or Node manager
  envelopes advertise skills to a provider. The bundle manifest points to
  `skill-audit.json` and records its hash and event types.
- `SkillLoaded` when `kungfu skill read` loads full `SKILL.md` content. This
  records the selected skill key, source hash, content hash, source path, source,
  manager, and optional run id.
- rooted lifecycle receipts for install, update, enable, Work selection, load,
  invocation, suspend, retire, remove-reference, and rollback operations;
- `kungfu skill audit --run-id <id>` to inspect bundle evidence, plus
  `--audit-file` for standalone JSON/JSONL audit files.

## First implementation slice

The first slice proves the context loop before broad execution:

1. Accept `SKILL.md`-only directories as valid instruction-only skills.
2. Add schema and fixtures under `framework/skill`.
3. Implement TypeScript and Python catalog/context builders over the same
   fixtures.
4. Implement `kungfu skill validate/install/list/catalog/context/read/explain`.
5. Generate compact catalogs and context envelopes from the Python CLI manager.
6. Generate the same context envelopes from the Node/Electron manager path.
7. Verify Python and Node manager envelopes through `managed-run` response
   evidence.
8. Scaffold a minimal skill with only `SKILL.md` through the developer SDK.
9. Bind declared KFX dependencies as exact coordinates while resolving package
   bodies only from the shared Core-native KFX registry.
10. Fold v2 install, update, lifecycle, Work selection, history, and recovery
    through the single fenced Python writer.

Follow-up slices should:

1. Expand the first-party `skill-manager` view with full-source inspection,
   trust/provenance details, and audit history.
2. Add explicit kfx artifact acquisition for unresolved dependencies, still
   installing artifacts into the shared kfx registry rather than under a skill.

Out of scope for the first slice:

- marketplace discovery;
- automatic permission elevation;
- third-party adapter execution through skill composition;
- generated runtime code beyond existing kfx dependency references;
- uninstalling shared kfx dependencies as a side effect of removing a skill.

## Verified by

The first implementation slice is verified by:

- a `SKILL.md`-only fixture accepted by Python and TypeScript validators;
- TypeScript and Python catalog/context output over shared fixtures;
- `kungfu skill contract --json` and `kungfu skill schema --json` over the
  packaged Skill contract;
- assembled product CLI `validate/catalog/context/verify/read/explain` over shared
  fixtures;
- assembled product CLI `skill verify --manager python` and `skill verify --manager node`
  with provider response evidence;
- `SkillAdvertised` audit sidecars discoverable through
  `kungfu skill audit --run-id`;
- `SkillLoaded` audit events from `kungfu skill read`;
- a skill with two kfx declarations proving the skill object can reference
  multiple kfx packages without granting runtime privilege.

Follow-up verification should add:

- kfx dependency binding through the shared registry, with deduplication;
- a third-party adapter dependency proving that skill composition does not bypass
  the existing runtime trust refusal.
