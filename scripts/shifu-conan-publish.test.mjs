// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MATRIX,
  packageRevisionRefs,
  parseArgs,
  plan,
  validateDetectedProfile,
} from './shifu-conan-publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'shifu-conan-publish.mjs');

test('matrix contract covers the required three platforms', () => {
  assert.deepEqual(Object.keys(MATRIX), [
    'macos-arm64',
    'linux-gcc14-x64',
    'windows-msvc-x64',
  ]);
  validateDetectedProfile(
    'linux-gcc14-x64',
    {
      host: {
        settings: {
          os: 'Linux',
          arch: 'x86_64',
          compiler: 'gcc',
          'compiler.version': '14',
        },
      },
    },
    'linux',
  );
  assert.throws(
    () =>
      validateDetectedProfile(
        'linux-gcc14-x64',
        {
          host: {
            settings: {
              os: 'Linux',
              arch: 'x86_64',
              compiler: 'gcc',
              'compiler.version': '13',
            },
          },
        },
        'linux',
      ),
    /requires compiler.version=14/,
  );
});

test('dry-run plan keeps publisher credentials out of Buildchain', () => {
  const options = parseArgs(['--matrix-entry', 'macos-arm64']);
  const output = plan(options.matrixEntry, options.remote);
  assert.deepEqual(output.buildchainInputs, [
    'SHIFU_CACHE_PROFILE_REF',
    'SHIFU_CACHE_PROFILE_DIGEST',
  ]);
  assert.equal(output.publisherSecretInBuildchain, false);
  assert.equal(output.authentication, 'conan-remote-env-only');
  assert.match(
    JSON.stringify(output),
    /remote auth workhub-conan --force --strict/,
  );
  assert.doesNotMatch(JSON.stringify(output), /password/i);
  assert.match(JSON.stringify(output), /rocksdb\/6\.29\.5#\*:\*#\*/);
});

test('package revision read-back requires exact recipe and package revisions', () => {
  assert.deepEqual(
    packageRevisionRefs({
      'Local Cache': {
        'rocksdb/6.29.5': {
          revisions: {
            recipeRevision: {
              packages: {
                packageId: {
                  revisions: { packageRevision: { timestamp: 1 } },
                },
              },
            },
          },
        },
      },
    }),
    ['rocksdb/6.29.5#recipeRevision:packageId#packageRevision'],
  );
  assert.deepEqual(
    packageRevisionRefs({
      remote: {
        'rocksdb/6.29.5': {
          revisions: {
            recipeRevision: { packages: { packageId: { info: {} } } },
          },
        },
      },
    }),
    [],
  );
});

test('execute fails closed outside Shifu before invoking Conan', () => {
  const result = spawnSync(
    process.execPath,
    [script, '--matrix-entry', 'macos-arm64', '--execute'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHIFU_CACHE_MANAGED_CONAN: '',
        CONAN_HOME: '',
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run inside shifu cache apply/);
});
