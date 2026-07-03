# Kungfu Rewind — record an agent run, then open it

> Pre-release. Rewind is the local agent flight recorder built on the kungfu
> runtime: one command wraps an **unmodified** agent run, every model call and
> tool call lands in one local journal, and you re-open the run afterwards —
> in the desktop app or from the command line. Nothing is uploaded anywhere.

This page is the complete path: install → capture → diagnose → replay →
clean up. It assumes nothing beyond a shell.

## Install (pre-release: from a built workspace)

Release binaries are not published yet; today Rewind runs from a built
workspace. Install `fnm` and `uv` once (see [CONTRIBUTING](../CONTRIBUTING.md)),
then:

```sh
git clone git@github.com:kungfu-systems/kungfu.git
cd kungfu
./kungfu-code sync && ./kungfu-code build
```

Everything below runs from the repository root. `kungfu` (alias `kfc`) is the
runtime CLI; the desktop app is the reference GUI.

## Capture a run

Wrap any command. The traced program needs **no code changes and no SDK** —
the only contact surface is the environment the supervisor injects. In a
workspace build, run the CLI from `framework/core`:

```sh
cd framework/core
uv run --frozen python .devtools/kfc.py -H <home-dir> \
  trace -- python3 my_agent.py
```

- `<home-dir>` is where the run store lives (any directory you own).
- `trace` assigns the run id and prints it on the `[rewind] run <id> starts`
  line — note it down, the diagnosis commands take it via `--run`.
- `trace` exits with the traced program's own exit code, so it drops into
  scripts and CI without changing failure semantics.
- Model calls are captured at the wire: the supervisor points
  `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` at a local proxy and forwards to
  the upstream your run would have used anyway — it reads your environment's
  own base-url variables before overriding them for the child, falling back
  to the providers' official endpoints. Request/response bodies are recorded;
  **headers are never captured** (that is where API keys live).
- Tool calls, results, errors and retries are captured in-process by hooks
  injected through `PYTHONPATH` (python) and `NODE_OPTIONS` (node). A process
  spawned inside a tool inherits its causal parent — one chain, across
  runtimes, in one journal.
- A run writes two things under `<home-dir>/runtime`: the journal itself
  (under `system/rewind/<run-id>/` — the recorded frames) and the trace
  bundle (under `rewind/<run-id>/bundle/` — the schema blob + manifest that
  make the journal decodable without this runtime).

## Diagnose from the command line

```sh
# from framework/core, same -H <home-dir> as the capture:

# the causal tree: model spans, tool spans (cross-runtime nested),
# retries, per-span latency, failed nodes with their error detail
uv run --frozen python .devtools/kfc.py -H <home-dir> rewind show --run <run-id>

# prove the record self-describes: decode every frame two independent
# ways (native accessors vs the bundle's reflection schema) and diff
uv run --frozen python .devtools/kfc.py -H <home-dir> rewind verify --run <run-id>
```

(In a packaged install these are just `kungfu rewind show` / `kungfu rewind
verify`; the long prefix is the workspace-build spelling.)

`show` answers the first diagnosis questions in one screen: which step failed
(✗ with the error detail inline), how long each step took, and how the run
ended. Full input/output bodies live in the app's node pane; the CLI shows
them only as far as the error message carries them. `verify` is forensic
replay: the journal is re-read on the same runtime that recorded it, and the
trace bundle alone must reproduce every fact — tampering or schema drift
fails loudly.

## Diagnose in the app

```sh
KF_RUNTIME_DIR=<home-dir>/runtime ./kungfu-code app
```

The **Rewind** tab (first in the left nav) shows three panes:

- **runs** — every recorded run; ● red means the run had errors.
- **trace** — the causal tree. Failed nodes are marked ✗; a tool executed in
  another runtime (e.g. a node tool called from python) nests under its
  caller, because both runtimes wrote the same journal.
- **node** — select any node: status, latency, tokens, the error, and the
  full input/output bodies, pretty-printed.

The 2-minute drill for "why did my run fail": open the run with the red dot →
follow the ✗ down the tree → read the node's `error` and `input`. That is the
whole workflow.

## Delete a run / privacy

A run is files under `<home-dir>/runtime` — delete the run's directories and
it is gone:

```sh
rm -r <home-dir>/runtime/system/rewind/<run-id> <home-dir>/runtime/rewind/<run-id>
```

Default mode never uploads anything: capture, storage, diagnosis and replay
are all local. The proxy only talks to the model upstream your run already
used.

## Demos

Deterministic end-to-end demos live under `tests/fixtures/` and double as
release gates (`./kungfu-code verify --full` runs them all):

| Demo | Shows |
| --- | --- |
| `rewind-demo-happy/` | capture basics + a flaky tool that retries and recovers |
| `rewind-demo-tool-failure/` | a tool failing for real: ✗ node, error detail, non-zero exit |
| `rewind-demo-model-drift/` | the model picks a tool that does not exist — the drift is visible in the model node's output, and the consequence in the failing step after it |
| `rewind-demo-cross-runtime/` | python agent → node tool, one causal chain in one journal |
| `rewind-demo-forensic-replay/` | re-open + two-path verify + tamper rejection |

Each runs standalone: `tests/fixtures/<name>/run.sh`.

## Known limits (pre-release)

- Install is workspace-build only; packaged three-platform installers are the
  next release gate.
- On macOS, run the workspace CLI from `framework/core` with
  `DYLD_FALLBACK_LIBRARY_PATH=<repo>/framework/core/dist/kfc` exported: the
  dev-python binding resolves `libnode` relative to the executable, and shell
  wrappers strip `DYLD_*` across re-exec, so exporting it in your own shell
  right before the command is the reliable spelling.
- The CLI tree does not yet label which runtime executed each node (the
  cross-runtime nesting itself is recorded and shown; the per-node runtime
  tag is a schema addition on the list).
- Streaming (SSE) model responses are captured verbatim, not parsed into
  token/usage facts.
- Replay is forensic (re-open, walk, verify); deterministic re-execution is a
  later differentiator gate.
- Framework auto-instrumentation ships with the demo toolkit adapter;
  real-framework adapters (LangChain et al.) grow in the same adapter table.
