# Agent-120 clean host restart evidence at `17e807700`

This directory retains the exact machine reports from the first bounded
`linux-agent120-clean-restart-v1` execution. The source was clean commit
`17e807700289bb5e26304282bac640ced8ed4979`; execution entered through local
Shifu on `agent-120`, reused its existing Conan cache, and did not dispatch a
GitHub workflow or self-hosted runner.

The run prepared a new sentinel-protected data root on ext4
`/dev/nvme0n1p1`, wrote the resume token last with file and directory fsync,
and recorded kernel boot ID `ed3352b6-7f2c-4438-b649-a5680923bea1`. A
separately authorized clean host reboot took the machine offline. Verification
resumed after 118 seconds with boot ID
`9618c4ac-c6a3-4e54-9104-dc9ad081a66f` and the same source commit.

## Retained reports

| Evidence | SHA-256 |
|---|---|
| `aggregate-report.json` | `7d377977a3bae516624cd1f9d6656e7f2c54b37eb9cef59b77ee68e979c4acb6` |
| `pre-report.json` | `c3360ff114d9ec1aa556316574279edb6128f8955f44adf7e2429ec7eed93459` |
| `resume.json` | `207c24f4ecaccd6b1cb2eabdd18b6e608aa3b13ad162ccbe0a64eaea530f4fc0` |
| `post-report.json` | `9634399abb7e4df8d50fecc08529ccdb62052bb2d3b351383506f80a0a607271` |

The post-restart process recovered durable cut `7201:1:3:720100003`, all three
records, the closed Episode, and projection digest
`3a5b18e5492f519535b419592b73a3c77eeb6102fd0ba8e973901ca7101c7a9f`.
Service and writer ownership generations both advanced from 1 to 3 and were
reacquired cleanly rather than being mislabeled as stale-owner recovery.

This evidence qualifies one clean agent-120 Linux/x86_64/ext4/NVMe host
restart. It does not model an unclean shutdown, sudden physical power loss,
controller-cache persistence, another host, or production activation. The
aggregate report therefore keeps `physical_power_loss_qualified` and
`production_eligible` false.
