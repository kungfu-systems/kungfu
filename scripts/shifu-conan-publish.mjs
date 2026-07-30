// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);

export const MATRIX = Object.freeze({
  'macos-arm64': {
    nodePlatform: 'darwin',
    settings: { os: 'Macos', arch: 'armv8', compiler: 'apple-clang' },
  },
  'linux-gcc14-x64': {
    nodePlatform: 'linux',
    settings: {
      os: 'Linux',
      arch: 'x86_64',
      compiler: 'gcc',
      'compiler.version': '14',
    },
  },
  'windows-msvc-x64': {
    nodePlatform: 'win32',
    settings: { os: 'Windows', arch: 'x86_64', compiler: 'msvc' },
  },
});

const ROCKSDB_PACKAGE_PATTERN = 'rocksdb/6.29.5#*:*#*';

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
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

function conanCommand(args, { capture = false } = {}) {
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

function detectProfile() {
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
    conanCommand(['profile', 'show', '-pr', 'default', '--format=json'], {
      capture: true,
    }),
  );
}

export function plan(matrixEntry, remote = 'workhub-conan') {
  return {
    schema: 'shifu.conan-binary-publish-plan/v1',
    mode: 'dry-run',
    matrixEntry,
    recipe: 'rocksdb/6.29.5',
    remote,
    execution: 'inside-shifu-cache-apply',
    profile: 'ephemeral-auto-detected-and-validated',
    storage: 'persistent-host-local-profile-partition',
    authentication: 'conan-remote-env-only',
    commands: [
      'conan profile detect --force (only when default is absent)',
      'conan create <rocksdb-recipe> --version 6.29.5 --build=missing',
      `conan list ${ROCKSDB_PACKAGE_PATTERN} --filter-profile default`,
      `conan remote auth ${remote} --force --strict`,
      `conan upload --list <exact-package-list> --remote ${remote} --check --confirm`,
      `conan list <each-exact-package-revision> --remote ${remote} and assert read-back`,
    ],
    buildchainInputs: ['SHIFU_CACHE_PROFILE_REF', 'SHIFU_CACHE_PROFILE_DIGEST'],
    publisherSecretInBuildchain: false,
  };
}

function assertExecutionEnvironment(remote) {
  if (process.env.SHIFU_CACHE_MANAGED_CONAN !== '1' || !process.env.CONAN_HOME)
    fail('publisher must run inside shifu cache apply');
  const suffix = remote.toUpperCase().replaceAll('-', '_');
  const username = `CONAN_LOGIN_USERNAME_${suffix}`;
  const password = `CONAN_PASSWORD_${suffix}`;
  if (!process.env[username] || !process.env[password])
    fail(`publisher requires ${username} and ${password}`);
}

export function execute({ matrixEntry, remote }) {
  assertExecutionEnvironment(remote);
  const detected = detectProfile();
  validateDetectedProfile(matrixEntry, detected);
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-conan-publish-'),
  );
  const packageList = path.join(scratch, 'rocksdb-package-list.json');
  try {
    conanCommand([
      'create',
      path.join(repoRoot, 'framework', 'core', '.conan', 'recipes', 'rocksdb'),
      '--version',
      '6.29.5',
      '--build=missing',
    ]);
    conanCommand([
      'list',
      ROCKSDB_PACKAGE_PATTERN,
      '--filter-profile',
      'default',
      '--format=json',
      '--out-file',
      packageList,
    ]);
    const expectedRefs = packageRevisionRefs(
      JSON.parse(fs.readFileSync(packageList, 'utf8')),
    );
    if (expectedRefs.length === 0)
      fail('local package list contains no exact RocksDB package revision');
    conanCommand(['remote', 'auth', remote, '--force', '--strict']);
    conanCommand([
      'upload',
      '--list',
      packageList,
      '--remote',
      remote,
      '--check',
      '--confirm',
    ]);
    const missing = expectedRefs.filter((reference) => {
      const remoteRefs = packageRevisionRefs(
        JSON.parse(
          conanCommand(
            ['list', reference, '--remote', remote, '--format=json'],
            { capture: true },
          ),
        ),
      );
      return !remoteRefs.includes(reference);
    });
    if (missing.length > 0)
      fail(`remote read-back missing package revisions: ${missing.join(', ')}`);
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
      execute(options);
      process.stdout.write(
        `${JSON.stringify({ ...output, mode: 'execute', outcome: 'published-and-read-back' }, null, 2)}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`shifu conan publish: ${error.message}\n`);
    process.exitCode = 1;
  }
}
