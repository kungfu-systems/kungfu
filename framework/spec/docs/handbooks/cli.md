# Kungfu CLI handbook

> **Pre-release source guidance.** Public CLI artifacts are not yet a polished
> one-command install. Command names below are backed by the current source;
> availability and release guarantees remain scoped by
> [Known Limits](../../../../docs/qualification/known-limits.md).

The `kungfu` command operates the runtime fact ledger. Fact state and Episode
causal experience are parallel substrates; Episode is the temporal work object.
`trace` and `rewind --run` are current Agent Work profile adapters, not the
identity of the whole CLI.

## Discover the installed surface

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
kungfu --help
```

## Inspect Episode authority

```sh
kungfu storage episode list --json
kungfu storage episode inspect --episode-id <episode-id> --json
kungfu storage fsck --scope episode --episode-id <episode-id> \
  --verify-frames --json
```

## Use the Agent Work capture adapter

```sh
kungfu trace -- <command>
kungfu rewind show --run <run-id>
kungfu rewind verify --run <run-id>
```

Rewind is forensic reopening. It never silently repeats external side effects.
See [Rewind an Episode](../../../../docs/guides/rewind.md) for the distinction between
Replay, Rewind, Recovery, and explicit re-execution.

The former `kungfu journal` maintenance command is retired. Storage, Episode,
query, repair-plan, export, and source operations own the current public
authority boundary. Use `kungfu <command> --help` and the installed agent brief
instead of an enumerated command list that can drift from the runtime.
