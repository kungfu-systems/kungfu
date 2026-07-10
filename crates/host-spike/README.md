# host-spike — Rust host shell feasibility probe

**Status: throwaway probe.** Excluded from the crates/ workspace, CI, and the
release matrix (`crates/Cargo.toml` `exclude`); it exists to turn one question
into measured facts:

> Can a Rust `main()` own the kungfu process — the role the Nuitka-frozen
> Python entrypoint plays today — and still drive the whole runtime fabric
> (libkungfu core, embedded CPython + pykungfu, embedded libnode)?

## The probe chain

| step | proves | how |
|---|---|---|
| 1 | Rust ↔ libkungfu FFI + runtime core init | one extern "C" shim: locator/location/`io_device` ctor, then a C++ journal write→read roundtrip (noop bus/publisher, the `EMBEDDING.md` shape) |
| 2 | python-build-standalone embeds | link `libpython3.x` from the uv-managed prefix, `Py_Initialize` with `PYTHONHOME` staged |
| 3 | the binding loads | `import pykungfu` with `PYTHONPATH` at the native dir |
| 4 | real runtime, not compile-time | Python-level journal write→read roundtrip through `pykungfu.yijinjing` |
| 5 | node satellite equivalence | `pykungfu.libnode.run(... '-e' ...)` — the same `node::Start` path the product uses — answers and hands control back |

Each step prints `PASS`/`FAIL` with timing; exit 0 means all five passed.

## How to build / run

The probe never compiles the C++ core. It borrows a **sibling fully-built
core** (any worktree where `framework/core` has `build/compile_commands.json`,
`build/Release/{libkungfu.dylib,pykungfu*.so,libnode*.dylib}`, and a synced
`.venv`), and compiles its one C++ shim with that sibling's own compile flags,
so shim and dylib share an ABI vintage.

```sh
cd crates/host-spike
KF_SPIKE_SIBLING_CORE=/path/to/built/worktree/framework/core cargo run
```

Env knobs (all optional):

- `KF_SPIKE_SIBLING_CORE` — built core to borrow (default `../../framework/core`)
- `KF_SPIKE_NATIVE_DIR` — dylib/binding dir (default `<core>/build/Release`)
- `KF_SPIKE_PYTHON_HOME` — python-build-standalone prefix (default: resolved
  from `<core>/.venv/bin/python3`)

Journal output goes to a per-pid directory under the system temp dir.

## Boundaries

- macOS arm64 only (the probe machine); no cross-platform claims.
- The Rust↔libkungfu seam is init + control plane only — the data hot path
  stays inside the existing C++/pykungfu boundaries, per the hard boundaries
  in `docs/rust-adoption.md` (no hot-path FFI; the memory-safety core stays
  C++). A real host shell would go through a reviewed cdylib/FFI case, which
  rust-adoption deliberately keeps non-default.
- Findings and the go/no-go recommendation live in the spike report, not here.
