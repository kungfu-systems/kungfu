# Vendored dependencies

Header-only third-party sources vendored into the repository and tracked by
git. The build consumes them from this tree (see `conanfile.py`, which exports
`.deps/*`); nothing downloads or overwrites them. Vendoring exists so we can
carry small, deliberate local modifications when correctness demands it —
every such divergence from upstream MUST be registered here.

Reading this file tells you everything this tree differs from upstream in.
If a directory has no entry in the register below, it carries no known local
modifications. When you upgrade a vendored dependency, walk its register
entries: re-apply, re-verify, or retire each one explicitly — never drop a
delta silently.

`vs/` is a build-tool area (Windows toolchain), not a vendored library.

## Local modification register

### sqlite_orm-1.7.1

| Field | Value |
| --- | --- |
| Modification | `on_open_internal` invokes the user `on_open` hook FIRST, before pragma replay (upstream calls it last). Single hunk in `include/sqlite_orm/sqlite_orm.h`, marked with an explanatory comment. |
| Why | sqlite_orm reopens connections per operation and replays stored pragmas (e.g. `journal_mode`) on every fresh connection — before the user hook could arm `sqlite3_busy_timeout`. Under cross-process write contention the unprotected replay raised SQLITE_BUSY as a C++ exception that escaped cleanup paths and terminated whole processes (node apps and the master alike). With the hook first, `kungfu/yijinjing/cache/backend.h` arms every fresh connection before its first statement, and contention becomes an in-library wait. |
| Introduced | `fix(core): arm every sqlite connection against cross-process contention` (2026-07, PR #156) — the commit message carries the full investigation. |
| Verify after upgrade | Run the concurrency regression: three writer processes hammering one runtime home against a live master must all exit cleanly with zero terminations and no new crash reports (node or python side). The scenario is documented in the PR; any SQLITE_BUSY process death reproduces within seconds. |
| Upstream status | Not yet proposed. Later upstream releases rework connection handling — when upgrading past 1.7.1, check whether the hook ordering (or an equivalent per-connection configuration point) exists upstream and retire this delta if so. |
