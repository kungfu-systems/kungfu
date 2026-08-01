---
name: kungfu-agent-onboarding
key: kungfu-agent-onboarding
title: Kungfu Agent Onboarding
description: Discover the exact Kungfu Project, WorkConsole, WorkRef, Skill catalog, and Core Work state admitted to this Claude process before choosing a work mode.
triggers:
  - kungfu
  - atlas projection
  - atlas import
  - sync atlas
  - kfx
  - rewind
  - managed-run
  - trace
  - report-goal
  - closeout receipt
  - xinfa
  - verified context
  - task chart
  - agent hub qualification
  - kfd agent hub
  - primitive
  - primitive management
  - release verification
  - release status
capabilities:
  - local-fact-review
  - mode-selection
  - receipt-verification
  - agent-hub-qualification
---

# Kungfu Agent Onboarding

When `KUNGFU_AGENT_ENVIRONMENT=native-interactive`, begin from the injected
Kungfu envelopes rather than provider chat history:

- `KUNGFU_AGENT_CONSOLE_ENVELOPE` identifies the exact Project, WorkConsole,
  SessionAttempt, runtime Profile, and optional WorkRef.
- `KUNGFU_SKILL_CONTEXT` advertises the compact Skill catalog. Load full Skill
  instructions only through the declared Kungfu entrypoint.
- `KUNGFU_AGENT_CONTEXT` and its entrypoints are discovery pointers, not a
  prior chat transcript.
- `KUNGFU_PRIOR_TRANSCRIPT_BYTES=0` means continuity comes from Core evidence.

Confirm current facts with `"$KUNGFU_CLI_BIN" agent console current --json`,
`"$KUNGFU_CLI_BIN" skill catalog --json`, and the exact
`"$KUNGFU_CLI_BIN" work status` query. Never
infer Work completion from terminal output or process exit. The Kungfu TUI is
an observer and never owns Claude input or transcript bytes.

A bare `kungfu run claude` launch is intentionally Work-unbound so many terminal
windows can start in the same Project. As soon as you choose or accept one
Assignment, and before editing files or invoking a Work mutation, run:

```sh
"$KUNGFU_CLI_BIN" agent console bind-work --initiative-id <id> --assignment-id <id> --json
```

Do not continue unless it returns `status: bound`. If Kungfu reports
`native_work_already_active`, stop this Work in the current terminal and follow
the returned guidance; never bypass the guard or become a second writer. The
`plan-native-bind-work` and `bind-native-work` capability names are internal
Session protocol operations, not public CLI entrypoints; never invoke them
through `kungfu agent session`.

Before acting in a Kungfu runtime, read local facts from the installed pack:

```sh
kungfu agent brief
kungfu release status --json
kungfu release explain --json
kungfu agent capabilities --json
kungfu agent work-model --json
kungfu agent hub qualify --output-dir <new-directory> --json
kungfu agent hub verify --qualification-dir <directory> --json
kungfu agent choose-mode --json
kungfu agent verify --json
kungfu agent status --target claude --json
kungfu agent console current --json
kungfu agent runtime list --json
kungfu agent session capabilities --json
kungfu agent session list --json
kungfu cut --repo <path> --json
kungfu work status --home --initiative-id <initiative-id> --assignment-id <assignment-id>
```

For source work, read `AGENTS.md` and `xinfa-context.md`, inspect
`./shifu docs inventory --json`, and compile the exact Agent route with
`./shifu docs context`. Do not guess a route or continue through ambiguous,
degraded, stale, unverified, or required-omission output. An installed runtime
has only a read-only precompiled Atlas; verify it with
`kungfu agent docs --verify --json`.

For Primitive source work, read `primitive-management.md` and use
`./shifu primitive:new -- --actor agent`; its dry-run automatically binds the
exact management Task Chart. Never write without returning the current
`context.projectionRoot`. Use `kungfu primitive list|show|explain --json` for
installed read-only discovery.

Use the smallest mode that preserves evidence:

- Before explaining whether Kungfu is publicly installable, run
  `kungfu release status --json`. For a retained status, activation receipt
  set, or released-evidence index, run `kungfu release verify
  <file-or-https-url> --json`. Report `verified`, `releaseAvailable`,
  `meaning`, and `notClaims`; never infer a legal, registration, or first-use
  conclusion.

- When asked whether the installed Kungfu implements the tested local KFD Agent
  Hub capability, run `kungfu agent hub qualify --output-dir <new-directory>
  --json`. Explain only its emitted `meaning` and `nonClaims`; keep the evidence
  path and use `kungfu agent hub verify` for an offline recheck. A pass is not
  KFD certification, security, production fitness, remote-network
  interoperability, external adoption, or unobserved-platform support.

- Start project-level work with `kungfu cut --repo <path> --json`, then use
  `kungfu work capture <request.json>` and `kungfu work status` against the exact workspace,
  Initiative, and Assignment. Treat this as the only public Work mutation
  family; older Work journals and compatibility aliases are not authorities.

- Read `kungfu agent work-model --json` before treating a goal as authority,
  context as complete reality, a plan as occurrence, or an Episode as
  completion. Preserve the referenced Pursuit, Atlas, Warrant, and Episode
  identities when work crosses a handoff or consequential boundary.

- When `console current` reports `available: true`, preserve its Console,
  attempt, optional WorkRef, exact Profile roots, and envelope root. Query its
  declared entrypoints before claiming what Kungfu can do.

- Use `kungfu agent session` for the shared Capsule action port. Review the
  exact `plan-start` or `plan-control` root before executing the matching
  action. A delivery receipt proves PTY delivery only; mutate and close work
  through public Profile/KFD-3 actions and their receipts.

- `report` for structured work facts.
- `atlas-projection` when importing an Atlas-style mission/goal/worktree repo
  into Kungfu for CLI, GUI, or kfx inspection.
- `trace` for an existing command.
- `managed-run` when Kungfu launches the provider CLI.
- `remote-sync` only when the task is about crossing runtime or machine
  boundaries; stable publishing commands are planned unless the local pack says
  otherwise.

For Atlas projection, the source repo remains authoritative. Import and verify:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage fsck --scope all --json
kungfu storage repair --scope episode --episode-id <id> --plan --dry-run --json
kungfu storage repair --scope episode --episode-id <id> --fetch --out repair-material.json --dry-run --json
kungfu storage repair --scope episode --episode-id <id> --apply --from <bundle.json> --dry-run --json
kungfu storage verify-sync --source <source-id> --json
kungfu atlas show import --json
kungfu work capture <request.json>
kungfu work status --workspace <path> --initiative-id <initiative-id> --assignment-id <assignment-id>
kungfu atlas show markers --json
```

For native Work, closeout is not complete until the exact Assignment has a
completion claim, an independent review, and a continuation decision:

```sh
kungfu work claim-completion <input.json> --workspace <path> --authorized-by <actor>
kungfu work review <input.json> --workspace <path> --authorized-by <reviewer>
kungfu work decide <input.json> --workspace <path> --authorized-by <actor>
```

Each mutation must return a verified Profile action receipt with canonical
Episode and Fact evidence. Provider usage remains only observed evidence unless
the provider gives split token fields or an exact dollar cost.

For setup or teardown, preview first:

```sh
kungfu agent bootstrap --target claude --mode report
kungfu agent mode set --target claude --mode managed-run
kungfu agent unbootstrap --target claude
kungfu agent uninstall --target claude
```

Do not delete Kungfu receipts, work items, or Rewind bundles unless the user
explicitly asks to archive or remove Kungfu data.

Keep observed, reported, imported, and remote facts distinct.
