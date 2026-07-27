// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MATRIX_PATH = path.join(
  ROOT,
  'framework/maintainability/terminal-evidence-matrix.json',
);
const REQUIRED_ASSIGNMENTS = [
  '2026-07-26-kungfu-authority-convergence',
  '2026-07-26-kungfu-responsibility-hotspot-decomposition',
  '2026-07-26-kungfu-linux-product-qualification',
  '2026-07-26-kungfu-windows-product-qualification',
  '2026-07-26-kungfu-dogfood-operational-hardening',
  '2026-07-27-kungfu-complexity-gate-integrity',
  '2026-07-27-kungfu-readonly-source-acceptance-closure',
];

function repositoryPathExists(reference) {
  if (/^https:\/\//u.test(reference)) return true;
  return fs.existsSync(path.join(ROOT, reference));
}

test('terminal maintainability evidence matrix is complete and exact-head bound', () => {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));

  assert.equal(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v1',
  );
  assert.equal(matrix.sourceBinding.repository, 'kungfu-systems/kungfu');
  assert.equal(matrix.sourceBinding.protectedBranch, 'dev/v4/v4.0');
  assert.equal(matrix.sourceBinding.deliveryPullRequest, 1578);
  assert.match(matrix.sourceBinding.exactHeadRule, /exact protected commit/u);
  assert.deepEqual(matrix.exceptions, []);
  for (const workflow of [
    matrix.terminalEvidence.sourceWorkflow,
    matrix.terminalEvidence.platformPreflightWorkflow,
    matrix.terminalEvidence.productWorkflow,
  ]) {
    assert.equal(repositoryPathExists(workflow), true, workflow);
  }

  assert.deepEqual(
    matrix.rows.map((row) => row.assignmentId).sort(),
    [...REQUIRED_ASSIGNMENTS].sort(),
  );
  assert.equal(new Set(matrix.rows.map((row) => row.assignmentId)).size, 7);
  assert.deepEqual(matrix.terminalEvidence.requiredPreflightPlatforms, [
    'linux-x64',
    'macos-arm64',
    'windows-x64',
  ]);
  assert.deepEqual(matrix.terminalEvidence.requiredProductPlatforms, [
    'linux-x64',
    'macos-arm64',
    'windows-x64',
  ]);
  assert.equal(matrix.terminalEvidence.reviewRule.reviewer, 'kungfu-origin');
  assert.equal(matrix.terminalEvidence.reviewRule.decision, 'APPROVED');
  assert.equal(matrix.terminalEvidence.reviewRule.freshContext, true);

  for (const row of matrix.rows) {
    assert.equal(row.disposition, 'implemented', row.assignmentId);
    assert.ok(row.obligations.length > 0, row.assignmentId);
    assert.ok(row.sourceEvidence.length > 0, row.assignmentId);
    assert.ok(row.rawChecks.length > 0, row.assignmentId);
    assert.ok(row.productPlatforms.length > 0, row.assignmentId);
    assert.ok(row.reviewDisposition, row.assignmentId);
    for (const reference of [...row.sourceEvidence, ...row.rawChecks]) {
      assert.equal(
        repositoryPathExists(reference),
        true,
        `${row.assignmentId}: missing ${reference}`,
      );
    }
  }
});
