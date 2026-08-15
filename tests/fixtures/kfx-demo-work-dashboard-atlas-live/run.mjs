// SPDX-License-Identifier: Apache-2.0
//
// Render the work-dashboard Atlas tab with the real Atlas capability handle.
// The fixture imports the sample Atlas control-plane tree through the real
// Kungfu CLI, then renders the built kfx view headlessly. This proves the GUI
// view and CLI-backed projection agree without opening an Electron window.
//
// Usage: node tests/fixtures/kfx-demo-work-dashboard-atlas-live/run.mjs

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
    path.join(fixtureDir, 'render-live.mjs'),
  ],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
