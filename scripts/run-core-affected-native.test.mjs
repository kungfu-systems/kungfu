// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  affectedNativeWorkflowSdkProjection,
  devQueueQualificationImpact,
  sdkQualificationImpact,
} from './run-core-affected-native.mjs';

const workflowPath = '.github/workflows/affected-native-pr.yml';

function affectedNativeWorkflowFixture() {
  return {
    permissions: { contents: 'read', actions: 'read' },
    jobs: {
      candidate_preflight: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 10,
        needs: 'candidate_buildchain_config',
        outputs: {
          'sdk-required': '${{ steps.plan.outputs.sdk-required }}',
        },
        steps: [
          {
            name: 'Plan exact dev candidate qualification',
            id: 'plan',
            run: 'node scripts/run-core-affected-native.mjs --json',
          },
          { name: 'Upload candidate preflight plan', uses: 'actions/upload' },
        ],
      },
      affected_native_shards: {
        needs: ['candidate_preflight', 'proof_probe'],
        if: '${{ needs.candidate_preflight.outputs.sdk-required }}',
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 75,
        strategy: { matrix: { partition: [0, 1] } },
        env: { CC: 'gcc-14', CXX: 'g++-14' },
        steps: [
          { uses: 'actions/checkout@v4' },
          { name: 'Build Core SDK artifacts', run: './shifu build:core:sdk' },
          {
            name: 'Qualify installed four-language SDK wire contract',
            run: './shifu layers:qualify:sdk',
          },
          { name: 'Run affected native closure', run: './shifu gate run' },
        ],
      },
    },
  };
}

function workflowImpact(before, after) {
  return sdkQualificationImpact(
    ['.github/workflows/affected-native-pr.yml'],
    'base',
    'head',
    {
      workflowAtRevision: (revision) => (revision === 'base' ? before : after),
    },
  );
}

test('dev queue impact keeps unrelated source changes out of optional heavy gates', () => {
  assert.deepEqual(devQueueQualificationImpact(['framework/gui/src/app.ts']), {
    shifuWorkspace: { required: false, reasons: [] },
    kfdVerifier: { required: false, reasons: [] },
  });
});

test('dev queue impact selects Shifu and KFD from their declared source surfaces', () => {
  const impact = devQueueQualificationImpact([
    'docs/development/buildchain.md',
    'crates/xinfa/src/lib.rs',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.deepEqual(
    impact.shifuWorkspace.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs', 'docs/development/buildchain.md'],
  );
  assert.equal(impact.kfdVerifier.required, true);
  assert.deepEqual(
    impact.kfdVerifier.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs'],
  );
});

test('the SDK build plan is a self-qualifying SDK authority input', () => {
  assert.deepEqual(
    sdkQualificationImpact(
      ['framework/core/architecture/sdk-build-plan.json'],
      'base',
      'head',
    ),
    {
      required: true,
      reasons: [
        {
          path: 'framework/core/architecture/sdk-build-plan.json',
          kind: 'sdk-authority-or-input',
        },
      ],
    },
  );
});

test('the staged workflow remains self-qualifying under both moved gates', () => {
  const impact = devQueueQualificationImpact([
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.equal(impact.kfdVerifier.required, true);
  assert.deepEqual(
    impact.shifuWorkspace.reasons.map(({ path }) => path),
    [
      '.github/workflows/affected-native-cache-promote.yml',
      '.github/workflows/affected-native-pr.yml',
    ],
  );
});

test('affected-native SDK projection excludes scheduling needs and unrelated jobs', () => {
  const before = affectedNativeWorkflowFixture();
  const after = structuredClone(before);
  after.jobs.affected_native_shards.needs.push('source_acceptance');
  after.jobs.affected_native_shards.if =
    "${{ needs.source_acceptance.result == 'success' && needs.candidate_preflight.outputs.sdk-required }}";
  after.jobs.cancel_after_source_failure = {
    needs: 'source_acceptance',
    'runs-on': 'ubuntu-24.04',
    steps: [{ run: 'gh api --method POST /cancel' }],
  };

  assert.deepEqual(
    affectedNativeWorkflowSdkProjection(before),
    affectedNativeWorkflowSdkProjection(after),
  );
  assert.deepEqual(workflowImpact(before, after), {
    required: false,
    reasons: [
      {
        path: workflowPath,
        kind: 'affected-native-workflow-sdk-neutral',
      },
    ],
  });
});

test('affected-native SDK projection preserves execution and qualification changes', () => {
  const mutations = [
    (workflow) => {
      workflow.jobs.candidate_preflight.steps[0].run += ' --changed';
    },
    (workflow) => {
      workflow.jobs.candidate_preflight.needs = 'another_preflight';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.needs = ['candidate_preflight'];
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.if =
        '${{ needs.candidate_preflight.outputs.native-required }}';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards['runs-on'] = 'ubuntu-22.04';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.steps[1].run += ' --changed';
    },
    (workflow) => {
      workflow.jobs.affected_native_shards.steps[2].run += ' --changed';
    },
  ];
  for (const mutate of mutations) {
    const before = affectedNativeWorkflowFixture();
    const after = structuredClone(before);
    mutate(after);
    assert.equal(workflowImpact(before, after).required, true);
    assert.equal(
      workflowImpact(before, after).reasons[0].kind,
      'affected-native-workflow-sdk-projection',
    );
  }
});

test('affected-native SDK projection fails closed when its boundary is missing', () => {
  const before = affectedNativeWorkflowFixture();
  const after = structuredClone(before);
  after.jobs.affected_native_shards.steps.splice(2, 1);
  assert.deepEqual(workflowImpact(before, after), {
    required: true,
    reasons: [
      {
        path: workflowPath,
        kind: 'affected-native-workflow-sdk-impact-unknown',
      },
    ],
  });
});
