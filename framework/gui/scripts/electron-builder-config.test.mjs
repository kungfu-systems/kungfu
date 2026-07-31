// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkElectronBuilderProjections,
  electronBuilderProjectionPaths,
  materializeElectronBuilderConfigs,
  readElectronBuilderProjection,
} from '../../maintainability/semantic-amplification.mjs';

test('electron-builder projections are deterministic and current', () => {
  assert.doesNotThrow(() => checkElectronBuilderProjections());
  const expected = materializeElectronBuilderConfigs();
  assert.deepEqual(
    readElectronBuilderProjection(electronBuilderProjectionPaths.framework),
    expected.framework,
  );
  assert.deepEqual(
    readElectronBuilderProjection(electronBuilderProjectionPaths.product),
    expected.product,
  );
});

test('product overlay preserves common policy and owns only product resources', () => {
  const { framework, product } = materializeElectronBuilderConfigs();
  for (const key of [
    'appId',
    'productName',
    'asar',
    'npmRebuild',
    'beforePack',
    'afterPack',
    'publish',
    'files',
    'mac',
    'linux',
    'win',
  ]) {
    assert.deepEqual(product[key], framework[key], key);
  }
  assert.equal(product.directories.output, '../../product/dist/desktop');
  assert.deepEqual(
    product.extraResources.map((resource) => resource.to),
    [
      'app/node_modules/@kungfu-tech/agent-session',
      'kungfu',
      'upgrade/kungfu-release-manifest.json',
      'cli',
      'tui',
      'extensions',
      'sdk',
      'action',
      'kfd',
      'templates',
      'node_modules',
    ],
  );
  assert.deepEqual(product.extraResources[0].filter, [
    'package.json',
    'src/**/*',
    'kungfu-agent-session.contract.json',
    'kungfu-codex-app-server.contract.json',
    'schemas/**/*',
  ]);
});
