# kungfu CLI handbook — `kungfu`

> Pre-release (spec 0.1) · minimal recipe. `kungfu` is the kungfu CLI
> (`@kungfu-tech/core`) and the runtime it invokes. The generated command reference (from the
> CLI's own definitions) and the agent-first `--json` provenance surface are
> planned; this page is a hand-written getting-started.

`kungfu` is how you capture and inspect fact-ledger records from the command
line. Everything below produces or reads the same portable bundle described in
the [format spec](../../spec/).

## Install

`kungfu` ships with `@kungfu-tech/core`:

```bash
pnpm add @kungfu-tech/core
# kungfu is now on your PATH inside the workspace
kungfu --version
```

## Capture a record

`trace` captures an agent run into a local trace store — everything the run
does is recorded into a fact-ledger you can re-open afterward:

```bash
# capture a run
kungfu trace -- <command>
```

## Re-open a record

`rewind` re-opens recorded runs for forensic replay over the trace journal:

```bash
kungfu rewind <subcommand>
```

## All commands

| Command | What it does |
| --- | --- |
| `trace` | capture an agent run into a local trace store |
| `rewind` | re-open recorded runs: forensic replay over the trace journal |
| `journal` | read the underlying journal (yijinjing) records |
| `schema` | compile kfx FlatBuffers schemas into open-layer `.bfbs` (in-process, no flatc) |
| `work` | manage work items: create, drive the lifecycle, and inspect state |
| `kfx` | install, list and remove kfx packages for this home |
| `tui` | open the reference TUI (Ink) |
| `cli` | open the interactive Node CLI |
| `atlas` | Atlas repo integration surface |
| `engage` | developer tooling (formatting and related helpers) |

Run `kungfu <command> --help` for the full option list.

## Planned

- `kungfu --json` emitting provenance + the authoritative `docs_url` for the
  installed version, so an agent can fetch the right doc automatically.
- A generated command reference kept in lock-step with the CLI definitions
  (drift = build fail).
