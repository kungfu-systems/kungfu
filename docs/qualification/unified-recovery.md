# Unified recovery portable qualification at `61bb5e0b08`

This record binds the portable unified-recovery candidate to source commit
`61bb5e0b08598f500124bd85374171e0b5ba6b1f` and pull request
[#1021](https://github.com/kungfu-systems/kungfu/pull/1021). It records the
manual macOS, Linux, and Windows checks performed on that exact commit before
integration. It is candidate evidence, not a stable-release or three-platform
native-product claim.

## Qualified surface

The common portable surface is:

- the `kungfu.recovery-plan/v1` planner and action classification;
- exact plan identity, confirmation, stale-plan, and manual-blocked behavior;
- the `kungfu recover` CLI plan path, including first-use read-only behavior;
- the shared diagnostics contract and its recovery registry bindings; and
- deterministic Python behavior independent of a platform-native Core build.

The recovery suite uses a bounded `pykungfu` test double and exercises the CLI
through Click's command runner. The diagnostics contract suite checks the
registered schemas, stable status and exit vocabulary, implementation
bindings, test entrypoints, and platform command routes.

## Exact-source result matrix

| Platform | Exact-source checks | Result | Boundary |
| --- | --- | --- | --- |
| macOS arm64 | `./shifu test:health-diagnostics`; `./shifu check:health-diagnostics-contract`; `./shifu docs:check` | health `17 passed`; recovery `8 passed`; native health `2 passed`; selected storage `1 passed`; diagnostics contract `8 passed`; docs `62 passed` | Includes the local native health seam already available in the checkout. |
| Linux, agent-120 | portable recovery suite; diagnostics contract suite | recovery `8 passed`; diagnostics contract `8 passed` | The aggregate native-health leg was not qualified because this disposable worktree had no built `pykungfu`. |
| Windows, DARKHERO | portable recovery suite; diagnostics contract suite | recovery `8 passed`; diagnostics contract `8 passed` | The aggregate native-health leg was not qualified because this disposable worktree had no built `pykungfu`. |

On Linux and Windows, the portable recovery suite is equivalent to:

```sh
uv run --project framework/core --frozen pytest \
  framework/core/tests/python/test_recovery.py -q
```

The contract check uses `./shifu check:health-diagnostics-contract` on POSIX
and `shifu.cmd check:health-diagnostics-contract` on Windows.

## Faults and fences covered by the portable suite

The eight recovery tests prove that, under their deterministic fixtures:

- an empty workspace produces a stable read-only plan;
- unknown authority and unknown projections remain non-executable;
- runtime execution uses the reviewed plan and deep postflight;
- missing Peer confirmation is rejected before a write;
- a stale plan is rejected before runtime activation; and
- CLI planning on first use does not initialize runtime state.

The diagnostics contract suite separately verifies stable registration and
schema bindings. Native runtime, Peer, storage, and Episode authorities still
own their execution-point fences; this portable suite does not replace their
native qualifications.

## Known baseline and non-claims

The wider `./shifu test:episode-control` run reported `43 passed, 1 failed`.
The failure was a pre-existing ordering issue in which a health-preflight
warning appeared before JSON stdout; it was independently reproduced at base
commit `d682779a674ce8000ead9a11c3613473ee278c77`. It is not counted as passing
evidence and was not introduced by unified recovery.

This record does not qualify:

- a full Linux or Windows C++ Core, Node, Electron, WASM, or packaged-product
  build;
- interactive GUI recovery or a graphical recovery wizard;
- multi-host recovery, network partitions, distributed consensus,
  replication, or HA;
- sudden power loss, physical media restoration, or corrupted authoritative
  journal repair; or
- unattended recovery when ownership or writer identity is unknown.

Mac full-product and runtime qualifications remain separate evidence. They
must not be inferred from this portable three-platform record.
