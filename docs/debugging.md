# Debugging kungfu

If kungfu itself misbehaves — a frame that looks wrong, a component that does not
see data, a replay that diverges — this is how to localize it. It is a *verify*
document: every step points at a real command or source you can run or read.

The single most useful fact: **the journal is the ground truth.** Because every
component reads and writes the same append-only journal
(see [`event-model.md`](event-model.md)), most "kungfu is broken" questions reduce
to "what is actually in the journal?" — which you can inspect directly.

## Inspect recorded facts

Journal pages are the data plane, but their lifecycle is exposed through typed
Episode and Storage surfaces rather than loose-file journal commands:

```sh
kungfu storage query --table episodes --scope all --json
kungfu storage query --table episode_frames --scope episode \
  --episode-id <episode-id> --json
kungfu query prove --episode-id <episode-id> --json
kungfu storage fsck --scope episode --episode-id <episode-id> \
  --verify-frames --json
```

The first two commands inspect the rebuildable SQLite projection. `query prove`
folds the declared authority by default and returns proof lineage. `storage
fsck --verify-frames` re-reads the Episode's claimed journal frames and verifies
their receipts. The Journal reference view exposes the same Episode anchors and
in-process ledger capability for interactive inspection.

## Reproduce with replay

Because live and replay run on the **same runtime** (see
[`contracts.md`](contracts.md)), a misbehavior recorded in an Episode can be
re-run rather than reproduced by guesswork. Replay the retained Episode and
watch the same code path execute against the same frames.

## Read the logs

The runtime logs through spdlog (configured in the `yijinjing` common layer,
[`framework/core/src/libyijinjing/include/kungfu/yijinjing/common.h`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/common.h)).
Use the logs to correlate a wrong frame in the journal with the component and the
moment that produced it.

## Localizing by layer

| Symptom | Where to look first |
|---|---|
| A reader sees no / stale / torn data | The publish/visibility contract is [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md); inspect the Episode with `kungfu query prove`, then verify attached frames with `kungfu storage fsck --verify-frames`. |
| Data is there but a language binding reads it wrong | The adapter boundary — see [`adapters.md`](adapters.md); the layout is the contract ([`contracts.md`](contracts.md)). |
| Replay diverges from live | Determinism boundary — see [`contracts.md`](contracts.md) and `known-limits` on cross-version/cross-machine reproduction. |
| Build / runtime won't start | The build path — see [`buildchain.md`](buildchain.md). |

## What is not yet here

A consumer-facing "verify this binary" path (signatures/checksums) is tracked
separately and waits on the release infrastructure — see
[`known-limits.md`](known-limits.md) and the `provenance` row in
[`MAP.md`](MAP.md).
