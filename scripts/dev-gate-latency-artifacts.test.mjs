// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  affectedNativeArtifactSelection,
  affectedNativeComparedPaths,
  classificationFromPlanMembers,
  devCandidatePlanArtifactSelection,
} from './cancel-dequeued-merge-group-runs.mjs';

function digest(value) {
  const ordered = (item) => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    }
    return item;
  };
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

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

test('dev candidate plan artifact selection requires one exact source', () => {
  const sourceSha = 'c'.repeat(40);
  assert.deepEqual(
    devCandidatePlanArtifactSelection(
      [
        {
          id: 1,
          name: `dev-candidate-plan-${sourceSha}`,
          expired: false,
        },
        {
          id: 2,
          name: `dev-candidate-plan-${'d'.repeat(40)}`,
          expired: false,
        },
      ],
      sourceSha,
    ),
    {
      id: 1,
      name: `dev-candidate-plan-${sourceSha}`,
      expired: false,
    },
  );
  assert.throws(
    () => devCandidatePlanArtifactSelection([], sourceSha),
    /artifact is missing/u,
  );
});

test('historical plan paths match planner diff filtering', () => {
  assert.deepEqual(
    affectedNativeComparedPaths([
      { status: 'modified', filename: 'kept.mjs' },
      { status: 'removed', filename: 'deleted.mjs' },
      {
        status: 'renamed',
        filename: 'new-name.mjs',
        previous_filename: 'old-name.mjs',
      },
    ]),
    ['kept.mjs', 'new-name.mjs'],
  );
});

test('source-bound historical plan owns full-evidence classification', () => {
  const sourceSha = 'e'.repeat(40);
  const baseSha = 'f'.repeat(40);
  const changedPaths = ['framework/example.cpp'];
  const planWithoutDigest = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: baseSha,
    head: sourceSha,
    authority: {
      layers: `sha256:${'1'.repeat(64)}`,
      buildCapabilities: `sha256:${'2'.repeat(64)}`,
    },
    changedPaths,
    closureComponents: ['example'],
    platformTier: 'github-hosted-linux-native-pr',
  };
  const members = {
    'plan.json': JSON.stringify({
      ...planWithoutDigest,
      planDigest: digest(planWithoutDigest),
    }),
  };
  assert.deepEqual(
    classificationFromPlanMembers(members, {
      expectedSourceSha: sourceSha,
      expectedBaseSha: baseSha,
      changedPaths,
    }),
    {
      kind: 'native',
      reason: 'github-hosted-linux-native-pr',
      baseSha,
      sourceSha,
      planDigest: digest(planWithoutDigest),
      changedPaths,
      authority: planWithoutDigest.authority,
      classificationAuthority: 'source-bound-dev-candidate-plan',
    },
  );
  assert.throws(
    () =>
      classificationFromPlanMembers(members, {
        expectedSourceSha: '0'.repeat(40),
        expectedBaseSha: baseSha,
        changedPaths,
      }),
    /identity or digest drift/u,
  );
});
