# Assignment Runtime API contract

This package freezes the pre-release `kungfu.assignment-runtime/v1` protocol.
It is an R0 contract and evidence surface, not a Local Runtime implementation.

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
