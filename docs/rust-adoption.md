---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---

# Rust adoption paradigm

Kungfu treats Rust as a **first-class option**, not a migration target: the
repository pays a small, fixed holding cost (a `crates/` cargo workspace, one CI
gate, one release pipeline) so that any future "should this piece be Rust?"
question costs minutes to decide and about an hour to wire up — in either
direction. The value of an option is that saying **no** stays cheap too.

The first exercised case is the `shifu` launcher (`crates/shifu`),
which also serves as the worked example for everything below.

## Where Rust fits — and where it does not

Rust earns its place here for **self-contained native tools at process
boundaries**: single static binaries with no runtime prerequisites, robust
cross-platform behavior (real path/process/env APIs instead of shell dialects),
and the same DNA as tools the repo already trusts (fnm and uv are Rust single
binaries).

Hard boundaries, decided deliberately and not per-case:

- **The memory-safety core stays C++.** The journal / storage semantics are
  cross-process shared-memory code; safety there is enforced at the
  architecture level (confinement, verification, fuzzing — see
  `docs/facts-before-trust.md`). Sharing mmap across processes is `unsafe` in
  Rust too, so a rewrite would move the risk, not remove it.
- **No hot-path FFI.** Rust's guarantees evaporate at an FFI boundary; a
  language seam inside a latency-critical path buys cost without safety. The
  supported seam is the process boundary.
- **Build logic stays declarative.** Tasks live in pnpm scripts / conan /
  cmake in this repo. Rust components are *invoked by* the build; they do not
  *become* the build.
- **Users never need a Rust toolchain.** rustc exists for maintainers and CI
  only; users consume prebuilt binaries.

## Source layout

All in-repo Rust lives in one cargo workspace:

```text
crates/
  Cargo.toml          # workspace; shared release profile (size-optimized, stripped)
  shifu/              # first member: the launcher (binary)
    Cargo.toml        # per-component version = its release pin
    src/
  shifu-core/         # the shifu role as a library (bootstrap + probe); unpublished
    Cargo.toml        # own version, NOT lerna-synced — no release pin surface
    src/
```

Adding a component = adding a workspace member directory and listing it in
`crates/Cargo.toml`. The `shifu CI` workflow (fmt, clippy `-D warnings`,
tests, release build on the three platforms) picks up every member
automatically via `--workspace`.

Dependency discipline: prefer std-only (the launcher is std-only on purpose —
process orchestration does not need crates, and an empty dependency tree keeps
the supply-chain surface empty). When a component genuinely needs crates,
pin them in the workspace and expect the addition to be reviewed as part of
the component's case for existing.

## Consumption modes

1. **Binary / subprocess (default, turnkey).** The component builds to a
   binary; consumers spawn it as a process. This is the supported, paved road:
   version pinned by the component's `Cargo.toml`, released as prebuilt
   per-platform assets, fetched on demand, cached user-globally under
   `${XDG_CACHE_HOME:-~/.cache}/kungfu/`. The launcher works exactly this way,
   and so should the next tool (a load generator, a data mangler, a fast
   checker...).
2. **cdylib / FFI (documented, deliberately non-default).** Rust can expose a C
   ABI for in-process embedding. Kungfu does not maintain infrastructure for
   this mode: it reintroduces the FFI seam the boundaries above exclude. A
   component that truly needs it must argue its own case and bring its own
   binding/build wiring in review. Argued cases on record: the host trunk —
   [ADR-0046](../framework/core/docs/adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md)
   (accepted; init + control plane only, hot paths never cross the seam) —
   and, proposed, the extension-side surfaces of
   [ADR-0045](../framework/core/docs/adr/ADR-0045-kfx-execution-profiles-native-rust-wasm.md)
   (the `kungfu-kfx` safe wrapper over the core's one versioned C ABI, and
   the bounded `libwasm` component host). Both sides converge on the same
   discipline: libkungfu owns one C embedding membrane and every in-process
   consumer wraps it, rather than each consumer growing a private seam.
3. **Artifact (natural).** Anything produced *by* a Rust tool (reports, data
   files, archives) is consumed like any other artifact; nothing Rust-specific
   applies downstream.

## Distribution

The paved road for mode 1, as implemented for the launcher:

- **Version pin** — the component's `Cargo.toml` `version` is what the shims
  and the release workflow bind to. For the launcher it is kept in lockstep
  with the monorepo version (`lerna.json`) by
  `scripts/sync-shifu-version.mjs`: the root `version` lifecycle rewrites it
  during `lerna version`, and `./shifu check` gates against drift. No separate
  VERSION files.
- **Release** — tag `shifu-v<version>` triggers
  `.github/workflows/release-shifu.yml`: a 3-platform matrix
  (macos-arm64, linux-x64 as a fully static musl build, windows-x64) publishes
  binaries plus `SHA256SUMS` to GitHub Releases.
- **Fetch** — thin shims (`shifu`, `shifu.cmd`) read the pin,
  download the matching asset, cache it, and `exec` it. Mirrors are
  configurable per environment through the user-global `build-local.env`
  (`SHIFU_DIST_MIRROR`, and `KUNGFU_FNM_DIST_MIRROR` /
  `KUNGFU_UV_DIST_MIRROR` for the launcher's own tool bootstrap).
- **Source freshness (dev machines)** — the release pin only moves when a
  release is cut, so on machines with cargo + git the shims content-address
  the cache slot by the last commit touching the launcher source
  (`<version>-<src-sha>`, built out-of-tree so read-only checkouts work) and
  rebuild whenever it moves; a dirty launcher tree rebuilds on every call. A
  checkout therefore always runs its own launcher code, never the last
  release. Machines without cargo keep the release-pinned path untouched.
- **Self-update** — `shifu self-update` refreshes an installed binary in
  place (answered before delegation, so it acts on the copy you invoked).
  Sources, in order: an explicit `--version <v>` fetches that release asset
  (verified against the release's `SHA256SUMS`) — also the road back to the
  official build; inside a checkout it rebuilds from the checkout's current
  source; outside one it takes the newest local build slot the shim produced
  (the binary that drove the last build, surviving its worktree), printing
  that binary's full identity line before the swap. Every replacement first
  archives the outgoing binary under a generations ledger
  (`KUNGFU_SHIFU_GENERATIONS_KEEP`, default 3): `--list` shows it,
  `--rollback` restores the previous generation — reversibly, since the
  current binary is archived in turn. `shifu --version` names each binary's
  build channel (`release` = CI release asset, `source` = any local build),
  so which supply chain you are running is never a guess. The swap is a
  rename dance that restores the old binary on failure; shim-cache slots
  refuse the verb — the shim owns their lifecycle.
- **Fallback** — when no release asset is reachable, the shims build from
  source if cargo is present, then fall back to the legacy in-script path, so
  no machine class is stranded.

A second binary component can copy this pipeline mechanically: new tag prefix,
same workflow shape, same shim pattern (or dispatch through the launcher).

## Selective exercise discipline

The point of holding the option is to exercise it **selectively**. For each
candidate, ask — in order:

1. **Is it at a process boundary?** If it wants to live inside the runtime
   fabric or a hot path, the answer is no (see boundaries above).
2. **Does it need what Rust actually buys here** — a dependency-free static
   binary, cross-platform correctness, or native performance in a standalone
   tool? "The team likes Rust" or "it would also work in Rust" do not count:
   node is the default for I/O-bound multi-language glue that runs where the
   toolchain is already provisioned, and Python via uv for the same reasons.
3. **Is the maintenance surface bounded?** Thin dispatchers and self-contained
   tools change rarely; anything expected to churn with product features
   belongs in the languages the product is built from.

A yes to all three: add the workspace member, reuse the distribution pipeline,
done — that is the whole cost of exercising the option. Any no: keep the
component where it is, at zero cost. Both outcomes are the paradigm working.
Reflexive spread of a fourth language across the codebase is the failure mode
this discipline exists to prevent.

## Worked example: the launcher

> 功夫练不下去的时候，你去找的那个人就是师傅。
> *When your kungfu fails you, the one you turn to is your shifu.*

The name states the role: shifu appears wherever kungfu cannot help itself —
before the toolchain exists, when the environment is broken, when the
repository itself still needs fetching. A self-hosting system (see
[ADR-0009](../framework/core/docs/adr/ADR-0009-load-bearing-self-bootstrap.md))
needs exactly one such fixed point outside its own loop, and that fixed point
must itself be beyond needing help — which is why the launcher's
zero-dependency, std-only, weld-as-little-as-possible discipline
([ADR-0044](../framework/core/docs/adr/ADR-0044-shifu-delegation-protocol.md))
is constitutive, not aesthetic: the helper of last resort cannot afford to
need one.

`crates/shifu` replaces the platform-split entrypoint logic (sh + cmd +
per-platform special-casing) with one binary that:

- discovers the repo root and loads the two-layer `build-local.env`;
- ensures fnm (node side) and uv (python side), and acquires Buildchain only
  when a declared script invokes it, **bootstrapping pinned prebuilt binaries**
  into the user-global cache when absent — a fresh clone needs nothing
  preinstalled beyond curl; the bootstrap versions are pinned by the repo data
  files `.fnm-version` / `.uv-version` / `.buildchain-version` (same shape as
  `.node-version`; env override wins, a compiled fallback covers checkouts
  without the pin files);
- pins Buildchain before PATH via `.buildchain-version`, pins node via
  `.node-version`, and dispatches every task to the
  corepack-pinned pnpm (with a `pnpm -> corepack pnpm` shim so repo scripts
  spawning bare `pnpm` work without `corepack enable`);
- delegates the rich subcommands (`build` / `rebuild` / `cache` / `proxy` /
  `config`) to the node L2 implementation (`shifu.mjs`), keeping cache-contract
  discovery and config management in one place; the cache contract and
  Shifu-specific decision trail start at [`docs/shifu/`](shifu/README.md);
- on Windows, loads the MSVC environment (vswhere → `vcvars64.bat`) when
  `cl.exe` is absent;
- when installed outside the repo (e.g. `cargo install --path crates/shifu
  --root ~/.local`), delegates to the checkout's own `./shifu` entrypoint
  whenever it runs inside one, so the repo-pinned launcher version always
  wins; `shifu --version` reports the crate version, the baked build commit,
  and whether the answering process is the installed or the repo launcher
  (plus the checkout's current branch for the repo role);
- `shifu clone [path]` fetches the repository itself and `shifu doctor`
  checks the development environment (install pointers for the heavyweight
  prerequisites it deliberately does not manage); `shifu promote` installs
  the freshest built dev product from the user-global build stash (successful
  desktop builds register themselves there, so a cleaned worktree cannot
  strand its build) and `shifu builds` lists that stash — the jurisdiction
  siblings of clone: clone acquires the repository, promote acquires the
  product. Together with delegation
  this makes an installed shifu a self-sufficient bootstrap core: install
  once, clone anywhere, and every capability that can evolve lives in the
  repo — the binary never needs re-installing to pick up new launcher
  behavior. The loop is welded to nothing but the entrypoints themselves:
  installed binaries recognize a repo root by the presence of `shifu` and
  `shifu.cmd` (both welded surfaces), spawn the entrypoint directly without
  assuming what it is implemented in, and carry a two-fuse anti-loop guard
  (`SHIFU_FROM_SHIM` / `SHIFU_DELEGATED`) — so the handover survives any
  toolchain evolution, including one that retires node. Protocol authority:
  [ADR-0044](../framework/core/docs/adr/ADR-0044-shifu-delegation-protocol.md).

It scores three yeses: it *is* the process boundary in front of everything
else; it needs to exist before node/python are provisioned, which only a
self-contained binary can do; and it is a thin dispatcher that changes rarely
because build logic stays declarative in the repo.

### The role as a library: shifu-core

The launcher is only the first bearer of the shifu role — the product's Rust
trunk is the queued second
([ADR-0046](../framework/core/docs/adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md):
stage 1 shares the bootstrap leg for its lazy pinned-uv fetch, stage 3
consumes the rest). So the parts of the role every bearer needs live in
`crates/shifu-core`, an unpublished workspace library, and each new appearance
of the role adds a probe or a tool spec instead of re-implementing downloads
and checklists. Two legs, one discipline each:

- **bootstrap** — acquire pinned tools. `FetchSpec`/`fetch` is the engine
  (exact version + URL, optional pinned SHA-256 verified before the cache is
  touched, user-global cache placement); `Tool` is the launcher-flavored front
  end (repo pin files, env overrides, mirror envs, release asset naming).
  Buildchain is pin-first because it is a reproducible build input; fnm and uv
  retain PATH-first compatibility with user-managed installations. A
  failed fetch is a named error carrying the exact URL, the expected checksum,
  and the mirror override to set — self-diagnosing by construction.
- **probe** — declarative environment checks (`label / probe / required /
  hint / repair_cmd`), findings rendered by a shared reporter. Reports, never
  repairs: a probe that knows the exact fix names it in `repair_cmd`, printed
  next to the failure; executing it stays a human decision. The dev doctor is
  the first consumer, including the seed probes with which the bootstrap leg
  diagnoses itself (cache health, mirror reachability, pin-vs-cache bite).

Distribution-wise the library is deliberately invisible: never published,
never tagged, no shim, version not lerna-synced — the launcher's release pin
surface stays exactly one crate wide.

### KFD-declared build registration

`shifu builds` / `shifu promote` consume a user-global build stash, and the
stash is fed by declaration, not by script. A repo that wants its builds
registered states the facts in its Buildchain-managed KFD-3 surface registry
(`.buildchain/kfd/kfd-3/surfaces.json`), on the surface that produces the
artifact:

```json
"distribution": {
  "registrar": "shifu",
  "tasks": ["dist", "package"],
  "artifacts": [
    { "kind": "app", "platform": "macos", "pathGlob": "product/dist/desktop/mac*/*.app" },
    { "kind": "installer", "platform": "windows", "pathGlob": "product/dist/desktop/*.exe" },
    { "kind": "appimage", "platform": "linux", "pathGlob": "product/dist/desktop/*.AppImage" }
  ]
}
```

When a task named in a declaration succeeds under the launcher, shifu reads
the declaration back (`crates/shifu/src/registrar.rs`), resolves the host
platform's artifact, verifies it (a pinned `sha256` must match; for dev
builds, whose content is only known after the build, the computed hash of a
file artifact is recorded for provenance), and stashes it in the registry
that `builds` / `promote` already read. Registration is advisory: a build
that succeeded is never failed by its own bookkeeping — every problem is a
named warning and the task's exit code passes through.

The division of labor is deliberate. Build logic stays declarative in the
repo; what the launcher carries is the one thing repo scripts cannot do for
themselves: outlive the build. Worktrees are temporary, so the stash is
user-global and the registrar runs in the process that survives the task —
which is also why onboarding a new repo costs zero scripts: declare the
artifacts in the KFD registry and the installed launcher does the rest. The
KFD registry was already the repo's fact ledger; letting the recorded facts
drive distribution is the same load-bearing member carrying one more load.
