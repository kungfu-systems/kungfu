// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDeliveryBinding,
  createProofDescriptor,
  digest,
  sealProof,
  verifyProofBundle,
} from './affected-native-proof.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const DEV_HEAD = '3'.repeat(40);
const TREE = '4'.repeat(40);
const QUEUE_HEAD = '5'.repeat(40);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLCHAIN = {
  compiler: 'g++-14 (Ubuntu 14.2.0) 14.2.0',
  cmake: 'cmake version 3.31.6',
  ninja: '1.13.2',
  runner: {
    environment: 'github-hosted',
    os: 'Linux',
    arch: 'X64',
    imageOS: 'ubuntu24',
    imageVersion: '20260720.1.0',
  },
};

function plan(head = HEAD, overrides = {}) {
  const value = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: BASE,
    head,
    authority: { layers: 'sha256:layers', buildCapabilities: 'sha256:build' },
    changedPaths: ['framework/core/CMakeLists.txt'],
    directComponents: [],
    closureComponents: ['core'],
    targets: ['a', 'test-a', 'b', 'test-b'],
    tests: ['test-a', 'test-b'],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [
      {
        path: 'framework/core/CMakeLists.txt',
        kind: 'architecture-or-gate-authority',
      },
    ],
    ...overrides,
  };
  return { ...value, planDigest: digest(value) };
}

function partition(value, index) {
  const count = 2;
  const targets = value.targets.filter(
    (_target, targetIndex) => targetIndex % count === index,
  );
  const tests = value.tests.filter((entry) => targets.includes(entry));
  const lanes = Array.from({ length: count }, (_unused, laneIndex) => {
    const laneTargets = value.targets.filter(
      (_target, targetIndex) => targetIndex % count === laneIndex,
    );
    return {
      index: laneIndex,
      targets: laneTargets,
      tests: value.tests.filter((entry) => laneTargets.includes(entry)),
    };
  });
  return {
    schema: 'kungfu.core-affected-native-partition/v1',
    index,
    count,
    targets,
    tests,
    partitionDigest: digest({
      planDigest: value.planDigest,
      index,
      count,
      targets,
      tests,
    }),
    coverageDigest: digest({ planDigest: value.planDigest, count, lanes }),
  };
}

function proofFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-attempt-'));
  const inputs = path.join(root, 'inputs');
  const bundle = path.join(root, 'bundle');
  const value = plan();
  fs.mkdirSync(inputs, { recursive: true });
  for (const index of [0, 1]) {
    const target = path.join(inputs, `partition-${index}`);
    const receipt = {
      schema: 'kungfu.core-affected-native-receipt/v1',
      status: 'passed',
      source: { base: value.base, head: value.head },
      plan: value,
      planDigest: value.planDigest,
      executionPartition: partition(value, index),
      platform: 'linux-x64',
      toolchain: TOOLCHAIN,
    };
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  return { root, inputs, bundle, value };
}

function deliveryValues(base = BASE) {
  const lease = createFamilyQueueLease(
    {
      ok: true,
      decision: 'qualified',
      schema: 'project.cut.merge-queue-admission/v1',
      baseCommitOid: base,
      headCommitOid: HEAD,
      candidateCommitOid: QUEUE_HEAD,
      candidateTreeOid: TREE,
      replayedCommitCount: 1,
      compositionChanged: false,
      compositionRoot: null,
      reasonCodes: [],
    },
    {
      initiativeId: 'go-family-native-state-contract',
      assignmentId: 'go-family-proof-evidence-binding',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'attempt-one',
      admissionProofRoots: [digest({ work: 'proof-evidence-binding' })],
    },
  );
  return {
    event: 'merge_group',
    pullRequest: 1728,
    pullRequestHead: HEAD,
    devHead: base,
    candidateHead: QUEUE_HEAD,
    candidateTree: TREE,
    pullRequestBody: lease.marker,
    combinedStatus: {
      statuses: [
        { context: lease.statusContext, state: 'pending' },
        { context: 'project-cut / queue-admission', state: 'success' },
      ],
    },
    requiredContexts: [
      'affected-native / linux',
      'project-cut / queue-admission',
    ],
    queueAdmissionContext: 'project-cut / queue-admission',
  };
}

function writeProofBundle(descriptor, fixture) {
  const producer = {
    repository: 'kungfu-systems/kungfu',
    runId: 42,
    event: 'pull_request',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: DEV_HEAD,
    checkoutSha: HEAD,
    createdAt: '2026-07-22T00:00:00Z',
  };
  const proof = sealProof(descriptor, fixture.inputs, producer);
  fs.mkdirSync(fixture.bundle, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.bundle, 'proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  for (const index of [0, 1]) {
    fs.copyFileSync(
      path.join(fixture.inputs, `partition-${index}`, 'receipt.json'),
      path.join(fixture.bundle, `partition-${index}.receipt.json`),
    );
  }
}

test('delivery attempt reuse preserves the admitted dev delta attribution', () => {
  const fixture = proofFixture();
  const pullDescriptor = createProofDescriptor(
    fixture.value,
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding({
      ...deliveryValues(),
      event: 'pull_request',
      pullRequestBody: '',
      combinedStatus: {},
    }),
  );
  const queueDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD, { base: DEV_HEAD }),
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding(deliveryValues(DEV_HEAD)),
  );
  writeProofBundle(pullDescriptor, fixture);
  const verification = {
    repository: 'kungfu-systems/kungfu',
    producerRunId: 42,
    producerEvent: 'pull_request',
    producerHeadSha: DEV_HEAD,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  };
  assert.throws(
    () => verifyProofBundle(queueDescriptor, fixture.bundle, verification),
    /dependency-attribution-unknown/u,
  );
  const proof = verifyProofBundle(queueDescriptor, fixture.bundle, {
    ...verification,
    deltaPlan: plan(DEV_HEAD, {
      base: BASE,
      changedPaths: ['docs/release-notes.md'],
      directComponents: ['documentation'],
      closureComponents: ['documentation'],
      targets: [],
      tests: [],
      reasons: [{ path: 'docs/release-notes.md', kind: 'documentation' }],
    }),
  });
  assert.equal(proof.baseDelta.reusable, true);
  assert.equal(proof.baseDelta.reason, 'unrelated-dev-delta');
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('delivery attempt workflow and CLI preserve the verified delta plan', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  const verifier = fs.readFileSync(
    path.join(ROOT, 'scripts/affected-native-proof.mjs'),
    'utf8',
  );
  assert.match(
    workflow,
    /name: Seal reconstructable family delivery attempt[\s\S]*delta_args=\(\)[\s\S]*--dev-delta-plan "\$delta_plan"[\s\S]*seal-attempt[\s\S]*"\$\{delta_args\[@\]\}"/u,
  );
  assert.match(
    verifier,
    /options\.command === 'seal-attempt'[\s\S]*deltaPlan: options\['dev-delta-plan'\]/u,
  );
});
