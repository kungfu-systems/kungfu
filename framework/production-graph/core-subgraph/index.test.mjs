// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authoritativeBuildCoreRoute,
  checkCoreProductionSubgraphContract,
  compileCoreProductionSubgraph,
  createCoreProductionSubgraphRequest,
  observeCoreProductionBindings,
} from './index.mjs';

const ROOT = new URL('../../..', import.meta.url).pathname;
const XINFA_SELECTION_ROOT = `sha256:${'cc'.repeat(32)}`;
const XINFA_VERIFICATION_ROOT = `sha256:${'dd'.repeat(32)}`;

function request() {
  return createCoreProductionSubgraphRequest(
    {
      subgraphId: 'project-independent-core-journal',
      xinfaSelectionRoot: XINFA_SELECTION_ROOT,
      xinfaVerificationRoot: XINFA_VERIFICATION_ROOT,
    },
    { root: ROOT },
  );
}

test('journal Core subgraph compiles to one exact three-stage plan', async () => {
  const compiled = await compileCoreProductionSubgraph(request(), {
    root: ROOT,
  });
  assert.deepEqual(compiled.plan.orderedNodeIds, [
    'dependency-bootstrap',
    'native-build',
    'artifact-stage',
  ]);
  assert.deepEqual(
    compiled.subgraph.nodes.map(({ responsibility }) => responsibility),
    [
      'resolve-and-materialize-native-dependencies',
      'compile-native-core',
      'stage-runtime-artifacts',
    ],
  );
  assert.deepEqual(compiled.subgraph.executionBoundary.command, [
    './shifu',
    'build:core',
  ]);
  assert.deepEqual(compiled.subgraph.executionBoundary.environment, {
    KUNGFU_BUILD_PROFILE: 'journal',
  });
  assert.equal(
    compiled.subgraph.executionBoundary.stagesDirectlyInvocable,
    false,
  );
  assert.equal(
    compiled.subgraph.executionBoundary.compilerExecutesStages,
    false,
  );
  assert.equal(compiled.subgraph.intent.sideEffects, false);
  for (const step of compiled.plan.steps) {
    assert.equal(step.directlyInvocable, false);
  }
});

test('request and reference ordering do not change compiled roots', async () => {
  const firstRequest = request();
  const reordered = structuredClone(firstRequest);
  reordered.stages.reverse();
  for (const stage of reordered.stages) {
    stage.dependencies.reverse();
    stage.inputs.reverse();
    stage.outputs.reverse();
  }
  const first = await compileCoreProductionSubgraph(firstRequest, {
    root: ROOT,
  });
  const second = await compileCoreProductionSubgraph(reordered, {
    root: ROOT,
  });
  assert.equal(first.subgraph.subgraphRoot, second.subgraph.subgraphRoot);
  assert.equal(first.plan.planRoot, second.plan.planRoot);
  assert.deepEqual(first, second);
});

test('each downstream stage consumes the exact upstream declaration root', async () => {
  const { subgraph } = await compileCoreProductionSubgraph(request(), {
    root: ROOT,
  });
  const byId = new Map(subgraph.nodes.map((node) => [node.id, node]));
  const dependencies = byId.get('dependency-bootstrap').outputs[0];
  const native = byId.get('native-build');
  assert.deepEqual(
    native.inputs.find(({ id }) => id === dependencies.id),
    dependencies,
  );
  const nativeArtifacts = native.outputs[0];
  assert.deepEqual(
    byId
      .get('artifact-stage')
      .inputs.find(({ id }) => id === nativeArtifacts.id),
    nativeArtifacts,
  );
});

test('source, toolchain, profile, project authority, and Xinfa are exact roots', async () => {
  const observed = observeCoreProductionBindings(ROOT);
  const source = request();
  const cases = [
    [
      'source-root-mismatch',
      (value) => {
        value.source.root = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'authority-root-drift',
      (value) => {
        value.bindings.toolchainRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'profile-authority-mismatch',
      (value) => {
        value.bindings.buildProfile.root = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'authority-root-drift',
      (value) => {
        value.bindings.projectAuthorityRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'xinfa-selection-root-mismatch',
      (value) => {
        value.xinfaVerification.selectionRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const changed = structuredClone(source);
    mutate(changed);
    await assert.rejects(
      compileCoreProductionSubgraph(changed, { root: ROOT, observed }),
      (error) => error?.code === code,
    );
  }
});

test('verification receipt is describe-only and retains the current route', async () => {
  const receipt = await checkCoreProductionSubgraphContract({ root: ROOT });
  const route = authoritativeBuildCoreRoute(ROOT);
  assert.equal(receipt.status, 'qualified');
  assert.equal(receipt.validFixtureCount, 1);
  assert.equal(receipt.invalidFixtureCount, 7);
  assert.equal(receipt.authoritativeRouteRoot, route.routeRoot);
  assert.equal(receipt.nodesExecuted, false);
  assert.equal(receipt.currentRouteUnchanged, true);
});
