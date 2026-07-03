# kungfu CLI handbook — `kungfu`

> Pre-release (spec 0.1) · minimal recipe. `kungfu` is the kungfu CLI
> (`@kungfu-tech/core`) and the runtime it invokes. The generated command reference (from the
> CLI's own definitions) and the agent-first `--json` provenance surface are
> planned; this page is a hand-written getting-started.

`kungfu` is how you produce and inspect fact-ledger records from the command
line. Everything below produces or reads the same portable bundle described in
the [format spec](../../spec/).

## Install

`kungfu` ships with `@kungfu-tech/core`:

```bash
pnpm add @kungfu-tech/core
# kungfu is now on your PATH inside the workspace
kungfu --version
```

## Produce a record

A run in `replay` or `backtest` mode executes a workflow and writes a
fact-ledger you can open afterward:

```bash
# execute a workflow and record it
kungfu run --mode backtest --category <category> --name <name>

# re-run a previously recorded session deterministically
kungfu run --mode replay --name <name>
```

`run` modes: `live`, `backtest`, `data`, `replay`. `replay` and `backtest` are
the record-producing paths.

## Inspect a record

```bash
# inspect recorded data over a time window
kungfu tool --begin <t0> --end <t1> --category <category> --name <name>

# slice a recorded ledger into a portable extract
kungfu slicetool --begin <t0> --end <t1> --name <name>
```

## Assemble a bundle

```bash
kungfu assemble <config.json>
```

## All commands

| Command | What it does |
| --- | --- |
| `run` | execute a workflow (`live` / `backtest` / `data` / `replay`); `replay`/`backtest` produce a ledger |
| `assemble` | assemble / package a workflow from a config |
| `tool` | inspect recorded data over a window |
| `slicetool` | slice a recorded ledger into an extract |
| `login` | authenticate an account (for `live` workflows) |
| `cli` | open the interactive Node CLI |

Run `kungfu <command> --help` for the full option list.

## Planned

- `kungfu --json` emitting provenance + the authoritative `docs_url` for the
  installed version, so an agent can fetch the right doc automatically.
- A generated command reference kept in lock-step with the CLI definitions
  (drift = build fail).
