#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Tool-failure fixture (gate G6/D2): the traced agent fails on a broken tool;
# the record must make the failure diagnosable — errored ToolResult with the
# real detail, failed run status, ✗ in the rendered tree.
#
# Usage: tests/fixtures/rewind-demo-tool-failure/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
run_id="fixturetoolfail$(date +%s)"

port_file="$home/mock-port"
# stdio-detached, killed by the trap — see rewind-demo-happy/run.sh for why
python3 "$fixture_dir/mock_model.py" "$port_file" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kfc${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
# the traced run is EXPECTED to fail with exit 1; anything else is a fixture bug
set +e
uv run --frozen python .devtools/kfc.py -H "$home" trace --run-id "$run_id" -- \
  python3 "$fixture_dir/demo_agent.py"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "FAIL: expected traced run to exit 1, got $rc"; exit 1; }

tree="$(uv run --frozen python .devtools/kfc.py -H "$home" rewind show --run "$run_id")"
printf '%s\n' "$tree"
printf '%s' "$tree" | grep -q '✗' || { echo "FAIL: failed node not marked in tree"; exit 1; }
echo "ok  tree marks the failure"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
