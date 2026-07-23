# Buildchain — from source to binary

How source becomes the binaries you run, and where each binary comes from. This
is a *use* reference; for the day-to-day commands and prerequisites see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md), and for why the release pipeline is
shaped the way it is see [`version-release-design.md`](version-release-design.md).

## Pinned bootstrap drivers

A fresh clone needs only `curl`. The orchestrator is `./shifu` (the development
entry point; see [`concepts.md`](../concepts/implementation-concepts.md)); it acquires pinned drivers into
the user-global Kungfu cache when needed:

- **Node side:** `fnm` selects the Node version pinned by `.node-version`, then
  Corepack provides the package manager (`pnpm`) at the version pinned in
  `package.json`.
- **Python side (symmetric):** `uv` manages a standalone CPython plus `uv.lock`,
  and `uv run` drives the Python build tools (Conan, Nuitka).
- **Build protocol:** Buildchain is selected by `.buildchain-version`, resolved
  pin-first from its standalone three-platform release archives, and added to
  child `PATH` when a declared package script invokes the bare `buildchain`
  command. `buildchain layout --json` is the stable KFD registry question;
  Shifu does not duplicate Buildchain's internal layout.

So the toolchain is reproducible from checked-in pins, not from whatever Node,
Python, or Buildchain happens to be on the host. `./shifu <task>` runs any `pnpm` task
under those pinned tools.

## Source → binary

| Output | From | Via |
|---|---|---|
| `libkungfu` (C++ core: yijinjing schema + journal) | `framework/core/src` | CMake + Conan 2; build orchestration in `framework/core/.gyp/` |
| Python binding (`py_kungfu`) | `framework/core/src/bindings/python` | pybind11, built under the pinned CPython |
| Node addon (`kungfu_node.node`) | `framework/core/src/bindings/node` | N-API via the `.gyp` build |
| `kungfu` (the product runtime) | the above + the Python/Node runtimes | `./shifu freeze` — assembles the complete pinned CPython tree next to the entry on every platform (ADR-0046 stage 2; the Nuitka/PyInstaller freeze legs were retired 2026-07-11) |
| distributable products | product runtime + GUI/TUI/CLI + all product-declared first-party kfx | `./shifu dist` |
| product loops | SDK-distributed GUI/TUI/CLI dev/build verbs | single kfx: `kungfu sdk product gui dev`; product assembly: `kungfu sdk product gui dist`; repo dogfood via `./shifu product ...` |

## Freeze retirement ledger (fully retired 2026-07-11)

ADR-0046 stage 2 retired freezing platform by platform, and Windows — the last
frozen platform — exited on 2026-07-11. The freeze **distribution** chain is now
gone; only the `assemble` leg ships. What was removed, and what stays and why:

| Leg | Status | Note |
|---|---|---|
| `run-freeze.js` nuitka leg + the `nuitka-project` header shim `src/python/kungfu_cli.py` (the `nofollow-import` list) | **retired 2026-07-11** — leg and shim deleted | Windows was the last frozen platform; `assemble` is the sole leg |
| `run-freeze.js` pyinstaller fallback leg + `src/python/kungfu.spec` + `src/python/pyi-hooks/` | **retired 2026-07-11** — leg, spec, and hooks deleted | retired together with the nuitka leg |
| `conanfile.py` legacy freeze path (its `freezer` option + `__run_freeze`/`__run_nuitka`/`__run_pyinstaller` + PyInstaller import) | **retired 2026-07-11** — dead code removed | freeze had left conan in the conan2 migration; the option was no longer passed by the build chain |
| `engage nuitka` / `engage pdm` bridges | **kept, deliberately** — their consumer is the Python-AOT kfx build contract (`kungfu sdk kfx build` for py extensions), not the freeze chain; retirement follows the ADR-0045 execution-profile line, not this ledger |
| Nuitka / PyInstaller pins in dev deps | **pyinstaller pin retired 2026-07-11**; **nuitka pin kept** — now resolved only by the `engage nuitka` bridge (ADR-0045), no longer by any freeze leg |

The assembled form's own policy record is
[ADR-0050](../adr/ADR-0050-assembled-runtime-stdlib-pruning-policy.md)
(stdlib pruning); the target architecture is
[ADR-0046](../adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md).

## Where the prebuilt binaries come from

kungfu distributes prebuilt cross-platform binaries rather than expecting users to
compile (see [`version-release-design.md`](version-release-design.md)): the native
artifacts are published via node-pre-gyp (configuration in
[`framework/core/package.json`](../../framework/core/package.json)), and the `kungfu` runtime is
shipped as an assembled complete CPython tree (ADR-0046 stage 2). A tag is bound
to its binaries atomically — *tag exists ⇒ the
matching binaries exist* — which is the trust property the release mechanism
exists to hold.

## CI source checkout cache

The release-candidate build uses Buildchain's locked source checkout cache in
`auto` mode. Self-hosted runners first try the trusted local/LAN Git object cache
declared by repository or organization variables, then fall back to GitHub if the
cache is unavailable:

- `BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE`
- `BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE`

These values are intentionally not checked into this repository. They describe
private runner or local-network topology. Buildchain still resolves and verifies
the immutable source commit and tree before running lifecycle commands, and it
writes sanitized `source-checkout.json` diagnostics into the platform artifacts.

## Maturity

The local build path (`./shifu sync && ./shifu build`) is real and is
how the repository builds itself. The **consumer-facing provenance** of a
published binary — how you verify a download's signature and that it matches its
tag — is tracked separately and waits on the release infrastructure being fully
operational on this repository; see [`known-limits.md`](../qualification/known-limits.md) and the
`provenance` row in [`MAP.md`](../MAP.md).

## Continuity claim binding

Buildchain does not decide whether a continuity benchmark is meaningful or
whether its result supports stronger copy. Kungfu qualification owns the
one-minute smoke, matched long-task comparison, public projection, and their
verdicts. Buildchain's release responsibility is narrower: when comparative
continuity copy is published, the Release Passport binds the exact release
artifact and copy to the fixture, runner and latest-native-baseline identities,
reset method, oracle, raw report, projection, limitations, and independent
review.

A smoke cannot be promoted into `FO10` evidence, and an animation without its
retained report is non-qualifying. An ordinary patch with no comparative claim
does not rerun the full comparison merely for Buildchain admission. See the
[release and promotion gate](../qualification/gates/release-and-promotion.md#continuity-claim-evidence-boundary)
and the machine contract at
`framework/agent-work/kungfu-agent-work-state.contract.json`.
