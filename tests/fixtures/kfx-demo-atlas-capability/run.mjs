// SPDX-License-Identifier: Apache-2.0
//
// Gate: the Atlas capability handle drives the real Kungfu CLI against a
// runtime dir, then reads back the imported Mission/go/worktree projection.
// Headless — no Electron window; it covers the capability layer the GUI injects.
//
// Usage: node tests/fixtures/kfx-demo-atlas-capability/run.mjs

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
    path.join(fixtureDir, 'roundtrip.mjs'),
  ],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
