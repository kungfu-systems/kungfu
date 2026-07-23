# Check Kungfu health

`kungfu health` gives a user-level answer before you start or resume work. It
projects the existing runtime, Peer, storage, and Episode facts into one report;
it does not create a second authority for any of them.

Start with the bounded check:

```sh
kungfu health
kungfu health --json
```

Use the complete read-only check when the fast result asks for more evidence:

```sh
kungfu health --deep
kungfu health --deep --json
```

Fast mode reads runtime status, declared Peer status, storage metadata, and at
most 100 recent Episodes. It never runs storage `fsck`. Deep mode additionally
runs the existing read-only storage integrity scan and evaluates every open
Episode through the fenced recovery planner.

## Result states and exit codes

| Status | Exit | Meaning |
| --- | ---: | --- |
| `ready` | 0 | The checked facts are consistent. An inactive daemonless workspace is normal. |
| `degraded` | 1 | Work may continue, but an optional or recent condition deserves attention. |
| `action-required` | 2 | A user decision or reviewed plan is required before the affected operation. |
| `blocked` | 3 | Kungfu cannot prove the affected state is safe. Preserve it and inspect the evidence. |

The JSON shape is `kungfu.health-report/v1`. Every problem is a
`kungfu.diagnostic.problem/v1` with both a stable diagnostic `code` and the
underlying `sourceCode`, a user-facing explanation, retryability, action
requirement, technical detail, subject coordinates, and zero or more
non-destructive suggested commands.

Inspect the exact contract with either command:

```sh
kungfu health --contract --json
kungfu contract show diagnostics --json
```

## What health never does

Health is observational. Both modes refuse to:

- start, stop, restart, or signal a process;
- repair a runtime route;
- rebuild or apply a storage projection;
- append an Episode terminal record;
- treat unknown process, writer, or I/O outcomes as safe.

Suggested recovery commands stop at status, inspection, `fsck`, or a dry-run
plan. A command that can write still requires a separate explicit authorization.

## Common results

- A first-use workspace with no runtime directory is `ready`; health does not
  create the directory just to inspect it.
- A stopped supervisor or coordinator is not itself a fault. Storage-only work
  remains daemonless, and ordinary live-required work can activate the runtime.
- A running PID whose process-start identity does not match is `blocked`.
  Kungfu never controls it by PID alone.
- A declared Peer that intentionally stopped is healthy. A crash loop, lost
  control, orphan, or unknown ownership reports the declared Peer identity and
  the read-only status command to run next.
- An open Episode with a live writer is normal. A recent writer-less Episode is
  degraded; a stale, proven-inactive Episode becomes action-required and points
  first to `kungfu recover`. The lower-level
  `storage episode recover --plan` command remains an advanced authority
  inspection surface. Unknown writer liveness is blocked.
- Deep storage findings distinguish rebuildable projection drift from failures
  in authoritative journals, manifests, payloads, or source heads.

The decision and failure semantics are frozen in
[ADR-0107](../adr/ADR-0107-unified-read-only-product-diagnostics.md). When health
reports action-required or blocked findings, use the separate plan-first
[`kungfu recover`](recovery.md) entry; health itself remains read-only.

## Automatic command preflight

High-value write and activation commands run only the fast diagnostic areas
they depend on. A ready preflight prints nothing. A degraded or
action-required result follows the profile policy and writes one actionable
warning to stderr; a blocking result stops the affected command with the same
problem vocabulary and exit severity as `kungfu health`.

| Profile | Checked areas | Initial command paths | Policy |
| --- | --- | --- | --- |
| `runtime-activation` | runtime | runtime ensure/start/restart | warn unless process identity is unverified |
| `peer-activation` | runtime, Peer | Peer start/ensure | warn on recoverable state; block unknown ownership or another blocked fence |
| `episode-write` | storage | Episode begin/heartbeat/attach/end/abort | block storage states that require action |
| `episode-recovery` | storage, Episode | Episode recovery plan/execute | warn and let the recovery planner or execution fence make the authoritative decision |

Profiles declare `freshness: command`, `cacheAllowed: false`, their checked
areas, and the handling of every health status in the diagnostics contract.
They never invoke deep mode or storage `fsck`. This means an unrelated area
cannot block a command and help, version, status, contract, and explicit health
inspection do not pay an automatic full-health scan.

Preflight is not authorization. Runtime activation, Peer hosting, storage, and
Episode writes still revalidate their existing generation, ownership, or writer
fence at the execution point. A state change after a ready preflight can still
reject the command safely.

Run the portable incremental-latency qualification on a development checkout:

```sh
./shifu test:health-preflight-performance
```

It reports raw cold and warm samples for empty and initialized workspaces, plus
four concurrent shell workers. The budget is cold p95 <= 250 ms and warm p95
<= 100 ms for `collect_preflight` plus contract validation; Python/CLI process
startup is reported as outside that incremental surface. The first Mac
qualification on 2026-07-17 observed maximum cold p95 of 8.82 ms and warm p95
of 4.72 ms across the single- and concurrent-worker scenarios, so no fact cache
or single-flight mechanism was introduced.
