# Agent Mode Selection

Choose the smallest mode that preserves evidence.

| Mode | Use when | First command | Maturity |
|---|---|---|---|
| brief | You need local facts before acting. | `kungfu agent brief` | stable |
| report | You need structured work facts, status, decisions, artifacts, or reported external run facts. | `kungfu work create <title> --json` or `kungfu codex report-goal --goal-id <goal-id> --status <status> --json` | stable |
| atlas-projection | The user asks to sync, import, inspect, or visualize an Atlas-style mission/goal/worktree control-plane repo inside Kungfu. | `kungfu atlas import --repo <atlas-repo> --json` then `kungfu atlas show import --json` | stable |
| trace | You already have a command or agent process to capture. | `kungfu trace -- <command>` | stable |
| managed-run | Kungfu should launch the provider CLI and bind skill context. | `kungfu managed-run --provider <provider> --prompt <task>` | experimental |
| remote-sync | Evidence must cross machines or runtime trust boundaries. | `kungfu remote add <source-id> --host <host> --home <kf-home> --json` then `kungfu remote sync <source-id> --json` | experimental |

Rules:

- Prefer `trace` for unmodified programs.
- Prefer `managed-run` only when Kungfu is responsible for launching the agent
  process.
- Prefer `report` when no process capture is needed and the durable fact is a
  work item, checkpoint, decision, artifact link, or reported external run fact.
- Prefer `atlas-projection` only for importing an external Atlas-style
  control-plane snapshot into Kungfu. The source repo remains authoritative;
  verify with `kungfu atlas show missions --json`,
  `kungfu atlas show goals --json`, and `kungfu atlas show markers --json`.
- For native Codex goals, prefer `kungfu codex report-goal` over hand-assembling
  `kungfu report` commands; run `kungfu codex verify-goal-report` on the emitted
  receipt before declaring the goal complete.
- Switching to `managed-run` does not require disabling report mode. Keep the
  receipt closeout gate available as a fallback for native-goal or interrupted
  runs.
- Treat `remote-sync` as source-scoped import: remote facts stay under
  `remotes/<source-id>/runtime` unless a later command explicitly promotes
  them.
- Use `kungfu agent choose-mode --json` when an agent needs a machine-readable
  recommendation.
