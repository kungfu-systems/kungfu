---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: analysis
review_state: unreviewed
sensitivity: public
sources: [local-files]
period: 2026-07-10
theme: rust-host-spike
confidence: medium
evidence_grade: B
last_reviewed: 2026-07-10
---

# Rust host shell — feasibility spike report

Status: spike complete; measured facts and a staged recommendation. The
probe code lives in `crates/host-spike` (workspace-excluded, never in CI or
the release matrix). This report is the deliverable; the probe is its
evidence. **Decided 2026-07-10**: the option was exercised — the target
architecture (Rust host trunk, layered CLI, assembled runtime) and its staged
adoption path are recorded in
[ADR-0046](../framework/core/docs/adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md).

## The question

Today the process topology is asymmetric: the runtime binary `kungfu` is a
Nuitka-frozen Python entrypoint that owns `main()`, embeds libnode as a
satellite, and loads pykungfu/libkungfu in-process. The examined alternative
is a thin Rust host shell that owns `main()` — linking libkungfu directly,
embedding CPython (python-build-standalone, the same distribution uv already
pins for the build) and libnode as symmetric satellites — which would retire
Nuitka from the distribution chain entirely.

Two sub-questions, answered in order:

1. Is Nuitka painful enough to justify replacing? (If not, symmetry alone is
   not a reason — see `docs/rust-adoption.md`, "the team likes Rust" does not
   count.)
2. Does the replacement chain actually work? (Measured, not argued.)

## Part 1 — What Nuitka actually costs (measured 2026-07-10, macOS arm64)

### What is NOT painful

| metric | measured | verdict |
|---|---|---|
| freeze wall time, cold cache | 67 s | not a bottleneck |
| freeze wall time, warm cache | 23 s | not a bottleneck |
| frozen CLI attributable size | 23.4 M binary + 16.6 M libpython | *smaller* than assembly |
| assembled CPython for comparison | 73 M (full python-build-standalone prefix) | assembly is the bigger ship |
| startup, frozen `kungfu --help` | 0.19 s | parity |
| startup, unfrozen `python -m kungfu --help` | 0.21 s warm | parity |

Context: dist/kungfu totals 328 M, of which 304 M are native artifacts
(libnode 105 M, kungfu_node 80 M, libkungfu 48 M, kungfu_electron 43 M,
pykungfu 11.5 M) that ship identically under any packaging scheme. Since the
scientific stack left the frozen runtime, freeze is a light step; the C++ core
build dwarfs it. The standing assumption that freeze is the heaviest, most
opaque link in the build chain **does not survive measurement**.

### What IS painful

1. **Incident rate.** In roughly three weeks of the v4 line, 10+ fixes were
   Nuitka-attributable, all discovered at runtime rather than build time:
   segfault dependent on which CPython flavor built the venv (fixed by pinning
   uv-managed CPython), gcc 13 internal compiler error on generated C (fixed
   by forcing clang on Linux), certifi/stdlib bundling stalls, mypyc-compiled
   packages rejected mid-freeze, Windows layout mismatches (pyd/libnode.dll
   not followed → post-freeze copy shims, PDB shipping, stubgen colocation),
   and a ~235 M scientific-stack inclusion that took a manual import audit to
   retire.
2. **Hand-maintained fragility surface.** `kungfu_cli.py` carries 30+ lines of
   `nofollow-import-to` exclusions plus per-file `--include-data-files`
   registrations (.bfbs schemas, agent pack). Every new Python dependency can
   trip a new exclusion; a miss either bloats the binary silently or fails at
   runtime in the field.
3. **Dev/prod divergence.** Development runs bare CPython, releases run the
   frozen binary; a class of bugs only reproduces frozen. `verify --full` had
   to adopt freeze-before-dogfood, paying the freeze on every full gate.

Structurally (not an operational pain): the frozen binary owning `main()` is
what forces Python to stay the host and excludes any other host topology.

## Part 2 — The probe chain (crates/host-spike)

Five steps, each independently PASS/FAIL with timing, run on macOS arm64
against a sibling-built core (borrowed artifacts, ABI-matched shim):

| step | claim tested | result |
|---|---|---|
| 1 | Rust `main()` → shared versioned libkungfu C ABI → safe Rust context/reader/batch wrapper → mmap-backed journal payload | **PASS** (3 ms, zero payload copy) |
| 2 | embed python-build-standalone via `Py_Initialize` with staged `PYTHONHOME` | **PASS** (7 ms) |
| 3 | `import pykungfu` in the embedded interpreter | **PASS** (42 ms) |
| 4 | Python-level journal write→read roundtrip, plus cross-language readback (Python reads the frame the C++ side wrote under the same host) | **PASS** (4 ms) |
| 5 | libnode starts via the production `pykungfu.libnode.run` path (`node::Start`) and control returns to the host afterwards | **PASS** (49 ms) |

5/5 on the first complete run; the whole fabric comes up under the Rust host
in about 100 ms. The host shell itself is a 571 KB release binary with zero
crate dependencies (one C++ shim compiled by build.rs against the sibling
core's own flags).

Notable friction found while wiring the probe, all resolved in-probe:

- `journal::assemble` remains an internal C++ surface. The follow-up membrane
  spike resolved the exported-surface decision with one versioned C ABI shared
  by native KFX and this host. The host no longer grows a parallel C++ seam.
- pykungfu resolves libnode/libkungfu via `@loader_path` rpath, so `import`
  works from any host as long as the natives stay colocated — the dist layout
  already guarantees that.
- `writer.write_bytes` takes an explicit length argument; the probe's Python
  snippet had to pass it correctly (a silent 1-byte write otherwise) — a
  reminder that the binding surface has sharp edges an embedding host will
  lean on.

## Part 3 — Risk register (the five known unknowns)

1. **Python environment layout discovery** — resolved cheaply: staging
   `PYTHONHOME` at the python-build-standalone prefix before `Py_Initialize`
   is sufficient; no `PyConfig` surgery, no path patching. The open packaging
   question is stdlib pruning policy (a full prefix ships 73 M where the
   frozen binary compiles the used subset into 23 M), not discovery.
2. **GIL / main-thread assumptions** — the probe runs the entire chain on the
   host main thread, same as today's frozen entrypoint.
3. **"I am the host" assumptions in the Python tree** — inventoried: 17
   `sys.executable` / `sys.argv[0]` sites (entry-command fallback in
   runtime_service spawning children as `[sys.executable, "-m", "kungfu"]`,
   config/artifact discovery relative to the executable, argv rewriting in
   site/variants), SIGTERM/SIGINT handlers installed on the assumption of
   owning the main thread, one atexit hook (REPL history). Notably there is
   **no multiprocessing usage** — concurrency is subprocess.Popen + signals,
   which survives a host swap unchanged.
4. **libnode equivalence** — held: the exact production path
   (`pykungfu.libnode.run` → `node::Start`) runs under the Rust host and hands
   control back. The known caveat stands regardless of host: `node::Start`
   has whole-process semantics (it assumes the calling thread is the
   process's main show while it runs), which is the same bargain the frozen
   entrypoint makes today.
5. **CLI surface parity cost** — estimate only (deliberately not built): the
   CLI itself would not be rewritten; a Rust host embeds CPython and runs the
   same click tree (23 command modules + 2 variants). The parity work is in
   the hosting seam, not the commands: argv0/self-exec semantics for the 17
   sites above, signal forwarding, env staging, and replacing the freeze step
   with an assembly step (stdlib pruning policy included) in packaging.

## Part 4 — Recommendation

**Technically de-risked; not forced.** Two findings that pull in opposite
directions, stated separately so the decision stays honest:

- The probe removes the feasibility question: every layer of the fabric —
  core init, embedded CPython, the binding, real journal traffic, the node
  satellite — runs under a Rust host today, wired up in an afternoon on
  borrowed artifacts.
- The measurement removes the urgency question: freeze is no longer the
  heaviest or slowest link, and assembly would not beat it on size or
  startup. What exercising the option buys is the *incident class* (runtime
  surprises attributable to freezing), the hand-maintained exclusion surface,
  the dev/prod divergence — and the symmetric host topology as an
  architectural option.

If exercised, the staged shape falls out of the probe:

1. **Phase A** — a host shell binary behind an off-by-default flag, macOS
   only, running the assembled (unfrozen) Python tree; freeze keeps shipping.
   Requires the exported-embedding-surface decision (Part 2) and an argued
   cdylib/FFI case per `docs/rust-adoption.md` (mode 2 is deliberately
   non-default).
2. **Phase B** — assembly packaging (python-build-standalone + stdlib pruning
   + site-packages) reaches parity on the three release platforms; the 17
   argv0/self-exec sites and signal forwarding get their host-neutral seam.
3. **Phase C** — freeze retires (with the `engage` bridges re-homed), Nuitka
   leaves the toolchain.

If not exercised, this report is the archive: the option stays held at zero
cost, the probe stays in `crates/host-spike` as the evidence, and the next
revisit starts from measured facts instead of intuition.
