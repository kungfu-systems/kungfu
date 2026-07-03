#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Work profile lifecycle fixture (gates P1/P2 slice): one item walks the whole
# default-profile vocabulary — create, every lifecycle verb, next action,
# checkpoint, decision, validation, artifact, linked run — and the journal
# plus the folded projection carry every fact. Asserted by check_lifecycle.py.
# Requires the core dev environment (built dist/kungfu).
#
# Usage: tests/fixtures/work-demo-lifecycle/run.sh

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

cd "$core_dir"
kfc="uv run --frozen python .devtools/kfc.py -H $home"

work_id="$($kfc work create 'Fixture lifecycle item' --kind task \
  --summary 'work profile lifecycle fixture' --json \
  | uv run --frozen python -c 'import sys, json; print(json.load(sys.stdin)["work_id"])')"

$kfc work start "$work_id"
$kfc work next "$work_id" "wire the projection"
$kfc work pause "$work_id" --reason "waiting on review"
$kfc work resume "$work_id"
$kfc work block "$work_id" --reason "blocked on schema decision"
$kfc work decide "$work_id" "keep five statuses" --by fixture
$kfc work resume "$work_id"
$kfc work checkpoint "$work_id" "projection folds correctly"
$kfc work validate "$work_id" --result pass --command "fixture smoke" --note "ran clean"
$kfc work artifact "$work_id" "framework/core/src/python/kungfu/work" --kind path
$kfc work link-run "$work_id" "runfixture01"
$kfc work ready "$work_id"
$kfc work done "$work_id" --reason "delivered"

uv run --frozen python "$fixture_dir/check_lifecycle.py" "$home/runtime" "$work_id"
