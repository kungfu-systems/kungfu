# Agent-120 Linux/ext4 durability candidate evidence at `791e09a70`

This directory retains the bounded machine evidence produced locally on
`agent-120` for the production-candidate fault campaign. The full QEMU matrix
ran against source revision
`791e09a70780997347347bc4a7dae503c46cba11` and tree
`baf9c05a2af4deefc501475165e0b11d44b0f47d`. A qualification-only marker fix
then advanced the harness to revision
`8fef5ad233ccb50c6fae7bb8ee167294f47a35db` and tree
`5ee4fb3d0b6d7923c04bceb04c1639b3f6cdb9ca`; the two process reports and the
institutional drill are bound to that later clean source.

All execution entered through repository-local Shifu commands with an empty
temporary `XDG_CONFIG_HOME`. The same `build:core` command reused exact
binaries from the host's existing Conan cache without changing persistent
controller configuration. No GitHub workflow or self-hosted runner produced
this evidence.

## Retained reports

| Evidence | Result | Retained file | SHA-256 |
|---|---:|---|---|
| Non-qualifying canary | 1/1 passed | `evidence/fault-campaign-v2.canary.json` | `a85025b29e130574a5ac483169d0344f6c5782f02e6f331f60237a7bb058c2f5` |
| Required QEMU matrix | 360/360 passed | `evidence/fault-campaign-v2.json` | `0ae769d3befabf3b382f5f116d638d68addafaedb6c263d7171369ff5bda0256` |
| QEMU raw JSONL | 360 immutable rows | `evidence/fault-campaign-v2.results.jsonl` | `018baa1d9cdf78392c9b79114fd2492dd3455ec0281241b68bfbdfa8e0e3ef4a` |
| Linux/ext4 `durable_group` process envelope | passed | `evidence/linux-ext4-process-durable_group-8fef5ad23.json` | `c3e46857748db7f8943b7cedc57fd978d446245938a065ed012cbcdaf6c3e8d1` |
| Linux/ext4 `durable_sync` process envelope | passed | `evidence/linux-ext4-process-durable_sync-8fef5ad23.json` | `af097d2acbff86d8d787c96d5a455b86e5d29b65de6819945f2444faacf11998` |
| Single-host institutional QEMU drill | passed | `evidence/single-host-institutional-qemu-8fef5ad23.json` | `088a7148c539cab3af0a7e698cd6c8146cfb248c79e8debe095f69a415927620` |

The QEMU matrix crosses two durability profiles, ten cut points, raw and
qcow2 data images, `none`/`writethrough`/`writeback` cache models, and three
deterministic seeds. Every trial used a fresh data image and a separate
verification boot. The raw JSONL was fsynced after every pass or failure; its
digest is also recorded inside the aggregate report.

The process reports retain all adjacent raw suite logs and cover durable
ingest, projection bootstrap, crash recovery, and the complete Episode
`mvp-smoke-v1` load/oracle. The first execution correctly failed closed when
the qualification harness expected an obsolete projection marker. The
retained passing reports were produced only after the marker contract and its
test were aligned with the already-passing projection suite.

The institutional report records serial-log paths and SHA-256 digests for a
clean durable write, three whole-guest recovery boots, an offline
backup/restore boot, real ENOSPC, and the ENOSPC reopen. Those terminal logs
remain in the sentinel-protected workspace because their raw control bytes and
CRLF output are not normalized into Git. The backup and restored image shared SHA-256
`c25abf250a937fed00b66ec2f93153afa7baa40339f9dc4dfa5a67b3f52dc82a`;
read-only `e2fsck` passed before backup and after restore. ENOSPC produced no
durable watermark and reopened at durable sequence zero.

The 4.5 GiB sentinel-protected disposable workspace, its fresh trial images,
institutional serial logs, and individual matrix serial logs remain on `agent-120` under
`/data/qualification/kungfu/durability/791e09a70-linux-ext4-fault-v2` for
local forensic review. They are not required to validate the retained
aggregate/raw pair and are intentionally not copied into Git.

## Claim boundary

This evidence qualifies only the named process-crash and disposable QEMU
device-model envelopes. It proves neither the physical NVMe/controller cache
nor sudden physical-host power loss. The institutional backup is on a separate
path on the same host, not off-host and not an independent failure domain.
Every report therefore keeps the applicable physical-host, physical-device,
off-host, independent-failure-domain, and production eligibility claims
`false`.

This evidence does not activate a production profile and does not qualify HA,
replication, consensus, automatic failover, malicious-administrator
resistance, or cross-host ordering.
