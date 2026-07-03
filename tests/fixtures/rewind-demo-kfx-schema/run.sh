#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# kfx open-layer fixture (S5): a kfx compiles its own `.fbs` at runtime, registers
# the schema into the traced run, and emits an event of its own msg_type. The
# event lands in the journal, the schema binds into the bundle under the kfx band
# (40000-49999), and it decodes by reflection with no generated accessor — the
# run-internal proof of the native-compile open layer. Asserted by check_capture.py.
# Requires the core dev environment (built dist/kfc, whose python has flatbuffers).
#
# Usage: tests/fixtures/rewind-demo-kfx-schema/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

home="$(mktemp -d)"
run_id="fixturekfx$(date +%s)"
trap 'rm -rf "$home"' EXIT

# dyld fallback so both the supervisor and the kfx child can import pykungfu
# (compile_schema) when the interpreter is uv's python rather than frozen kfc
DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kfc${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"
# the kfx child is the core's 3.13 interpreter (has flatbuffers); it reaches the
# kungfu package + binding itself, and the supervisor injects the capture hook.
uv run --frozen python .devtools/kfc.py -H "$home" trace --run-id "$run_id" -- \
  "$core_dir/.venv/bin/python" "$fixture_dir/kfx_program.py"

uv run --frozen python "$fixture_dir/check_capture.py" "$home/runtime" "$run_id"
