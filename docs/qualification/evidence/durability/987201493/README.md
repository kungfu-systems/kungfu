# Agent-120 to Ubuntu 222 off-host restore evidence at `987201493`

This directory retains the exact machine reports from the first bounded
`linux-agent120-ubuntu222-offhost-v1` execution. The source was clean commit
`987201493c4ca7f806d08ca45473172a7f219077`; execution entered through local
Shifu on `agent-120`, reused its existing Conan cache, and did not dispatch a
GitHub workflow or self-hosted runner.

The source was `agent-120` on ext4 `/dev/nvme0n1p1`. The target was the existing
host `Kerens-MoreFine` at the sentinel-protected disposable root
`/data/qualification/kungfu/offhost-backup-restore`. The 16,780,850-byte
transport package bound durable cut `7201:1:3:720100003`, three records, one
closed Episode, five authoritative files, every file digest, and a projection
that rebuilt to integrity digest
`3a5b18e5492f519535b419592b73a3c77eeb6102fd0ba8e973901ca7101c7a9f`.

## Retained reports

| Evidence | SHA-256 |
|---|---|
| `aggregate-report.json` | `4034b2653c1acd5f1b1608d7e68c3328f91fa501c04f180252c4f22e232bc574` |
| `source-report.json` | `0506f956cfac122bb28a10c196a94c94cb994d9838c94b53b60b47d085f8d93e` |
| `verify-report.json` | `b2f9cc3580821554f8735ee718ce4fffa6cc1dc42589428a2c274f6398fec274` |
| `restore-report.json` | `476e78aec85d3c1a8180cb69495dd9926fb37097b85faf7a90c6ded4301576db` |
| `manifest.json` | `049aa86a0d63be989c54261ec2b246dada8d97fd10751e45232ebc56c6e9d42e` |
| `complete.json` | `a08ca3e356c4e1ee650d1337663fcb11c7944fbfa408a12b439d2bb8186b957b` |

The harness first transferred only the manifest and verified that restore
failed closed because the completion marker and data files were absent. It
retained that partial directory, then transferred the complete package into a
new incoming directory, verified it, atomically published it, restored an empty
root, checked the durable frontier, record and payload digests, Episode fsck,
and projection state, and repeated restore to prove idempotence.

This is real off-host transfer and restore evidence, but both machines are in
the same office. It does not establish independent power, network, site, or
administrator failure domains; it does not test physical power loss and does
not activate a production profile. The report therefore keeps
`independent_failure_domain_qualified`, `physical_power_loss_qualified`, and
`production_eligible` false.
