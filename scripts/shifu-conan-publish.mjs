// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);

export const MATRIX = Object.freeze({
  'macos-arm64': {
    nodePlatform: 'darwin',
    settings: {
      os: 'Macos',
      arch: 'armv8',
      compiler: 'apple-clang',
      'compiler.version': '21',
      'compiler.cppstd': '23',
    },
  },
  'linux-gcc14-x64': {
    nodePlatform: 'linux',
    settings: {
      os: 'Linux',
      arch: 'x86_64',
      compiler: 'gcc',
      'compiler.version': '14',
      'compiler.cppstd': '23',
    },
  },
  'windows-msvc-x64': {
    nodePlatform: 'win32',
    settings: {
      os: 'Windows',
      arch: 'x86_64',
      compiler: 'msvc',
      'compiler.cppstd': '23',
    },
  },
});

const CORE_RECIPE = path.join(repoRoot, 'framework', 'core');
const PROFILE_ARGS = ['-pr', 'default', '-s:a', 'compiler.cppstd=23'];

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = {
    execute: false,
    matrixEntry: '',
    remote: 'workhub-conan',
    receiptFile: '',
    lockfileFile: '',
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
    } else if (argument === '--receipt-file') {
      options.receiptFile = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--lockfile-file') {
      options.lockfileFile = argv[index + 1] || '';
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  if (!MATRIX[options.matrixEntry])
    fail(`--matrix-entry must be one of: ${Object.keys(MATRIX).join(', ')}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(options.remote)) fail('invalid remote name');
  return options;
}

export function validateDetectedProfile(
  matrixEntry,
  profile,
  platform = process.platform,
) {
  const contract = MATRIX[matrixEntry];
  if (platform !== contract.nodePlatform)
    fail(
      `${matrixEntry} must run on ${contract.nodePlatform}, not ${platform}`,
    );
  const settings = profile?.host?.settings || {};
  for (const [name, expected] of Object.entries(contract.settings)) {
    if (String(settings[name] || '') !== expected)
      fail(
        `${matrixEntry} requires ${name}=${expected}, detected ${settings[name] || '<missing>'}`,
      );
  }
  return settings;
}

export function packageRevisionRefs(payload) {
  const refs = [];
  for (const repository of Object.values(payload || {})) {
    for (const [recipe, recipeValue] of Object.entries(repository || {})) {
      for (const [recipeRevision, revisionValue] of Object.entries(
        recipeValue?.revisions || {},
      )) {
        for (const [packageId, packageValue] of Object.entries(
          revisionValue?.packages || {},
        )) {
          for (const packageRevision of Object.keys(
            packageValue?.revisions || {},
          ))
            refs.push(
              `${recipe}#${recipeRevision}:${packageId}#${packageRevision}`,
            );
        }
      }
    }
  }
  return refs.sort();
}

export function graphPackageRevisionRefs(payload) {
  return graphDependencyRecords(payload).map((row) => row.exactReference);
}

export function graphDependencyRecords(payload) {
  const records = [];
  for (const node of Object.values(payload?.graph?.nodes || {})) {
    if (node?.recipe === 'Consumer') continue;
    if (!node?.package_id) continue;
    const rawReference = String(node.ref || '');
    const [reference, embeddedRrev = ''] = rawReference.split('#', 2);
    if (!reference.includes('/')) continue;
    const rrev = String(node.rrev || embeddedRrev || '');
    const packageId = String(node.package_id || '');
    const prev = String(node.prev || '');
    if (!rrev || !packageId || !prev)
      fail(
        `graph dependency lacks exact RREV/package_id/PREV identity: ${reference}`,
      );
    records.push({
      reference,
      rrev,
      packageId,
      prev,
      exactReference: `${reference}#${rrev}:${packageId}#${prev}`,
      binary: String(node.binary || ''),
      remote: String(node.binary_remote || node.remote || ''),
      effectiveSettings: node.settings || {},
      options: node.options || {},
    });
  }
  const unique = new Map(records.map((row) => [row.exactReference, row]));
  return [...unique.values()].sort((left, right) =>
    left.exactReference.localeCompare(right.exactReference),
  );
}

export function exactClosureDigest(references) {
  const normalized = [...new Set(references)].sort();
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'shifu.conan-exact-closure/v1',
        identity: 'rrev-package-id-prev',
        exactReferences: normalized,
      }),
    )
    .digest('hex')}`;
}

export function bytesDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function assertStrictDependencySettings(records, matrixEntry) {
  const expected = MATRIX[matrixEntry].settings;
  const mismatches = [];
  for (const record of records) {
    for (const name of [
      'os',
      'arch',
      'compiler',
      'compiler.version',
      'compiler.cppstd',
    ]) {
      const effective = record.effectiveSettings?.[name];
      if (effective !== undefined && String(effective) !== expected[name])
        mismatches.push(
          `${record.reference}:${name}=${effective} (expected ${expected[name]})`,
        );
    }
  }
  if (mismatches.length > 0)
    fail(
      `strict package qualification resolved compatible settings: ${mismatches.join(', ')}`,
    );
}

export function conanVersion() {
  return conanCommand(['--version'], { capture: true }).trim();
}

export function disableBinaryCompatibility() {
  assertManagedConanEnvironment();
  const pluginDirectory = path.join(
    process.env.CONAN_HOME,
    'extensions',
    'plugins',
    'compatibility',
  );
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDirectory, 'compatibility.py'),
    [
      '# Shifu exact-package qualification: do not substitute another package ID.',
      'def compatibility(conanfile):',
      '    return []',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

export function conanCommand(args, { capture = false } = {}) {
  const executable = process.env.SHIFU_CONAN_BIN || 'conan';
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
  });
  if (result.error) fail(`cannot run Conan: ${result.error.message}`);
  if (result.status !== 0)
    fail(`Conan command failed (${result.status}): conan ${args.join(' ')}`);
  return result.stdout || '';
}

export function detectProfile() {
  const probe = spawnSync(
    process.env.SHIFU_CONAN_BIN || 'conan',
    ['profile', 'path', 'default'],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell:
        process.platform === 'win32' &&
        /\.(?:cmd|bat)$/i.test(process.env.SHIFU_CONAN_BIN || 'conan'),
    },
  );
  if (probe.status !== 0) conanCommand(['profile', 'detect', '--force']);
  return JSON.parse(
    conanCommand(['profile', 'show', ...PROFILE_ARGS, '--format=json'], {
      capture: true,
    }),
  );
}

export function plan(matrixEntry, remote = 'workhub-conan') {
  return {
    schema: 'shifu.conan-binary-publish-plan/v1',
    mode: 'dry-run',
    matrixEntry,
    recipe: 'framework/core dependency closure',
    remote,
    execution: 'inside-shifu-cache-apply',
    profile: 'ephemeral-auto-detected-and-validated',
    settings: MATRIX[matrixEntry].settings,
    storage: {
      mutable: 'persistent-host-local-profile-partition',
      immutableBinaryAuthority: 'hosted-remote-rrev-package-id-prev',
      immutableSourceTransport: 'shared-content-addressed-download-cache',
    },
    authentication: 'conan-remote-env-only',
    publication: 'additive-only-no-force',
    commands: [
      'conan profile detect --force (only when default is absent)',
      'assert clean exact Git checkout',
      'disable Conan global binary compatibility in the disposable CONAN_HOME',
      'conan install framework/core --build=missing -s:a compiler.cppstd=23 --lockfile-out <publish-lockfile> --format=json',
      'derive every dependency RREV/package_id/PREV from the resolved graph',
      'conan list <each-exact-package-revision> --remote <remote>',
      `conan remote auth ${remote} --force --strict`,
      `conan upload <each-missing-exact-package-revision> --remote ${remote} --check --confirm`,
      `conan list <each-exact-package-revision> --remote ${remote} and assert exact read-back`,
      `conan list <each-rrev-package-id>#latest --remote ${remote} and bind the remote-current PREV closure`,
    ],
    buildchainInputs: ['SHIFU_CACHE_PROFILE_REF', 'SHIFU_CACHE_PROFILE_DIGEST'],
    publisherSecretInBuildchain: false,
  };
}

export function assertManagedConanEnvironment() {
  if (process.env.SHIFU_CACHE_MANAGED_CONAN !== '1' || !process.env.CONAN_HOME)
    fail('Conan operation must run inside shifu cache apply');
}

export function assertExecutionEnvironment(remote) {
  assertManagedConanEnvironment();
  const suffix = remote.toUpperCase().replaceAll('-', '_');
  const username = `CONAN_LOGIN_USERNAME_${suffix}`;
  const password = `CONAN_PASSWORD_${suffix}`;
  if (!process.env[username] || !process.env[password])
    fail(`publisher requires ${username} and ${password}`);
}

export function gitRevision() {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (status.status !== 0) fail('cannot verify publisher Git checkout');
  if (String(status.stdout || '').trim())
    fail('publisher requires a clean exact Git checkout');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (revision.status !== 0) fail('cannot resolve publisher Git revision');
  return String(revision.stdout || '').trim();
}

function remoteHasExactReference(reference, remote) {
  const payload = JSON.parse(
    conanCommand(['list', reference, '--remote', remote, '--format=json'], {
      capture: true,
    }),
  );
  return packageRevisionRefs(payload).includes(reference);
}

export function bindRemotePackageRevisions(records, remoteReferences) {
  const byPackage = new Map();
  for (const reference of remoteReferences) {
    const packageCoordinate = reference.slice(0, reference.lastIndexOf('#'));
    if (byPackage.has(packageCoordinate))
      fail(`remote returned multiple current PREVs for ${packageCoordinate}`);
    byPackage.set(packageCoordinate, reference);
  }
  return records.map((record) => {
    const packageCoordinate = `${record.reference}#${record.rrev}:${record.packageId}`;
    const exactReference = byPackage.get(packageCoordinate);
    if (!exactReference)
      fail(`remote current PREV is missing for ${packageCoordinate}`);
    return {
      ...record,
      prev: exactReference.slice(exactReference.lastIndexOf('#') + 1),
      exactReference,
    };
  });
}

function remoteCurrentReference(record, remote) {
  const packageCoordinate = `${record.reference}#${record.rrev}:${record.packageId}`;
  const payload = JSON.parse(
    conanCommand(
      [
        'list',
        `${packageCoordinate}#latest`,
        '--remote',
        remote,
        '--format=json',
      ],
      { capture: true },
    ),
  );
  const references = packageRevisionRefs(payload);
  if (references.length !== 1)
    fail(
      `remote current PREV query returned ${references.length} references for ${packageCoordinate}`,
    );
  return references[0];
}

export function execute({ matrixEntry, remote, lockfileFile }) {
  assertExecutionEnvironment(remote);
  if (!lockfileFile) fail('--lockfile-file is required with --execute');
  const sourceRevision = gitRevision();
  const detected = detectProfile();
  validateDetectedProfile(matrixEntry, detected);
  disableBinaryCompatibility();
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-publish-'),
  );
  try {
    const generatedLockfile = path.join(scratch, 'conan.lock');
    const graph = JSON.parse(
      conanCommand(
        [
          'install',
          CORE_RECIPE,
          '--output-folder',
          path.join(scratch, 'generators'),
          '--lockfile=',
          '--lockfile-out',
          generatedLockfile,
          '--build=missing',
          ...PROFILE_ARGS,
          '--format=json',
        ],
        { capture: true },
      ),
    );
    const resolvedDependencies = graphDependencyRecords(graph);
    assertStrictDependencySettings(resolvedDependencies, matrixEntry);
    const lockfileBytes = fs.readFileSync(generatedLockfile);
    fs.writeFileSync(path.resolve(lockfileFile), lockfileBytes, {
      mode: 0o600,
      flag: 'wx',
    });
    const localRefs = resolvedDependencies.map((row) => row.exactReference);
    if (localRefs.length === 0)
      fail(
        'resolved Core graph contains no exact dependency package revisions',
      );
    const alreadyPresent = localRefs.filter((reference) =>
      remoteHasExactReference(reference, remote),
    );
    const missingBefore = localRefs.filter(
      (reference) => !alreadyPresent.includes(reference),
    );
    conanCommand(['remote', 'auth', remote, '--force', '--strict']);
    for (const reference of missingBefore)
      conanCommand([
        'upload',
        reference,
        '--remote',
        remote,
        '--check',
        '--confirm',
      ]);
    const missing = localRefs.filter((reference) => {
      return !remoteHasExactReference(reference, remote);
    });
    if (missing.length > 0)
      fail(`remote read-back missing package revisions: ${missing.join(', ')}`);
    const remoteReferences = resolvedDependencies.map((record) =>
      remoteCurrentReference(record, remote),
    );
    const remoteDependencies = bindRemotePackageRevisions(
      resolvedDependencies,
      remoteReferences,
    );
    const expectedRefs = remoteDependencies.map((row) => row.exactReference);
    return {
      schema: 'shifu.conan-binary-publish-receipt/v1',
      sourceRevision,
      matrixEntry,
      settings: MATRIX[matrixEntry].settings,
      remote,
      identity: 'rrev-package-id-prev',
      compatibilityPolicy: 'disabled-for-exact-package-id',
      conan: {
        version: conanVersion(),
        compatibilityPolicy: 'global-plugin-disabled-in-disposable-home',
      },
      lockfile: {
        schema: 'conan-lockfile',
        digest: bytesDigest(lockfileBytes),
        pins: 'dependency-rrev',
      },
      closureDigest: exactClosureDigest(expectedRefs),
      exactReferences: expectedRefs,
      resolvedDependencies: remoteDependencies,
      alreadyPresent,
      published: missingBefore,
      readBack: expectedRefs,
      overwrite: false,
      outcome: 'published-and-read-back',
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
    const options = parseArgs(process.argv.slice(2));
    const output = plan(options.matrixEntry, options.remote);
    if (!options.execute) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      const receipt = execute(options);
      if (options.receiptFile)
        fs.writeFileSync(
          path.resolve(options.receiptFile),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`shifu conan publish: ${error.message}\n`);
    process.exitCode = 1;
  }
}
