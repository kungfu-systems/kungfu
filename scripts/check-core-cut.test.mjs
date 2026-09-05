// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildCut,
  createCutReceipt,
  exportCut,
  importCut,
  verifyCut,
  verifyCutReceipt,
} from '../framework/work/cut/src/cut.mjs';
import {
  migrateProjectCut,
  verifyMigration,
} from '../framework/work/cut/src/project-cut-migration.mjs';
import { buildProjectCut } from '../framework/work/project-cut/index.mjs';

const root = (digit) => `sha256:${digit.repeat(64)}`;
const base = (
  profile = {
    id: 'course-production',
    version: 1,
    displayName: 'Course Release Cut',
    schemaRoot: root('1'),
  },
) => ({
  profile,
  parentCutRoots: [],
  bindings: [
    {
      type: 'course.release-package',
      authority: 'course-catalog',
      root: root('2'),
      schemaRoot: root('3'),
    },
  ],
  episodeDelta: { admitted: true, empty: false, root: root('4') },
  interpretation: {
    protocolRoot: root('5'),
    schemaRoot: root('6'),
    policyRoots: [root('7')],
  },
  uncertainty: { omissions: [], conflicts: [], unknowns: [] },
});

test('a non-software Profile creates, verifies, exports, and rebuilds the same Core Cut', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      'framework/work/cut/fixtures/course-production-cut-v1.json',
      'utf8',
    ),
  );
  const cut = buildCut(base());
  assert.equal(verifyCut(cut).valid, true);
  assert.deepEqual(importCut(exportCut(cut)), cut);
  assert.equal(createCutReceipt(cut).cutRoot, cut.cutRoot);
  assert.equal(JSON.stringify(cut).includes('git'), false);
  assert.deepEqual(cut, fixture.cut);
  assert.deepEqual(createCutReceipt(cut), fixture.receipt);
  assert.equal(verifyCutReceipt(cut, fixture.receipt).valid, true);
});

test('Core Cut fails closed on authority and canonical-order drift', () => {
  assert.throws(() => buildCut({ ...base(), bindings: [] }), {
    code: 'cut-invalid',
  });
  const cut = buildCut(base());
  assert.equal(verifyCut({ ...cut, cutRoot: root('f') }).valid, false);
});

test('legacy Project Cut migration creates a distinct root-bound identity and retains rollback', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      'framework/work/project-cut/fixtures/golden/project-cut-v1.json',
      'utf8',
    ),
  );
  const legacy = buildProjectCut(fixture.projectCutInput);
  const migration = migrateProjectCut(legacy);
  assert.notEqual(migration.cut.cutRoot, legacy.cutRoot);
  assert.equal(migration.cut.profile.displayName, 'Project Cut');
  assert.equal(migration.receipt.legacyCutRoot, legacy.cutRoot);
  assert.equal(
    migration.receipt.rollback,
    'read-legacy-project-cut-with-original-verifier',
  );
  assert.equal(verifyMigration(legacy, migration).valid, true);
  assert.equal(
    verifyMigration(legacy, {
      ...migration,
      receipt: { ...migration.receipt, cutRoot: root('e') },
    }).valid,
    false,
  );
});
