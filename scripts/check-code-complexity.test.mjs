// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkerArgs, pythonCommand } from './check-code-complexity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

test('Python structure manifest covers the exact production and test roots', () => {
  const manifest = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  );
  assert.deepEqual(manifest.sourceRoots, {
    production: ['framework/core/src/python'],
    test: ['framework/core/tests/python'],
  });
  assert.equal(manifest.limits.newProductionModulePhysicalLines, 1000);
  assert.equal(manifest.limits.giantPhysicalLines, 2000);
  assert.deepEqual(manifest.exceptions, []);
});

test('anti-gaming corpus covers every required rejection family', () => {
  const fixtures = readJson(
    'framework/maintainability/python-structure-negative-fixtures.json',
  );
  assert.deepEqual(
    new Set(fixtures.cases.map((item) => item.expected)),
    new Set([
      'wrapper-only-split',
      'production-source-hidden',
      'oversized-responsibility-not-reduced',
      'duplicated-responsibility',
      'invalid-structure-exception',
    ]),
  );
});

test('build-free entrypoint returns the retained zero-blocking report', () => {
  const result = spawnSync(pythonCommand(), checkerArgs(['--json']), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'kungfu.abstraction-integrity-report/v1');
  assert.equal(report.summary.blockingIssues, 0);
  assert.deepEqual(report.measurement.stronglyConnectedComponents, []);
});

test('Python anti-gaming oracle rejects every negative fixture', () => {
  const result = spawnSync(
    pythonCommand(),
    [path.join(ROOT, 'scripts/check-python-structure.test.py')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
