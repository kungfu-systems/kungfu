// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..', '..');
const RUNNER = path.join(DIR, 'run.mjs');
const SDK_RUNNER = path.join(DIR, 'sdk', 'run.mjs');
const MATRIX = path.join(DIR, 'artifact-matrix.json');

function run(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('emits a bound report and passes the GUI deletion fixture', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-layer-test-'));
  try {
    const reportPath = path.join(temp, 'report.json');
    const result = run(['--report', reportPath]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.harness_valid, true);
    assert.equal(report.artifacts.length, 8);
    assert.equal(report.deletion_fixtures[0].status, 'passing');
    assert.ok(report.matrix_sha256);
    assert.ok(report.matrix_schema_sha256);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects a matrix that drops an official artifact', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-layer-test-'));
  try {
    const invalidPath = path.join(temp, 'invalid-matrix.json');
    const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
    matrix.artifacts = matrix.artifacts.filter(
      (artifact) => artifact.id !== 'format-spec',
    );
    fs.writeFileSync(
      invalidPath,
      `${JSON.stringify(matrix, null, 2)}\n`,
      'utf8',
    );
    const result = run(['--matrix', invalidPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifact ids must exactly match/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('validates the shared SDK semantic and wire fixtures without installed artifacts', () => {
  const result = spawnSync(process.execPath, [SDK_RUNNER, '--validate-only'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /fixtures valid; semantic_steps=7; semantic_sha256=[a-f0-9]{64}; wire_cases=2; wire_sha256=[a-f0-9]{64}/,
  );
});
