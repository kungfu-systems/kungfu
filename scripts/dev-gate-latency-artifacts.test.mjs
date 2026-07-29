// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { affectedNativeArtifactSelection } from './cancel-dequeued-merge-group-runs.mjs';

test('affected-native artifact selection accepts one complete immutable set', () => {
  const sourceSha = 'a'.repeat(40);
  const selected = affectedNativeArtifactSelection(
    [
      {
        id: 2,
        name: `core-affected-native-${sourceSha}-partition-1-of-2`,
        expired: false,
      },
      {
        id: 1,
        name: `core-affected-native-${sourceSha}-partition-0-of-2`,
        expired: false,
      },
      {
        id: 3,
        name: `core-affected-native-${sourceSha}-partition-2-of-3`,
        expired: true,
      },
    ],
    sourceSha,
  );
  assert.deepEqual(
    selected.map(({ id }) => id),
    [1, 2],
  );
});

test('affected-native artifact selection rejects incomplete or ambiguous sets', () => {
  const sourceSha = 'b'.repeat(40);
  assert.throws(
    () =>
      affectedNativeArtifactSelection(
        [
          {
            name: `core-affected-native-${sourceSha}-partition-0-of-2`,
            expired: false,
          },
        ],
        sourceSha,
      ),
    /partition artifact set is incomplete/u,
  );
  assert.throws(
    () =>
      affectedNativeArtifactSelection(
        [
          {
            name: `core-affected-native-${sourceSha}`,
            expired: false,
          },
          {
            name: `core-affected-native-${sourceSha}-partition-0-of-1`,
            expired: false,
          },
        ],
        sourceSha,
      ),
    /artifact set is ambiguous/u,
  );
});
