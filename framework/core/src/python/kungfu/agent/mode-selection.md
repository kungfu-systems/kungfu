# Agent Mode Selection

Choose the smallest mode that preserves evidence.

| Mode | Use when | First command | Maturity |
|---|---|---|---|
| brief | You need local facts before acting. | `kungfu agent brief` | stable |
| report | You need structured work facts, status, decisions, or artifacts. | `kungfu work create <title> --json` | stable |
| trace | You already have a command or agent process to capture. | `kungfu trace -- <command>` | stable |
| managed-run | Kungfu should launch the provider CLI and bind skill context. | `kungfu managed-run --provider <provider> --prompt <task>` | experimental |
| remote-sync | Evidence must cross machines or trust boundaries. | Use exported bundles and journal facts. | planned |

Rules:

- Prefer `trace` for unmodified programs.
- Prefer `managed-run` only when Kungfu is responsible for launching the agent
  process.
- Prefer `report` when no process capture is needed and the durable fact is a
  work item, checkpoint, decision, or artifact link.
- Treat `remote-sync` as planned unless a concrete installed command says
  otherwise.
- Use `kungfu agent choose-mode --json` when an agent needs a machine-readable
  recommendation.
