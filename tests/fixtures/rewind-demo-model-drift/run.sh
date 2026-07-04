#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Model-drift fixture (gate G6/D3): the model selects a nonexistent tool;
# the record must show the drift point (the model node output) and its
# consequence (the routing step failing on that exact name).
#
# Usage: tests/fixtures/rewind-demo-model-drift/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
run_id="fixturedrift$(date +%s)"

port_file="$home/mock-port"
# stdio-detached, killed by the trap — see rewind-demo-happy/run.sh for why
python3 "$fixture_dir/mock_model.py" "$port_file" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
# the traced run is EXPECTED to fail with exit 1; anything else is a fixture bug
set +e
uv run --frozen python .devtools/kungfu_cli.py -H "$home" trace --run-id "$run_id" -- \
  python3 "$fixture_dir/demo_agent.py"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "FAIL: expected traced run to exit 1, got $rc"; exit 1; }

tree="$(uv run --frozen python .devtools/kungfu_cli.py -H "$home" rewind show --run "$run_id")"
printf '%s\n' "$tree"
printf '%s' "$tree" | grep -q '✗' || { echo "FAIL: failed node not marked in tree"; exit 1; }
echo "ok  tree marks the failure"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
