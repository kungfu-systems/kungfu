#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Kfx scaffold fixture: `kfs create extension` output builds and installs
# from a clean directory. Scaffolds a view extension into a temp dir, links
# the workspace contract packages the way pnpm would (the fixture stays
# offline), builds it with `kfs kfx build`, asserts the bundle honors the
# load contract (View export, shell-injected modules left external), then
# packs the tgz and runs it through the `kungfu kfx install` lifecycle.
# Requires the core dev environment (built dist/kungfu) and the repository's
# installed node_modules (the sdk's esbuild).
#
# Usage: tests/fixtures/kfx-demo-scaffold/run.sh

set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$fixture_dir/../../.." && pwd)"
core_dir="$repo_dir/framework/core"
kfs="$repo_dir/developer/sdk/src/kfs.js"

work="$(mktemp -d)"
home="$(mktemp -d)"
packdir="$(mktemp -d)"
trap 'rm -rf "$work" "$home" "$packdir"' EXIT

DYLD_FALLBACK_LIBRARY_PATH="$core_dir/dist/kungfu${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH

ext_dir="$work/my-view"
node "$kfs" create extension "$ext_dir" --workspace
[ -f "$ext_dir/package.json" ] || { echo "FAIL: no package.json scaffolded"; exit 1; }
[ -f "$ext_dir/.gitignore" ] || { echo "FAIL: _gitignore not renamed to .gitignore"; exit 1; }
grep -q '__EXT_' "$ext_dir/package.json" && { echo "FAIL: unreplaced template token"; exit 1; }

# workspace deps in a standalone dir: link the contract packages like pnpm
# would inside the monorepo (the build only needs their sources)
mkdir -p "$ext_dir/node_modules/@kungfu-tech"
ln -s "$repo_dir/framework/kfx" "$ext_dir/node_modules/@kungfu-tech/kfx"
ln -s "$repo_dir/framework/api" "$ext_dir/node_modules/@kungfu-tech/api"

(cd "$ext_dir" && node "$kfs" kfx build)
bundle="$ext_dir/dist/view/index.js"
[ -f "$bundle" ] || { echo "FAIL: kfs kfx build produced no bundle"; exit 1; }

# the load contract, asserted the way the shell loads it: CommonJS-wrap with
# a require shim; only shell-provided modules may be required; the bundle
# must export a View component function
node -e '
const fs = require("node:fs");
const code = fs.readFileSync(process.argv[1], "utf8");
const provided = ["react", "react/jsx-runtime", "react-dom", "@kungfu-tech/api", "@kungfu-tech/api/capability"];
const m = { exports: {} };
new Function("require", "module", "exports", code)(
  (id) => { if (provided.includes(id)) return {}; throw new Error("unexpected require: " + id); },
  m, m.exports,
);
if (typeof m.exports.View !== "function") { console.error("FAIL: bundle does not export View"); process.exit(1); }
' "$bundle"

# the distribution unit: npm pack, then the managed install lifecycle
tgz="$(cd "$ext_dir" && npm pack --pack-destination "$packdir" 2>/dev/null | tail -1)"
tgz="$packdir/$tgz"
[ -f "$tgz" ] || { echo "FAIL: npm pack produced no tgz"; exit 1; }

cd "$core_dir"
kfc="uv run --frozen python .devtools/kfc.py -H $home"

$kfc kfx install "$tgz"
$kfc kfx list | grep -q "my-view" || { echo "FAIL: installed kfx not listed"; exit 1; }
[ -f "$home/extensions/my-view/dist/view/index.js" ] || { echo "FAIL: bundle missing from install root"; exit 1; }
$kfc kfx remove my-view
[ ! -d "$home/extensions/my-view" ] || { echo "FAIL: not removed"; exit 1; }
echo "[kfx-demo-scaffold] scaffold-to-install ok"
