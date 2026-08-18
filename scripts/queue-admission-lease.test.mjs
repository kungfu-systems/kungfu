// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digest, verifyQueueAdmissionLease } from './affected-native-proof.mjs';
import {
  queueAdmissionRequiredContexts,
  validateDevRequiredLatencyBaseline,
} from './cancel-dequeued-merge-group-runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARRANT_RUNTIME_SHA = '888e87fec88cad41d225c32615e80a87744d4b6d';
const WARRANT_READBACK_RUNTIME_SHA = '0f4004d0d2b2474c2135a3e88d29d9c85bc37834';
const SOURCE_HEAD = '2'.repeat(40);
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'docs',
      'qualification',
      'gates',
      'dev-queue-admission.contract.json',
    ),
    'utf8',
  ),
);

function qualifiedWarrantView(overrides = {}) {
  const candidateId = digest({ candidate: 'qualified' });
  const sourceProofRoot = digest({ proof: 'source' });
  const candidate = {
    pullRequestNumber: 1728,
    sourceHead: SOURCE_HEAD,
    candidateId,
    sourceProofRoot,
    status: 'qualified',
    ...(overrides.candidate || {}),
  };
  const warrant = {
    pullRequestNumber: 1728,
    sourceHead: SOURCE_HEAD,
    candidateId,
    sourceProofRoot,
    phase: 'qualified',
    nativeProofRoot: digest({ proof: 'native' }),
    nativeProofReuseRoot: digest({ proof: 'native-reuse' }),
    fencingToken: digest({ fence: 'qualified' }),
    generation: 7,
    expiresAt: '2026-08-12T12:00:00.000Z',
    ...(overrides.warrant || {}),
  };
  return {
    schema: 'kungfu.buildchain.dev-delivery-command-result/v1',
    observation: {
      schema: 'kungfu.buildchain.dev-delivery-queue-observation/v1',
      repository: 'kungfu-systems/kungfu',
      protectedBase: 'dev/v4/v4.0',
      stateRoot: digest({ queue: 'qualified' }),
      observedAt: '2026-08-12T11:00:00.000Z',
      activeCandidate: candidate,
      activeWarrant: warrant,
    },
  };
}

test('queue admission consumes only an exact qualified two-phase Warrant', () => {
  const receipt = verifyQueueAdmissionLease({
    view: qualifiedWarrantView(),
    pullRequestNumber: 1728,
    sourceHeadSha: SOURCE_HEAD,
    now: '2026-08-12T11:30:00.000Z',
  });
  assert.equal(receipt.candidateState, 'qualified');
  assert.equal(receipt.nativeProofRoot, digest({ proof: 'native' }));
  assert.equal(receipt.nativeProofReuseRoot, digest({ proof: 'native-reuse' }));
});

test('queue admission rejects provisional and legacy single-phase states', () => {
  for (const status of ['selected', 'proving', 'waiting', 'blocked']) {
    assert.throws(
      () =>
        verifyQueueAdmissionLease({
          view: qualifiedWarrantView({
            candidate: { status },
            warrant: { phase: 'provisional' },
          }),
          pullRequestNumber: 1728,
          sourceHeadSha: SOURCE_HEAD,
          now: '2026-08-12T11:30:00.000Z',
        }),
      /not delivery-ready/u,
    );
  }
});

test('queue admission rejects qualified state without native proof binding', () => {
  assert.throws(
    () =>
      verifyQueueAdmissionLease({
        view: qualifiedWarrantView({
          warrant: { nativeProofRoot: undefined },
        }),
        pullRequestNumber: 1728,
        sourceHeadSha: SOURCE_HEAD,
        now: '2026-08-12T11:30:00.000Z',
      }),
    /nativeProofRoot/u,
  );
});

test('queue admission lease has distinct PR-head and merge-group authorities', () => {
  assert.equal(CONTRACT.schema, 'kungfu.dev-queue-admission/v1');
  assert.equal(CONTRACT.requiredContext, 'Queue admission lease');
  assert.equal(
    CONTRACT.authority.pullRequestHead,
    'buildchain-serialized-pr-head',
  );
  assert.equal(
    CONTRACT.authority.mergeGroup,
    '.github/workflows/queue-admission-lease.yml',
  );
  assert.equal(CONTRACT.admission.queueMustBeEmpty, true);
  assert.equal(CONTRACT.admission.requiredPosition, 1);
  assert.equal(CONTRACT.admission.freshProjectCutReplay, true);
  assert.equal(CONTRACT.admission.exactQueueRevisionRequired, true);
  assert.equal(CONTRACT.admission.exactWarrantFenceRequired, true);
  assert.equal(CONTRACT.admission.activeWarrantNonPreemptive, true);
  assert.equal(CONTRACT.admission.transientDequeueNonTerminal, true);
  assert.equal(CONTRACT.admission.continuousNativeHeartbeat, true);
  assert.equal(CONTRACT.admission.fenceLossStopsWorker, true);
  assert.equal(CONTRACT.admission.sourceQualificationProofRequired, true);
  assert.equal(CONTRACT.admission.integrationDeliveryProofRequired, true);
  assert.equal(
    CONTRACT.authority.queueAndWarrant,
    `kungfu-systems/buildchain@${WARRANT_RUNTIME_SHA}`,
  );
  assert.equal(
    CONTRACT.authority.stateRefPattern,
    'buildchain/dev-delivery-warrant/dev-vN-vN.N',
  );
  assert.equal(
    CONTRACT.revocation.dequeue,
    'failure-status-on-exact-pr-head-for-non-merged-removal',
  );
  assert.equal(
    CONTRACT.revocation.merged,
    'preserve-success-status-on-exact-pr-head',
  );
  assert.equal(
    CONTRACT.authority.dequeueControllerSource,
    'current-protected-pull-request-base-ref',
  );
  assert.equal(CONTRACT.revocation.sameHeadRetry, 'forbidden-after-revocation');
  assert.equal(CONTRACT.admittedFamily.minimumMajor, 4);
  assert.deepEqual(CONTRACT.admittedFamily.include, ['refs/heads/dev/v*/v*']);
  assert.deepEqual(CONTRACT.admittedFamily.exclude, [
    'refs/heads/dev/v1/v*',
    'refs/heads/dev/v2/v*',
    'refs/heads/dev/v3/v*',
  ]);
  assert.equal(CONTRACT.rulesetActivation.required, true);
  assert.equal(CONTRACT.rulesetActivation.rulesetId, 19057118);
  assert.equal(
    CONTRACT.rulesetActivation.rulesetName,
    'Buildchain dev merge queue: admitted default dev channel',
  );
  assert.deepEqual(CONTRACT.rulesetActivation.target, {
    include: ['~DEFAULT_BRANCH'],
    exclude: [],
  });
  assert.match(
    CONTRACT.rulesetActivation.providerConstraint,
    /reject wildcard ref targets/u,
  );
  assert.equal(CONTRACT.rulesetActivation.expectedSource, 'any');
});

test('merge-group continuation consumes the exact durable Warrant lease', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.authority.mergeGroup),
    'utf8',
  );
  assert.match(workflow, /^name: Queue admission lease$/mu);
  assert.match(workflow, /^\s{2}merge_group:$/mu);
  assert.doesNotMatch(workflow, /^\s{2}pull_request(?:_target)?:$/mu);
  assert.match(workflow, /^\s{2}contents: read$/mu);
  assert.match(workflow, /^\s{2}pull-requests: read$/mu);
  assert.match(workflow, /^\s{4}name: Queue admission lease$/mu);
  assert.match(
    workflow,
    /MERGE_GROUP_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/u,
  );
  assert.match(workflow, /MERGE_GROUP_HEAD_SHA" != "\$GITHUB_SHA/u);
  assert.match(
    workflow,
    /buildchain\/dev-delivery-warrant\/\$\{protected_base\/\/\\\/\/-\}/u,
  );
  assert.match(workflow, /buildchain\.mjs" dev warrant observe/u);
  assert.match(workflow, /--branch "\$protected_base"/u);
  assert.match(workflow, /affected-native-proof\.mjs queue-lease-verify/u);
  assert.match(workflow, new RegExp(WARRANT_RUNTIME_SHA, 'u'));
  assert.match(
    workflow,
    /name: Install pinned Buildchain Warrant runtime[\s\S]*working-directory: \.buildchain\/dev-delivery-runtime[\s\S]*corepack pnpm install --frozen-lockfile --ignore-scripts[\s\S]*name: Consume the exact Buildchain Warrant lease/u,
  );
});

test('mutating Warrant controllers share one runtime and read-only qualification uses the protected compatibility reader', () => {
  const workflowPaths = [
    '.github/workflows/dev-pr-auto-merge.yml',
    '.github/workflows/dev-delivery-warrant-terminal.yml',
    CONTRACT.authority.mergeGroup,
  ];
  for (const workflowPath of workflowPaths) {
    const workflow = fs.readFileSync(path.join(ROOT, workflowPath), 'utf8');
    assert.match(
      workflow,
      new RegExp(WARRANT_RUNTIME_SHA, 'u'),
      `${workflowPath} must consume Buildchain ${WARRANT_RUNTIME_SHA}`,
    );
  }
  const qualificationWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(
    qualificationWorkflow,
    new RegExp(WARRANT_READBACK_RUNTIME_SHA, 'u'),
  );
  assert.doesNotMatch(
    qualificationWorkflow,
    new RegExp(WARRANT_RUNTIME_SHA, 'u'),
  );
});

test('trusted dequeue controller revokes the same exact-head context', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.authority.dequeueRevocation),
    'utf8',
  );
  assert.match(workflow, /^\s{2}pull_request_target:$/mu);
  assert.match(workflow, /^\s+types: \[dequeued\]$/mu);
  assert.match(workflow, /^\s+statuses: write$/mu);
  assert.match(
    workflow,
    new RegExp(
      `QUEUE_ADMISSION_CONTEXT: ${CONTRACT.requiredContext.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
      'u',
    ),
  );
  assert.match(
    workflow,
    /DEQUEUED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
});

test('live required contexts match baseline or one declared lease expansion', () => {
  const baseline = {
    $schema: 'kungfu.dev-required-latency-baseline/v1',
    requiredContexts: ['a', 'b'],
  };
  assert.equal(validateDevRequiredLatencyBaseline(baseline, ['b', 'a']), true);
  assert.equal(
    validateDevRequiredLatencyBaseline(
      baseline,
      ['b', 'queue-lease', 'a'],
      ['queue-lease'],
    ),
    true,
  );
  assert.throws(
    () => validateDevRequiredLatencyBaseline(baseline, ['a', 'c']),
    /live required contexts drifted/,
  );
  assert.throws(
    () =>
      validateDevRequiredLatencyBaseline(
        baseline,
        ['a', 'queue-lease'],
        ['queue-lease'],
      ),
    /live required contexts drifted/,
  );
});

test('queue admission contract authorizes only one explicit required context', () => {
  assert.deepEqual(
    queueAdmissionRequiredContexts({
      schema: 'kungfu.dev-queue-admission/v1',
      requiredContext: 'Queue admission lease',
      rulesetActivation: { required: true },
    }),
    ['Queue admission lease'],
  );
  assert.throws(
    () =>
      queueAdmissionRequiredContexts({
        schema: 'kungfu.dev-queue-admission/v1',
        requiredContext: 'Queue admission lease',
        rulesetActivation: { required: false },
      }),
    /must require ruleset activation/,
  );
});
