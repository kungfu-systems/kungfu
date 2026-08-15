// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  classifyProofBaseDelta,
  createProofDescriptor,
  digest,
} from './affected-native-proof.mjs';
import {
  activeLeaseContextForPullRequest,
  createDevDeliveryWarrantInput,
} from './dev-delivery-warrant-input.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TREE = '3'.repeat(40);

function plan(overrides = {}) {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: BASE,
    head: HEAD,
    authority: { layers: 'sha256:layers', buildCapabilities: 'sha256:build' },
    changedPaths: ['framework/core/CMakeLists.txt'],
    directComponents: [],
    closureComponents: ['core'],
    targets: ['core'],
    tests: ['core-test'],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [],
    sdkQualification: { required: false, reasons: [] },
  };
  const merged = { ...body, ...overrides };
  return { ...merged, planDigest: digest(merged) };
}

function binding() {
  const body = {
    schema: 'kungfu.affected-native-delivery-binding/v1',
    state: 'unbound',
    source: { pullRequest: 42, pullRequestHead: HEAD },
    requiredChecks: { contexts: [], root: digest({ contexts: [] }) },
    queueAdmission: { context: 'Queue admission lease', state: 'not-issued' },
    reason: 'family-lease-issued-only-after-pr-qualification',
  };
  return { ...body, bindingRoot: digest(body) };
}

const TOOLCHAIN = {
  compiler: 'g++-14',
  cmake: 'cmake 3.31',
  ninja: '1.13',
  runner: {
    environment: 'github-hosted',
    os: 'Linux',
    arch: 'X64',
    imageOS: 'ubuntu24',
    imageVersion: '20260804.1',
  },
};

test('consumer input projects exact base-independent Warrant roots', () => {
  const value = plan();
  const descriptor = createProofDescriptor(
    value,
    TREE,
    2,
    TOOLCHAIN,
    binding(),
  );
  const result = createDevDeliveryWarrantInput({
    repository: 'kungfu-systems/kungfu',
    pullRequest: {
      number: 42,
      head: { sha: HEAD },
      base: { ref: 'dev/v4/v4.0' },
    },
    descriptor,
    plan: value,
  });
  assert.equal(result.sourceHead, HEAD);
  assert.equal(result.deliveryClass, 'native-proof-required');
  assert.deepEqual(result.affectedPaths, ['framework/core/CMakeLists.txt']);
  assert.ok(result.shardEvidenceRoots.includes(`sha256:${descriptor.proofId}`));
  assert.equal(
    result.environmentRoot,
    digest({
      schema: 'kungfu.github-hosted-native-environment/v1',
      platformTier: descriptor.identity.platformTier,
      toolchain: descriptor.identity.toolchain,
    }),
  );
  for (const field of [
    'assignmentRoot',
    'initiativeRoot',
    'sourceIdentityRoot',
    'sourcePatchRoot',
    'planRoot',
    'closureRoot',
    'dependencyRoot',
    'toolchainRoot',
    'environmentRoot',
    'inputRoot',
  ]) {
    assert.match(result[field], /^sha256:[0-9a-f]{64}$/u, field);
  }
});

test('consumer input rejects a descriptor bound to another head', () => {
  const value = plan();
  const descriptor = createProofDescriptor(
    value,
    TREE,
    2,
    TOOLCHAIN,
    binding(),
  );
  assert.throws(
    () =>
      createDevDeliveryWarrantInput({
        repository: 'kungfu-systems/kungfu',
        pullRequest: {
          number: 42,
          head: { sha: '4'.repeat(40) },
          base: { ref: 'dev/v4/v4.0' },
        },
        descriptor,
        plan: value,
      }),
    /descriptor head drift/u,
  );
});

test('consumer forwards only the exact-head active family lease context', () => {
  const lease = createFamilyQueueLease(
    {
      ok: true,
      decision: 'qualified',
      schema: 'project.cut.merge-queue-admission/v1',
      baseCommitOid: BASE,
      headCommitOid: HEAD,
      candidateCommitOid: '4'.repeat(40),
      candidateTreeOid: TREE,
      replayedCommitCount: 1,
      compositionChanged: false,
      compositionRoot: null,
      reasonCodes: [],
    },
    {
      initiativeId: 'local-assignment-runtime-api',
      assignmentId: 'local-assignment-runtime-api-r1',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'retry-one',
      admissionProofRoots: [digest({ proof: 'exact' })],
    },
  );
  const pullRequest = { body: lease.marker };

  assert.equal(
    activeLeaseContextForPullRequest(pullRequest, HEAD),
    lease.statusContext,
  );
  assert.equal(
    activeLeaseContextForPullRequest(pullRequest, '5'.repeat(40)),
    '',
  );
});

test('consumer delta classifier reuses only unrelated base movement', () => {
  const proofPlan = plan();
  const advancedBase = '6'.repeat(40);
  const descriptor = createProofDescriptor(
    plan({ base: advancedBase }),
    TREE,
    2,
    TOOLCHAIN,
    binding(),
  );
  const unrelated = plan({
    base: BASE,
    head: advancedBase,
    changedPaths: ['docs/README.md'],
    closureComponents: [],
    targets: [],
    tests: [],
  });
  assert.equal(
    classifyProofBaseDelta({ descriptor, proofPlan, deltaPlan: unrelated })
      .reason,
    'unrelated-dev-delta',
  );
  assert.equal(
    classifyProofBaseDelta({
      descriptor,
      proofPlan,
      deltaPlan: plan({ base: BASE, head: advancedBase }),
    }).reason,
    'dev-delta-overlaps-affected-closure',
  );
  assert.equal(
    classifyProofBaseDelta({ descriptor, proofPlan }).reason,
    'dependency-attribution-unknown',
  );
});

test('terminal consumer executes only protected event and Buildchain authority', () => {
  const workflow = fs.readFileSync(
    new URL(
      '../.github/workflows/dev-delivery-warrant-terminal.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(workflow, /pull_request_target:/u);
  assert.match(workflow, /types: \[closed, dequeued, synchronize\]/u);
  assert.match(workflow, /No matching active Warrant or queued candidate/u);
  assert.match(workflow, /\.observation\.queued\[\]\?/u);
  assert.match(workflow, /needs\.prepare\.outputs\.queued == 'true'/u);
  assert.match(
    workflow,
    /if \[ "\$MERGED" = "true" \] && \[ "\$recorded_head" = "\$EXPECTED_HEAD" \]; then\s+outcome=merged\s+elif \[ "\$EVENT_ACTION" = "dequeued" \] && \[ "\$recorded_head" = "\$EXPECTED_HEAD" \]; then\s+outcome=dequeued/u,
  );
  assert.match(
    workflow,
    /expected-head-sha: \$\{\{ needs\.prepare\.outputs\.active-source-head-sha \}\}/u,
  );
  assert.match(
    workflow,
    /recordedSourceHead:\$recordedHead,observedSourceHead:\$observedHead/u,
  );
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(
    workflow,
    /dev-delivery-warrant-close\.yml@888e87fec88cad41d225c32615e80a87744d4b6d/u,
  );
  assert.match(
    workflow,
    /dev-delivery-warrant-cancel\.yml@888e87fec88cad41d225c32615e80a87744d4b6d/u,
  );
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.ref/u);
  assert.doesNotMatch(workflow, /checkout[^\n]*pull_request\.head/u);
});

test('protected caller makes the Warrant mandatory for exact delivery', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/dev-pr-auto-merge.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /delivery-warrant-mode:.*workflow_run.*required/u);
  assert.match(
    workflow,
    /workflow_dispatch.*inputs\.dry-run == false.*required/u,
  );
  assert.doesNotMatch(workflow, /delivery-warrant-mode:.*shadow/u);
  assert.match(
    workflow,
    /active-lease-context: \$\{\{ needs\.delivery-contract\.outputs\.active-lease-context \}\}/u,
  );
  assert.match(
    workflow,
    /required-status-checks: \|-\n\s+Candidate source acceptance \/ check/u,
  );
  assert.match(workflow, /require-approval: true/u);
  assert.match(workflow, /landing-mode: queue/u);
  assert.match(
    workflow,
    /expected-head-sha: \$\{\{ needs\.resolve-target\.outputs\.expected-head-sha \}\}/u,
  );

  for (const weakened of [
    workflow.replace('require-approval: true', 'require-approval: false'),
    workflow.replaceAll(
      'Candidate source acceptance / check',
      'Candidate source acceptance omitted',
    ),
  ]) {
    const protectedBoundary =
      /require-approval: true/u.test(weakened) &&
      /required-status-checks: \|-\n\s+Candidate source acceptance \/ check/u.test(
        weakened,
      );
    assert.equal(protectedBoundary, false);
  }
});
