#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Event-dispatch latency baseline, master form (ADR-0005 evidence).
#
# Starts a master with the KF_DISPATCH_PROBE instrument enabled, drives it
# with an open-layer event burst from a registered apprentice
# (dispatch_load.py), then prints the probe reports collected on the master
# side. Requires the core dev environment (built dist/kfc).
#
# Usage: tests/bench/dispatch_bench.sh [event-count] [load-type]
#
#   KF_BYPASS_CACHED=1 tests/bench/dispatch_bench.sh   # rx-isolated run
#   tests/bench/dispatch_bench.sh                      # storage-on run
#   tests/bench/dispatch_bench.sh 200000 30001         # open-layer control run

set -eu
bench_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$bench_dir/../.." && pwd)"

count="${1:-200000}"
# "quote" (typed longfist frames) by default: both master and the node
# watcher pre-filter open-layer events in is_reactable before rx, so only
# typed frames actually traverse the filter chains being measured
load_type="${2:-quote}"

# short path: nanomsg ipc sockets live under the home and macOS caps
# sun_path at 104 chars — the default $TMPDIR /var/folders/... is too deep
home="$(mktemp -d /tmp/kfb.XXXXXX)"
echo "bench home: $home (KF_BYPASS_CACHED=${KF_BYPASS_CACHED:-unset})"

KF_DISPATCH_PROBE=1
export KF_DISPATCH_PROBE

# Dev-python import of pykungfu: give dyld the dist dir as fallback (same as
# the capture fixtures).
DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kfc${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"

# same invocation shape the app supervisor uses (processUtils buildKungfuArgs)
uv run --frozen python .devtools/kfc.py -H "$home" \
  run -c system -g master -n master -m live \
  >"$home/master.out" 2>&1 &
master_pid=$!
cleanup() {
  kill "$master_pid" 2>/dev/null || true
}
trap cleanup EXIT

# let master bind sockets and settle
sleep 3
if ! kill -0 "$master_pid" 2>/dev/null; then
  echo "master failed to start:" >&2
  cat "$home/master.out" >&2
  exit 1
fi

uv run --frozen python "$bench_dir/dispatch_load.py" "$home" "$count" 64 "$load_type"

# let at least one 5s probe report tick fire after the burst settles
sleep 6
kill "$master_pid" 2>/dev/null || true
wait "$master_pid" 2>/dev/null || true

echo "--- dispatch probe reports (master) ---"
found=0
for f in "$home/master.out" $(find "$home/runtime" -name '*.log' 2>/dev/null); do
  if grep -h "dispatch probe" "$f" 2>/dev/null; then
    found=1
  fi
done
if [ "$found" -eq 0 ]; then
  echo "no probe output found — check $home/master.out" >&2
  exit 1
fi
echo "bench home kept for inspection: $home"
