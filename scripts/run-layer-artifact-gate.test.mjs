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
    ['layers:qualify:surfaces'],
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
