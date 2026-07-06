# Agent Mode Selection

Choose the smallest mode that preserves evidence.

| Mode | Use when | First command | Maturity |
|---|---|---|---|
| brief | You need local facts before acting. | `kungfu agent brief` | stable |
| report | You need structured work facts, status, decisions, artifacts, or reported external run facts. | `kungfu work create <title> --json` or `kungfu report run begin --work <work-id> --provider <provider> --json` | stable |
| trace | You already have a command or agent process to capture. | `kungfu trace -- <command>` | stable |
| managed-run | Kungfu should launch the provider CLI and bind skill context. | `kungfu managed-run --provider <provider> --prompt <task>` | experimental |
| remote-sync | Evidence must cross machines or runtime trust boundaries. | `kungfu remote add <source-id> --host <host> --home <kf-home> --json` then `kungfu remote sync <source-id> --json` | experimental |

Rules:

- Prefer `trace` for unmodified programs.
- Prefer `managed-run` only when Kungfu is responsible for launching the agent
  process.
- Prefer `report` when no process capture is needed and the durable fact is a
  work item, checkpoint, decision, artifact link, or reported external run fact.
- Treat `remote-sync` as source-scoped import: remote facts stay under
  `remotes/<source-id>/runtime` unless a later command explicitly promotes
  them.
- Use `kungfu agent choose-mode --json` when an agent needs a machine-readable
  recommendation.
