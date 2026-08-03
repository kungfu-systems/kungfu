# Shifu Agent Brief

Shifu is Kungfu's product-owned, one-stop development and recovery launcher.
It hides pinned-toolchain plumbing from the user while keeping every operation
discoverable and explicit.

Start with `shifu agent capabilities --json`, then choose the smallest route:

- source planning: `shifu source plan ...` (read-only, exact commit and tree)
- source acquisition: repeat the exact plan as `shifu source acquire ... --execute`
- source verification: `shifu source verify ...` (read-only and fail-closed)
- diagnose/bootstrap: `shifu doctor`
- pinned uv/fnm/pnpm environment: ordinary `shifu <task>` dispatch
- dependencies/build: `shifu sync`, `shifu build`, `shifu build:core`
- checks/verification: `shifu check`, `shifu verify`, registered gate commands
- artifacts: `shifu artifacts <verb>` and local build catalog
- promotion/recovery: `shifu promote`, `shifu promote --rollback`, `shifu builds`

Read-only discovery and source planning grant no mutation authority. Source
acquisition, build, cache/config, promotion, and recovery retain their own
command contracts and diagnostics. A qualified acquisition never executes,
builds, edits, or cleans repository code; use the checkout's `./shifu` next.
A successful build is not a promotion, release, or Work completion receipt.
Kungfu composes this interface as `kungfu shifu agent ...` but does not own or
duplicate Shifu authority.
