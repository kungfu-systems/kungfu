---
status: draft
period: 2026-07-10
theme: rust-host-spike
doc_type: analysis
source_level: local-files
confidence: medium
sensitivity: internal
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-10
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-10
  invisible_context: exact model build and hidden reasoning unavailable
---

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
| 1 | Rust ↔ shared libkungfu membrane | fixture-only C++ writer, then the versioned C ABI context/reader/batch lifecycle through a safe Rust wrapper; mmap payload, zero payload copy |
| 2 | python-build-standalone embeds | link `libpython3.x` from the uv-managed prefix, `Py_Initialize` with `PYTHONHOME` staged |
| 3 | the binding loads | `import pykungfu` with `PYTHONPATH` at the native dir |
| 4 | real runtime, not compile-time | Python-level journal write→read roundtrip through `pykungfu.yijinjing` |
| 5 | node satellite equivalence | `pykungfu.libnode.run(... '-e' ...)` — the same `node::Start` path the product uses — answers and hands control back |

Each step prints `PASS`/`FAIL` with timing; exit 0 means all five passed.

## How to build / run

The probe never compiles the C++ core. It borrows a **sibling fully-built
core** (a worktree where `framework/core` has `build/compile_commands.json`,
`build/Release/{libkungfu.dylib,pykungfu*.so,libnode*.dylib}`, and a synced
`.venv`), and compiles its fixture-only C++ writer with that sibling's own
compile flags. The reader/lifecycle seam itself is the core-owned C ABI, not
that helper.

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

- This full five-step host probe remains macOS arm64 only. The shared membrane's
  separate native KFX slice carries the macOS/Linux/Windows build and latency
  matrix.
- Frame iteration stays inside C++; Rust receives a bounded metadata batch and
  borrowed mmap payload slices. There is no per-frame callback or payload copy.
- Findings and the go/no-go recommendation live in the spike report, not here.
