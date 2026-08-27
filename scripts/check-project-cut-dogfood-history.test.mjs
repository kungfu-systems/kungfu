// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readJson(
  'framework/data-protection/project-cut-dogfood-history.contract.json',
);
const parent = readJson(
  'framework/data-protection/kungfu-data-protection.contract.json',
);
const exitContract = readJson(
  'framework/exit/kungfu-exit-bundle.contract.json',
);

test('binds Project Cut history to one owner adapter and four frozen roots', () => {
  assert.equal(
    contract.schema,
    'kungfu.project-cut-dogfood-history.contract/v1',
  );
  assert.equal(contract.status, 'source-qualified');
  assert.equal(contract.parentContract.id, parent.id);
  assert.equal(contract.authority.kind, 'composition-and-routing-contract');
  assert.equal(contract.authority.projectCutOwner, 'Project Cut protocol');
  assert.match(contract.authority.rule, /never become semantic authority/u);
  assert.deepEqual(contract.projectCutIdentity.requiredRoots, [
    'cutRoot',
    'serializationRoot',
    'artifactDigest',
    'receiptRoot',
  ]);
  assert.match(
    contract.projectCutIdentity.relations.predecessor,
    /parentCutRoots/u,
  );
  assert.match(
    contract.projectCutIdentity.relations.successor,
    /successor manifests/u,
  );
  assert.deepEqual(contract.projectCutIdentity.settlementStates, [
    'settled-unpublished',
    'published',
  ]);
  assert.match(contract.projectCutIdentity.publication, /manifestRoot/u);
});

test('reuses native Assignment and Dogfood authorities without a second store', () => {
  assert.deepEqual(contract.exitComposition.nativeAssignmentMembers, [
    'fact-authority-v2',
    'fact-library-v1',
    'episode-v1',
  ]);
  assert.deepEqual(contract.exitComposition.dogfoodMembers, [
    'profile-source-v1',
    'fact-library-v1',
    'episode-v1',
  ]);
  assert.match(
    contract.exitComposition.singularity,
    /declared owner verifier/u,
  );
  assert.equal(
    contract.projectionBoundaries.every((row) =>
      ['observer-projection', 'cache-rebuildable'].includes(row.classification),
    ),
    true,
  );
});

test('registers the Project Cut member in both the public request and composer', () => {
  const inventory = exitContract.memberInventory.find(
    (member) => member.id === 'project-cut-v1',
  );
  assert.ok(inventory);
  assert.equal(inventory.eligibleMember, true);
  assert.deepEqual(inventory.modes, ['full', 'thin']);
  assert.equal(inventory.schemas[0], 'kungfu.project-cut.history-bundle/v1');
  assert.ok(
    exitContract.requestSchema.properties.members.items.properties.kind.enum.includes(
      'project-cut-v1',
    ),
  );
  const composer = read(
    'framework/core/src/python/kungfu/_exit_bundle/common.py',
  );
  assert.match(composer, /"project-cut-v1": \{/u);
  assert.match(composer, /_project_cut_build_bundle/u);
  assert.match(composer, /_project_cut_import_bundle/u);
});

test('full and thin migration claims stay fail closed', () => {
  assert.deepEqual(contract.modeSemantics.full.capabilities, [
    'inspect',
    'verify-inventory',
    'verify-content',
    'materialize',
  ]);
  assert.deepEqual(contract.modeSemantics.thin.capabilities, [
    'inspect',
    'verify-inventory',
  ]);
  assert.equal(contract.modeSemantics.thin.import, 'forbidden');
  assert.match(contract.migration.destinationPreflight, /before any write/u);
  assert.match(
    contract.migration.successorRule,
    /old roots keep their original verifier/u,
  );
  assert.ok(
    contract.privacy.excluded.includes('absolute user or worktree paths'),
  );
  assert.ok(contract.privacy.excluded.includes('credentials'));
  assert.ok(contract.qualification.requiredCases.includes('unknown-member'));
  assert.ok(contract.qualification.requiredCases.includes('root-tamper'));
  assert.ok(
    contract.qualification.requiredCases.includes('projection-only-recovery'),
  );
  assert.match(contract.nonClaims.join('\n'), /physical-media durability/u);
});
