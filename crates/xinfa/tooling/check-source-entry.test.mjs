// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanSourceEntry } from './check-source-entry.mjs';

test('rejects production physical Xinfa binaries', () => {
  assert.equal(
    scanSourceEntry(
      'scripts/production.mjs',
      "path.join(ROOT, 'xinfa', 'target', 'debug', 'xinfa')",
    ).length,
    1,
  );
  assert.equal(
    scanSourceEntry('docs/agent.md', './xinfa/target/debug/xinfa --version')
      .length,
    1,
  );
});

test('allows the bounded standalone oracle and source resolver', () => {
  assert.deepEqual(
    scanSourceEntry(
      'crates/xinfa/tooling/standalone-smoke.mjs',
      './target/debug/xinfa',
    ),
    [],
  );
  assert.deepEqual(
    scanSourceEntry(
      'scripts/production.mjs',
      'crates/xinfa/tooling/source-xinfa',
    ),
    [],
  );
});
