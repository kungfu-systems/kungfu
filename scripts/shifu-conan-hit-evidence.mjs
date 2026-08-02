// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  MATRIX,
  assertManagedConanEnvironment,
  conanCommand,
  detectProfile,
  gitRevision,
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
  const options = { execute: false, matrixEntry: '', remote: 'workhub-conan' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--matrix-entry') {
      options.matrixEntry = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--remote') {
      options.remote = argv[index + 1] || '';
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
    ],
    command:
      'conan install framework/core --build=never --remote <remote> -s:a compiler.cppstd=23 --format=json',
    proof: [
      'every dependency has exact RREV/package_id/PREV',
      'every dependency binary state is Download',
      'every dependency binary remote is the selected hosted remote',
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

export function graphHitEvidence(payload, remote) {
  const exactReferences = graphPackageRevisionRefs(payload);
  const dependencies = [];
  for (const node of Object.values(payload?.graph?.nodes || {})) {
    if (node?.recipe === 'Consumer') continue;
    if (!node?.package_id) continue;
    const reference = String(node.ref || '').split('#', 1)[0];
    const binary = String(node.binary || '');
    const binaryRemote = String(node.binary_remote || node.remote || '');
    dependencies.push({ reference, binary, remote: binaryRemote });
  }
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
  return { exactReferences, dependencies };
}

export function executeHitEvidence({ matrixEntry, remote }) {
  assertManagedConanEnvironment();
  const sourceRevision = gitRevision();
  const storageRoot = String(process.env.SHIFU_CONAN_STORAGE_ROOT || '');
  if (!storageRoot) fail('managed Conan storage root is unavailable');
  const before = packageCount(storageRoot);
  if (before !== 0)
    fail(
      `hit qualification requires an empty package partition, found ${before}`,
    );
  validateDetectedProfile(matrixEntry, detectProfile());
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-hit-'));
  try {
    const graph = JSON.parse(
      conanCommand(
        [
          'install',
          path.join(repoRoot, 'framework', 'core'),
          '--output-folder',
          path.join(scratch, 'generators'),
          '--lockfile=',
          '--build=never',
          '--remote',
          remote,
          ...PROFILE_ARGS,
          '--format=json',
        ],
        { capture: true },
      ),
    );
    const evidence = graphHitEvidence(graph, remote);
    return {
      schema: 'shifu.conan-cache-hit-evidence/v1',
      sourceRevision,
      matrixEntry,
      settings: MATRIX[matrixEntry].settings,
      remote,
      partitionBefore: { packageCount: before, state: 'empty' },
      identity: 'rrev-package-id-prev',
      exactReferences: evidence.exactReferences,
      dependencies: evidence.dependencies,
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
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`shifu conan hit evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
