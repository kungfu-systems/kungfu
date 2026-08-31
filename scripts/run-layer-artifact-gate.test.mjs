// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  layerArtifactStages,
  runLayerArtifactGate,
} from './run-layer-artifact-gate.mjs';

test('artifact Gate stages keep packing and exact qualification together', () => {
  assert.deepEqual(
    layerArtifactStages('format').map(([task]) => task),
    ['pack:spec', 'layers:qualify:format'],
  );
  assert.deepEqual(
    layerArtifactStages('sdk').map(([task]) => task),
    ['pack:sdk', 'layers:qualify:sdk'],
  );
  assert.deepEqual(
    layerArtifactStages('surfaces').map(([task]) => task),
    ['pack:npm-release-inventory', 'layers:qualify:surfaces'],
  );
});

test('artifact Gate fails closed and does not advance after a failed stage', () => {
  const calls = [];
  const status = runLayerArtifactGate('sdk', {
    run(args) {
      calls.push(args);
      return calls.length === 1 ? 17 : 0;
    },
    env: {},
  });
  assert.equal(status, 17);
  assert.deepEqual(calls, [['pack:sdk']]);
});

test('KFD Verify qualifies sealed release artifacts without repacking them', () => {
  const calls = [];
  const status = runLayerArtifactGate('sdk', {
    run(args) {
      calls.push(args);
      return 0;
    },
    env: { KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS: '1' },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    [
      'layers:qualify:sdk',
      '--',
      '--report',
      'product/release/qualification/layer-sdk-report.json',
    ],
  ]);
});

test('prebuilt-artifact qualification still fails closed without a pack fallback', () => {
  const calls = [];
  const status = runLayerArtifactGate('surfaces', {
    run(args) {
      calls.push(args);
      return 23;
    },
    env: { KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS: '1' },
  });
  assert.equal(status, 23);
  assert.deepEqual(calls, [
    [
      'layers:qualify:surfaces',
      '--',
      '--report',
      'product/release/qualification/layer-surface-report.json',
    ],
  ]);
});
