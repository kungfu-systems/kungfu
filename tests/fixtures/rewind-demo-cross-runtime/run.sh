#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Cross-runtime single-journal fixture (gate G7): a python agent calls a Node
# tool under one traced run; both runtimes' events must land in one journal
# with a shared run id, a causal edge across the boundary, and one timeline.
# Requires the core dev environment (built dist/kungfu) and node on PATH.
#
# Usage: tests/fixtures/rewind-demo-cross-runtime/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

command -v node >/dev/null || { echo "node not on PATH"; exit 2; }

home="$(mktemp -d)"
run_id="fixturecross$(date +%s)"

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

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
uv run --frozen python .devtools/kfc.py -H "$home" trace --run-id "$run_id" -- \
  python3 "$fixture_dir/demo_agent.py"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
