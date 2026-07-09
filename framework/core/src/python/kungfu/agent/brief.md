# Kungfu Agent Onboarding Pack

This installed runtime carries a local agent pack. Use it before guessing from
old docs, release notes, or memory.

Start here:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
kungfu agent verify --json
kungfu agent status --target codex --json
```

Kungfu is journal-first infrastructure for capturing local facts, replaying
runs, and making control decisions from evidence. The agent-facing layer is not
ambient permission. It is a set of local facts, command contracts, Skill
instructions, and kfx trust boundaries that must remain inspectable after
installation.

The KFD-3 collaboration interface is declared in `kfd3_api.registry.json`.
`commands.json`, this brief, and provider skills are projections of that
registry. `kungfu agent verify --json` checks the installed runtime command tree
against the registry so a shipped agent surface cannot quietly expose extra
`kungfu agent` commands outside the declared interface.

Use the modes this way:

- **brief**: read the local facts; no runtime action.
- **report**: create or inspect structured work facts with `kungfu work`, and
  append external run facts with `kungfu report`. Native Codex goals should use
  `kungfu codex report-goal` and verify the receipt before closeout.
- **atlas-projection**: snapshot an Atlas-style control-plane repo with
  `kungfu atlas import` when the user asks to sync, inspect, or visualize
  missions, goals, and worktree markers in Kungfu.
- **trace**: capture an existing command with `kungfu trace -- <command>`.
- **managed-run**: let Kungfu launch a provider CLI with skill context and run
  evidence; this surface is experimental. Keep the report closeout gate as a
  fallback when switching between managed-run and report mode.
- **remote-sync**: mirror evidence across runtime boundaries with source labels;
  `kungfu remote` is experimental and does not merge remote facts into local
  authoritative truth.

When the user asks to sync an Atlas-style control-plane repo into Kungfu,
snapshot it and verify the projection with:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage fsck --scope all --json
kungfu storage repair --scope episode --episode-id <id> --plan --dry-run --json
kungfu storage repair --scope episode --episode-id <id> --apply --from <bundle.json> --dry-run --json
kungfu storage verify-sync --source <source-id> --json
kungfu atlas show import --json
kungfu atlas show missions --json
kungfu atlas show goals --json
kungfu atlas show markers --json
```

The source repo remains the authority. Kungfu stores a read-only projection for
inspection in CLI, GUI, and kfx work views.

The pack is included by the Electron artifact, the standalone CLI, npm
`@kungfu-tech/core`, and the PyPI wheel. Future Homebrew, winget, container, and
kfx packaging must keep the same pack validation gate before claiming support.

Bootstrap surfaces are local and explicit:

```sh
kungfu agent bootstrap --target codex --mode report
kungfu agent mode set --target codex --mode managed-run
kungfu agent unbootstrap --target codex
kungfu agent uninstall --target codex
```

These commands dry-run by default unless they expose an `--execute` flag. They
do not read provider credentials and do not delete receipts, work items, or
Rewind bundles.
