// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  assertExecutionEnvironment,
  conanCommand,
  gitRevision,
  packageRevisionRefs,
} from './shifu-conan-publish.mjs';

function fail(message) {
  throw new Error(message);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function directorySize(root) {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    bytes += stat.size;
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current))
      pending.push(path.join(current, entry));
  }
  return bytes;
}

export function packageTreeFingerprint(root) {
  const records = [];
  const pending = [[root, '.']];
  while (pending.length > 0) {
    const [current, relative] = pending.pop();
    const stat = fs.lstatSync(current, { bigint: true });
    let type = 'other';
    if (stat.isDirectory()) type = 'directory';
    else if (stat.isFile()) type = 'file';
    else if (stat.isSymbolicLink()) type = 'symlink';
    records.push(
      [
        relative,
        type,
        stat.dev,
        stat.ino,
        stat.mode,
        stat.nlink,
        stat.size,
        stat.mtimeNs,
        type === 'symlink' ? fs.readlinkSync(current) : '',
      ].join('\0'),
    );
    if (!stat.isDirectory()) continue;
    const entries = fs.readdirSync(current).sort().reverse();
    for (const entry of entries)
      pending.push([
        path.join(current, entry),
        relative === '.' ? entry : path.join(relative, entry),
      ]);
  }
  return digest(records.sort().join('\n'));
}

export function copyPackageStoreForUpload(packagesRoot, scratchRoot) {
  const destination = path.join(scratchRoot, 'packages');
  fs.cpSync(packagesRoot, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return destination;
}

export function withDisposablePackageStoreForUpload(
  packagesRoot,
  scratchRoot,
  callback,
) {
  const partitionScratch = fs.mkdtempSync(
    path.join(scratchRoot, 'package-store-'),
  );
  try {
    return callback(copyPackageStoreForUpload(packagesRoot, partitionScratch));
  } finally {
    fs.rmSync(partitionScratch, { recursive: true, force: true });
  }
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'stale';
    return 'unknown';
  }
}

function lockState(partitionRoot) {
  const lock = path.join(partitionRoot, '.shifu-conan.lock');
  if (!fs.existsSync(lock)) return { state: 'absent' };
  try {
    const value = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return {
      state: processState(value.pid),
      acquiredAt:
        typeof value.acquiredAt === 'string' ? value.acquiredAt : null,
    };
  } catch {
    return { state: 'unreadable' };
  }
}

function isSafeArtifactPath(packagesRoot, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value))
    return false;
  const candidate = path.resolve(packagesRoot, value);
  const relative = path.relative(packagesRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return false;
    const canonicalRoot = fs.realpathSync(packagesRoot);
    const canonicalCandidate = fs.realpathSync(candidate);
    const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
    return (
      !canonicalRelative.startsWith('..') && !path.isAbsolute(canonicalRelative)
    );
  } catch {
    return false;
  }
}

function emptyIdentity(state = 'empty') {
  return {
    state,
    confidence: 'none',
    recipeCount: 0,
    packageCount: 0,
    references: [],
    exactReferences: [],
  };
}

function unsafeRootIdentity(reason) {
  return {
    ...emptyIdentity('unsafe-root'),
    confidence: 'ambiguous',
    unsafeRootReason: reason,
  };
}

function storageRootSnapshot(storageRoot) {
  const stat = fs.lstatSync(storageRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail('Conan storage root must be a real directory, not a symlink');
  return {
    canonicalRoot: fs.realpathSync(storageRoot),
    fingerprint: {
      device: String(stat.dev),
      inode: String(stat.ino),
    },
  };
}

function assertStableStorageRoot(storageRoot, expected = null) {
  const snapshot = storageRootSnapshot(storageRoot);
  if (
    expected &&
    (snapshot.canonicalRoot !== expected.canonicalRoot ||
      JSON.stringify(snapshot.fingerprint) !==
        JSON.stringify(expected.fingerprint))
  )
    fail('Conan storage root changed during migration');
  return snapshot;
}

function partitionRootSnapshot(partitionRoot, storage = null) {
  let partitionStat;
  try {
    partitionStat = fs.lstatSync(partitionRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'vanished' };
    throw error;
  }
  if (partitionStat.isSymbolicLink() || !partitionStat.isDirectory())
    return { state: 'unsafe', reason: 'partition-root-not-real-directory' };
  const packagesRoot = path.join(partitionRoot, 'packages');
  let packagesStat;
  try {
    packagesStat = fs.lstatSync(packagesRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'empty' };
    throw error;
  }
  if (packagesStat.isSymbolicLink() || !packagesStat.isDirectory())
    return { state: 'unsafe', reason: 'packages-root-not-real-directory' };
  const canonicalPartition = fs.realpathSync(partitionRoot);
  const canonicalPackages = fs.realpathSync(packagesRoot);
  if (storage) {
    const relative = path.relative(storage.canonicalRoot, canonicalPartition);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative !== path.basename(partitionRoot)
    )
      return {
        state: 'unsafe',
        reason: 'partition-root-canonical-path-escaped',
      };
  }
  if (path.relative(canonicalPartition, canonicalPackages) !== 'packages')
    return { state: 'unsafe', reason: 'packages-root-canonical-path-escaped' };
  return {
    state: 'safe',
    packagesRoot,
    fingerprint: {
      partitionDevice: String(partitionStat.dev),
      partitionInode: String(partitionStat.ino),
      packagesDevice: String(packagesStat.dev),
      packagesInode: String(packagesStat.ino),
      canonicalPartition,
      canonicalPackages,
    },
  };
}

function assertStablePartitionRoot(
  partitionRoot,
  expected = null,
  storage = null,
) {
  const snapshot = partitionRootSnapshot(partitionRoot, storage);
  if (snapshot.state !== 'safe')
    fail(
      `unsafe legacy partition root ${path.basename(partitionRoot)}: ${snapshot.reason || snapshot.state}`,
    );
  if (
    expected &&
    JSON.stringify(snapshot.fingerprint) !== JSON.stringify(expected)
  )
    fail(
      `legacy partition root changed during migration: ${path.basename(partitionRoot)}`,
    );
  return snapshot;
}

function cacheIdentity(partitionRoot, storage = null) {
  const root = partitionRootSnapshot(partitionRoot, storage);
  if (root.state === 'vanished') return emptyIdentity('vanished');
  if (root.state === 'empty') return emptyIdentity();
  if (root.state !== 'safe') return unsafeRootIdentity(root.reason);
  const packagesRoot = root.packagesRoot;
  const databasePath = path.join(packagesRoot, 'cache.sqlite3');
  let databaseStat;
  try {
    databaseStat = fs.lstatSync(databasePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyIdentity();
    throw error;
  }
  if (databaseStat.isSymbolicLink() || !databaseStat.isFile())
    return unsafeRootIdentity('cache-database-not-real-file');
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const recipes = database
      .prepare(
        'SELECT reference, rrev, path FROM recipes ORDER BY reference, rrev',
      )
      .all();
    const packages = database
      .prepare(
        'SELECT reference, rrev, pkgid, prev, path FROM packages ORDER BY reference, rrev, pkgid, prev',
      )
      .all();
    const incomplete = packages.filter(
      (row) => !row.reference || !row.rrev || !row.pkgid || !row.prev,
    );
    const unsafeOrMissingPaths = [...recipes, ...packages].filter(
      (row) => !isSafeArtifactPath(packagesRoot, row.path),
    );
    const exactReferences = packages.map(
      (row) => `${row.reference}#${row.rrev}:${row.pkgid}#${row.prev}`,
    );
    return {
      state:
        incomplete.length > 0 || unsafeOrMissingPaths.length > 0
          ? 'ambiguous'
          : 'readable',
      confidence:
        incomplete.length === 0 && unsafeOrMissingPaths.length === 0
          ? 'exact'
          : 'ambiguous',
      recipeCount: recipes.length,
      packageCount: packages.length,
      references: [...new Set(recipes.map((row) => row.reference))].sort(),
      exactReferences: [...new Set(exactReferences)].sort(),
      incompletePackageRows: incomplete.length,
      unsafeOrMissingArtifactPaths: unsafeOrMissingPaths.length,
    };
  } catch (error) {
    return {
      state: 'corrupt-or-unsupported',
      confidence: 'none',
      recipeCount: 0,
      packageCount: 0,
      references: [],
      exactReferences: [],
      errorClass: error?.code || error?.name || 'database-error',
    };
  } finally {
    database?.close();
  }
}

export function inventoryLegacyPartitions(storageRoot, now = Date.now()) {
  const absoluteRoot = path.resolve(storageRoot);
  let storage;
  let names;
  try {
    storage = storageRootSnapshot(absoluteRoot);
    names = fs
      .readdirSync(absoluteRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^development-[a-f0-9]{12}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    fail(`cannot inventory Conan storage root: ${error.message}`);
  }
  const partitions = names.map((name) => {
    const partitionRoot = path.join(absoluteRoot, name);
    let stat;
    try {
      stat = fs.lstatSync(partitionRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return {
        partition: name,
        partitionDigest: digest(name),
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
      };
    }
    const identity = cacheIdentity(partitionRoot, storage);
    const lock =
      identity.state === 'unsafe-root' || identity.state === 'vanished'
        ? { state: 'unavailable' }
        : lockState(partitionRoot);
    let eligibility = 'eligible';
    if (identity.state === 'vanished') eligibility = 'skipped-vanished';
    else if (identity.state === 'unsafe-root')
      eligibility = 'skipped-identity-ambiguous';
    else if (lock.state !== 'absent')
      eligibility = `skipped-lock-${lock.state}`;
    else if (identity.state === 'corrupt-or-unsupported')
      eligibility = 'skipped-corrupt';
    else if (identity.confidence !== 'exact')
      eligibility =
        identity.state === 'empty'
          ? 'skipped-empty'
          : 'skipped-identity-ambiguous';
    else if (identity.packageCount === 0) eligibility = 'skipped-empty';
    return {
      partition: name,
      partitionDigest: digest(name),
      sizeBytes: directorySize(partitionRoot),
      ageDays: Math.max(0, Math.floor((now - stat.mtimeMs) / 86_400_000)),
      modifiedAt: stat.mtime.toISOString(),
      lock,
      identity,
      migrationEligibility: eligibility,
    };
  });
  return {
    schema: 'shifu.conan-legacy-inventory/v1',
    mode: 'read-only',
    storageRootDigest: digest(absoluteRoot),
    partitionCount: partitions.length,
    totalSizeBytes: partitions.reduce((total, row) => total + row.sizeBytes, 0),
    eligiblePartitionCount: partitions.filter(
      (row) => row.migrationEligibility === 'eligible',
    ).length,
    partitions,
    mutations: [],
  };
}

export function migrationPlan(inventory, remote = 'workhub-conan') {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) fail('invalid remote name');
  const candidates = new Map();
  for (const partition of inventory.partitions) {
    if (partition.migrationEligibility !== 'eligible') continue;
    for (const reference of partition.identity.exactReferences) {
      if (!candidates.has(reference))
        candidates.set(reference, partition.partition);
    }
  }
  const exactReferences = [...candidates].map(([reference, partition]) => ({
    reference,
    partition,
  }));
  const plan = {
    schema: 'shifu.conan-legacy-migration-plan/v1',
    mode: 'dry-run',
    remote,
    identity: 'rrev-package-id-prev',
    storageRootDigest: inventory.storageRootDigest,
    impact: {
      inventoryPartitionCount: inventory.partitionCount,
      eligiblePartitionCount: inventory.eligiblePartitionCount,
      totalSizeBytes: inventory.totalSizeBytes,
      exactReferenceCount: exactReferences.length,
    },
    exactReferences,
    skippedPartitions: inventory.partitions
      .filter((row) => row.migrationEligibility !== 'eligible')
      .map((row) => ({
        partition: row.partition,
        reason: row.migrationEligibility,
      })),
    skippedLayers: [
      {
        layer: 'legacy-download-cache',
        reason: 'transport keys do not prove RREV/package_id/PREV identity',
      },
      {
        layer: 'build-and-generator-folders',
        reason: 'mutable worktree state is never migrated as a Conan artifact',
      },
    ],
    operations: [
      'recheck every partition lock and exact local identity',
      'query the remote for each exact reference',
      'copy an eligible package store to disposable scratch only when an exact reference is absent',
      'upload only absent exact references from scratch with --check and without --force',
      'read back every exact RREV/package_id/PREV',
      'verify the legacy package-tree metadata fingerprint is unchanged',
      'leave every legacy byte in place',
    ],
    deletion: false,
    overwrite: false,
    localArtifactMutation: false,
    temporaryPartitionLock: true,
    rollback:
      'No local rollback is needed because legacy bytes are retained; remote artifacts are additive and remain subject to repository retention policy.',
  };
  const approvalBasis = {
    schema: 'shifu.conan-legacy-migration-approval/v1',
    remote,
    identity: plan.identity,
    storageRootDigest: plan.storageRootDigest,
    exactReferences,
  };
  const approvalDigest = digest(JSON.stringify(approvalBasis));
  plan.approval = {
    schema: approvalBasis.schema,
    digest: approvalDigest,
    binds: [
      'remote',
      'storage-root',
      'eligible-partition',
      'rrev-package-id-prev',
    ],
    ignores: ['read-only-inventory-timestamp', 'empty-mutable-partition-churn'],
    executeCommand:
      `SHIFU_CONAN_MIGRATION_APPROVAL=${approvalDigest} ` +
      `./shifu cache apply -- node scripts/shifu-conan-legacy.mjs migrate --remote ${remote} --execute`,
    storageRootEnvironment: 'SHIFU_CONAN_STORAGE_BASE',
  };
  return plan;
}

function remoteContains(reference, remote, queryStorageRoot) {
  const payload = JSON.parse(
    conanCommand(
      [
        'list',
        reference,
        '--remote',
        remote,
        '-cc',
        `core.cache:storage_path=${queryStorageRoot}`,
        '--format=json',
      ],
      { capture: true, originalPath: true },
    ),
  );
  return packageRevisionRefs(payload).includes(reference);
}

export function withPartitionLock(storageRoot, partition, callback) {
  const storage = assertStableStorageRoot(storageRoot);
  const partitionRoot = path.join(storageRoot, partition);
  const before = assertStablePartitionRoot(partitionRoot, null, storage);
  const lockPath = path.join(partitionRoot, '.shifu-conan.lock');
  const token = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
        purpose: 'legacy-additive-migration',
      })}\n`,
    );
  } catch (error) {
    fail(
      error?.code === 'EEXIST'
        ? `partition became locked: ${partition}`
        : `cannot lock partition ${partition}: ${error.message}`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let released = false;
  const release = () => {
    if (released) return;
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.token !== token)
      fail(`partition lock ownership changed: ${partition}`);
    fs.unlinkSync(lockPath);
    released = true;
  };
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      try {
        release();
      } finally {
        for (const [name, value] of signalHandlers)
          process.removeListener(name, value);
        process.kill(process.pid, signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    assertStableStorageRoot(storageRoot, storage);
    assertStablePartitionRoot(partitionRoot, before.fingerprint, storage);
    const identity = cacheIdentity(partitionRoot, storage);
    if (identity.confidence !== 'exact')
      fail(`partition identity became ambiguous: ${partition}`);
    const packageTreeBefore = packageTreeFingerprint(before.packagesRoot);
    let result;
    let operationError;
    try {
      result = callback(identity, before.fingerprint, storage);
    } catch (error) {
      operationError = error;
    }
    let verificationError;
    try {
      assertStableStorageRoot(storageRoot, storage);
      const after = assertStablePartitionRoot(
        partitionRoot,
        before.fingerprint,
        storage,
      );
      if (packageTreeFingerprint(after.packagesRoot) !== packageTreeBefore)
        fail(`legacy package tree changed during migration: ${partition}`);
    } catch (error) {
      verificationError = error;
    }
    if (operationError && verificationError)
      throw new AggregateError(
        [operationError, verificationError],
        `legacy migration operation and verification both failed for ${partition}: ${operationError.message}; ${verificationError.message}`,
      );
    if (operationError) throw operationError;
    if (verificationError) throw verificationError;
    return result;
  } finally {
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);
    release();
  }
}

export function executeMigration(storageRoot, remote) {
  assertExecutionEnvironment(remote);
  const sourceRevision = gitRevision();
  const inventory = inventoryLegacyPartitions(storageRoot);
  const plan = migrationPlan(inventory, remote);
  if (process.env.SHIFU_CONAN_MIGRATION_APPROVAL !== plan.approval.digest)
    fail(`migration requires exact approval digest ${plan.approval.digest}`);
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-legacy-migrate-'),
  );
  try {
    const queryStorageRoot = path.join(scratch, 'remote-query');
    fs.mkdirSync(queryStorageRoot);
    conanCommand(['remote', 'auth', remote, '--force', '--strict'], {
      originalPath: true,
    });
    const published = [];
    const alreadyPresent = [];
    const byPartition = new Map();
    for (const candidate of plan.exactReferences) {
      const values = byPartition.get(candidate.partition) || [];
      values.push(candidate.reference);
      byPartition.set(candidate.partition, values);
    }
    for (const [partition, references] of byPartition) {
      withPartitionLock(
        storageRoot,
        partition,
        (identity, fingerprint, storage) => {
          const exact = new Set(identity.exactReferences);
          const missing = [];
          for (const reference of references) {
            assertStablePartitionRoot(
              path.join(storageRoot, partition),
              fingerprint,
              assertStableStorageRoot(storageRoot, storage),
            );
            if (!exact.has(reference))
              fail(
                `partition no longer contains exact reference: ${reference}`,
              );
            if (remoteContains(reference, remote, queryStorageRoot))
              alreadyPresent.push(reference);
            else missing.push(reference);
          }
          if (missing.length === 0) return;
          withDisposablePackageStoreForUpload(
            path.join(storageRoot, partition, 'packages'),
            scratch,
            (uploadStorageRoot) => {
              for (const reference of missing) {
                conanCommand(
                  [
                    'upload',
                    reference,
                    '--remote',
                    remote,
                    '--check',
                    '--confirm',
                    '-cc',
                    `core.cache:storage_path=${uploadStorageRoot}`,
                  ],
                  { originalPath: true },
                );
                if (!remoteContains(reference, remote, queryStorageRoot))
                  fail(
                    `remote read-back missing exact reference: ${reference}`,
                  );
                published.push(reference);
              }
            },
          );
          assertStablePartitionRoot(
            path.join(storageRoot, partition),
            fingerprint,
            assertStableStorageRoot(storageRoot, storage),
          );
        },
      );
    }
    return {
      schema: 'shifu.conan-legacy-migration-receipt/v1',
      sourceRevision,
      approvalDigest: plan.approval.digest,
      remote,
      identity: plan.identity,
      alreadyPresent,
      published,
      retainedLegacyPartitions: inventory.partitionCount,
      localDeletion: false,
      localOverwrite: false,
      localArtifactMutation: false,
      migrationUploadSource: 'disposable-shadow-package-store',
      outcome: 'additive-upload-and-exact-read-back',
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function parseLegacyArgs(argv, env = process.env) {
  const command = argv[0] || '';
  if (!['inventory', 'migrate'].includes(command))
    fail(
      'usage: shifu-conan-legacy.mjs <inventory|migrate> [--storage-root PATH] [--remote NAME] [--execute]',
    );
  const options = {
    command,
    execute: false,
    storageRoot: String(env.SHIFU_CONAN_STORAGE_BASE || ''),
    remote: 'workhub-conan',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--storage-root') {
      options.storageRoot = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--remote') {
      options.remote = argv[index + 1] || '';
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  if (!options.storageRoot)
    fail(
      'storage root is required through --storage-root or SHIFU_CONAN_STORAGE_BASE',
    );
  if (command === 'inventory' && options.execute)
    fail('inventory is always read-only and does not accept --execute');
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseLegacyArgs(process.argv.slice(2));
    const inventory = inventoryLegacyPartitions(options.storageRoot);
    let output = inventory;
    if (options.command === 'migrate')
      output = options.execute
        ? executeMigration(options.storageRoot, options.remote)
        : migrationPlan(inventory, options.remote);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`shifu conan legacy: ${error.message}\n`);
    process.exitCode = 1;
  }
}
