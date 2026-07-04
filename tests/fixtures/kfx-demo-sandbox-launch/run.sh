#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Gate: the default-tier OS sandbox (ADR-0013). A guest launched under the OS
# sandbox relays capabilities over its stdio but cannot touch the filesystem or
# the network. macOS only (Seatbelt via sandbox-exec); the Linux launcher
# (Landlock + seccomp + namespaces) is not implemented yet, so this gate skips
# there rather than pass vacuously. Requires node >= 22 and python3.
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$(uname)" != "Darwin" ]; then
  echo "skipped: os sandbox gate runs on darwin only (linux launcher not implemented)"
  exit 0
fi
node --experimental-transform-types "$fixture_dir/parent.mjs"
