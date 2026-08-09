// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectTestManifest } from './check-test-manifest.mjs';

test('an unregistered tracked test fails the manifest', () => {
  const result = inspectTestManifest({
    trackedFiles: [
      'scripts/registered.test.mjs',
      'scripts/unregistered.test.mjs',
    ],
    packageScripts: [],
    runnerSources: [
      {
        path: 'scripts/run-example.mjs',
        text: 'node --test scripts/registered.test.mjs',
      },
    ],
  });

  assert.deepEqual(result.missing, ['scripts/unregistered.test.mjs']);
});

test('package test globs and pytest directories register tracked tests', () => {
  const result = inspectTestManifest({
    trackedFiles: [
      'developer/sdk/tests/contract-cli.test.mjs',
      'framework/core/tests/python/test_contract.py',
    ],
    packageScripts: [
      {
        path: 'developer/sdk/package.json',
        scripts: { test: 'node --test tests/*.test.mjs' },
      },
      {
        path: 'package.json',
        scripts: {
          'test:core-python': 'pytest -q framework/core/tests/python',
        },
      },
    ],
    runnerSources: [],
  });

  assert.deepEqual(result.missing, []);
});

test('a basename reference does not register duplicate test basenames', () => {
  const result = inspectTestManifest({
    trackedFiles: [
      'framework/a/tests/test_contract.py',
      'framework/b/tests/test_contract.py',
      'scripts/a/contract.test.mjs',
      'scripts/b/contract.test.mjs',
    ],
    packageScripts: [],
    runnerSources: [
      {
        path: 'scripts/run-example.mjs',
        text: [
          'pytest test_contract.py',
          'node --test contract.test.mjs',
          'pytest framework/a/tests/test_contract.py',
          'node --test scripts/a/contract.test.mjs',
        ].join('\n'),
      },
    ],
  });

  assert.deepEqual(result.missing, [
    'framework/b/tests/test_contract.py',
    'scripts/b/contract.test.mjs',
  ]);
});

test('a unique basename remains an explicit registration', () => {
  const result = inspectTestManifest({
    trackedFiles: ['scripts/unique-contract.test.mjs'],
    packageScripts: [],
    runnerSources: [
      {
        path: 'scripts/run-example.mjs',
        text: 'node --test unique-contract.test.mjs',
      },
    ],
  });

  assert.deepEqual(result.missing, []);
});
