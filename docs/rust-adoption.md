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
  shifu/        # first member: the launcher
    Cargo.toml        # per-component version = its release pin
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
   binding/build wiring in review.
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

`crates/shifu` replaces the platform-split entrypoint logic (sh + cmd +
per-platform special-casing) with one binary that:

- discovers the repo root and loads the two-layer `build-local.env`;
- ensures fnm (node side) and uv (python side), **bootstrapping pinned
  prebuilt binaries** into the user-global cache when absent — a fresh clone
  needs nothing preinstalled beyond curl; the bootstrap versions are pinned by
  the repo data files `.fnm-version` / `.uv-version` (same shape as
  `.node-version`; env override wins, a compiled fallback covers checkouts
  without the pin files);
- pins node via `.node-version` and dispatches every task to the
  corepack-pinned pnpm (with a `pnpm -> corepack pnpm` shim so repo scripts
  spawning bare `pnpm` work without `corepack enable`);
- delegates the rich subcommands (`build` / `rebuild` / `proxy` / `config`) to
  the node L2 implementation (`shifu.mjs`), keeping config management in
  one place;
- on Windows, loads the MSVC environment (vswhere → `vcvars64.bat`) when
  `cl.exe` is absent;
- when installed outside the repo (e.g. `cargo install --path crates/shifu
  --root ~/.local`), delegates to the checkout's own `./shifu` entrypoint
  whenever it runs inside one, so the repo-pinned launcher version always
  wins; `shifu --version` reports the crate version, the baked build commit,
  and whether the answering process is the installed or the repo launcher.

It scores three yeses: it *is* the process boundary in front of everything
else; it needs to exist before node/python are provisioned, which only a
self-contained binary can do; and it is a thin dispatcher that changes rarely
because build logic stays declarative in the repo.
