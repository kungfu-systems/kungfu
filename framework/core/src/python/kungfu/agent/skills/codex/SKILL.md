---
key: kungfu-agent-onboarding
title: Kungfu Agent Onboarding
description: Use the installed Kungfu agent pack before choosing report, atlas-projection, trace, managed-run, or remote-sync mode.
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
kungfu agent choose-mode --json
kungfu agent verify --json
kungfu agent status --target codex --json
```

Use the smallest mode that preserves evidence:

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
