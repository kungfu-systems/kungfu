# Kungfu Skill Contract

This package contains the shared schemas, fixtures, and TypeScript helpers for
Kungfu Skills. A skill is the agent-facing capability object above kfx. The
minimum valid source is a directory containing only `SKILL.md`.

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

See [`../../docs/skills.md`](../../docs/skills.md) and
[`../core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md`](../core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md).
