---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0015
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0015: Kungfu Skill as the agent context layer above kfx

- Status: accepted
- Date: 2026-07-05
- Implementation: first slice landed. `framework/skill`, the Python CLI manager,
  shared fixtures/schemas, and SDK `SKILL.md` scaffolding are implemented;
  GUI-manager wiring, audit persistence, and kfx dependency install binding
  remain follow-up work.
- Category: (architecture) agent capability model — skill discovery, context
  injection, and kfx composition
- Subsystem: `framework/skill` (new shared skill contract), `framework/core`
  Python CLI manager, `framework/gui` Node/Electron manager, `developer/sdk`
  skill scaffolding, and kfx dependency/trust integration.
- Related: ADR-0011 defines the v4 capability SDK contract and runtime-tier
  declaration. ADR-0013 defines extension isolation and the trusted channel on
  the runtime plane. ADR-0014 defines the uniform capability surface across
  extension trust tiers. `docs/extensions.md` defines kfx packages, facets and
  suites; this ADR defines the layer above them.

## Context

kfx already gives Kungfu a governed runtime artifact: a package with a static
manifest, install key, facet declarations, discovery roots, trust tiers, and
loader behavior. A view kfx can be sandboxed or source-verified. Runtime facets
such as adapters are more sensitive because they run inside the traced process
and therefore must not become executable merely because a user installed a
package.

Agent skills need a different product shape. A user should be able to write a
minimal directory:

```text
my-skill/
  SKILL.md
```

and have Kungfu treat it as a valid skill: something the agent can discover,
select, load on demand, and follow. That object is not necessarily executable
and may not have any kfx dependency. At the other end, a richer skill may
compose several kfx packages: a trace view, a journal view, and a runtime facet.

This creates two pressures:

1. If skill is modeled as a field inside a kfx manifest, then the runtime package
   becomes the parent object. That reverses the user model: users author skills;
   skills may contain or depend on multiple kfx packages.
2. If GUI and CLI agent launch paths each implement their own skill injection,
   the agent-visible catalog will drift. The Electron GUI naturally dispatches
   from Node, while `kungfu` CLI naturally dispatches from Python. Both must
   produce the same skill context semantics.

The design must preserve the kfx trust boundary while making skills first-class
agent context objects.

This ADR deliberately distinguishes Kungfu Skills from generic agent skills:
generic agent skills teach agents how to act; Kungfu Skills make delegated agent
work accountable through catalog injection, audited loading, kfx trust
boundaries, and journal-backed proof.

## Decision

Model Kungfu Skill as the agent-facing capability layer above kfx.

A skill is a source directory plus derived metadata. The minimum valid source is
a directory containing `SKILL.md`. A skill may declare kfx dependencies, but kfx
packages remain separately installed, deduplicated, verified, and governed. A
skill can compose kfx; kfx does not contain the skill.

The architecture has three layers:

1. **Skill source.** User-authored `SKILL.md`, optional front matter, optional
   `skill.json`, and optional packaged kfx dependency artifacts.
2. **Skill catalog and context envelope.** Generated, schema-validated data that
   the managers inject into agent invocations. The default injection is compact:
   key, title, description, triggers, kind, requested capabilities, kfx
   dependencies, source hash, and a declaration that full instructions are
   available through `kungfu.skill.read`.
3. **kfx runtime artifacts.** The actual executable UI/runtime/tool packages
   referenced by a skill. They keep their own `kungfuConfig.key`, install
   lifecycle, trust tier, sandbox/refusal policy, and provenance.

Kungfu must support two manage modes over the same schemas:

- **Node manage mode** for agent sessions launched from the Electron GUI.
- **Python manage mode** for agent sessions launched from `kungfu` CLI.

Both managers discover installed skills, filter them for the session, generate
the same compact catalog, inject the same context envelope shape, expose the
same on-demand `kungfu.skill.read` operation, and write the same audit events.
Those audit events are part of the responsibility trail for the delegated work,
not merely debug logs for the skill subsystem.

The shared contract home is:

```text
framework/skill/
```

It contains schemas, shared fixtures, and the TypeScript reference
implementation. Runtime-specific glue lives where the runtime naturally belongs:
Python under `framework/core/src/python/kungfu/skill`, Node/Electron under
`framework/gui/src/main`, the user-facing management view under
`extensions/system/skill-manager`, and scaffolding under `developer/sdk`.

## Consequences

- A `SKILL.md`-only directory is a first-class valid skill. It is
  instruction-only by default and receives no runtime privilege.
- The agent sees a compact skill catalog first, not every full `SKILL.md`.
  Loading full instructions is explicit, on demand, and audited.
- The skill layer is accountability-first. It may guide actions, but its root
  purpose is to help Kungfu explain, verify, recover, and govern delegated work.
- A skill can depend on multiple kfx packages without copying them per skill.
  Dependencies install into the normal kfx registry and are shared by key.
- Removing a skill does not remove shared kfx dependencies unless a separate
  orphan-cleanup command proves they are unused.
- Skill composition cannot launder permissions. A third-party view remains
  sandboxed. A third-party adapter/runtime facet remains refused unless the
  runtime trust policy explicitly allows it.
- GUI and CLI agent sessions share one context schema. Differences between Node
  and Python are implementation details, not product semantics.

## Repository layout

The first implementation lands the shared contract, Python manager, and SDK
scaffolding in these areas:

```text
framework/skill/
  schema/
    skill.schema.json
    skill-catalog.schema.json
    skill-context.schema.json
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
  registry.py

framework/core/src/python/kungfu/cli/commands/skill.py

developer/sdk/templates/skill/
```

The planned Node/Electron manager and first-party GUI view remain in:

```text
framework/gui/src/main/skill-manager.ts
framework/gui/src/main/skill-context.ts

extensions/system/skill-manager/
```

The first implementation should not put the canonical skill contract inside
`framework/kfx`, because skill is not a kfx facet. It should not put the
canonical contract only under `framework/core` or only under `framework/gui`,
because both Python and Node managers must share the same semantics.

## First delivery

The first delivery is intentionally narrow:

1. Accept `SKILL.md`-only directories as valid instruction-only skills.
2. Define `skill`, `skill-catalog`, and `skill-context` schemas.
3. Add shared fixtures for minimal and front-matter skills.
4. Implement TypeScript and Python catalog/context builders over the same
   fixtures.
5. Add `kungfu skill validate`, `install`, `list`, `catalog`, `context`,
   `read`, and `explain`.
6. Let the Python manager generate compact catalogs and expose the
   `kungfu.skill.read` contract.

Follow-up deliveries should:

1. Wire Node/Electron manager injection to the same catalog/context contract.
2. Write audit events for catalog advertisement and full skill loading.
3. Bind declared kfx dependencies through the normal kfx registry without
   copying them per skill.
4. Add a first-party `skill-manager` view that shows installed skills, full
   source, generated catalog, dependency state, trust/provenance and audit.

Explicitly out of scope for the first delivery:

- marketplace discovery and remote publishing;
- automatic permission elevation;
- making third-party runtime facets executable through a skill wrapper;
- generated executable code beyond existing kfx dependency references;
- removing shared kfx dependencies as a side effect of removing a skill.

## Alternatives considered

- **Put `skill` under `kungfuConfig.config` as a kfx facet.** Rejected. It makes
  kfx the parent object and prevents a skill from naturally containing several
  kfx packages. It also encourages confusing agent instructions with runtime
  execution.
- **Make skills just kfx suites.** Rejected. Suites group kfx packages for
  distribution and operation. A skill is an agent-facing instruction and
  context object: triggers, selection, full instruction loading, audit and
  agent-visible catalog are load-bearing.
- **Implement only a GUI skill manager first.** Rejected. GUI sessions dispatch
  naturally from Node, but CLI sessions dispatch naturally from Python. A
  GUI-only design would make skill injection a shell feature rather than a
  Kungfu runtime capability.
- **Inject every `SKILL.md` fully into every agent run.** Rejected. It wastes
  context, makes selection opaque, and makes audit too coarse. The compact
  catalog plus on-demand read pattern is the contract.
- **Allow skill composition to grant dependency permissions.** Rejected. The
  kfx trust gate is the runtime boundary. Skill can request and explain; it
  cannot elevate.

## Residual risk

- Node and Python implementations can drift even with shared schemas. The
  mitigation is shared golden fixtures and equivalence tests over catalog and
  context output.
- Minimal `SKILL.md` inference can over-extract from prose. The first parser
  should be intentionally simple: heading, first paragraph, optional front
  matter, no opaque language-model summarization on the hot path.
- Users may expect uninstalling a skill to remove its packaged dependencies.
  The product must make shared dependency ownership explicit and provide a
  separate orphan cleanup flow.
- The first slice proves parsing, catalog/context generation, and frozen CLI
  operation, not arbitrary tool execution or GUI-launched injection.

## Verification target

The first slice is verified by:

- a `SKILL.md`-only fixture accepted by both Python and TypeScript validators;
- Python and TypeScript catalog/context output over shared fixtures;
- frozen `dist/kungfu/kungfu skill validate/catalog/context/read/explain`
  commands over the shared fixtures;
- a skill with two declared kfx dependencies proving skill metadata can compose
  multiple kfx references without granting runtime privilege.

Follow-up verification should add:

- a GUI-launched agent session receiving the same envelope schema;
- audit entries for advertised skills and on-demand full skill loading;
- deduplicated kfx install/binding through the kfx registry;
- a third-party runtime facet dependency proving that skill composition does not
  bypass the existing runtime trust refusal.
