// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  inventoryLegacyPartitions,
  migrationPlan,
  parseLegacyArgs,
} from './shifu-conan-legacy.mjs';

function cachePartition(root, name, rows) {
  const partition = path.join(root, name);
  const packages = path.join(partition, 'packages');
  fs.mkdirSync(packages, { recursive: true });
  const database = new DatabaseSync(path.join(packages, 'cache.sqlite3'));
  database.exec(
    'CREATE TABLE recipes (reference text NOT NULL, rrev text NOT NULL, path text NOT NULL UNIQUE, timestamp real NOT NULL, lru integer NOT NULL, UNIQUE(reference, rrev));',
  );
  database.exec(
    'CREATE TABLE packages (reference text NOT NULL, rrev text NOT NULL, pkgid text, prev text, path text NOT NULL UNIQUE, timestamp real NOT NULL, build_id text, lru integer NOT NULL, UNIQUE(reference, rrev, pkgid, prev));',
  );
  for (const [index, row] of rows.entries()) {
    const recipePath = `recipe-${index}`;
    const packagePath = `package-${index}`;
    fs.mkdirSync(path.join(packages, recipePath));
    fs.mkdirSync(path.join(packages, packagePath));
    database
      .prepare('INSERT INTO recipes VALUES (?, ?, ?, 1, 1)')
      .run(row.reference, row.rrev, recipePath);
    database
      .prepare('INSERT INTO packages VALUES (?, ?, ?, ?, ?, 1, NULL, 1)')
      .run(row.reference, row.rrev, row.packageId, row.prev, packagePath);
  }
  database.close();
  return partition;
}

test('legacy inventory reads exact identities without changing cache bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exact = cachePartition(root, 'development-111111111111', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const locked = cachePartition(root, 'development-222222222222', [
    {
      reference: 'flatbuffers/25.9.23',
      rrev: 'flatRecipe',
      packageId: 'flatPackage',
      prev: 'flatRevision',
    },
  ]);
  fs.writeFileSync(
    path.join(locked, '.shifu-conan.lock'),
    `${JSON.stringify({ pid: process.pid, acquiredAt: '2026-08-03T00:00:00Z' })}\n`,
  );
  const before = fs.readFileSync(path.join(exact, 'packages', 'cache.sqlite3'));
  const inventory = inventoryLegacyPartitions(root, Date.UTC(2026, 7, 3));
  assert.equal(inventory.partitionCount, 2);
  assert.equal(inventory.eligiblePartitionCount, 1);
  assert.equal(inventory.partitions[0].identity.confidence, 'exact');
  assert.equal(inventory.partitions[0].migrationEligibility, 'eligible');
  assert.equal(
    inventory.partitions[1].migrationEligibility,
    'skipped-lock-live',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(exact, 'packages', 'cache.sqlite3')),
    before,
  );
  assert.deepEqual(inventory.mutations, []);
});

test('migration plan is additive, exact, dry-run, and approval-bound', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  cachePartition(root, 'development-333333333333', [
    {
      reference: 'nng/1.11.0',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const plan = migrationPlan(inventoryLegacyPartitions(root));
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.deletion, false);
  assert.equal(plan.overwrite, false);
  assert.equal(plan.localArtifactMutation, false);
  assert.equal(plan.temporaryPartitionLock, true);
  assert.equal(plan.impact.totalSizeBytes > 0, true);
  assert.deepEqual(plan.exactReferences, [
    {
      partition: 'development-333333333333',
      reference: 'nng/1.11.0#recipeRevision:packageId#packageRevision',
    },
  ]);
  assert.match(plan.approval.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    plan.approval.schema,
    'shifu.conan-legacy-migration-approval/v1',
  );
  assert.match(plan.approval.executeCommand, /SHIFU_CONAN_MIGRATION_APPROVAL=/);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(root));
});

test('migration approval ignores empty mutable partition churn', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  cachePartition(root, 'development-555555555555', [
    {
      reference: 'nng/1.11.0',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const before = migrationPlan(inventoryLegacyPartitions(root));
  fs.mkdirSync(path.join(root, 'development-666666666666'));
  const afterEmptyPartition = migrationPlan(inventoryLegacyPartitions(root));
  assert.equal(afterEmptyPartition.impact.inventoryPartitionCount, 2);
  assert.equal(afterEmptyPartition.approval.digest, before.approval.digest);

  cachePartition(root, 'development-777777777777', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'otherRecipeRevision',
      packageId: 'otherPackageId',
      prev: 'otherPackageRevision',
    },
  ]);
  const afterEligiblePartition = migrationPlan(inventoryLegacyPartitions(root));
  assert.notEqual(
    afterEligiblePartition.approval.digest,
    before.approval.digest,
  );
});

test('legacy inventory rejects artifact paths that escape the package root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const partition = cachePartition(root, 'development-444444444444', [
    {
      reference: 'sqlite3/3.39.2',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const database = new DatabaseSync(
    path.join(partition, 'packages', 'cache.sqlite3'),
  );
  database
    .prepare('UPDATE packages SET path = ?')
    .run('../../outside-package-root');
  database.close();
  const inventory = inventoryLegacyPartitions(root);
  assert.equal(
    inventory.partitions[0].migrationEligibility,
    'skipped-identity-ambiguous',
  );
  assert.equal(
    inventory.partitions[0].identity.unsafeOrMissingArtifactPaths,
    1,
  );
});

test('legacy CLI is read-only by default and requires an explicit root', () => {
  assert.deepEqual(
    parseLegacyArgs(['inventory'], {
      SHIFU_CONAN_STORAGE_BASE: '/cache/conan',
    }),
    {
      command: 'inventory',
      execute: false,
      storageRoot: '/cache/conan',
      remote: 'workhub-conan',
    },
  );
  assert.throws(
    () => parseLegacyArgs(['inventory'], {}),
    /storage root is required/,
  );
  assert.throws(
    () =>
      parseLegacyArgs(['inventory', '--execute'], {
        SHIFU_CONAN_STORAGE_BASE: '/cache/conan',
      }),
    /always read-only/,
  );
});
