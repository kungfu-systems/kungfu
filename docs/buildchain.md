# Buildchain — from source to binary

How source becomes the binaries you run, and where each binary comes from. This
is a *use* reference; for the day-to-day commands and prerequisites see
[`CONTRIBUTING.md`](../CONTRIBUTING.md), and for why the release pipeline is
shaped the way it is see [`version-release-design.md`](version-release-design.md).

## The two-driver bootstrap

A fresh clone needs only two host tools — `fnm` and `uv` — installed once.
Everything else is pinned and resolved automatically. The orchestrator is
`./kungfu-code` (the development entry point; see [`concepts.md`](concepts.md)):

- **Node side:** `fnm` selects the Node version pinned by `.node-version`, then
  Corepack provides the package manager (`pnpm`) at the version pinned in
  `package.json`.
- **Python side (symmetric):** `uv` manages a standalone CPython plus `uv.lock`,
  and `uv run` drives the Python build tools (Conan, Nuitka).

So the toolchain is reproducible from checked-in pins, not from whatever Node or
Python happens to be on the host. `./kungfu-code <task>` runs any `pnpm` task
under those pinned tools.

## Source → binary

| Output | From | Via |
|---|---|---|
| `libkungfu` (C++ core: longfist + yijinjing) | `framework/core/src` | CMake + Conan 2; build orchestration in `framework/core/.gyp/` |
| Python binding (`py_kungfu`) | `framework/core/src/bindings/python` | pybind11, built under the pinned CPython |
| Node addon (`kungfu_node.node`) | `framework/core/src/bindings/node` | N-API via the `.gyp` build |
| `kungfu` (the frozen runtime) | the above + embedded Python/Node runtimes | `./kungfu-code freeze` |
| app / artifact bundles | the SDK assembling the above | `./kungfu-code build:app`, the `kfs` packaging |

## Where the prebuilt binaries come from

kungfu distributes prebuilt cross-platform binaries rather than expecting users to
compile (see [`version-release-design.md`](version-release-design.md)): the native
artifacts are published via node-pre-gyp (configuration in
[`framework/core/package.json`](../framework/core/package.json)), and the `kungfu` runtime is
shipped frozen. A tag is bound to its binaries atomically — *tag exists ⇒ the
matching binaries exist* — which is the trust property the release mechanism
exists to hold.

## Maturity

The local build path (`./kungfu-code sync && ./kungfu-code build`) is real and is
how the repository builds itself. The **consumer-facing provenance** of a
published binary — how you verify a download's signature and that it matches its
tag — is tracked separately and waits on the release infrastructure being fully
operational on this repository; see [`known-limits.md`](known-limits.md) and the
`provenance` row in [`MAP.md`](MAP.md).
