# Durability Qualification Harness

This directory owns the process-crash evidence tier for ADR-0068. It keeps
durability correctness separate from mmap performance and from later
disposable-volume, VM, or physical-device power-loss evidence.

Every invocation is a dry run unless `--execute` is explicit:

```sh
./shifu durability:qualify -- \
  --profile macos-apfs-process-v1 \
  --durability-profile durable_group
```

After reviewing that plan, a retained local run uses an immutable report path:

```sh
./shifu durability:qualify -- \
  --profile macos-apfs-process-v1 \
  --durability-profile durable_group \
  --filesystem apfs \
  --report /tmp/kungfu-durable-group-macos.json \
  --execute
```

When a dry run includes `--report`, that plan is itself written immutably to
the named path. Use a different, new report path for the later `--execute`
invocation; the harness deliberately refuses to overwrite the dry-run plan.

Use `linux-ext4-process-v1` with `--filesystem ext4` on the Linux
qualification host and `windows-ntfs-process-v1` with `--filesystem ntfs` on
the Windows qualification host. Run `durable_group` and `durable_sync`
separately so each receipt profile has its own report.

The harness executes only local Shifu tasks. It does not dispatch GitHub
workflows or self-hosted runners. It retains each suite's raw output beside the
report and binds the report to the source revision, tree, profile digest,
platform facts, Shifu doctor record, fault matrix, and exact result. The Episode
suite runs the complete `mvp-smoke-v1` accumulation, contention, and semantic
oracle gate; a semantic-only invocation is not accepted as load evidence.

## Claim boundary

A passing v1 report qualifies only its declared process-crash proxy envelope.
The report schema hard-codes both `power_loss_qualified` and
`production_profile_eligible` to `false`. Process termination, deterministic
fault injection, restart, recovery, projection rebuild, Episode oracle, and
backup/restore evidence cannot be promoted into a sudden-power-loss or device
cache claim.

Disposable volume/VM/device evidence, real ENOSPC, performance ceilings, soak,
and production profile activation remain separate later tiers. Their absence
is a passing report's explicit non-claim, not an ignored test.

## Disposable power-cut fixture

`./shifu durability:powercut:fixture` builds a small native worker for the
later VM/device tier. It can stop at every append, data-sync, checkpoint,
directory-sync, and post-receipt boundary, then verify the checkpoint-covered
record chain after a fresh boot. Building or running its non-interrupting
smoke path is not power-loss evidence; only an external disposable-VM
orchestrator may terminate the guest after the worker emits
`KF_POWER_CUT_ARMED`.

The worker fails closed unless both safeguards are present:

- `KUNGFU_DURABILITY_QUALIFICATION=disposable-powercut`;
- a pre-existing data root containing
  `.kungfu-disposable-powercut-fixture` with the exact
  `kungfu.durability.disposable-root/v1` sentinel.

Never place that sentinel in a user journal or production data root. The
fixture does not create, mount, format, terminate, or restart a VM or storage
device; those destructive actions belong to a separately reviewed,
dry-run-first orchestrator and retained machine report.

The Linux device-tier preflight is generated without side effects:

```sh
./shifu durability:powercut:plan -- \
  --run-id 12dd26e899-linux-ext4-v1 \
  --repo /data/worktrees/kungfu/feature/durability-qualification-final \
  --source-revision "$(git rev-parse HEAD)" \
  --image kungfu-linux-build-probe:conanfix-20260630T101847Z \
  --kernel-release 6.8.0-134-generic \
  --kernel-version 6.8.0-134.134
```

Run the command from the exact isolated repository worktree named by `--repo`;
the shell substitution binds the plan to that worktree's full commit. The
result is a `dry-run-only` JSON plan. It refuses arbitrary repository and
workspace roots, names every host mutation, leaves physical hosts and devices
out of scope, and separates the exact armed marker from the direct-child QEMU
termination step. Every profile/fault trial creates a small guest-root qcow2
overlay and a pristine raw ext4 data image, so sequence state and guest writes
cannot leak across trials while qcow2 stays outside the tested durability
device. The plan is evidence for review, not authorization to run the mutating
commands.

The raw data drive uses QEMU `cache=none,aio=native`; write and verification
boots use different root overlays. After the guest emits its exact verification
completion marker it remains alive as PID 1, and the host runner terminates only
that direct QEMU child. This avoids treating a missing guest init-system
`poweroff` helper as durability evidence.

The production-candidate v2 campaign is a separate, stricter local Shifu task:

```sh
./shifu durability:powercut:prepare -- \
  --run-id SOURCE-linux-ext4-fault-v2 \
  --repo /home/dkr/Worktrees/kungfu/feature/agent120-fault-campaign \
  --image kungfu-linux-build-probe:conanfix-20260630T101847Z \
  --kernel-release 6.8.0-134-generic \
  --kernel-version 6.8.0-134.134

./shifu durability:fault-campaign:qemu -- \
  --workspace /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2 \
  --rootfs-base /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/rootfs-base.ext4 \
  --report /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/evidence/fault-campaign-v2.json \
  --raw-results /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/evidence/fault-campaign-v2.results.jsonl \
  --kernel-release 6.8.0-134-generic
```

Before the full matrix, run one explicitly non-qualifying canary against the
same prepared workspace with separate evidence filenames:

```sh
./shifu durability:fault-campaign:qemu -- \
  --workspace /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2 \
  --rootfs-base /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/rootfs-base.ext4 \
  --report /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/evidence/fault-campaign-v2.canary.json \
  --raw-results /data/qualification/kungfu/durability/SOURCE-linux-ext4-fault-v2/evidence/fault-campaign-v2.canary.results.jsonl \
  --kernel-release 6.8.0-134-generic \
  --canary-trial c1-dg-qcow2-writeback-after_data_sync
```

The canary uses `canary-`-prefixed trial artifacts so the subsequent full
matrix remains append-only and collision-free. Its report always has
`complete_required_matrix=false`, `production_profile_eligible=false`, and is
never qualification evidence, even when its verdict is `canary-passed`.

Both commands are dry-run by default. Preparation refuses an existing
workspace and executes only after the exact repository, run id, image, kernel,
commands, impact, and leave-in-place rollback have been reviewed. The campaign
freezes 360 required trials: two durability profiles, ten cut points, raw and
qcow2 data devices, `none`/`writethrough`/`writeback` QEMU cache models, and
three deterministic seeds. Every trial uses a fresh data image and a distinct
verification boot. Each pass or failure is fsynced to append-only JSONL before
the next trial; a failed or interrupted workspace is retained and is never
reused to erase evidence.

These cache values qualify QEMU device-model envelopes only. They do not prove
the physical NVMe cache, controller firmware, sudden host power loss, or a
production profile. A complete passing v2 report must keep
`physical_power_loss_qualified`, `physical_device_cache_qualified`, and
`production_profile_eligible` false.

The separate `./shifu durability:institutional:qemu` harness extends that
disposable Linux/ext4 envelope with a real filesystem-full ENOSPC trial, a
cleanly unmounted write followed by three whole-guest reopen checks, and an
offline block-image backup copied to a sentinel-protected path outside the VM
workspace. It restores that backup onto an absent data-device path, verifies
the image hash, runs read-only `e2fsck`, and boots a fresh root overlay to
verify the durable chain. Execution requires the same explicit QEMU
confirmation plus a second backup-root sentinel and refuses pre-existing
evidence files.

This qualifies only the named disposable guest/device envelope. It does not
restart the physical QEMU host, move the backup off-host, establish an
independent backup failure domain, or activate a production profile; the
machine report records each of those as `false`.

## Agent-120 absolute durability SLO

`./shifu durability:slo` owns the build-tree-local, default-dry-run performance
slice for `candidate/linux-ext4-agent120-slo-v1`. The profile freezes eight
workloads before measurement: latency, batched throughput, rapid rollover, and
15-minute soak runs for both `durable_group` and `durable_sync`. Each run keeps
complete latency histograms plus recovery, projection, backup/restore, CPU,
RSS, fault, I/O, mapped-region, and retained-byte measurements.

```sh
./shifu durability:slo -- --run-id SOURCE-agent120-slo-v1
```

Execution is local to the exact clean agent-120 worktree and requires the
explicit `KUNGFU_DURABILITY_SLO_CONFIRMATION=agent120-slo-v1` safeguard. It
creates only a new run under
`framework/core/build/qualification/durability-slo/`, fsyncs each append-only
raw result, refuses an existing workspace or report, and never dispatches a
GitHub workflow or self-hosted runner. Correctness failure is a knockout; a
latency or throughput miss is retained as a rejected candidate rather than
being hidden by changing the frozen profile.

This is an absolute usability gate for one named Linux/x86_64/NVMe/ext4 host.
It has no comparator, does not qualify the mmap visible path or another host,
and keeps physical-power-loss, off-host-backup, and production eligibility
false.

The first retained execution at source `070e0804b` passed all eight workloads
with zero violations. Its repository evidence index is
[`docs/qualification/evidence/durability/070e0804b/`](../../../../../docs/qualification/evidence/durability/070e0804b/);
the complete 245,668 bytes of report/raw histogram evidence remain in the
named agent-120 workspace under the exact digests recorded there.

## Agent-120 clean host restart

`./shifu durability:host-restart` is a default-dry-run, two-phase protocol for
the frozen `linux-agent120-clean-restart-v1` envelope. `prepare` creates one new
sentinel-protected run under `/data/qualification/kungfu/clean-host-restart`,
exports a durable root, and writes `resume.json` last with file and directory
fsync. The repository command then stops; it has no host-control authority.

After a separately reviewed and authorized clean host restart, `verify`
requires `/proc/sys/kernel/random/boot_id` to differ, binds the same clean
source commit and resume token, and uses a fresh fixture process to verify the
durable frontier, records, closed Episode, projection state/cut, and strictly
newer clean owner generations:

```sh
KUNGFU_CLEAN_RESTART_CONFIRMATION=agent120-clean-restart-v1 \
  ./shifu durability:host-restart -- \
  --run-id SOURCE-agent120-clean-restart-v1 --phase prepare --execute

KUNGFU_CLEAN_RESTART_CONFIRMATION=agent120-clean-restart-v1 \
  ./shifu durability:host-restart -- \
  --run-id SOURCE-agent120-clean-restart-v1 --phase verify --execute
```

The exact host maintenance command is deliberately outside this harness. This
profile qualifies one clean agent-120 Linux/x86_64/ext4/NVMe reboot only. It
keeps physical-power-loss and production eligibility false.

## Current-hardware production-candidate admission

`./shifu durability:admission` is a build-free, read-only verifier over the
retained admission inventory. It checks all six prerequisite delivery SHAs,
PRs, rerun commands, environment/freshness boundaries, tracked artifact bytes,
and claim semantics before accepting
`passed-current-hardware-production-candidate`.

The result is default-off and fail-closed: candidate completion is true while
physical power loss, an independent failure domain, production eligibility,
HA, replication, and consensus remain false. It does not dispatch CI, build
Core, mutate evidence, or activate a runtime profile.

## Files

- `profiles/*.json` freezes the platform/filesystem process profiles.
- `schemas/durability-qualification-profile-v1.schema.json` validates profiles.
- `schemas/durability-qualification-report-v1.schema.json` validates reports.
- `run.mjs` owns dry-run planning, local execution, raw evidence, and verdicts.
- `run.test.mjs` proves fail-closed platform, marker, and claim behavior without
  entering a compiler or build lifecycle.
- `powercut_plan.mjs` freezes the disposable Linux ext4/QEMU write set and fault
  matrix without executing it.
- `fault_campaign.mjs` freezes the v2 multi-seed device/cache matrix and its
  digest without executing it.
- `powercut_guest_init` is the guest-only init entrypoint copied into the
  disposable root image; it cannot create or terminate a host VM.
- `scripts/prepare-durability-powercut-qemu.mjs` owns explicit, fail-closed
  workspace preparation; it never cleans an existing run.
- `scripts/run-durability-fault-campaign.mjs` records every required v2 trial
  before continuing and preserves incomplete or failed workspaces.
- `scripts/run-durability-institutional-qemu.mjs` owns the explicit real
  ENOSPC, whole-guest reopen, and offline backup/restore drill.
- `profiles/linux-ext4-agent120-slo-v1.json` freezes the named host's absolute
  durability SLO and soak workload before its first retained measurement.
- `scripts/run-durability-slo.mjs` owns its project-local dry-run, execution,
  append-only raw evidence, correctness knockout, and aggregate verdict.
- `scripts/check-durability-production-candidate.mjs` verifies the frozen
  admission inventory and derived report without a build or runtime mutation.
