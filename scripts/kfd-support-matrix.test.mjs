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
const SHIFU = path.join(ROOT, 'shifu');
const AUTHORITY = path.join(ROOT, '.buildchain', 'kfd', 'support-matrix.json');
const KFD3_QUERY = path.join(
  ROOT,
  '.buildchain',
  'kfd',
  'kfd-3',
  'capability-query.json',
);
const BASE = JSON.parse(readFileSync(AUTHORITY, 'utf8'));
const BASE_QUERY = JSON.parse(readFileSync(KFD3_QUERY, 'utf8'));

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

function sourceFixture(t, matrix, query = BASE_QUERY) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kungfu-kfd-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const matrixPath = path.join(directory, 'support-matrix.json');
  const queryPath = path.join(directory, 'capability-query.json');
  writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  writeFileSync(queryPath, `${JSON.stringify(query, null, 2)}\n`);
  return spawnSync(process.execPath, [SCRIPT, '--source-check', '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      KUNGFU_KFD_SUPPORT_MATRIX_AUTHORITY: matrixPath,
      KUNGFU_KFD3_QUERY_AUTHORITY: queryPath,
    },
    encoding: 'utf8',
  });
}

test('validates the exact KFD-1 through KFD-13 authority', (t) => {
  const result = validateFixture(t, BASE);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rowCount, 13);
  const kfd4 = BASE.rows.find((row) => row.key === 'kfd-4');
  assert.equal(kfd4.supportStatus, 'candidate');
  assert.equal(kfd4.verification.status, 'passed');
  assert.equal(kfd4.buildchain.gateStatus, 'passed');
  assert.equal(kfd4.releaseQualification.shippedSupport, false);
  assert.deepEqual(kfd4.implementation.surfaces, [
    'framework/core/src/python/kungfu/rewind/perspective.py',
    'framework/core/tests/qualification/kfd4-perspective.mjs',
  ]);
  assert.deepEqual(
    kfd4.verification.evidenceRoots.map((entry) => entry.path),
    [
      'docs/qualification/evidence/kfd-4-perspective/d73cab0d69/report.json',
      'framework/core/tests/python/test_kfd4_perspective.py',
    ],
  );
  const kfd5 = BASE.rows.find((row) => row.key === 'kfd-5');
  assert.equal(kfd5.supportStatus, 'candidate');
  assert.equal(kfd5.verification.status, 'passed');
  assert.equal(kfd5.buildchain.gateStatus, 'passed');
  assert.equal(kfd5.releaseQualification.shippedSupport, false);
  assert.deepEqual(
    kfd5.verification.evidenceRoots.map((entry) => entry.path),
    [
      'docs/qualification/evidence/assignment-organization-rollout/7aae2c562a/report.json',
      'framework/core/tests/python/test_assignment_orchestration.py',
      'docs/architecture/primitive-management-plane.md',
      'framework/incubation/incubation-passport.registry.json',
      'framework/primitive/kungfu-primitive-catalog.contract.json',
    ],
  );
  const kfd6 = BASE.rows.find((row) => row.key === 'kfd-6');
  assert.equal(kfd6.supportStatus, 'unsupported');
  assert.equal(kfd6.implementation.status, 'not-implemented');
  assert.equal(kfd6.verification.status, 'none');
  assert.equal(kfd6.precursorEvidence.status, 'non-conforming-evidence');
  assert.deepEqual(kfd6.precursorEvidence.surfaces, [
    'framework/work-design-advisor/work-design-advisor.contract.json',
    'framework/work-design-policy-replay/work-design-policy-replay.contract.json',
    'framework/project-cut/README.md',
  ]);
  assert.equal(kfd6.releaseQualification.shippedSupport, false);
  const kfd10 = BASE.rows.find((row) => row.key === 'kfd-10');
  assert.equal(kfd10.supportStatus, 'draft-adopter-evidence');
  assert.equal(kfd10.implementation.status, 'implemented-specialized-witness');
  assert.deepEqual(kfd10.implementation.surfaces, [
    'framework/core/src/libkungfu/src/runtime/kfx/native_authority.cpp',
    'framework/kfx/kungfu-kfx-domain-profile.contract.json',
    'framework/core/src/python/kungfu/storage/kfx_service.py',
  ]);
  assert.deepEqual(
    kfd10.verification.evidenceRoots.map((entry) => entry.path),
    ['framework/kfx/evidence/kfd-10/runtime-warrant-adopter.json'],
  );
  assert.equal(kfd10.releaseQualification.shippedSupport, false);
});

test('fails closed when the KFD-5 candidate loses its passed product gate', (t) => {
  const matrix = clone(BASE);
  matrix.rows[4].buildchain.gateStatus = 'failed';
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /kfd-5 must remain a verified, Buildchain-gated, non-shipped candidate/,
  );
});

test('fails closed when KFD-5 loses Primitive Management evidence', (t) => {
  const matrix = clone(BASE);
  matrix.rows[4].verification.evidenceRoots.pop();
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KFD-5 Primitive Management evidence drifted/);
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

test('fails closed when KFD-6 precursor evidence implies conformance', (t) => {
  const matrix = clone(BASE);
  matrix.rows[5].precursorEvidence.status = 'passed';
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /precursor evidence must remain bounded and non-conforming/,
  );
});

test('fails closed when KFD-6 precursor evidence widens its claim', (t) => {
  const matrix = clone(BASE);
  matrix.rows[5].precursorEvidence.claimBoundary =
    'Work Design implements KFD-6 discovery.';
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /precursor evidence must remain bounded and non-conforming/,
  );
});

test('fails closed when draft evidence becomes shipped support', (t) => {
  const matrix = clone(BASE);
  matrix.rows[12].releaseQualification.shippedSupport = true;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /draft and cannot claim shipped support/);
});

test('fails closed when the KFD-10 specialized witness widens its boundary', (t) => {
  const matrix = clone(BASE);
  matrix.rows[9].exposure.cli = 'released-runtime-authority';
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KFD-10 specialized witness boundary drifted/);
});

test('fails closed when a KFD-4 candidate becomes shipped support', (t) => {
  const matrix = clone(BASE);
  matrix.rows[3].releaseQualification.shippedSupport = true;
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shipped support must remain exactly/);
});

test('fails closed when KFD-4 loses its retained perspective qualification', (t) => {
  const matrix = clone(BASE);
  matrix.rows[3].verification.evidenceRoots = [];
  const result = validateFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /KFD-4 perspective qualification evidence drifted/,
  );
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

test('Shifu separates the immediate human verdict from stable agent JSON', () => {
  const human = spawnSync(SHIFU, ['kfd', 'status'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /BOUNDED SUPPORT/);
  assert.match(human.stdout, /195 declared, 0 enforced/);
  assert.doesNotMatch(human.stdout, /^\s*\{/u);

  const agent = spawnSync(SHIFU, ['kfd', 'status', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(agent.status, 0, agent.stderr);
  const report = JSON.parse(agent.stdout);
  assert.equal(report.schema, 'shifu.kfd-source-report/v1');
  assert.equal(report.scope, 'source-checkout');
  assert.deepEqual(report.support.shipped, [
    'KFD-1',
    'KFD-2',
    'KFD-3',
    'KFD-7',
  ]);
  assert.equal(report.kfd3.enforcement.declaredSurfaceCount, 195);
  assert.equal(report.kfd3.enforcement.enforcedSurfaceCount, 0);
});

test('legacy KFD query alias delegates to the same source report', () => {
  const result = spawnSync(SHIFU, ['kfd:query', 'KFD-3', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'shifu.kfd-source-report/v1');
  assert.equal(report.operation, 'query');
  assert.equal(report.selection.id, 'KFD-3');
});

test('source check fails closed when retained evidence disappears', (t) => {
  const matrix = clone(BASE);
  matrix.rows[0].verification.evidenceRoots[0].path =
    '.buildchain/kfd/kfd-1/does-not-exist.json';
  const result = sourceFixture(t, matrix);
  assert.equal(result.status, 1);
  const diagnosis = JSON.parse(result.stdout);
  assert.equal(diagnosis.schema, 'shifu.kfd-source-diagnosis/v1');
  assert.match(diagnosis.message, /evidence is missing/);
  assert.equal(result.stderr, '');
});

test('source check never follows evidence outside the checkout', (t) => {
  const matrix = clone(BASE);
  matrix.rows[0].verification.evidenceRoots[0].path = '../outside.json';
  const result = sourceFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(
    JSON.parse(result.stdout).message,
    /escapes the source checkout/,
  );
});

test('source check rejects malformed and claim-widened matrices', (t) => {
  const malformed = clone(BASE);
  malformed.rows.pop();
  const malformedResult = sourceFixture(t, malformed);
  assert.equal(malformedResult.status, 1);
  assert.match(JSON.parse(malformedResult.stdout).message, /exactly 13 rows/);

  const widened = clone(BASE);
  widened.rows[3].releaseQualification.shippedSupport = true;
  const widenedResult = sourceFixture(t, widened);
  assert.equal(widenedResult.status, 1);
  assert.match(
    JSON.parse(widenedResult.stdout).message,
    /shipped support must remain exactly/,
  );
});

test('source check rejects a stale support projection', (t) => {
  const matrix = clone(BASE);
  matrix.rows[0].owner = 'stale-projection-fixture';
  const result = sourceFixture(t, matrix);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /projection is stale/);
});

test('source check rejects a malformed or failed KFD-3 query', (t) => {
  const query = clone(BASE_QUERY);
  query.status = 'failed';
  const result = sourceFixture(t, BASE, query);
  assert.equal(result.status, 1);
  assert.match(
    JSON.parse(result.stdout).message,
    /capability query is malformed or not passed/,
  );
});

test('declared KFD-3 surfaces cannot silently become enforced', (t) => {
  const matrix = clone(BASE);
  const query = clone(BASE_QUERY);
  query.capabilities[0].enforced = true;
  query.summary.enforced = 1;
  matrix.kfd3Enforcement.enforcedSurfaceCount = 1;
  const result = sourceFixture(t, matrix, query);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /enforced count drift/);
});

test('an enforced KFD-3 surface requires a retained passed hard Gate', (t) => {
  const matrix = clone(BASE);
  const query = clone(BASE_QUERY);
  const surfaceId = query.capabilities[0].id;
  query.capabilities[0].enforced = true;
  query.summary.enforced = 1;
  matrix.kfd3Enforcement.enforcedSurfaceCount = 1;
  matrix.kfd3Enforcement.gateBindings = [
    {
      surfaceId,
      gate: {
        path: '.buildchain/kfd/kfd-3/missing-hard-gate.json',
        sha256: `sha256:${'0'.repeat(64)}`,
        requiredStatus: 'passed',
      },
    },
  ];
  const result = sourceFixture(t, matrix, query);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /enforced Gate is missing/);
});
