#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Kfx distribution fixture: `npm pack` of a view extension is a complete,
# offline installable unit. Packs the real work-dashboard package, installs
# the tgz into a clean home through `kungfu kfx install`, and asserts the
# managed lifecycle: list, double-install refusal, --force replace, remove.
# Requires the core dev environment (built dist/kungfu) and the extension's
# own build output (dist/view/index.js, from `kungfu sdk kfx build`).
#
# Usage: tests/fixtures/kfx-demo-install/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$fixture_dir/../../.." && pwd)"
core_dir="$repo_dir/framework/core"

home="$(mktemp -d)"
packdir="$(mktemp -d)"
trap 'rm -rf "$home" "$packdir"' EXIT

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

# the distribution unit: a plain npm tgz of the built extension package
ext_dir="$repo_dir/extensions/work-dashboard"
[ -f "$ext_dir/dist/view/index.js" ] || {
  echo "FAIL: work-dashboard is not built (run kungfu sdk kfx build first)"; exit 1;
}
tgz="$(cd "$ext_dir" && npm pack --pack-destination "$packdir" 2>/dev/null | tail -1)"
tgz="$packdir/$tgz"
[ -f "$tgz" ] || { echo "FAIL: npm pack produced no tgz"; exit 1; }

cd "$core_dir"
kfc="uv run --frozen python .devtools/kungfu_cli.py -H $home"

$kfc kfx install "$tgz"
$kfc kfx list

# double install must refuse without --force, succeed with it
if $kfc kfx install "$tgz" 2>/dev/null; then
  echo "FAIL: double install did not refuse"; exit 1;
fi
$kfc kfx install "$tgz" --force

uv run --frozen python "$fixture_dir/check_install.py" "$home"

$kfc kfx remove work-dashboard
if $kfc kfx remove work-dashboard 2>/dev/null; then
  echo "FAIL: removing a missing key did not fail"; exit 1;
fi
[ ! -d "$home/extensions/work-dashboard" ] || { echo "FAIL: not removed"; exit 1; }
echo "[kfx-demo-install] lifecycle ok"
