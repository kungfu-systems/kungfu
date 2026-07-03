#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Gate: the sandboxed-ipc capability boundary enforces the manifest's declared
# capabilities (an undeclared capability is unreachable and rejected at the
# host). Headless — no Electron; the live isolation is proven by the electron
# harness in the goal record. Requires node >= 22 (native TS type-stripping).
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node --experimental-transform-types "$fixture_dir/boundary.test.mjs"
