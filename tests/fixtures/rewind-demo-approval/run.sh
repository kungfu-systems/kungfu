#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Approval-bridge fixture. Proves a human control decision on a managed run
# becomes a journal fact (ApprovalDecision, msg_type 30009) and yields the right
# process control action (SIGINT for interrupt, input for approve/deny/resume),
# plus schema-only decode of the pinned .bfbs. No real terminal, no native
# journal writer.
#
# Runs under `uv run --frozen python` for flatbuffers; stubs the top-level
# kungfu package so the native binding import is skipped.
#
# Usage: tests/fixtures/rewind-demo-approval/run.sh
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$fixture_dir/../../../framework/core" && pwd)"

cd "$core_dir"
uv run --frozen python "$fixture_dir/check_approval.py" "$fixture_dir"
