# kungfu CLI handbook — `kfc`

> Pre-release (spec 0.1) · minimal recipe. `kfc` is the current kungfu CLI
> (`@kungfu-tech/core`). The generated command reference (from the CLI's own
> definitions) and the agent-first `--json` provenance surface are planned; this
> page is a hand-written getting-started.

`kfc` is how you produce and inspect fact-ledger records from the command line.
Everything below produces or reads the same portable bundle described in the
[format spec](../../spec/).

## Install

`kfc` ships with `@kungfu-tech/core`:

```bash
pnpm add @kungfu-tech/core
# kfc is now on your PATH inside the workspace
kfc --version
```

## Produce a record

A run in `replay` or `backtest` mode executes a workflow and writes a
fact-ledger you can open afterward:

```bash
# execute a workflow and record it
kfc run --mode backtest --category <category> --name <name>

# re-run a previously recorded session deterministically
kfc run --mode replay --name <name>
```

`run` modes: `live`, `backtest`, `data`, `replay`. `replay` and `backtest` are
the record-producing paths.

## Inspect a record

```bash
# inspect recorded data over a time window
kfc tool --begin <t0> --end <t1> --category <category> --name <name>

# slice a recorded ledger into a portable extract
kfc slicetool --begin <t0> --end <t1> --name <name>
```

## Assemble a bundle

```bash
kfc assemble <config.json>
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

Run `kfc <command> --help` for the full option list.

## Planned

- `kfc --json` emitting provenance + the authoritative `docs_url` for the
  installed version, so an agent can fetch the right doc automatically.
- A generated command reference kept in lock-step with the CLI definitions
  (drift = build fail).
