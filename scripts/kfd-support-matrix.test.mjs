// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'kfd-support-matrix.mjs');
const AUTHORITY = path.join(ROOT, '.buildchain', 'kfd', 'support-matrix.json');
const BASE = JSON.parse(readFileSync(AUTHORITY, 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFixture(t, value) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kungfu-kfd-matrix-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const matrixPath = path.join(directory, 'support-matrix.json');
  writeFileSync(matrixPath, `${JSON.stringify(value, null, 2)}\n`);
  return spawnSync(process.execPath, [SCRIPT, '--validate'], {
    cwd: ROOT,
    env: {
      ...process.env,
      KUNGFU_KFD_SUPPORT_MATRIX_AUTHORITY: matrixPath,
    },
    encoding: 'utf8',
  });
}

test('validates the exact KFD-1 through KFD-13 authority', (t) => {
  const result = validateFixture(t, BASE);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rowCount, 13);
});

test('fails closed when a KFD row is omitted', (t) => {
  const matrix = clone(BASE);
  matrix.rows.pop();
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly 13 rows/);
});

test('fails closed when a KFD row is duplicated', (t) => {
  const matrix = clone(BASE);
  matrix.rows[12] = clone(matrix.rows[11]);
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate KFD keys/);
});

test('fails closed when KFD-6 implies adoption', (t) => {
  const matrix = clone(BASE);
  matrix.rows[5].supportStatus = 'candidate';
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KFD-6 must remain an explicit unsupported/);
});

test('fails closed when draft evidence becomes shipped support', (t) => {
  const matrix = clone(BASE);
  matrix.rows[12].releaseQualification.shippedSupport = true;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /draft and cannot claim shipped support/);
});

test('fails closed when a KFD-4 candidate becomes shipped support', (t) => {
  const matrix = clone(BASE);
  matrix.rows[3].releaseQualification.shippedSupport = true;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shipped support must remain exactly/);
});

test('fails closed when a supported release claim is omitted', (t) => {
  const matrix = clone(BASE);
  matrix.rows[6].releaseQualification.shippedSupport = false;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shipped support must remain exactly/);
});

test('fails closed on stale normative KFD metadata', (t) => {
  const matrix = clone(BASE);
  matrix.rows[0].normative.revision += 1;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /normative projection drifts/);
});
