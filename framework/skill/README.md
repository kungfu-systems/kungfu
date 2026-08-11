# Kungfu Skill Contract

This package contains the shared schemas, fixtures, and TypeScript helpers for
Kungfu Skills. A skill is the agent-facing orchestration object above KFX and
Profile authorities. Existing v1 sources may still begin as a directory
containing only `SKILL.md`; they are not silently reinterpreted as v2.

The staged v2 definition contract adds an immutable `key + revision +
contentRoot` coordinate, a root over the complete declared package closure,
explicit scope and Work binding, proof and recovery requirements, and exactly
three classes:

- `instruction-only` carries no executable dependency, capability, or effect;
- `operational` resolves effects through separately admitted exact KFX refs;
- `domain` resolves domain meaning through separately admitted exact Profile
  refs and uses separately admitted KFX for any executable behavior.

Skill definitions reference those authorities. They do not grant capability,
select or complete Work, own Profile meaning, or replace Fact, Episode, KFD,
or KFX contracts. Run the deterministic v2 contract gate with:

```sh
./shifu check:skill-contract-v2
```

The runtime injects only a compact catalog into agent prompts. Full `SKILL.md`
content stays on demand through `kungfu.skill.read`, and declared kfx
dependencies remain metadata until the kfx trust gate grants runtime access.

Two managers share the same contract:

- CLI runs build the context in Python through `kungfu.skill.provider` and
  `kungfu managed-run`.
- GUI runs build the context in Electron main through `@kungfu-tech/skill`,
  write it to `KF_SKILL_CONTEXT_FILE`, and let the managed-run process inject
  that Node-generated envelope.

For dev and verification flows, the same Node manager path is available as:

```sh
node --experimental-transform-types framework/skill/scripts/context.mjs \
  --home <kungfu-home> \
  --source gui \
  --manager node \
  --path <skill-or-root> \
  --out <context.json>
```

Skill Manager and GUI views use the same Node-side dependency binding semantics:

```sh
node --experimental-transform-types framework/skill/scripts/manager.mjs \
  --home <kungfu-home> \
  --path <skill-or-root> \
  --out <skill-manager.json>
```

The manager view reports installed skills, catalog entries, declared kfx
dependencies, shared registry paths, and resolved/unresolved counts before an
agent is launched.

`fixtures/golden/` pins the catalog and context envelopes used to keep the
Python and TypeScript implementations schema-equivalent.

See [`../../docs/architecture/skills.md`](../../docs/architecture/skills.md),
the [original Skill context-layer decision](../../docs/adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md),
and its [v2 contract amendment](../../docs/adr/KF-ADR-019fee22-e71d-7da9-8a44-9403c21a5d62.md).
