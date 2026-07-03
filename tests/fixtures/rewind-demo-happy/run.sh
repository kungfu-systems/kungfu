#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Happy-path capture fixture (gate G2, L0 slice): one command wraps an
# unmodified child process and produces a local run store — journal frames
# bracketing the run plus a self-describing trace bundle. Asserted by
# check_capture.py. Requires the core dev environment (built dist/kungfu).
#
# Usage: tests/fixtures/rewind-demo-happy/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
run_id="fixturehappy$(date +%s)"

# deterministic model upstream: the mock binds an ephemeral port and reports
# it through a file; the supervisor picks it up as the openai forward target
port_file="$home/mock-port"
# The mock detaches from stdio and dies with this script: it must not hold a
# captured pipe open (a harness reading our output would wait for EOF forever),
# and the cleanup trap must actually run (no exec below — exec replaces the
# shell and silently disarms the trap; that leaked mocks and deadlocked
# verify's stage 6 the first time this ran under spawnSync).
python3 "$fixture_dir/mock_model.py" "$port_file" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL

# Dev-python import of pykungfu: its libnode install name is
# @executable_path-relative (correct for the frozen kfc executable); when the
# interpreter is uv's python instead, give dyld the dist dir as fallback.
DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
uv run --frozen python .devtools/kfc.py -H "$home" trace --run-id "$run_id" -- \
  python3 "$fixture_dir/demo_agent.py"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
