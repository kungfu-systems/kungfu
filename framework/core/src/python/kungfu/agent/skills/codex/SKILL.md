---
key: kungfu-agent-onboarding
title: Kungfu Agent Onboarding
description: Use the installed Kungfu agent pack and discover verified Xinfa context before choosing report, atlas-projection, trace, managed-run, or remote-sync mode.
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
capabilities:
  - local-fact-review
  - mode-selection
  - receipt-verification
---

# Kungfu Agent Onboarding

Before acting in a Kungfu runtime, read local facts from the installed pack:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent work-model --json
kungfu agent choose-mode --json
kungfu agent verify --json
kungfu agent status --target codex --json
kungfu agent console current --json
kungfu agent runtime list --json
kungfu agent session capabilities --json
kungfu agent session list --json
kungfu cut --repo <path> --json
kungfu work capabilities --json
kungfu work export <work-id> --repo <path> --json
kungfu work import --file <envelope.json> --repo <path> --json
```

For source work, read `AGENTS.md` and `xinfa-context.md`, inspect
`./shifu docs inventory --json`, and compile the exact Agent route with
`./shifu docs context`. Do not guess a route or continue through ambiguous,
degraded, stale, unverified, or required-omission output. An installed runtime
has only a read-only precompiled Atlas; verify it with
`kungfu agent docs --verify --json`.

Use the smallest mode that preserves evidence:

- Start project-level work with `kungfu cut --repo <path> --json`, then read
  `kungfu work capabilities --json`. Treat its `unavailable`, `degraded`, and
  `plan-only` states as hard capability limits; the identical manifest is
  available at `kungfu agent capabilities --json` under `workLoop`.

- Use `kungfu work export` only against one verified current Project Cut. Treat
  `kungfu work import` as verification unless the caller explicitly supplies
  `--execute`; the portable root proves integrity, not origin authenticity.

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
kungfu atlas show missions --json
kungfu atlas show goals --json
kungfu atlas show markers --json
```

If report mode is enabled and the work uses a native Codex goal, closeout is not
complete until both commands succeed:

```sh
kungfu codex report-goal --goal-id <goal-id> --status <status> --json
kungfu codex verify-goal-report --receipt <receipt-path> --json
```

Use native goal usage only as observed usage evidence unless the provider gives
split token fields or an exact dollar cost. Switching to `managed-run` does not
require disabling report mode; keep the report receipt gate as the fallback for
native-goal or interrupted work.

For setup or teardown, preview first:

```sh
kungfu agent bootstrap --target codex --mode report
kungfu agent mode set --target codex --mode managed-run
kungfu agent unbootstrap --target codex
kungfu agent uninstall --target codex
```

Do not delete Kungfu receipts, work items, or Rewind bundles unless the user
explicitly asks to archive or remove Kungfu data.

Keep observed, reported, imported, and remote facts distinct.
