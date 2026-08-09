// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAffectedNativeCacheManifests } from './write-affected-native-cache-manifests.mjs';

const plan = {
  schema: 'kungfu.core-affected-native-plan/v1',
  head: 'a'.repeat(40),
  planDigest: `sha256:${'b'.repeat(64)}`,
  profile: 'embedded-sqlite',
  platformTier: 'github-hosted-linux-native-pr',
  closureComponents: ['storage-runtime'],
  targets: ['kungfu_storage_services'],
  tests: [],
  authority: {
    layers: `sha256:${'c'.repeat(64)}`,
    buildCapabilities: `sha256:${'d'.repeat(64)}`,
  },
};

test('affected native manifests share exact roots and separate cache layers', () => {
  const manifests = createAffectedNativeCacheManifests({
    plan,
    env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24' },
    toolFacts: [{ command: 'c++', status: 0, version: 'fixture compiler' }],
  });
  assert.equal(manifests.dependency.layer, 'dependency');
  assert.equal(manifests.compiler.layer, 'compiler');
  assert.equal(manifests.dependency.identity.sourceSha, plan.head);
  assert.equal(manifests.compiler.identity.planDigest, plan.planDigest);
  assert.deepEqual(manifests.dependency.identity, manifests.compiler.identity);
});

test('compiler exact roots are partitioned while compatibility identity is shared', () => {
  const options = {
    plan: {
      ...plan,
      targets: ['kungfu', 'test-a', 'yijinjing', 'test-b'],
      tests: ['test-a', 'test-b'],
    },
    env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24' },
    toolFacts: [{ command: 'c++', status: 0, version: 'fixture compiler' }],
    partitionCount: 2,
  };
  const first = createAffectedNativeCacheManifests({
    ...options,
    partitionIndex: 0,
  });
  const second = createAffectedNativeCacheManifests({
    ...options,
    partitionIndex: 1,
  });
  assert.deepEqual(first.dependency.identity, second.dependency.identity);
  assert.equal(
    first.compiler.identity.profileDigest,
    second.compiler.identity.profileDigest,
  );
  assert.notEqual(
    first.compiler.identity.planDigest,
    second.compiler.identity.planDigest,
  );
});

test('affected plan profiles share the same validated cache compatibility family', () => {
  const options = {
    env: { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24' },
    toolFacts: [{ command: 'c++', status: 0, version: 'fixture compiler' }],
  };
  const narrow = createAffectedNativeCacheManifests({
    ...options,
    plan,
  });
  const full = createAffectedNativeCacheManifests({
    ...options,
    plan: {
      ...plan,
      profile: 'full',
      planDigest: `sha256:${'e'.repeat(64)}`,
      closureComponents: ['storage-runtime', 'execution-runtime'],
      targets: ['kungfu_storage_services', 'kungfu_execution'],
    },
  });
  assert.equal(
    narrow.dependency.identity.profileDigest,
    full.dependency.identity.profileDigest,
  );
  assert.equal(
    narrow.compiler.identity.profileDigest,
    full.compiler.identity.profileDigest,
  );
  assert.notEqual(
    narrow.compiler.identity.planDigest,
    full.compiler.identity.planDigest,
  );
});

test('non-native and malformed plans cannot mint cache manifests', () => {
  assert.throws(
    () =>
      createAffectedNativeCacheManifests({
        plan: { ...plan, profile: null, closureComponents: [] },
      }),
    /require a native plan/,
  );
  assert.throws(
    () =>
      createAffectedNativeCacheManifests({
        plan: { ...plan, schema: 'other' },
      }),
    /unsupported affected-native plan schema/,
  );
});
