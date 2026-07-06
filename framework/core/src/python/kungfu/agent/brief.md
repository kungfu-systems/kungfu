# Kungfu Agent Onboarding Pack

This installed runtime carries a local agent pack. Use it before guessing from
old docs, release notes, or memory.

Start here:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
```

Kungfu is journal-first infrastructure for capturing local facts, replaying
runs, and making control decisions from evidence. The agent-facing layer is not
ambient permission. It is a set of local facts, command contracts, Skill
instructions, and kfx trust boundaries that must remain inspectable after
installation.

Use the modes this way:

- **brief**: read the local facts; no runtime action.
- **report**: create or inspect structured work facts with `kungfu work`.
- **trace**: capture an existing command with `kungfu trace -- <command>`.
- **managed-run**: let Kungfu launch a provider CLI with skill context and run
  evidence; this surface is experimental.
- **remote-sync**: move or compare evidence across runtime boundaries; stable
  local publishing commands are still planned.

The pack is included by the Electron artifact, the standalone CLI, npm
`@kungfu-tech/core`, and the PyPI wheel. Future Homebrew, winget, container, and
kfx packaging must keep the same pack validation gate before claiming support.
