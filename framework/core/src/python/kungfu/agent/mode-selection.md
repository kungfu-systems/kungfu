# Agent Mode Selection

Choose the smallest mode that preserves evidence.

Native interaction is an orthogonal launch surface, not another evidence mode.
Bare `kungfu run codex|claude|amp|opencode` or bare `kungfu run agent` keeps the
provider UI, starts a fresh content-bound SessionAttempt, and lets the Kungfu
TUI observe the same Core Work state without owning provider input or transcript
bytes. A registered third-party PTY provider uses
`kungfu run agent --agent <profile-id>` through the same path. Adding a task or
managed-run control selects the managed path instead.

| Mode | Use when | First command | Maturity |
|---|---|---|---|
| brief | You need local facts before acting. | `kungfu agent brief` | stable |
| report | You need structured Work facts, status, decisions, or reported external run facts. | `kungfu work capture <request.json>` then `kungfu work status --home --initiative-id <initiative-id> --assignment-id <assignment-id>` | stable |
| trace | You already have a command or agent process to capture. | `kungfu trace -- <command>` | stable |
| managed-run | Kungfu should launch the provider CLI and bind skill context. | `kungfu managed-run --provider <provider> --prompt <task>` | experimental |
| remote-sync | Evidence must cross machines or runtime trust boundaries. | `kungfu remote add <source-id> --host <host> --home <kf-home> --json` then `kungfu remote sync <source-id> --json` | experimental |

Rules:

- Prefer `trace` for unmodified programs.
- Prefer `managed-run` only when Kungfu is responsible for launching the agent
  process.
- Prefer `report` when no process capture is needed and the durable fact is a
  work item, checkpoint, decision, artifact link, or reported external run fact.
- Close native Work only through `kungfu work claim-completion`, `review`, and
  `decide`, and verify every returned Profile action receipt.
- Switching to `managed-run` does not require disabling report mode. Keep the
  receipt closeout gate available as a fallback for native Assignment or interrupted
  runs.
- Treat `remote-sync` as source-scoped import: remote facts stay under
  `remotes/<source-id>/runtime` unless a later command explicitly promotes
  them.
- Use `kungfu agent choose-mode --json` when an agent needs a machine-readable
  recommendation.
