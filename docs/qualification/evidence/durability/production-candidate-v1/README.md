# Single-host production-candidate admission evidence

This directory is the retained, machine-readable admission record for
`single-host-institutional-production-candidate-v1`.

- `admission-inputs.json` freezes the six prerequisite implementation and
  qualification deliveries, exact artifact digests, named environments,
  rerun entrypoints, and fail-closed freshness invalidators.
- `admission-report.json` is the derived verdict consumed by the C++
  capability authority and projected unchanged through Python, Node, and CLI.
- `scripts/check-durability-production-candidate.mjs` verifies every tracked
  artifact and semantic claim before source acceptance can pass.

The verdict means that all work possible on the current agent-120 and Ubuntu
222 hardware has reached a reproducible, default-off engineering candidate.
It does not make that candidate a production profile. Sudden physical power
loss, an independent failure domain, whole-device loss, HA, replication, and
consensus remain false or unsupported, so `production_eligible` remains false.
