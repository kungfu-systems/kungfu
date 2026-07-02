# Debugging kungfu

If kungfu itself misbehaves — a frame that looks wrong, a component that does not
see data, a replay that diverges — this is how to localize it. It is a *verify*
document: every step points at a real command or source you can run or read.

The single most useful fact: **the journal is the ground truth.** Because every
component reads and writes the same append-only journal
(see [`event-model.md`](event-model.md)), most "kungfu is broken" questions reduce
to "what is actually in the journal?" — which you can inspect directly.

## Inspect the journal

`kfc` exposes a `journal` command group (implemented in
[`console/commands/journal.py`](../framework/core/src/python/kungfu/console/commands/journal.py)):

- **List recorded sessions** — `kfc journal sessions` (sortable, multiple table
  formats). Tells you what was recorded, when, and by which source.
- **Show a session's frames** — `kfc journal show -i <session_id>`, selecting
  input or output frames, with `-o <file>.csv` to export. This is how you see the
  exact frames a component produced or consumed — the direct answer to "did the
  data actually flow?"
- **Rebuild / update the index** — if `sessions` looks wrong or incomplete, the
  index can be rebuilt from the journal files.

Filters (`--mode`, `--category`, `--group`, `--name`) scope the view to the part
of the system you are investigating.

## Reproduce with replay

Because live and replay run on the **same runtime** (see
[`contracts.md`](contracts.md)), a misbehavior recorded in a journal can be
re-run rather than reproduced by guesswork. Replay the recorded session and watch
the same code path execute against the same frames.

## Read the logs

The runtime logs through spdlog (configured in the `yijinjing` common layer,
[`framework/core/src/libyijinjing/include/kungfu/yijinjing/common.h`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/common.h)).
Use the logs to correlate a wrong frame in the journal with the component and the
moment that produced it.

## Localizing by layer

| Symptom | Where to look first |
|---|---|
| A reader sees no / stale / torn data | The publish/visibility contract is [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md); first confirm with `kfc journal show` whether the frame is in the journal at all. |
| Data is there but a language binding reads it wrong | The adapter boundary — see [`adapters.md`](adapters.md); the layout is the contract ([`contracts.md`](contracts.md)). |
| Replay diverges from live | Determinism boundary — see [`contracts.md`](contracts.md) and `known-limits` on cross-version/cross-machine reproduction. |
| Build / runtime won't start | The build path — see [`buildchain.md`](buildchain.md). |

## What is not yet here

A consumer-facing "verify this binary" path (signatures/checksums) is tracked
separately and waits on the release infrastructure — see
[`known-limits.md`](known-limits.md) and the `provenance` row in
[`MAP.md`](MAP.md).
