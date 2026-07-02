#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Forensic replay fixture (gate G-Moat, machine half): record a cross-runtime
# run, then prove the record self-describes —
#   show    the causal tree reconstructs from the journal alone;
#   verify  the native decode and the bundle's reflection decode (no generated
#           event code) agree fact-for-fact over every frame;
#   tamper  a corrupted schema blob must make verify FAIL (falsification —
#           the check has teeth, it is not vacuously green).
#
# Usage: tests/fixtures/rewind-demo-forensic-replay/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

command -v node >/dev/null || { echo "node not on PATH"; exit 2; }

home="$(mktemp -d)"
run_id="fixturereplay$(date +%s)"

port_file="$home/mock-port"
python3 "$fixture_dir/mock_model.py" "$port_file" &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null; rm -rf "$home"' EXIT
while [ ! -s "$port_file" ]; do sleep 0.1; done
OPENAI_BASE_URL="http://127.0.0.1:$(cat "$port_file")/v1"
export OPENAI_BASE_URL

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kfc${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
kfc() { uv run --frozen python .devtools/kfc.py -H "$home" "$@"; }

kfc trace --run-id "$run_id" -- python3 "$fixture_dir/demo_agent.py"

echo "--- rewind show ---"
tree="$(kfc rewind show --run "$run_id")"
printf '%s\n' "$tree"
printf '%s' "$tree" | grep -q "tool delegate"      || { echo "FAIL: python tool missing from tree"; exit 1; }
printf '%s' "$tree" | grep -q "tool node-lookup"   || { echo "FAIL: node tool missing from tree"; exit 1; }
printf '%s' "$tree" | grep -q "model openai"       || { echo "FAIL: model span missing from tree"; exit 1; }
# the node tool must render nested under the python delegate (cross-runtime edge)
printf '%s\n' "$tree" | grep -A1 "tool delegate" | grep -q "  - tool node-lookup" \
  || { echo "FAIL: node tool not nested under python delegate"; exit 1; }
echo "ok  causal tree reconstructs with the cross-runtime edge"

echo "--- rewind verify ---"
kfc rewind verify --run "$run_id" | grep -q "verify passed" \
  || { echo "FAIL: two decode paths disagree"; exit 1; }
echo "ok  native and reflection decodes agree"

echo "--- tamper falsification ---"
bundle="$home/runtime/rewind/$run_id/bundle"
tampered="$home/tampered-bundle"
cp -R "$bundle" "$tampered"
blob="$(/bin/ls "$tampered/schemas/" | head -1)"
printf 'x' | dd of="$tampered/schemas/$blob" bs=1 seek=64 conv=notrunc 2>/dev/null
if kfc rewind verify --run "$run_id" --bundle "$tampered" >/dev/null 2>&1; then
  echo "FAIL: tampered bundle passed verify (check is vacuous)"; exit 1
fi
echo "ok  tampered bundle rejected"

echo "forensic replay check passed"
