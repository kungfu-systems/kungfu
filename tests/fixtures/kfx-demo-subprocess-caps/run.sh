#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Gate: the subprocess capability transport (ADR-0013). A Node host serves mock
# capabilities to a sandboxed Python guest over the child's stdio; the guest
# reaches only its declared capabilities, and a bridged subscription round-trips.
# Headless — no Electron. Requires node >= 22 (native TS type-stripping) and a
# python3 that can import kungfu.capability (the core dev environment).
set -eu
fixture_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node --experimental-transform-types "$fixture_dir/parent.mjs"
