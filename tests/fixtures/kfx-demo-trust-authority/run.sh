#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Gate: the source-authority verdict (ADR-0013) grants the node-integrated tier
# by first-party-set membership and (when pinned) bundle content hash, never by
# which extension root a package loaded from. Headless — no Electron; the pure
# verdict is framework/kfx/src/index.ts and the manifest generator is
# framework/gui/src/main/first-party-manifest.ts. Requires node >= 22 (native
# TS type-stripping).
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node --experimental-transform-types "$fixture_dir/authority.test.mjs"
