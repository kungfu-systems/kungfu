// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  graphHitEvidence,
  hitPlan,
  parseHitArgs,
} from './shifu-conan-hit-evidence.mjs';

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

test('hit evidence accepts only exact downloads from the selected remote', () => {
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
  );
  assert.deepEqual(evidence.exactReferences, [
    'rocksdb/6.29.5#rrev:packageId#prev',
  ]);
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
});
