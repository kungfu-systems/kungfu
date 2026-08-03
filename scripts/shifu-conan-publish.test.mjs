// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  conanStorageLayout,
  conanStoragePartition,
} from './shifu-cache-runtime.mjs';
import {
  MATRIX,
  assertStrictDependencySettings,
  disableBinaryCompatibility,
  exactClosureDigest,
  graphDependencyRecords,
  graphPackageRevisionRefs,
  packageRevisionRefs,
  parseArgs,
  plan,
  validateDetectedProfile,
} from './shifu-conan-publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'shifu-conan-publish.mjs');

test('Conan storage partitions isolate mutable packages and share downloads', () => {
  const first = conanStoragePartition('development', {
    SHIFU_CACHE_PRINCIPAL: 'worktree:first',
  });
  assert.equal(
    first,
    conanStoragePartition('development', {
      SHIFU_CACHE_PRINCIPAL: 'worktree:first',
    }),
  );
  assert.notEqual(
    first,
    conanStoragePartition('development', {
      SHIFU_CACHE_PRINCIPAL: 'worktree:second',
    }),
  );
  assert.match(first, /^development-[a-f0-9]{12}$/);
  assert.match(
    conanStoragePartition('self-hosted-runner', {
      RUNNER_NAME: 'runner-one',
    }),
    /^runner-[a-f0-9]{12}$/,
  );
  const firstLayout = conanStorageLayout('/cache/conan/workhub-v1', first);
  const secondLayout = conanStorageLayout(
    '/cache/conan/workhub-v1',
    conanStoragePartition('development', {
      SHIFU_CACHE_PRINCIPAL: 'worktree:second',
    }),
  );
  assert.notEqual(firstLayout.packageRoot, secondLayout.packageRoot);
  assert.equal(firstLayout.downloadRoot, secondLayout.downloadRoot);
});

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
          'compiler.cppstd': '23',
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
              'compiler.cppstd': '23',
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
  assert.equal(output.publication, 'additive-only-no-force');
  assert.equal(
    output.storage.immutableBinaryAuthority,
    'hosted-remote-rrev-package-id-prev',
  );
  assert.match(JSON.stringify(output), /framework\/core dependency closure/);
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

test('resolved graph evidence requires full dependency identity', () => {
  assert.deepEqual(
    graphPackageRevisionRefs({
      graph: {
        nodes: {
          0: {
            recipe: 'Consumer',
            ref: 'kungfu-core/4.0.0-alpha.1',
            package_id: 'consumerPackageId',
          },
          1: {
            ref: 'flatbuffers/25.9.23#recipeRevision',
            package_id: 'packageId',
            prev: 'packageRevision',
          },
          2: {
            ref: 'rocksdb/6.29.5',
            rrev: 'rocksRecipeRevision',
            package_id: 'rocksPackageId',
            prev: 'rocksPackageRevision',
          },
        },
      },
    }),
    [
      'flatbuffers/25.9.23#recipeRevision:packageId#packageRevision',
      'rocksdb/6.29.5#rocksRecipeRevision:rocksPackageId#rocksPackageRevision',
    ],
  );
  assert.throws(
    () =>
      graphPackageRevisionRefs({
        graph: {
          nodes: {
            1: { ref: 'nng/1.11.0', package_id: 'packageId', prev: '' },
          },
        },
      }),
    /lacks exact RREV\/package_id\/PREV identity/,
  );
});

test('resolved dependency records disclose effective settings and exact closure digest', () => {
  const payload = {
    graph: {
      nodes: {
        1: {
          ref: 'rocksdb/6.29.5#recipeRevision',
          package_id: 'packageId',
          prev: 'packageRevision',
          binary: 'Download',
          binary_remote: 'workhub-conan',
          settings: { compiler: 'apple-clang', 'compiler.cppstd': 'gnu17' },
          options: { shared: 'False' },
        },
      },
    },
  };
  const records = graphDependencyRecords(payload);
  assert.equal(records[0].effectiveSettings['compiler.cppstd'], 'gnu17');
  assert.equal(records[0].options.shared, 'False');
  assert.equal(records[0].binary, 'Download');
  assert.match(
    exactClosureDigest(graphPackageRevisionRefs(payload)),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.throws(
    () => assertStrictDependencySettings(records, 'macos-arm64'),
    /resolved compatible settings/,
  );
  records[0].effectiveSettings['compiler.cppstd'] = '23';
  assert.doesNotThrow(() =>
    assertStrictDependencySettings(records, 'macos-arm64'),
  );
});

test('publisher disables global Conan binary compatibility only in managed overlay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-conan-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousManaged = process.env.SHIFU_CACHE_MANAGED_CONAN;
  const previousHome = process.env.CONAN_HOME;
  t.after(() => {
    if (previousManaged === undefined)
      Reflect.deleteProperty(process.env, 'SHIFU_CACHE_MANAGED_CONAN');
    else process.env.SHIFU_CACHE_MANAGED_CONAN = previousManaged;
    if (previousHome === undefined)
      Reflect.deleteProperty(process.env, 'CONAN_HOME');
    else process.env.CONAN_HOME = previousHome;
  });
  process.env.SHIFU_CACHE_MANAGED_CONAN = '1';
  process.env.CONAN_HOME = root;
  disableBinaryCompatibility();
  const plugin = fs.readFileSync(
    path.join(
      root,
      'extensions',
      'plugins',
      'compatibility',
      'compatibility.py',
    ),
    'utf8',
  );
  assert.match(plugin, /return \[\]/);
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
