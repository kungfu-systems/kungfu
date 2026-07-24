// SPDX-License-Identifier: Apache-2.0
// Gate: the default-tier OS sandbox (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847). A guest launched under the OS
// sandbox relays capabilities over its stdio but cannot touch the filesystem or
// the network. macOS uses Seatbelt (sandbox-exec); Linux uses bubblewrap (bwrap).
// On a platform with no sandbox (or Linux without bwrap) parent.mjs skips rather
// than pass vacuously. Requires node >= 22 and python3.
//
// Usage: node tests/fixtures/kfx-demo-sandbox-launch/run.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { locate } from '../_harness.mjs';

const { fixtureDir } = locate(import.meta.url);
const resolver = path.resolve(
  fixtureDir,
  '../../../framework/api/src/capability/guest-harness/ts-resolve.mjs',
);

// parent.mjs is the gate entry: it composes the launcher/transport/host and
// spawns child.py under the OS sandbox. It self-skips (exit 0) when no OS
// sandbox is available — macOS Seatbelt / Linux bwrap — so run it unchanged
// under the TS type-stripping flag and surface its exit code verbatim.
const r = spawnSync(
  process.execPath,
  [
    '--import',
    resolver,
    '--experimental-transform-types',
    path.join(fixtureDir, 'parent.mjs'),
  ],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
