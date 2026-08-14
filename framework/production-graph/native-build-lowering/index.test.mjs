// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadFixture, rooted } from '../contract.mjs';
import {
  FIXTURE_PATH,
  NativeBuildLoweringError,
  checkNativeBuildLoweringContract,
  compileNativeBuildIr,
  lowerNativeBuildIr,
} from './index.mjs';

const ROOT = new URL('../../..', import.meta.url).pathname;

test('journal native-build lowers deterministically to a non-executable Bazel data projection', async () => {
  const fixture = loadFixture(ROOT, FIXTURE_PATH);
  const first = await compileNativeBuildIr(fixture, { root: ROOT });
  const second = await compileNativeBuildIr(structuredClone(fixture), {
    root: ROOT,
  });
  assert.deepEqual(first, second);
  assert.equal(first.schema, 'shifu.native-build-ir/v0');
  assert.equal(first.target.id, 'yijinjing');
  assert.equal(first.target.sources.length > 0, true);
  assert.equal(first.target.headers.length > 0, true);
  assert.deepEqual(
    first.target.dependencies.map(({ id }) => id),
    ['fmt', 'nlohmann-json', 'spdlog', 'xxhash'],
  );

  const projection = lowerNativeBuildIr(first, { root: ROOT });
  assert.equal(projection.provider.id, 'bazel-data-fixture');
  assert.equal(projection.target.ruleClass, 'cc_library');
  assert.equal(projection.target.dependencyLabels, null);
  assert.equal(projection.target.toolchainConstraints, null);
  assert.equal(projection.target.artifactStageProvider, null);
  assert.equal(projection.authorityBoundary.authoritativeBuildGraph, false);
  assert.equal(projection.authorityBoundary.executable, false);
  assert.equal(projection.authorityBoundary.buildFilesWritten, false);
  assert.equal(projection.authorityBoundary.backendInvoked, false);
});

test('authority drift is rejected before provider lowering', async () => {
  const fixture = loadFixture(ROOT, FIXTURE_PATH);
  const original = await compileNativeBuildIr(fixture, { root: ROOT });
  const changed = structuredClone(original);
  const { irRoot: originalRoot, ...body } = changed;
  assert.match(originalRoot, /^sha256:/u);
  body.authorityBindings.layersRoot = `sha256:${'e'.repeat(64)}`;
  const ir = rooted(body, 'irRoot');
  assert.throws(
    () => lowerNativeBuildIr(ir, { root: ROOT }),
    (error) =>
      error instanceof NativeBuildLoweringError &&
      error.code === 'authority-drift',
  );
});

test('receipt retains conditional-go prerequisites and proves forbidden effects absent', async () => {
  const receipt = await checkNativeBuildLoweringContract({ root: ROOT });
  assert.equal(receipt.status, 'qualified-exploration');
  assert.equal(receipt.verdict, 'conditional-go');
  assert.deepEqual(receipt.prerequisites, [
    'artifact-stage-provider',
    'dependency-label-provider',
    'platform-toolchain-provider',
  ]);
  assert.deepEqual(receipt.determinism, {
    irStable: true,
    projectionStable: true,
  });
  assert.deepEqual(receipt.forbiddenEffects, {
    bazelInstallationPerformed: false,
    bazelDownloadPerformed: false,
    bazelInvoked: false,
    nativeBuildExecuted: false,
    buildFilesWritten: false,
    nodesExecuted: false,
    buildCoreRouteChanged: false,
  });
});
