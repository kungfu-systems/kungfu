// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractFunctions } from '../framework/maintainability/function-risk.mjs';
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

test('build-free entrypoint regenerates a zero-blocking exact-source report', () => {
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

test('Agent Python responsibility map conserves exact targets and reduced risk', () => {
  const map = readJson(
    'framework/maintainability/agent-python-responsibility-map.json',
  );
  const structure = spawnSync(
    pythonCommand(),
    [path.join(ROOT, 'scripts/check-agent-python-responsibility-map.py')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(structure.status, 0, structure.stderr || structure.stdout);
  const layers = readJson('framework/core/architecture/layers.json');
  const ownership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  const metrics = (bytes, pathname) => {
    const functions = extractFunctions(
      { path: pathname, bytes },
      layers,
      ownership,
    );
    return {
      functions: functions.length,
      total: functions.reduce((total, item) => total + item.baseRisk, 0),
      maximum: Math.max(...functions.map((item) => item.baseRisk)),
    };
  };
  for (const target of map.targets) {
    const baseline = spawnSync(
      'git',
      ['show', `${map.baselineRevision}:${target.sourcePath}`],
      { cwd: ROOT },
    );
    assert.equal(baseline.status, 0, baseline.stderr.toString());
    const current = fs.readFileSync(path.join(ROOT, target.sourcePath));
    assert.deepEqual(
      metrics(baseline.stdout, target.sourcePath),
      target.baseline.functionRisk,
      target.sourcePath,
    );
    assert.deepEqual(
      metrics(current, target.sourcePath),
      target.current.functionRisk,
      target.sourcePath,
    );
    assert.ok(
      target.current.functionRisk.total < target.baseline.functionRisk.total,
      target.sourcePath,
    );
  }
});

test('Agent Python responsibility checker fails closed on a missing owner source', () => {
  const checker = fs.readFileSync(
    path.join(ROOT, 'scripts/check-agent-python-responsibility-map.py'),
    'utf8',
  );
  const measure = checker.slice(
    checker.indexOf('function measure(files, paths)'),
    checker.indexOf('process.stdout.write'),
  );
  const missingGuard = measure.indexOf('required owner source paths missing:');
  const transition = measure.indexOf('const transition = analyzeTransition');
  assert.ok(missingGuard >= 0);
  assert.ok(transition > missingGuard);
  assert.match(measure, /new Set\(files\.map\(\(\{ path \}\) => path\)\)/u);
});
