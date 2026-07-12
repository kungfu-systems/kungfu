# ADR-0044: The shifu delegation protocol — what installed binaries bake in forever

- Status: accepted
- Date: 2026-07-10
- Category: toolchain / distribution contract (repo-level; recorded here with
  the other load-bearing decisions)
- Subsystem: the shifu launcher (`crates/shifu`, `./shifu`, `shifu.cmd`) and
  every externally installed copy of it
- Related: [ADR-0009](ADR-0009-load-bearing-self-bootstrap.md) (the launcher is
  the outermost load-bearing ring: the path a newcomer walks to *obtain* the
  product); KFD-1 welded-surface register entry `shifu-launcher`
  ([`docs/versioning.md`](../../../../docs/versioning.md));
  [`docs/rust-adoption.md`](../../../../docs/rust-adoption.md) (bootstrap-core
  loop)

## Context

A shifu binary installed outside the repository (e.g. `~/.local/bin` via
`cargo install`) is a **bootstrap core**: it can `clone` the repository and,
inside any checkout, it delegates every invocation to that checkout's own
`./shifu` entrypoint, which resolves the launcher version the checkout pins.
Install once, clone anywhere, stay current by pulling code — the binary never
needs re-installing to pick up new launcher behavior.

That loop has a hard property: **whatever protocol the installed binary uses to
find and hand over to the repo is baked into it forever.** Old binaries in the
wild cannot be updated by changing the repo. The protocol therefore must be
anchored exclusively on things this repository promises never to change, and
on nothing that is free to evolve — not the current L2 implementation, not the
node pin file, not even the assumption that the entrypoint is a shell script.

## Decision

Installed shifu binaries bake in exactly four protocol clauses, and the
repository welds the corresponding surfaces:

1. **Repo-root recognition = the presence of both `shifu` and `shifu.cmd` at
   the root — nothing else.** The two entrypoint files are themselves the
   welded surface, so recognition survives any toolchain evolution, including
   a future that retires node. Both are required as a pair so a stray file
   named `shifu` in an unrelated directory cannot be mistaken for a repo —
   delegation *executes* what it finds.
2. **The entrypoint is spawned directly** (executable bit + shebang on POSIX,
   `cmd.exe` for the `.cmd`), never via an assumed interpreter. The
   implementation form of the entrypoints is *not* part of the protocol: they
   may be rewritten in anything, provided the names stay and they stay
   executable.
3. **`SHIFU_FROM_SHIM=1` and `SHIFU_DELEGATED=1` suppress delegation.** The
   shim sets the first when dispatching a resolved binary; a delegating binary
   injects the second. Either one stops re-delegation, so a single mistake
   (e.g. a future shim forgetting the first) degrades to local execution
   instead of an infinite loop.
4. **Prebuilt release assets live at `shifu-v<version>/shifu-<platform>`**
   (version in lockstep with `lerna.json`), so shims can always fetch the
   version a checkout pins.

## Consequences — read this before touching the entrypoints

- `./shifu` and `shifu.cmd` **must both exist at the repository root, under
  exactly these names, and be executable, forever**. Renaming, removing, or
  splitting either one strands every installed binary in the wild: they stop
  recognizing checkouts (or half of them), and the bootstrap-core loop breaks
  for users who did nothing wrong. There is no repo-side fix once broken —
  old binaries cannot be reached.
- Their **implementation may change freely** (sh → anything, cmd → anything
  launchable by `cmd.exe` under the same name); clause 2 exists precisely so
  this stays cheap.
- The shim contract on dispatch: keep setting `SHIFU_FROM_SHIM=1`; never
  repurpose `SHIFU_FROM_SHIM` / `SHIFU_DELEGATED` for other meanings.
- Release asset naming (clause 4) is append-only: new platforms may be added;
  existing names must keep resolving.
- Changes to any clause are **major-face changes** on the `shifu-launcher`
  welded surface (KFD-1): they require a register decision and must reckon
  with the installed-binary population that cannot be updated.

## Alternatives considered

- *Anchor recognition on `shifu.mjs` + `.node-version`* (the original
  implementation): rejected — both are current-toolchain facts. The L2 node
  implementation is expected to evolve and node itself may one day be retired;
  neither event may break installed binaries.
- *Spawn the entrypoint via `/bin/sh`*: rejected — bakes "the entrypoint is a
  shell script" into old binaries, contradicting clause 2.
- *A dedicated marker file (e.g. `.shifu-root`)*: rejected — introduces a new
  always-existing surface when two already-welded files suffice; one more
  thing to forget.
