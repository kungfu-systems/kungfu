# Assignment Runtime API contract

This package freezes the pre-release `kungfu.assignment-runtime/v1` protocol.
The contract is implemented by the embedded Local Runtime and shared by GUI,
CLI, Agent, and KFX clients.

The contract keeps Assignment state authority inside one declared realm. GUI,
CLI, Agent, and KFX callers are clients: they may discover capabilities, read
snapshots, resume events, and submit fenced commands, but they never own or
mutate journal, JSON, SQLite, PostgreSQL, Electron, or filesystem layouts.

Run the build-free contract checks with:

```sh
node --test framework/assignment-runtime/assignment-runtime.test.mjs
```

The positive and negative cases use only in-memory JSON fixtures. They do not
initialize or mutate a real Home Workspace.

Work Control also exposes domain-neutral Work semantics through fenced command
types `work.input.snapshot`, `work.run.record`, `work.effect.authorize`,
`work.effect.attempt`, and `work.effect.outcome`. They reuse the Runtime's
revision, generation, idempotency, Attempt, lease, restart, and recovery
semantics; they do not add another state store. The public protocol and CLI are
documented in [`docs/profiles/work-control.md`](../../docs/profiles/work-control.md).
