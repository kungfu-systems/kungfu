#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Cost-adapter parse fixture. Proves
# the provider cost adapters turn Codex `exec --json` JSONL and Claude `--print
# --output-format json` into a normalized, honestly-attributed CostSnapshot, and
# that provider binary discovery locates the CLIs (incl. the macOS Codex App
# bundle) without touching any credential.
#
# Unlike the other rewind-demo-* fixtures this one is PARSE-ONLY: pure stdlib,
# no built dist/kungfu, no journal writer, no network. It runs under plain
# python3 in well under a second. The check stubs the heavy kungfu package
# parents so the pure-stdlib cost subpackage imports without the native binding.
# When a later slice puts these facts on the journal, a heavier journal fixture
# will join it; this one stays the fast contract test for the parse layer.
#
# Usage: tests/fixtures/rewind-demo-cost-adapter/run.sh
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
python3 "$fixture_dir/check_cost_adapter.py" "$fixture_dir"
