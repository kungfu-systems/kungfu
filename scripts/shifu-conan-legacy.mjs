// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
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

function cacheIdentity(partitionRoot) {
  const packagesRoot = path.join(partitionRoot, 'packages');
  const databasePath = path.join(packagesRoot, 'cache.sqlite3');
  if (!fs.existsSync(databasePath))
    return {
      state: 'empty',
      confidence: 'none',
      recipeCount: 0,
      packageCount: 0,
      references: [],
      exactReferences: [],
    };
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
  let names;
  try {
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
    const stat = fs.statSync(partitionRoot);
    const lock = lockState(partitionRoot);
    const identity = cacheIdentity(partitionRoot);
    let eligibility = 'eligible';
    if (lock.state !== 'absent') eligibility = `skipped-lock-${lock.state}`;
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
      'upload only absent exact references with --check and without --force',
      'read back every exact RREV/package_id/PREV',
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

function remoteContains(reference, remote, packagesRoot) {
  const payload = JSON.parse(
    conanCommand(
      [
        'list',
        reference,
        '--remote',
        remote,
        '-cc',
        `core.cache:storage_path=${packagesRoot}`,
        '--format=json',
      ],
      { capture: true },
    ),
  );
  return packageRevisionRefs(payload).includes(reference);
}

function withPartitionLock(storageRoot, partition, callback) {
  const partitionRoot = path.join(storageRoot, partition);
  const lockPath = path.join(partitionRoot, '.shifu-conan.lock');
  const token = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
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
  let result;
  let callbackError;
  try {
    const identity = cacheIdentity(partitionRoot);
    if (identity.confidence !== 'exact')
      fail(`partition identity became ambiguous: ${partition}`);
    result = callback(identity);
  } catch (error) {
    callbackError = error;
  }
  let releaseError;
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.token === token) fs.unlinkSync(lockPath);
    else
      releaseError = new Error(
        `partition lock ownership changed: ${partition}`,
      );
  } catch (error) {
    releaseError =
      error?.code === 'ENOENT'
        ? new Error(`partition lock disappeared: ${partition}`)
        : error;
  }
  if (releaseError) throw releaseError;
  if (callbackError) throw callbackError;
  return result;
}

export function executeMigration(storageRoot, remote) {
  assertExecutionEnvironment(remote);
  const sourceRevision = gitRevision();
  const inventory = inventoryLegacyPartitions(storageRoot);
  const plan = migrationPlan(inventory, remote);
  if (process.env.SHIFU_CONAN_MIGRATION_APPROVAL !== plan.approval.digest)
    fail(`migration requires exact approval digest ${plan.approval.digest}`);
  conanCommand(['remote', 'auth', remote, '--force', '--strict']);
  const published = [];
  const alreadyPresent = [];
  const byPartition = new Map();
  for (const candidate of plan.exactReferences) {
    const values = byPartition.get(candidate.partition) || [];
    values.push(candidate.reference);
    byPartition.set(candidate.partition, values);
  }
  for (const [partition, references] of byPartition) {
    withPartitionLock(storageRoot, partition, (identity) => {
      const exact = new Set(identity.exactReferences);
      const packagesRoot = path.join(storageRoot, partition, 'packages');
      for (const reference of references) {
        if (!exact.has(reference))
          fail(`partition no longer contains exact reference: ${reference}`);
        if (remoteContains(reference, remote, packagesRoot)) {
          alreadyPresent.push(reference);
          continue;
        }
        conanCommand([
          'upload',
          reference,
          '--remote',
          remote,
          '--check',
          '--confirm',
          '-cc',
          `core.cache:storage_path=${packagesRoot}`,
        ]);
        if (!remoteContains(reference, remote, packagesRoot))
          fail(`remote read-back missing exact reference: ${reference}`);
        published.push(reference);
      }
    });
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
    outcome: 'additive-upload-and-exact-read-back',
  };
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
