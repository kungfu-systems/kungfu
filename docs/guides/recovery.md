# Recover a Kungfu workspace

For ordinary local recovery, remember two commands:

```sh
kungfu health
kungfu recover
```

Use `kungfu health` to understand the problem, then `kungfu recover` to review
the safe next actions. Normal users do not need to choose among supervisor,
coordinator, Peer, storage, or Episode maintenance commands. Those lower-level
surfaces remain available for advanced diagnosis and authority-specific review.

`kungfu recover` turns the current runtime, Peer, storage, and Episode health
findings into one reviewable plan. Planning is the default and does not change
the workspace:

```sh
kungfu recover
kungfu recover --json
```

The plan reports one of three action classes:

| Class | Meaning |
| --- | --- |
| `automatic-safe` | Idempotent activation or rebuilding of a declared derived projection. |
| `confirmation-required` | Peer lifecycle or stale Episode state will change. |
| `manual-blocked` | Kungfu cannot prove ownership, authority, or outcome well enough to execute. |

Keep the complete `planId`. Execute only after reviewing the targets and
preconditions:

```sh
kungfu recover --execute --plan-id sha256:...
```

If the plan contains confirmation-required actions, approve them explicitly:

```sh
kungfu recover --execute --plan-id sha256:... --approve all
kungfu recover --execute --plan-id sha256:... --approve peer.restart:...
```

Use repeated `--action` options to run a reviewed subset. A manual-blocked
action can never be selected for execution.

## Why a reviewed plan can still be refused

Execution regenerates the plan immediately before writing. If any health fact,
target, generation, process identity, Peer declaration, writer lease, or
Episode manifest position changed, the old `planId` is rejected and you must
review a new plan. Each underlying service also retains its own fence at the
actual write point.

This is intentional: a plan is authorization evidence, not a lock on the
workspace.

## Receipts and partial outcomes

Machine-readable execution returns `kungfu.recovery-receipt/v1`:

```sh
kungfu recover --execute --plan-id sha256:... --approve all --json
```

Each action is `succeeded`, `failed`, or `not-run`, with its native result or
technical error. Kungfu stops after the first failure and then runs a fresh deep
health postflight.

Recovery is not a global transaction. If one action succeeds and a later action
fails, the successful change is not silently rolled back. Keep the receipt,
inspect the postflight, and generate a new plan.

## Current scope

The current product surface is a local, single-host CLI with stable JSON for
Agent and future GUI consumers. It covers one Kungfu workspace and the runtime,
Peers, storage projections, and Episodes owned on that host. CLI prose and JSON
use the same plan, action classes, fences, and receipts.

A graphical recovery wizard is not shipped yet. A future GUI may present this
same contract, but it must not invent a separate recovery authority or bypass
plan review, explicit confirmation, write-point fences, or receipts.

## Not yet supported

This entry does not provide:

- multi-host coordination or cross-host ownership transfer;
- network-partition healing, distributed consensus, replication, or HA;
- unattended repair when process, writer, or authority identity is unknown;
- restoration of corrupted authoritative journals or lost physical media; or
- global rollback across runtime, Peer, storage, and Episode actions.

These are different product and durability contracts, not hidden modes of
`kungfu recover`.

## Safety boundary

The unified entry can:

- activate a daemonless runtime through its existing host;
- start or restart a declared Peer through its lifecycle controller;
- rebuild only the declared source-registry or Episode-manifest projection from
  authoritative journals;
- append an abort record for a stale, open Episode after writer and manifest
  fences pass.

It cannot repair unknown or corrupted authoritative facts, take over a process
whose identity is unverified, execute a future unregistered projection repair,
restore lost media, or claim rollback across components. Those cases remain
`manual-blocked` with the technical evidence preserved.

Inspect the shared contract with:

```sh
kungfu recover --contract --json
kungfu contract show diagnostics --json
```

The authority boundary and acceptance gates are frozen in
[KF-ADR-019f86da-4f90-7d58-b5b3-b6d5041dcab6](../adr/KF-ADR-019f86da-4f90-7d58-b5b3-b6d5041dcab6.md). The exact
portable three-platform candidate evidence is retained in the
[unified recovery qualification](../qualification/unified-recovery.md).
