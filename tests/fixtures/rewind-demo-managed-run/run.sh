#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Managed-run fixture. Proves the seam that joins the cost parse layer and the
# cost wire event into one managed act: launch a provider, parse its
# structured output, and emit a CostSnapshot journal event bound to the run.
# Drives run_managed with an injected fake process runner and a list-collecting
# emit sink (the same (msg_type, bytes) signature the supervisor exposes), so it
# spawns no real CLI and needs no native journal writer.
#
# Runs under `uv run --frozen python` for flatbuffers; stubs the top-level
# kungfu package so the native binding import is skipped.
#
# Usage: tests/fixtures/rewind-demo-managed-run/run.sh
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

cd "$core_dir"
uv run --frozen python "$fixture_dir/check_managed_run.py" "$fixture_dir"
