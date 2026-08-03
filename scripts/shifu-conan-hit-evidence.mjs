// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  MATRIX,
  assertManagedConanEnvironment,
  assertStrictDependencySettings,
  bytesDigest,
  conanCommand,
  conanVersion,
  detectProfile,
  disableBinaryCompatibility,
  exactClosureDigest,
  gitRevision,
  graphDependencyRecords,
  graphPackageRevisionRefs,
  validateDetectedProfile,
} from './shifu-conan-publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const PROFILE_ARGS = ['-pr', 'default', '-s:a', 'compiler.cppstd=23'];

function fail(message) {
  throw new Error(message);
}

export function parseHitArgs(argv) {
  const options = {
    execute: false,
    matrixEntry: '',
    remote: 'workhub-conan',
    publishReceipt: '',
    publishLockfile: '',
    receiptFile: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--matrix-entry') {
      options.matrixEntry = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--remote') {
      options.remote = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--publish-receipt') {
      options.publishReceipt = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--publish-lockfile') {
      options.publishLockfile = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--receipt-file') {
      options.receiptFile = argv[index + 1] || '';
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  if (!MATRIX[options.matrixEntry])
    fail(`--matrix-entry must be one of: ${Object.keys(MATRIX).join(', ')}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(options.remote)) fail('invalid remote name');
  return options;
}

export function hitPlan(matrixEntry, remote = 'workhub-conan') {
  return {
    schema: 'shifu.conan-cache-hit-plan/v1',
    mode: 'dry-run',
    matrixEntry,
    settings: MATRIX[matrixEntry].settings,
    remote,
    preconditions: [
      'clean exact Git checkout',
      'fresh empty mutable Conan package partition',
      'Shifu-managed disposable CONAN_HOME',
      'publisher receipt and lockfile from the same source revision, matrix and remote',
    ],
    command:
      'disable compatibility, then conan install framework/core --lockfile <publish-lockfile> --build=never --remote <remote> -s:a compiler.cppstd=23 --format=json --publish-receipt <receipt>',
    proof: [
      'every dependency has exact RREV/package_id/PREV',
      'every dependency binary state is Download',
      'every dependency binary remote is the selected hosted remote',
      'resolved exact-reference set equals the publisher closure',
      'source build count is zero',
    ],
  };
}

function packageCount(storageRoot) {
  const database = path.join(storageRoot, 'packages', 'cache.sqlite3');
  if (!fs.existsSync(database)) return 0;
  const connection = new DatabaseSync(database, { readOnly: true });
  try {
    return Number(
      connection.prepare('SELECT COUNT(*) AS count FROM packages').get().count,
    );
  } finally {
    connection.close();
  }
}

export function assertFreshCoreBuildTree(root = repoRoot) {
  const buildTree = path.join(root, 'framework', 'core', 'build');
  try {
    fs.lstatSync(buildTree);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  fail(`hit qualification requires an absent Core build tree: ${buildTree}`);
}

export function graphHitEvidence(payload, remote, expectedReferences = null) {
  const exactReferences = graphPackageRevisionRefs(payload);
  const resolvedDependencies = graphDependencyRecords(payload);
  const dependencies = resolvedDependencies.map((row) => ({
    reference: row.reference,
    binary: row.binary,
    remote: row.remote,
  }));
  if (exactReferences.length === 0)
    fail('fresh-partition hit proof contains no exact dependency references');
  if (dependencies.length !== exactReferences.length)
    fail('fresh-partition hit proof dependency identity is ambiguous');
  const invalid = dependencies.filter(
    (dependency) =>
      dependency.binary !== 'Download' || dependency.remote !== remote,
  );
  if (invalid.length > 0)
    fail(
      `fresh-partition hit proof rejected non-remote dependency states: ${invalid
        .map(
          (row) =>
            `${row.reference}:${row.binary || 'unknown'}:${row.remote || 'unknown'}`,
        )
        .join(', ')}`,
    );
  if (expectedReferences) {
    const expected = [...new Set(expectedReferences)].sort();
    if (JSON.stringify(exactReferences) !== JSON.stringify(expected))
      fail(
        `fresh-partition exact closure differs from publisher receipt: expected ${exactClosureDigest(expected)}, resolved ${exactClosureDigest(exactReferences)}`,
      );
  }
  return { exactReferences, dependencies, resolvedDependencies };
}

export function validatePublishReceipt(
  receipt,
  { matrixEntry, remote, sourceRevision, lockfileDigest },
) {
  if (receipt?.schema !== 'shifu.conan-binary-publish-receipt/v1')
    fail('hit qualification requires a publisher receipt');
  if (receipt.sourceRevision !== sourceRevision)
    fail('publisher receipt source revision differs from hit checkout');
  if (receipt.matrixEntry !== matrixEntry || receipt.remote !== remote)
    fail('publisher receipt matrix or remote differs from hit request');
  if (receipt.identity !== 'rrev-package-id-prev')
    fail('publisher receipt identity is not exact');
  if (receipt.compatibilityPolicy !== 'disabled-for-exact-package-id')
    fail('publisher receipt did not disable binary compatibility');
  if (
    receipt.conan?.compatibilityPolicy !==
      'global-plugin-disabled-in-disposable-home' ||
    typeof receipt.conan?.version !== 'string' ||
    !receipt.conan.version
  )
    fail('publisher receipt lacks Conan version and strict policy evidence');
  if (
    receipt.lockfile?.schema !== 'conan-lockfile' ||
    receipt.lockfile?.pins !== 'dependency-rrev' ||
    receipt.lockfile?.digest !== lockfileDigest
  )
    fail('publisher lockfile digest or pinning evidence is invalid');
  const expectedSettings = MATRIX[matrixEntry].settings;
  if (JSON.stringify(receipt.settings) !== JSON.stringify(expectedSettings))
    fail('publisher receipt settings differ from matrix contract');
  if (
    !Array.isArray(receipt.exactReferences) ||
    receipt.exactReferences.length === 0
  )
    fail('publisher receipt exact closure is empty');
  const expectedDigest = exactClosureDigest(receipt.exactReferences);
  if (receipt.closureDigest !== expectedDigest)
    fail('publisher receipt exact closure digest is invalid');
  return {
    sourceRevision: receipt.sourceRevision,
    closureDigest: expectedDigest,
    lockfileDigest,
    exactReferences: [...new Set(receipt.exactReferences)].sort(),
  };
}

export function executeHitEvidence({
  matrixEntry,
  remote,
  publishReceipt,
  publishLockfile,
}) {
  assertManagedConanEnvironment();
  const sourceRevision = gitRevision();
  if (!publishReceipt) fail('--publish-receipt is required with --execute');
  if (!publishLockfile) fail('--publish-lockfile is required with --execute');
  let publisher;
  try {
    publisher = validatePublishReceipt(
      JSON.parse(fs.readFileSync(path.resolve(publishReceipt), 'utf8')),
      {
        matrixEntry,
        remote,
        sourceRevision,
        lockfileDigest: bytesDigest(
          fs.readFileSync(path.resolve(publishLockfile)),
        ),
      },
    );
  } catch (error) {
    fail(`cannot validate publisher receipt: ${error.message}`);
  }
  const storageRoot = String(process.env.SHIFU_CONAN_STORAGE_ROOT || '');
  if (!storageRoot) fail('managed Conan storage root is unavailable');
  const before = packageCount(storageRoot);
  if (before !== 0)
    fail(
      `hit qualification requires an empty package partition, found ${before}`,
    );
  const buildTreeBefore = assertFreshCoreBuildTree();
  validateDetectedProfile(matrixEntry, detectProfile());
  disableBinaryCompatibility();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-hit-'));
  try {
    const graph = JSON.parse(
      conanCommand(
        [
          'install',
          path.join(repoRoot, 'framework', 'core'),
          '--output-folder',
          path.join(scratch, 'generators'),
          '--lockfile',
          path.resolve(publishLockfile),
          '--build=never',
          '--remote',
          remote,
          ...PROFILE_ARGS,
          '--format=json',
        ],
        { capture: true },
      ),
    );
    const evidence = graphHitEvidence(graph, remote, publisher.exactReferences);
    assertStrictDependencySettings(evidence.resolvedDependencies, matrixEntry);
    return {
      schema: 'shifu.conan-cache-hit-evidence/v1',
      sourceRevision,
      matrixEntry,
      settings: MATRIX[matrixEntry].settings,
      remote,
      partitionBefore: { packageCount: before, state: 'empty' },
      buildTreeBefore,
      identity: 'rrev-package-id-prev',
      compatibilityPolicy: 'disabled-for-exact-package-id',
      conan: {
        version: conanVersion(),
        compatibilityPolicy: 'global-plugin-disabled-in-disposable-home',
      },
      publisherClosure: publisher,
      exactReferences: evidence.exactReferences,
      dependencies: evidence.dependencies,
      resolvedDependencies: evidence.resolvedDependencies,
      sourceBuilds: [],
      outcome: 'hosted-artifact-hit-without-source-build',
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseHitArgs(process.argv.slice(2));
    const output = options.execute
      ? executeHitEvidence(options)
      : hitPlan(options.matrixEntry, options.remote);
    if (options.execute && options.receiptFile)
      fs.writeFileSync(
        path.resolve(options.receiptFile),
        `${JSON.stringify(output, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`shifu conan hit evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
