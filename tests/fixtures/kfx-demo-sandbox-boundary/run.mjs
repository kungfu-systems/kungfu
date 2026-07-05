// SPDX-License-Identifier: Apache-2.0
// Gate: the sandboxed-ipc capability boundary enforces the manifest's declared
// capabilities (an undeclared capability is unreachable and rejected at the
// host). Headless — no Electron; the live isolation is proven by the electron
// harness in the goal record. Requires node >= 22 (native TS type-stripping).
//
// Usage: node tests/fixtures/kfx-demo-sandbox-boundary/run.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { locate } from '../_harness.mjs';

const { fixtureDir } = locate(import.meta.url);

const r = spawnSync(
  process.execPath,
  ['--experimental-transform-types', path.join(fixtureDir, 'boundary.test.mjs')],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
