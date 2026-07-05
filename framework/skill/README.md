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

`fixtures/golden/` pins the catalog and context envelopes used to keep the
Python and TypeScript implementations schema-equivalent.

See [`../../docs/skills.md`](../../docs/skills.md) and
[`../core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md`](../core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md).
