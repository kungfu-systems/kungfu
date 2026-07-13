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

## Files

- `profiles/*.json` freezes the platform/filesystem process profiles.
- `schemas/durability-qualification-profile-v1.schema.json` validates profiles.
- `schemas/durability-qualification-report-v1.schema.json` validates reports.
- `run.mjs` owns dry-run planning, local execution, raw evidence, and verdicts.
- `run.test.mjs` proves fail-closed platform, marker, and claim behavior without
  entering a compiler or build lifecycle.
