// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run.mjs');

test('surface qualification source contract validates without artifacts', () => {
  const result = spawnSync(process.execPath, [runner, '--validate-only'], {
    cwd: path.resolve(here, '..', '..', '..', '..'),
    env: { ...process.env, SHIFU_ENTRYPOINT: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /source-valid/);
  assert.match(result.stdout, /does not qualify installed artifacts/);
});
