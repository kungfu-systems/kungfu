#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Cost-wire fixture. Proves the parse-layer CostSnapshot becomes a rewind
# open-layer journal event (msg_type 30008) that decodes without the runtime
# that wrote it: the serializer + parse->wire bridge round-trip, the honesty
# invariant (unknown cost never becomes 0.0), and the pinned rewind_events.bfbs
# carrying the CostSnapshot shape for schema-only decode.
#
# Heavier than the pure-stdlib cost-adapter parse fixture — it needs flatbuffers
# — so it runs under `uv run --frozen python`. It still needs no built
# dist/kungfu and no journal writer: the check stubs the top-level kungfu
# package so the native binding import is skipped.
#
# Usage: tests/fixtures/rewind-demo-cost-wire/run.sh
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

cd "$core_dir"
uv run --frozen python "$fixture_dir/check_cost_wire.py" "$fixture_dir"
