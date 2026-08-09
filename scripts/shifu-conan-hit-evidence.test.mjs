// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertFreshCoreBuildTree,
  graphHitEvidence,
  hitPlan,
  parseHitArgs,
  validatePublishReceipt,
} from './shifu-conan-hit-evidence.mjs';
import { exactClosureDigest } from './shifu-conan-publish.mjs';

test('hit evidence dry-run binds the exact macOS toolchain slice', () => {
  const options = parseHitArgs(['--matrix-entry', 'macos-arm64']);
  const output = hitPlan(options.matrixEntry, options.remote);
  assert.equal(output.settings.os, 'Macos');
  assert.equal(output.settings.arch, 'armv8');
  assert.equal(output.settings.compiler, 'apple-clang');
  assert.equal(output.settings['compiler.version'], '21');
  assert.equal(output.settings['compiler.cppstd'], '23');
  assert.match(output.command, /--build=never/);
});

test('hit evidence requires an absent Core build tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-hit-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(assertFreshCoreBuildTree(root), { state: 'absent' });
  fs.mkdirSync(path.join(root, 'framework', 'core', 'build'), {
    recursive: true,
  });
  assert.throws(
    () => assertFreshCoreBuildTree(root),
    /requires an absent Core build tree/,
  );
});

test('hit evidence accepts only exact downloads from the selected remote', () => {
  const exact = 'rocksdb/6.29.5#rrev:packageId#prev';
  const evidence = graphHitEvidence(
    {
      graph: {
        nodes: {
          0: {
            recipe: 'Consumer',
            ref: 'kungfu-core/4.0.0-alpha.1',
            package_id: 'consumerPackageId',
          },
          1: {
            ref: 'rocksdb/6.29.5#rrev',
            package_id: 'packageId',
            prev: 'prev',
            binary: 'Download',
            binary_remote: 'workhub-conan',
          },
        },
      },
    },
    'workhub-conan',
    [exact],
  );
  assert.deepEqual(evidence.exactReferences, [exact]);
  assert.equal(
    evidence.resolvedDependencies[0].effectiveSettings['compiler.cppstd'],
    undefined,
  );
  assert.throws(
    () => graphHitEvidence({ graph: { nodes: {} } }, 'workhub-conan'),
    /contains no exact dependency references/,
  );
  assert.throws(
    () =>
      graphHitEvidence(
        {
          graph: {
            nodes: {
              1: {
                ref: 'flatbuffers/25.9.23#rrev',
                package_id: 'packageId',
                prev: 'prev',
                binary: 'Build',
                binary_remote: '',
              },
            },
          },
        },
        'workhub-conan',
      ),
    /rejected non-remote dependency states/,
  );
  assert.throws(
    () =>
      graphHitEvidence(
        {
          graph: {
            nodes: {
              1: {
                ref: 'rocksdb/6.29.5#rrev',
                package_id: 'differentPackageId',
                prev: 'prev',
                binary: 'Download',
                binary_remote: 'workhub-conan',
              },
            },
          },
        },
        'workhub-conan',
        [exact],
      ),
    /exact closure differs from publisher receipt/,
  );
});

test('hit evidence validates and binds a strict publisher receipt', () => {
  const exactReferences = ['rocksdb/6.29.5#rrev:packageId#prev'];
  const receipt = {
    schema: 'shifu.conan-binary-publish-receipt/v1',
    sourceRevision: 'sourceRevision',
    matrixEntry: 'macos-arm64',
    settings: {
      os: 'Macos',
      arch: 'armv8',
      compiler: 'apple-clang',
      'compiler.version': '21',
      'compiler.cppstd': '23',
    },
    remote: 'workhub-conan',
    identity: 'rrev-package-id-prev',
    compatibilityPolicy: 'disabled-for-exact-package-id',
    conan: {
      version: 'Conan version 2.test',
      compatibilityPolicy: 'global-plugin-disabled-in-disposable-home',
    },
    lockfile: {
      schema: 'conan-lockfile',
      digest: 'sha256:lockfile',
      pins: 'dependency-rrev',
    },
    exactReferences,
    closureDigest: exactClosureDigest(exactReferences),
  };
  assert.deepEqual(
    validatePublishReceipt(receipt, {
      matrixEntry: 'macos-arm64',
      remote: 'workhub-conan',
      sourceRevision: 'sourceRevision',
      lockfileDigest: 'sha256:lockfile',
    }),
    {
      sourceRevision: 'sourceRevision',
      closureDigest: receipt.closureDigest,
      lockfileDigest: 'sha256:lockfile',
      exactReferences,
    },
  );
  assert.throws(
    () =>
      validatePublishReceipt(
        { ...receipt, closureDigest: 'sha256:wrong' },
        {
          matrixEntry: 'macos-arm64',
          remote: 'workhub-conan',
          sourceRevision: 'sourceRevision',
          lockfileDigest: 'sha256:lockfile',
        },
      ),
    /closure digest is invalid/,
  );
});
