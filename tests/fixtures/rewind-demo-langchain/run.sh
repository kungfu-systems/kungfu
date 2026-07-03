#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Real-framework capture fixture (Rewind next-falsification main item): one
# command wraps an *unmodified* LangChain agent — the langgraph `create_agent`
# runtime with a `ChatOpenAI` model and a real `BaseTool` — and produces a
# local run store whose journal carries the model turns (wire proxy) and the
# tool call (in-process adapter patching `BaseTool.run`). Asserted by
# check_capture.py. This replaces the toy toolkit as the moat evidence for
# zero-code-change capture: the toy proved the mechanism, this proves it on a
# framework kungfu does not control.
#
# The real framework is provisioned into a cached, git-ignored venv. The gate
# genuinely requires it: if langchain cannot be provisioned this fixture FAILS
# loudly rather than silently passing — a real-framework claim must be backed
# by a real framework.
#
# Usage: tests/fixtures/rewind-demo-langchain/run.sh
#   Requires the core dev environment (built dist/kungfu) and network on first run
#   to install langchain; the run itself uses a deterministic mock model.

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

# ── provision the real framework (cached across runs) ────────────────
venv="$fixture_dir/.venv-langchain"
agent_py="$venv/bin/python"
if ! "$agent_py" -c "import langchain, langchain_openai" >/dev/null 2>&1; then
  echo "[langchain-fixture] provisioning real langchain venv (first run)…"
  uv venv "$venv" --python 3.13 >/dev/null
  VIRTUAL_ENV="$venv" uv pip install -q -r "$fixture_dir/requirements.txt"
fi
if ! "$agent_py" -c "import langchain, langchain_openai" >/dev/null 2>&1; then
  echo "[langchain-fixture] FAIL: real langchain framework unavailable" >&2
  exit 1
fi

home="$(mktemp -d)"
run_id="fixturelangchain$(date +%s)"

# deterministic model upstream: the mock (stdlib only, system python3) binds an
# ephemeral port and reports it; the supervisor picks it up as the openai
# forward target and points the child's ChatOpenAI at its own proxy.
port_file="$home/mock-port"
python3 "$fixture_dir/mock_model.py" "$port_file" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL
# the openai SDK refuses to construct a client without a key; the proxy never
# forwards request headers, so this dummy never leaves the machine
OPENAI_API_KEY="sk-langchain-fixture"
export OPENAI_API_KEY

# Dev-python import of pykungfu (supervisor + check side): dyld fallback to the
# dist dir when the interpreter is uv's python rather than the frozen kfc.
DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

# The LangChain adapter is NOT in core — it is the kfx package under
# extensions/langchain-adapter. Point the extension root at the workspace
# extensions tree so the supervisor discovers and injects it; capture of an
# unmodified langchain run therefore comes from the package, not the kernel.
KF_EXTENSION_PATH="$core_dir/../../extensions${KF_EXTENSION_PATH:+:$KF_EXTENSION_PATH}"
export KF_EXTENSION_PATH

cd "$core_dir"
uv run --frozen python .devtools/kfc.py -H "$home" trace --run-id "$run_id" -- \
  "$agent_py" "$fixture_dir/langchain_agent.py"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
