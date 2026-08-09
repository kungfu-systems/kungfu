# Configure durability

Kungfu's durability config lets you choose which local facts remain merely
visible and which must earn a local durability receipt. It does **not** turn a
machine into HA storage, and editing JSON does not qualify hardware.

The safe default is unchanged:

```json
{
  "storage": {
    "durability": {
      "activation": "off",
      "defaultProfile": "visible"
    }
  }
}
```

Use stronger profiles only after reading the capability and policy reports:

```sh
kungfu agent capabilities --json
kungfu config durability --json
```

## The three states you must distinguish

`kungfu config durability --json` reports three different things:

| State | Meaning |
|---|---|
| `requested` | The KFD-1 policy produced by defaults, user config, and workspace config. This is what you asked for. |
| `admission` | Whether the current libkungfu capability and retained qualification evidence permit that request. |
| `effective` | What the coordinator will execute. It is the requested policy or `refused`; there is no silent downgrade. |

The report also contains:

- `contract.hash`: identity of the complete config contract;
- `policyDigest`: SHA-256 identity of the contract hash plus requested
  durability policy;
- `qualificationProfile`: the named evidence envelope used for admission;
- `productionEligible`: still `false` for the current-hardware candidate.

Config is a request. C++ rechecks admission at coordinator construction; a
caller cannot pass `qualificationPassed=true` through Python or Node.

## Where to configure it

Resolution order is:

```text
contract defaults
  < ${KF_CONFIG_HOME:-~/.kungfu-config}/config.json
  < <workspace>/.kungfu/config.json
```

Objects merge recursively. Scalars and arrays replace. A workspace can
therefore be stricter than your normal machine default.

Write the user scope explicitly:

```sh
kungfu config set storage.durability.activation qualified-candidate --scope user --json
kungfu config set storage.durability.defaultProfile durable_group --scope user --json
```

Write only the current workspace:

```sh
kungfu config set storage.durability.activation qualified-candidate --scope workspace --json
kungfu config set storage.durability.defaultProfile durable_group --scope workspace --json
```

`--scope workspace` requires a Git workspace or an existing `.kungfu/` home.
It writes `.kungfu/config.json`; it does not alter the user file.

Inspect exact paths and winners:

```sh
kungfu config path --json
kungfu config show --json
kungfu config durability --json
```

## Complete parameter reference

All values live under `storage.durability`.

| Key | Default | Effect | Cost and caution |
|---|---:|---|---|
| `activation` | `off` | `qualified-candidate` asks the runtime to admit the named current-hardware candidate. | Startup refuses strong profiles when evidence or identities do not match. This does not set production eligibility. |
| `qualificationProfile` | `candidate/current-hardware-single-host/v1` | Names the exact capability/evidence envelope required by both Python diagnostics and C++ admission. | Changing it to an unknown profile refuses admission; it cannot create qualification. |
| `defaultProfile` | `visible` | Profile used when no rule matches. | `durable_group` adds batched sync latency; `durable_sync` adds a barrier per selected append. |
| `segmentMaxBytes` | `67108864` (64 MiB) | Rolls KFDL to a new segment after a completed barrier once this size is reached. Range: 1 MiB–1 GiB. | Smaller segments create more files and directory syncs; larger segments increase scan/tail working set. It does not change acknowledgement frequency. |
| `requestTimeoutMs` | `5000` | Converts each strong request to an absolute monotonic deadline. Range: 1–600000 ms. | A short timeout can produce `unknown` after I/O starts. It is not cancellation or rollback. |
| `reconcileOnTimeout` | `true` | Immediately reconciles the same request id and position after timeout/unknown. | Adds a checkpoint lookup. A still-unknown result must remain unknown until explicit later reconciliation. |
| `failurePolicy` | `fail-closed` | Prevents fallback or invented acknowledgement. This is the only permitted v1 value. | An unavailable service, stale writer fence, unsupported profile, bad identity, or uncertain append becomes an error/unknown result. |
| `group.maxDelayMs` | `10` | Flushes a pending `durable_group` frontier after this many milliseconds. Range: 0–1000; zero means immediate. | Lower values reduce exposure and batching efficiency; timer scheduling is not a physical power-loss guarantee. |
| `group.maxRecords` | `32` | Flushes when pending records reach this count. Range: 1–65536. | Lower values increase barrier frequency; higher values increase the pending group. |
| `group.maxBytes` | `1048576` (1 MiB) | Flushes when pending encoded bytes reach this size. Range: 4 KiB–64 MiB. | Limits large-payload batches independently of record count. |
| `rules` | `[]` | Selects a profile by carrier type, source id, and/or destination id. Maximum 256 rules. | Arrays replace at the winning scope. Highest priority wins; equal priority uses lexical `id`. |

Rule fields are ANDed. This rule matches carrier `1001` only when its source is
also `7`:

```json
{
  "id": "critical-decisions",
  "priority": 1000,
  "match": {
    "carrierTypes": [1001],
    "sourceIds": [7]
  },
  "profile": "durable_sync"
}
```

## Profile guarantees and prices

| Profile | A successful result proves | Typical use | Main price |
|---|---|---|---|
| `visible` | The ordinary hot-path publication is visible. It is not a strong local durability receipt. | Reconstructible or ephemeral observations. | Lowest latency; no local durability barrier. |
| `durable_group` | The receipt position is at or below one completed qualified local batch barrier. Earlier positions in the same stream are covered by the durable watermark. | Normal durable facts where a small batching window is acceptable. | One sync is amortized across a group; acknowledgement waits for records, bytes, delay, or explicit flush. |
| `durable_sync` | The selected frontier completed the qualified local data/checkpoint/directory barrier. | Critical decisions, close receipts, or facts whose loss is not acceptable inside the qualified envelope. | Highest per-fact latency and lowest sustainable throughput because selected appends immediately cross the barrier. |

`durable_group` and `durable_sync` currently use the same native barrier
primitive. Their difference is scheduling: group amortizes that barrier;
sync requests it immediately.

Inside an activated configured stream, all records are also appended to the
sequential KFDL chain so a later durable frontier has no position gap. A
rule-selected `visible` record therefore avoids the sync barrier but still pays
the extra sequential KFDL append and remains an unacknowledged tail until a
later strong barrier covers it. With activation `off`, the ordinary journal hot
path is unchanged and no configured stream can be opened.

## Recommended workspace policy

This example keeps ordinary facts batched and makes carrier `1001` synchronous:

```json
{
  "schema": "kungfu.config.override/v1",
  "storage": {
    "durability": {
      "activation": "qualified-candidate",
      "qualificationProfile": "candidate/current-hardware-single-host/v1",
      "defaultProfile": "durable_group",
      "segmentMaxBytes": 67108864,
      "requestTimeoutMs": 5000,
      "reconcileOnTimeout": true,
      "failurePolicy": "fail-closed",
      "group": {
        "maxDelayMs": 10,
        "maxRecords": 32,
        "maxBytes": 1048576
      },
      "rules": [
        {
          "id": "critical-decisions",
          "priority": 1000,
          "match": {"carrierTypes": [1001]},
          "profile": "durable_sync"
        }
      ]
    }
  }
}
```

Before relying on it, require both of these:

```sh
kungfu config durability --json
kungfu agent capabilities --json
```

The effective report must say `activation=qualified-candidate` and
`admission.admitted=true`. The capability report will still say
`production_eligible=false`; that boundary is intentional.

## What happens at runtime

```text
KFD-1 contract + user/workspace override
  -> canonical policyDigest
  -> requested/admission/effective report
  -> CoordinatorEngine passes policy to libkungfu
  -> libkungfu re-derives candidate admission
  -> state-service owns the data-root lease
  -> configured stream owns one writer lease
  -> rule selects visible / durable_group / durable_sync
  -> append
  -> group threshold or immediate sync barrier
  -> native receipt
  -> timeout/unknown: reconcile exact request id and position
```

The state-service status exposes the effective contract hash, policy digest,
default profile, admission reason, segment size, timeout, reconciliation mode,
failure policy, and all group limits. That status is what actually entered the
native runtime; the source JSON alone is not runtime evidence.

### Python execution API

The standard `CoordinatorEngine` creates `engine.durability`. After the
coordinator is set up, open one fenced stream epoch:

```python
stream = engine.durability.open_stream(
    stream_id=7,
    container_epoch=11,
    writer_resource_id="facts-7",
)

result = stream.append(
    b"encoded fact",
    carrier_type=1001,
    sequence=1,
    frame_uid=101,
    source_id=7,
)
```

For `durable_group`, `result.state` may be `pending` and
`result.acknowledged` is false until a threshold fires or `stream.flush()`
returns a successful receipt. For `durable_sync`, append requests the barrier
immediately. `frame_uid` is the default idempotent request id for configured
execution; preserve it together with stream id, epoch, sequence, and profile.

Every policy execution envelope contains `policyIdentity`, `selectedProfile`,
the native receipt/status, and any reconciliation. The envelope may report:

- `visible`: visible acknowledgement only;
- `pending`: no durability acknowledgement yet;
- `succeeded`: a native strong receipt exists;
- `failed`: a terminal rejection exists;
- `unknown`: do not infer success or failure.

The group timer retains `last_async_result` or `last_async_error` for
inspection. It never converts timer failure into success. Call `close()` or
close the coordinator to flush a pending group; use `close(flush=False)` only
when explicitly abandoning unacknowledged work.

Configuration does not relabel or intercept unrelated legacy journal writers.
Only records deliberately sent through `engine.durability` participate in this
KFDL receipt chain. A Profile or application that claims authoritative local
durability must route those facts through this API and retain the returned
receipt or explicit unknown outcome; ordinary `writer.write_*` success remains
a visibility result.

## Timeout, crash, and reconciliation

A timeout before barrier I/O starts can be terminal. A timeout after I/O starts
is potentially `unknown`: storage may have crossed the barrier even though the
caller did not observe completion.

Do not send the same logical request under a new id. Reconcile the original
coordinates:

```python
outcome = stream.reconcile(
    request_id=101,
    sequence=1,
    frame_uid=101,
    requested_profile="durable_sync",
)
```

After process restart, the lower-level `kungfu.durability.reconcile(...)` API
can inspect the checkpoint-covered request index read-only. Absence remains
unknown; it does not prove failure.

## Roll back safely

Return one workspace to visible/off without changing other workspaces:

```sh
kungfu config unset storage.durability.rules --scope workspace --json
kungfu config set storage.durability.defaultProfile visible --scope workspace --json
kungfu config set storage.durability.activation off --scope workspace --json
kungfu config durability --json
```

Restart the affected coordinator so the new policy identity enters the native
runtime. Existing receipts retain their original checkpoint authority; a new
config does not rewrite history.

## Current trust boundary

This config can execute the admitted current-hardware single-host candidate. It
does not provide or claim:

- physical power-loss qualification on the exact production machine;
- independent failure-domain durability;
- HA, replication, or consensus;
- automatic external backup or restore orchestration;
- production eligibility.

See [Durability and crash recovery](../qualification/durability-and-crash-recovery.md),
[Single-host institutional trust](../qualification/single-host-institutional-trust.md),
and [Known limits](../qualification/known-limits.md) before using strong
profiles for production decisions.
