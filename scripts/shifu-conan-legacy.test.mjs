// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  copyPackageStoreForUpload,
  inventoryLegacyPartitions,
  migrationPlan,
  packageTreeFingerprint,
  parseLegacyArgs,
  withDisposablePackageStoreForUpload,
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

test('migration upload shadow is independent and leaves the legacy tree unchanged', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-shadow-'));
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-shadow-copy-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const partition = cachePartition(root, 'development-121212121212', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const packages = path.join(partition, 'packages');
  const before = packageTreeFingerprint(packages);
  const shadow = copyPackageStoreForUpload(packages, scratch);
  fs.writeFileSync(path.join(shadow, 'package-0', 'conan_package.tgz'), 'new');
  assert.equal(packageTreeFingerprint(packages), before);
  assert.notEqual(packageTreeFingerprint(shadow), before);
  assert.equal(
    fs.existsSync(path.join(packages, 'package-0', 'conan_package.tgz')),
    false,
  );
});

test('migration upload shadow is removed when one partition fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-shadow-'));
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-shadow-lifetime-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const partition = cachePartition(root, 'development-131313131313', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  assert.throws(
    () =>
      withDisposablePackageStoreForUpload(
        path.join(partition, 'packages'),
        scratch,
        (shadow) => {
          assert.equal(fs.existsSync(path.join(shadow, 'cache.sqlite3')), true);
          throw new Error('simulated upload failure');
        },
      ),
    /simulated upload failure/,
  );
  assert.deepEqual(fs.readdirSync(scratch), []);
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

test('legacy inventory skips a partition that vanishes after discovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vanished = path.join(root, 'development-888888888888');
  fs.mkdirSync(vanished);
  const originalLstatSync = fs.lstatSync;
  let removed = false;
  t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
    if (candidate === vanished && !removed) {
      removed = true;
      fs.rmSync(vanished, { recursive: true });
      const error = new Error(
        `ENOENT: no such file or directory, stat '${candidate}'`,
      );
      error.code = 'ENOENT';
      throw error;
    }
    return originalLstatSync(candidate, ...args);
  });

  const inventory = inventoryLegacyPartitions(root);
  assert.equal(inventory.partitionCount, 1);
  assert.equal(inventory.eligiblePartitionCount, 0);
  assert.deepEqual(inventory.partitions[0], {
    partition: 'development-888888888888',
    partitionDigest: inventory.partitions[0].partitionDigest,
    sizeBytes: 0,
    ageDays: null,
    modifiedAt: null,
    lock: { state: 'unavailable' },
    identity: {
      state: 'vanished',
      confidence: 'none',
      recipeCount: 0,
      packageCount: 0,
      references: [],
      exactReferences: [],
    },
    migrationEligibility: 'skipped-vanished',
  });
  assert.equal(
    migrationPlan(inventory).skippedPartitions[0].reason,
    'skipped-vanished',
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

test('legacy inventory rejects a packages root symlink outside storage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-root-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-outside-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const source = cachePartition(outside, 'development-aaaaaaaaaaaa', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const partition = path.join(root, 'development-bbbbbbbbbbbb');
  fs.mkdirSync(partition);
  fs.symlinkSync(
    path.join(source, 'packages'),
    path.join(partition, 'packages'),
  );
  const inventory = inventoryLegacyPartitions(root);
  assert.equal(inventory.eligiblePartitionCount, 0);
  assert.equal(
    inventory.partitions[0].migrationEligibility,
    'skipped-identity-ambiguous',
  );
  assert.equal(
    inventory.partitions[0].identity.unsafeRootReason,
    'packages-root-not-real-directory',
  );
});

test('legacy inventory rejects a symlink storage root', (t) => {
  const realRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-real-root-'),
  );
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-root-link-'),
  );
  const linkedRoot = path.join(parent, 'storage');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  t.after(() => fs.rmSync(realRoot, { recursive: true, force: true }));
  cachePartition(realRoot, 'development-eeeeeeeeeeee', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  fs.symlinkSync(realRoot, linkedRoot);
  assert.throws(
    () => inventoryLegacyPartitions(linkedRoot),
    /storage root must be a real directory/,
  );
});

test('legacy inventory rejects a partition replaced by a symlink after discovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-race-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-outside-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const name = 'development-cccccccccccc';
  const partition = cachePartition(root, name, [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'recipeRevision',
      packageId: 'packageId',
      prev: 'packageRevision',
    },
  ]);
  const external = cachePartition(outside, 'development-dddddddddddd', [
    {
      reference: 'rocksdb/6.29.5',
      rrev: 'outsideRecipeRevision',
      packageId: 'outsidePackageId',
      prev: 'outsidePackageRevision',
    },
  ]);
  const originalLstatSync = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
    if (candidate === partition && !replaced) {
      replaced = true;
      fs.rmSync(partition, { recursive: true });
      fs.symlinkSync(external, partition);
    }
    return originalLstatSync(candidate, ...args);
  });
  const inventory = inventoryLegacyPartitions(root);
  assert.equal(inventory.eligiblePartitionCount, 0);
  assert.equal(
    inventory.partitions[0].migrationEligibility,
    'skipped-identity-ambiguous',
  );
  assert.equal(
    inventory.partitions[0].identity.unsafeRootReason,
    'partition-root-not-real-directory',
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
