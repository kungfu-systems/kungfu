// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

test('production-candidate admission is digest-bound and fail-closed', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/check-durability-production-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  const result = JSON.parse(output);
  assert.equal(result.verdict, 'passed-current-hardware-production-candidate');
  assert.equal(result.admitted_input_count, 6);
  assert.equal(result.production_eligible, false);
  assert.match(result.inputs_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.report_sha256, /^[a-f0-9]{64}$/u);
});
