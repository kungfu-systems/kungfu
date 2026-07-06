---
key: kungfu-agent-onboarding
title: Kungfu Agent Onboarding
description: Use the installed Kungfu agent pack before choosing report, trace, managed-run, or remote-sync mode.
triggers:
  - kungfu
  - kfx
  - rewind
  - managed-run
  - trace
capabilities:
  - local-fact-review
  - mode-selection
---

# Kungfu Agent Onboarding

Before acting in a Kungfu runtime, read local facts from the installed pack:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
```

Use the smallest mode that preserves evidence:

- `report` for structured work facts.
- `trace` for an existing command.
- `managed-run` when Kungfu launches the provider CLI.
- `remote-sync` only when the task is about crossing runtime or machine
  boundaries; stable publishing commands are planned unless the local pack says
  otherwise.

Keep observed, reported, imported, and remote facts distinct.
