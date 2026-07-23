// SPDX-License-Identifier: Apache-2.0
// Gate: the source-authority verdict (ADR-0013) grants the node-integrated tier
// by first-party-set membership and (when pinned) bundle content hash, never by
// which extension root a package loaded from. Headless — no Electron; the pure
// verdict is framework/kfx/src/index.ts and the manifest generator is
// framework/gui/src/main/first-party-manifest.ts. Requires node >= 22 (native
// TS type-stripping).
//
// Usage: node tests/fixtures/kfx-demo-trust-authority/run.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { locate } from '../_harness.mjs';

const { fixtureDir } = locate(import.meta.url);
const resolver = path.resolve(
  fixtureDir,
  '../../../framework/api/src/capability/guest-harness/ts-resolve.mjs',
);

const r = spawnSync(
  process.execPath,
  [
    '--import',
    resolver,
    '--experimental-transform-types',
    path.join(fixtureDir, 'authority.test.mjs'),
  ],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
