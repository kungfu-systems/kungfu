#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Atlas import fixture (P7 dogfood slice): a synthetic control-plane tree is
# imported twice; the journal carries both snapshot batches and the projection
# folds the latest one. Read-only against the source tree — the fixture also
# asserts the sample tree is byte-identical after both imports. Asserted by
# check_import.py. Requires the core dev environment (built dist/kungfu).
#
# Usage: tests/fixtures/atlas-demo-import/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT

# Dev-python import of pykungfu: its libnode install name is
# @executable_path-relative (correct for the frozen kfc executable); when the
# interpreter is uv's python instead, give dyld the dist dir as fallback.
DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

before="$(find "$fixture_dir/sample-root" -type f -exec cksum {} + | sort)"

cd "$core_dir"
kfc="uv run --frozen python .devtools/kungfu_cli.py -H $home"

$kfc atlas import --repo "$fixture_dir/sample-root"
second_id="$($kfc atlas import --repo "$fixture_dir/sample-root" --json \
  | uv run --frozen python -c 'import sys, json; print(json.load(sys.stdin)["import_id"])')"

after="$(find "$fixture_dir/sample-root" -type f -exec cksum {} + | sort)"
[ "$before" = "$after" ] || { echo "FAIL: source tree was modified"; exit 1; }

uv run --frozen python "$fixture_dir/check_import.py" "$home/runtime" "$second_id"
