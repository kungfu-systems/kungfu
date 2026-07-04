#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Event-dispatch latency baseline, node watcher form (ADR-0005 evidence).
#
# Starts a master, attaches the real node Watcher under plain node
# (dispatch_watcher_bench.js), drives typed Quote load through a registered
# apprentice, then prints the probe reports collected on the watcher side.
# Requires the core dev environment (built dist/kungfu) and fnm (repo-pinned
# node, same bootstrap as ./kungfu-code).
#
# Usage: tests/bench/dispatch_bench_watcher.sh [event-count]

set -eu
bench_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
core_dir="$(CDPATH= cd -- "$bench_dir/../.." && pwd)"
repo_dir="$(CDPATH= cd -- "$core_dir/../.." && pwd)"

count="${1:-200000}"

# short path: nanomsg ipc sockets live under the home and macOS caps
# sun_path at 104 chars — the default $TMPDIR /var/folders/... is too deep
home="$(mktemp -d /tmp/kfb.XXXXXX)"
echo "bench home: $home"

KF_DISPATCH_PROBE=1
export KF_DISPATCH_PROBE

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

cd "$core_dir"

uv run --frozen python .devtools/kungfu_cli.py -H "$home" \
  run -c system -g master -n master -m live \
  >"$home/master.out" 2>&1 &
master_pid=$!

watcher_pid=""
cleanup() {
  kill "$master_pid" 2>/dev/null || true
  [ -n "$watcher_pid" ] && kill "$watcher_pid" 2>/dev/null || true
}
trap cleanup EXIT

sleep 3
if ! kill -0 "$master_pid" 2>/dev/null; then
  echo "master failed to start:" >&2
  cat "$home/master.out" >&2
  exit 1
fi

# watcher window: register grace + load + probe report ticks
(cd "$repo_dir" && fnm exec --using-file -- \
  node "$bench_dir/dispatch_watcher_bench.js" "$home" 40) \
  >"$home/watcher.out" 2>&1 &
watcher_pid=$!

sleep 5
if ! kill -0 "$watcher_pid" 2>/dev/null; then
  echo "watcher failed to start:" >&2
  cat "$home/watcher.out" >&2
  exit 1
fi

uv run --frozen python "$bench_dir/dispatch_load.py" "$home" "$count" 64 quote

wait "$watcher_pid" || true

echo "--- dispatch probe reports (watcher) ---"
found=0
for f in "$home/watcher.out" $(find "$home/runtime/log/system/node" -name '*.log' 2>/dev/null); do
  if grep -h "dispatch probe" "$f" 2>/dev/null; then
    found=1
  fi
done
if [ "$found" -eq 0 ]; then
  echo "no watcher probe output found — check $home/watcher.out" >&2
  exit 1
fi
echo "bench home kept for inspection: $home"
