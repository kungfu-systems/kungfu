// SPDX-License-Identifier: Apache-2.0
// Gate: the subprocess capability transport (ADR-0013). A Node host serves mock
// capabilities to a sandboxed Python guest over the child's stdio; the guest
// reaches only its declared capabilities, and a bridged subscription round-trips.
// Headless — no Electron. Requires node >= 22 (native TS type-stripping) and a
// python3 that can import kungfu.capability (the core dev environment).
//
// Usage: node tests/fixtures/kfx-demo-subprocess-caps/run.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { locate } from '../_harness.mjs';

const { fixtureDir } = locate(import.meta.url);
const resolver = path.resolve(
  fixtureDir,
  '../../../framework/api/src/capability/guest-harness/ts-resolve.mjs',
);

// parent.mjs is the gate entry (a Node host that spawns child.py over stdio);
// run it unchanged under the TS type-stripping flag and surface its exit code.
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
