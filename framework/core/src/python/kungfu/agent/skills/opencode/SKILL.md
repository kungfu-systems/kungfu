---
name: kungfu-agent-onboarding
key: kungfu-agent-onboarding
title: Kungfu Agent Onboarding
description: Discover the exact Kungfu Project, WorkConsole, WorkRef, Skill catalog, and Core Work state admitted to this OpenCode process.
triggers:
  - kungfu
  - work console
  - workref
  - skill catalog
---

# Kungfu Agent Onboarding

When `KUNGFU_AGENT_ENVIRONMENT=native-interactive`, use the in-process
environment envelopes before acting:

- `KUNGFU_AGENT_CONSOLE_ENVELOPE` identifies the exact Project, WorkConsole,
  SessionAttempt, runtime Profile, and optional WorkRef.
- `KUNGFU_SKILL_CONTEXT` advertises the compact Skill catalog. Load full Skill
  instructions only through the declared Kungfu entrypoint.
- `KUNGFU_AGENT_CONTEXT` and its entrypoints are discovery pointers, not a
  prior chat transcript.
- `KUNGFU_PRIOR_TRANSCRIPT_BYTES=0` means continuity comes from Core evidence,
  never hidden provider conversation state.

Confirm current facts with read-only commands when needed:

```sh
"$KUNGFU_CLI_BIN" agent console current --json
"$KUNGFU_CLI_BIN" agent bootstrap-status --json
"$KUNGFU_CLI_BIN" agent capabilities --json
"$KUNGFU_CLI_BIN" skill catalog --json
"$KUNGFU_CLI_BIN" work status --workspace <path> --initiative-id <id> --assignment-id <id>
"$KUNGFU_CLI_BIN" agent session list --json
```

A bare `kungfu run opencode` launch is intentionally Work-unbound so many
terminal windows can start in the same Project. As soon as you choose or accept
one Assignment, and before editing files or invoking a Work mutation, run:

```sh
"$KUNGFU_CLI_BIN" agent console bind-work --initiative-id <id> --assignment-id <id> --json
```

Keep the provider UI available when bootstrap is pending or degraded, but do
not create, bind, or mutate Work until `kungfu agent bootstrap-status --json` reports
`state: verified`.

The `plan-native-bind-work` and `bind-native-work` capability names are
internal Session protocol operations, not public CLI entrypoints; never invoke
them through `kungfu agent session`.

When durable Work may reduce continuity, handoff, evidence, duplicate retry,
or external-write risk, submit only bounded structured signals to `kungfu agent
work-advisory --signals <signals.json> --json`. Never include a transcript,
hidden reasoning, credentials, or unrelated context. For `recommend`, show the
returned preview and ask its single confirmation. Only after confirmation use
the returned existing `kungfu.work.capture`, `kungfu.work.admit`, and
`kungfu.agent.console.bind-work` path, cite its receipts, and continue the
original task. Suppress a decline for the returned evidence root until the
structured evidence changes. Advice grants no external authority.

Do not continue unless it returns `status: bound`. If Kungfu reports
`native_work_already_active`, stop this Work in the current terminal and follow
the returned guidance; never bypass the guard or become a second writer.

Do not infer Work completion from terminal output or process exit. Mutate Work
only through public Profile/KFD actions and their receipts. The Kungfu TUI is
an observer of this native UI and never owns OpenCode input or transcript
bytes.
