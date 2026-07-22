# Agent-120 durability SLO candidate evidence at `070e0804b`

This directory retains the repository-side evidence index for the first frozen
`linux-ext4-agent120-slo-v1` execution. The exact source commit was
`070e0804b5e1e6096b3dca1c6380b0581743ae83`; the host reported `agent-120`,
Linux/x86_64, ext4 on `/dev/nvme0n1p1`, 32 logical CPUs, and 64 GiB of memory.

All eight required workloads passed their pre-measurement absolute thresholds
with zero correctness violations. The two 15-minute soaks retained 449,984
`durable_group` records and 224,992 `durable_sync` records. Their end-to-end
rates were 492.95 and 247.17 records/s; receipt p99.9 was 73.4 ms and 109.1 ms.
The largest observed RSS was 1,002,196 KiB and the slowest verified reopen was
6.18 seconds.

The checked-in JSON is a derived, reviewable summary. Complete histogram
buckets and the aggregate machine report remain on agent-120 at the immutable
run workspace named in that index. Their exact SHA-256 digests and byte sizes
are retained so a later transfer or audit fails closed on drift. This follows
the earlier device campaign convention: large raw artifacts remain on the
named qualification host while the repository retains their bounded index and
cryptographic identity.

This evidence establishes only an absolute candidate SLO on the named current
hardware. It does not qualify another host, the mmap visible path, physical
power loss, off-host backup, a comparator, or production admission.
