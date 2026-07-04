#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Export/open fixture (gate G8): a recorded run packs into one portable file
# that re-opens ANYWHERE — proven the hard way: the original home is deleted
# before the export is opened in a fresh location, and the opened copy must
# still verify (two-path decode) and render the full causal tree. Offline,
# no services.
#
# Usage: tests/fixtures/rewind-demo-export/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
opened="$(mktemp -d)"
run_id="fixtureexport$(date +%s)"

port_file="$home/mock-port"
# stdio-detached, killed by the trap — see rewind-demo-happy/run.sh for why
python3 "$fixture_dir/mock_model.py" "$port_file" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home" "$opened"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
kfc() { uv run --frozen python .devtools/kungfu_cli.py "$@"; }

kfc -H "$home" trace --run-id "$run_id" -- python3 "$fixture_dir/demo_agent.py"

archive="$opened/$run_id.rewind.zip"
kfc -H "$home" rewind export --run "$run_id" -o "$archive"
[ -s "$archive" ] || { echo "FAIL: export produced no archive"; exit 1; }
echo "ok  export produced $(wc -c < "$archive" | tr -d ' ') bytes"

# the hard part: the original home disappears entirely
rm -rf "$home/runtime"
echo "ok  original home deleted"

out="$(kfc -H "$opened" rewind open "$archive" --dir "$opened/reopened")"
printf '%s\n' "$out"
printf '%s' "$out" | grep -q "frames verified"        || { echo "FAIL: opened export did not verify"; exit 1; }
printf '%s' "$out" | grep -q "tool lookup"             || { echo "FAIL: tree missing tool node"; exit 1; }
printf '%s' "$out" | grep -q "model openai/demo-model" || { echo "FAIL: tree missing model node"; exit 1; }
printf '%s' "$out" | grep -q "(retry #2)"         || { echo "FAIL: tree missing retry annotation"; exit 1; }
echo "ok  opened export verifies and renders the full tree"

echo "export/open check passed"
