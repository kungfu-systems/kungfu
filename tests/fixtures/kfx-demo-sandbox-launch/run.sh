#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Gate: the default-tier OS sandbox (ADR-0013). A guest launched under the OS
# sandbox relays capabilities over its stdio but cannot touch the filesystem or
# the network. macOS uses Seatbelt (sandbox-exec); Linux uses bubblewrap (bwrap).
# On a platform with no sandbox (or Linux without bwrap) parent.mjs skips rather
# than pass vacuously. Requires node >= 22 and python3.
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node --experimental-transform-types "$fixture_dir/parent.mjs"
