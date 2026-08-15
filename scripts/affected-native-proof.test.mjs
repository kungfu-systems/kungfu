// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCachePromotionAuthority,
  createDeliveryAttempt,
  createDeliveryBinding,
  createProofDescriptor,
  digest,
  nativeToolchainIdentity,
  requiredContextsFromRules,
  sealProof,
  selectReusableArtifact,
  validateDeliveryAttempt,
  verifyCachePromotionAuthority,
  verifyProofBundle,
} from './affected-native-proof.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const OTHER_HEAD = '3'.repeat(40);
const TREE = '4'.repeat(40);
const QUEUE_HEAD = '5'.repeat(40);
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
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function plan(head = HEAD, overrides = {}) {
  const body = {
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
  return { ...body, planDigest: digest(body) };
}

function partition(value, count, index) {
  const targets = value.targets.filter(
    (_target, targetIndex) => targetIndex % count === index,
  );
  const targetSet = new Set(targets);
  const tests = value.tests.filter((entry) => targetSet.has(entry));
  const lanes = Array.from({ length: count }, (_unused, laneIndex) => {
    const laneTargets = value.targets.filter(
      (_target, targetIndex) => targetIndex % count === laneIndex,
    );
    const laneTargetSet = new Set(laneTargets);
    return {
      index: laneIndex,
      targets: laneTargets,
      tests: value.tests.filter((entry) => laneTargetSet.has(entry)),
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

function receipt(value, index) {
  return {
    schema: 'kungfu.core-affected-native-receipt/v1',
    status: 'passed',
    source: { base: value.base, head: value.head },
    plan: value,
    planDigest: value.planDigest,
    executionPartition: partition(value, 2, index),
    platform: 'linux-x64',
    toolchain: TOOLCHAIN,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-proof-'));
  const inputs = path.join(root, 'inputs');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(inputs, { recursive: true });
  const value = plan();
  for (const index of [0, 1]) {
    const target = path.join(inputs, `partition-${index}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'receipt.json'),
      `${JSON.stringify(receipt(value, index), null, 2)}\n`,
    );
  }
  return { root, inputs, bundle, value };
}

function producer(overrides = {}) {
  return {
    repository: 'kungfu-systems/kungfu',
    runId: 42,
    event: 'merge_group',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: HEAD,
    checkoutSha: HEAD,
    createdAt: '2026-07-22T00:00:00Z',
    ...overrides,
  };
}

function deliveryFixture(overrides = {}) {
  const lease = createFamilyQueueLease(
    {
      ok: true,
      decision: 'qualified',
      schema: 'project.cut.merge-queue-admission/v1',
      baseCommitOid: BASE,
      headCommitOid: HEAD,
      candidateCommitOid: QUEUE_HEAD,
      candidateTreeOid: TREE,
      replayedCommitCount: 1,
      compositionChanged: false,
      compositionRoot: null,
      reasonCodes: [],
      ...(overrides.cut || {}),
    },
    {
      initiativeId: 'go-family-native-state-contract',
      assignmentId: 'go-family-proof-evidence-binding',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'attempt-one',
      admissionProofRoots: [digest({ work: 'proof-evidence-binding' })],
      ...(overrides.family || {}),
    },
  );
  const requiredContexts = [
    'affected-native / linux',
    'project-cut / queue-admission',
  ];
  return {
    lease,
    values: {
      event: 'merge_group',
      pullRequest: 1728,
      pullRequestHead: HEAD,
      devHead: BASE,
      candidateHead: QUEUE_HEAD,
      candidateTree: TREE,
      pullRequestBody: lease.marker,
      combinedStatus: {
        statuses: [
          { context: lease.statusContext, state: 'pending' },
          { context: 'project-cut / queue-admission', state: 'success' },
        ],
      },
      requiredContexts,
      queueAdmissionContext: 'project-cut / queue-admission',
      ...(overrides.values || {}),
    },
  };
}

function writeBundle(descriptor, value, proofProducer = producer()) {
  const proof = sealProof(descriptor, value.inputs, proofProducer);
  fs.mkdirSync(value.bundle, { recursive: true });
  fs.writeFileSync(
    path.join(value.bundle, 'proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  for (const index of [0, 1]) {
    fs.copyFileSync(
      path.join(value.inputs, `partition-${index}`, 'receipt.json'),
      path.join(value.bundle, `partition-${index}.receipt.json`),
    );
  }
  return proof;
}
test('descriptor binds the exact tree, base, plan projection, and toolchain', () => {
  const first = createProofDescriptor(plan(HEAD), TREE, 2, TOOLCHAIN);
  const rewritten = createProofDescriptor(plan(OTHER_HEAD), TREE, 2, TOOLCHAIN);
  assert.equal(first.proofId, rewritten.proofId);
  assert.notEqual(
    first.proofId,
    createProofDescriptor(
      plan(HEAD, { base: '5'.repeat(40) }),
      TREE,
      2,
      TOOLCHAIN,
    ).proofId,
  );
  assert.notEqual(
    first.proofId,
    createProofDescriptor(
      plan(HEAD, { targets: ['different'] }),
      TREE,
      2,
      TOOLCHAIN,
    ).proofId,
  );
  assert.notEqual(
    first.proofId,
    createProofDescriptor(plan(HEAD), TREE, 2, {
      ...TOOLCHAIN,
      compiler: 'g++-14 changed',
    }).proofId,
  );
  assert.equal(
    first.proofId,
    createProofDescriptor(plan(HEAD), TREE, 2, {
      ...TOOLCHAIN,
      runner: { ...TOOLCHAIN.runner, imageVersion: '20260721.2.0' },
    }).proofId,
  );
  assert.notEqual(
    first.proofId,
    createProofDescriptor(plan(HEAD), TREE, 2, {
      ...TOOLCHAIN,
      runner: { ...TOOLCHAIN.runner, imageOS: 'ubuntu26' },
    }).proofId,
  );
  assert.deepEqual(
    first.identity.toolchain,
    nativeToolchainIdentity(TOOLCHAIN),
  );
});
test('family delivery binding is separate from reusable qualification identity', () => {
  const { values } = deliveryFixture();
  const binding = createDeliveryBinding(values);
  const first = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    binding,
  );
  const repeated = createProofDescriptor(
    plan(OTHER_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding(values),
  );
  assert.equal(binding.state, 'bound');
  assert.equal(first.schema, 'kungfu.affected-native-proof-descriptor/v4');
  assert.match(first.identity.dependencyRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(first.identity.closureRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.proofId, repeated.proofId);
  const reclassified = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding(
      deliveryFixture({
        family: { deliveryClass: 'native-proof-reclassified' },
      }).values,
    ),
  );
  const expandedChecks = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding({
      ...values,
      requiredContexts: [...values.requiredContexts, 'source / acceptance'],
    }),
  );
  assert.equal(first.proofId, reclassified.proofId);
  assert.equal(first.proofId, expandedChecks.proofId);
  assert.deepEqual(
    first.qualificationIdentity,
    reclassified.qualificationIdentity,
  );
  assert.deepEqual(
    first.qualificationIdentity,
    expandedChecks.qualificationIdentity,
  );
  assert.notEqual(
    first.identity.deliveryBinding.bindingRoot,
    reclassified.identity.deliveryBinding.bindingRoot,
  );
  assert.notEqual(
    first.identity.deliveryBinding.bindingRoot,
    expandedChecks.identity.deliveryBinding.bindingRoot,
  );
  assert.equal(
    first.proofId,
    createProofDescriptor(
      plan(QUEUE_HEAD, { base: '6'.repeat(40) }),
      TREE,
      2,
      TOOLCHAIN,
      createDeliveryBinding(
        deliveryFixture({
          cut: { baseCommitOid: '6'.repeat(40) },
          values: { devHead: '6'.repeat(40) },
        }).values,
      ),
    ).proofId,
  );
  assert.throws(
    () =>
      createProofDescriptor(
        plan(QUEUE_HEAD),
        TREE,
        2,
        TOOLCHAIN,
        createDeliveryBinding(
          deliveryFixture({
            cut: { candidateTreeOid: '6'.repeat(40) },
            values: { candidateTree: '6'.repeat(40) },
          }).values,
        ),
      ),
    /descriptor delivery source drift/u,
  );
  assert.throws(
    () =>
      createDeliveryBinding({
        ...values,
        devHead: OTHER_HEAD,
      }),
    /latest-dev replay drift/u,
  );
});
test('exact pull-request qualification proof is reusable by bound delivery', () => {
  const value = fixture();
  const { values } = deliveryFixture();
  const unbound = createDeliveryBinding({
    ...values,
    event: 'pull_request',
    pullRequestBody: '',
    combinedStatus: {},
  });
  const bound = createDeliveryBinding(values);
  const pullDescriptor = createProofDescriptor(
    value.value,
    TREE,
    2,
    TOOLCHAIN,
    unbound,
  );
  const queueDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    bound,
  );
  assert.equal(unbound.state, 'unbound');
  assert.equal(unbound.queueAdmission.state, 'not-issued');
  assert.equal(pullDescriptor.proofId, queueDescriptor.proofId);
  assert.deepEqual(
    pullDescriptor.qualificationIdentity,
    queueDescriptor.qualificationIdentity,
  );
  assert.notEqual(
    pullDescriptor.identity.deliveryBinding.bindingRoot,
    queueDescriptor.identity.deliveryBinding.bindingRoot,
  );
  writeBundle(
    pullDescriptor,
    value,
    producer({
      event: 'pull_request',
      triggerHeadSha: OTHER_HEAD,
      checkoutSha: HEAD,
    }),
  );
  const proof = verifyProofBundle(queueDescriptor, value.bundle, {
    repository: 'kungfu-systems/kungfu',
    producerRunId: 42,
    producerEvent: 'pull_request',
    producerHeadSha: OTHER_HEAD,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  });
  const projectedDrift = structuredClone(queueDescriptor);
  projectedDrift.qualificationIdentity.sourceTree = '6'.repeat(40);
  assert.throws(
    () =>
      verifyProofBundle(projectedDrift, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'pull_request',
        producerHeadSha: OTHER_HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /qualification identity projection drift/u,
  );
  const attempt = createDeliveryAttempt(
    queueDescriptor,
    proof,
    'reused',
    producer({
      runId: 84,
      triggerHeadSha: QUEUE_HEAD,
      checkoutSha: QUEUE_HEAD,
    }),
  );
  assert.equal(attempt.deliveryBindingRoot, bound.bindingRoot);
  assert.equal(validateDeliveryAttempt(attempt), attempt);
  const ordinary = createDeliveryBinding({
    ...values,
    pullRequestBody: '',
    combinedStatus: {
      statuses: [{ context: values.queueAdmissionContext, state: 'success' }],
    },
  });
  const ordinaryDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    ordinary,
  );
  const ordinaryAttempt = createDeliveryAttempt(
    ordinaryDescriptor,
    proof,
    'reused',
    producer({
      runId: 84,
      triggerHeadSha: QUEUE_HEAD,
      checkoutSha: QUEUE_HEAD,
    }),
  );
  assert.equal(ordinaryDescriptor.proofId, pullDescriptor.proofId);
  assert.equal(validateDeliveryAttempt(ordinaryAttempt), ordinaryAttempt);
  assert.throws(
    () =>
      createDeliveryBinding({
        ...values,
        pullRequestBody: '',
        combinedStatus: {},
      }),
    /queue admission lease is not successful/u,
  );
  assert.throws(
    () =>
      createDeliveryBinding({
        ...values,
        combinedStatus: {
          statuses: [
            {
              context: values.queueAdmissionContext,
              state: 'success',
            },
          ],
        },
      }),
    /family delivery lease is not active/u,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});
test('delivery attempt seals the exact family, source, proof decision, and run', () => {
  const binding = createDeliveryBinding({
    ...deliveryFixture().values,
    candidateHead: OTHER_HEAD,
  });
  const descriptor = createProofDescriptor(
    plan(OTHER_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    binding,
  );
  const queueProducer = producer({
    triggerHeadSha: OTHER_HEAD,
    checkoutSha: OTHER_HEAD,
  });
  const proof = {
    proofId: descriptor.proofId,
    proofRoot: digest({ proofId: descriptor.proofId }),
    producer: { ...queueProducer, runId: 41 },
  };
  const attempt = createDeliveryAttempt(descriptor, proof, 'reused', {
    ...queueProducer,
    runId: 42,
  });
  assert.equal(validateDeliveryAttempt(attempt), attempt);
  assert.equal(attempt.source.pullRequestHead, HEAD);
  assert.equal(attempt.source.mergeGroupHead, OTHER_HEAD);
  assert.equal(attempt.source.replayedTree, TREE);
  assert.equal(attempt.proof.decision, 'reused');
  assert.equal(attempt.workflow.runId, 42);
  assert.throws(
    () =>
      validateDeliveryAttempt({
        ...attempt,
        source: { ...attempt.source, pullRequestHead: OTHER_HEAD },
      }),
    /root drift/u,
  );
});
test('effective rules normalize the exact required-check set', () => {
  assert.deepEqual(
    requiredContextsFromRules([
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'project-cut / queue-admission' },
            { context: 'affected-native / linux' },
            { context: 'affected-native / linux' },
          ],
        },
      },
    ]),
    ['affected-native / linux', 'project-cut / queue-admission'],
  );
});

test('hosted image rollout preserves proof compatibility and receipt facts', () => {
  const value = fixture();
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  const receiptPath = path.join(value.inputs, 'partition-1', 'receipt.json');
  const rolled = receipt(value.value, 1);
  rolled.toolchain = {
    ...TOOLCHAIN,
    runner: { ...TOOLCHAIN.runner, imageVersion: '20260721.2.0' },
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(rolled, null, 2)}\n`);
  const proof = sealProof(descriptor, value.inputs, producer());
  assert.equal(
    proof.partitions[1].toolchain.runner.imageVersion,
    '20260721.2.0',
  );

  rolled.toolchain = {
    ...TOOLCHAIN,
    runner: { ...TOOLCHAIN.runner, imageOS: 'ubuntu26' },
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(rolled, null, 2)}\n`);
  assert.throws(
    () => sealProof(descriptor, value.inputs, producer()),
    /toolchain identity drift/,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('complete partition evidence seals and verifies against the exact producer', () => {
  const value = fixture();
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  const proof = writeBundle(descriptor, value);
  const verified = verifyProofBundle(descriptor, value.bundle, {
    repository: 'kungfu-systems/kungfu',
    producerRunId: 42,
    producerEvent: 'merge_group',
    producerHeadSha: HEAD,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(verified.proofRoot, proof.proofRoot);
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('exact PR proof survives the synthetic merge-group commit rewrite', () => {
  const value = fixture();
  const pullDescriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  const queueDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
  );
  writeBundle(
    pullDescriptor,
    value,
    producer({
      event: 'pull_request',
      triggerHeadSha: OTHER_HEAD,
      checkoutSha: HEAD,
    }),
  );
  assert.doesNotThrow(() =>
    verifyProofBundle(queueDescriptor, value.bundle, {
      repository: 'kungfu-systems/kungfu',
      producerRunId: 42,
      producerEvent: 'pull_request',
      producerHeadSha: OTHER_HEAD,
      maxAgeSeconds: 6 * 60 * 60,
      now: '2026-07-22T01:00:00Z',
    }),
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('delivery attempt reuse preserves the admitted dev delta attribution', () => {
  const value = fixture();
  const { values } = deliveryFixture();
  const pullDescriptor = createProofDescriptor(
    value.value,
    TREE,
    2,
    TOOLCHAIN,
    createDeliveryBinding({
      ...values,
      event: 'pull_request',
      pullRequestBody: '',
      combinedStatus: {},
    }),
  );
  const queueBinding = createDeliveryBinding(
    deliveryFixture({
      cut: { baseCommitOid: OTHER_HEAD },
      values: { devHead: OTHER_HEAD },
    }).values,
  );
  const queueDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD, { base: OTHER_HEAD }),
    TREE,
    2,
    TOOLCHAIN,
    queueBinding,
  );
  writeBundle(
    pullDescriptor,
    value,
    producer({
      event: 'pull_request',
      triggerHeadSha: OTHER_HEAD,
      checkoutSha: HEAD,
    }),
  );
  const verification = {
    repository: 'kungfu-systems/kungfu',
    producerRunId: 42,
    producerEvent: 'pull_request',
    producerHeadSha: OTHER_HEAD,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  };
  assert.throws(
    () => verifyProofBundle(queueDescriptor, value.bundle, verification),
    /dependency-attribution-unknown/u,
  );
  const deltaPlan = plan(OTHER_HEAD, {
    base: BASE,
    changedPaths: ['docs/release-notes.md'],
    directComponents: ['documentation'],
    closureComponents: ['documentation'],
    targets: [],
    tests: [],
    reasons: [
      {
        path: 'docs/release-notes.md',
        kind: 'documentation',
      },
    ],
  });
  const proof = verifyProofBundle(queueDescriptor, value.bundle, {
    ...verification,
    deltaPlan,
  });
  assert.equal(proof.baseDelta.reusable, true);
  assert.equal(proof.baseDelta.reason, 'unrelated-dev-delta');
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('merge-group authority admits exact PR cache payload transport', () => {
  const value = fixture();
  const pullDescriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  const queueDescriptor = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
  );
  const proof = writeBundle(
    pullDescriptor,
    value,
    producer({
      event: 'pull_request',
      triggerHeadSha: OTHER_HEAD,
      checkoutSha: HEAD,
    }),
  );
  const authority = createCachePromotionAuthority(
    queueDescriptor,
    value.bundle,
    {
      targetRepository: 'kungfu-systems/kungfu',
      targetRunId: 84,
      targetEvent: 'merge_group',
      targetHeadSha: QUEUE_HEAD,
      targetSourceTree: TREE,
      producerRepository: 'kungfu-systems/kungfu',
      producerRunId: 42,
      producerEvent: 'pull_request',
      producerHeadSha: OTHER_HEAD,
      maxAgeSeconds: 6 * 60 * 60,
      now: '2026-07-22T01:00:00Z',
    },
  );
  const authorityDir = path.join(value.root, 'authority');
  fs.mkdirSync(path.join(authorityDir, 'proof'), { recursive: true });
  fs.writeFileSync(
    path.join(authorityDir, 'descriptor.json'),
    `${JSON.stringify(queueDescriptor, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(authorityDir, 'authority.json'),
    `${JSON.stringify(authority, null, 2)}\n`,
  );
  for (const entry of fs.readdirSync(value.bundle)) {
    fs.copyFileSync(
      path.join(value.bundle, entry),
      path.join(authorityDir, 'proof', entry),
    );
  }
  const verified = verifyCachePromotionAuthority(authorityDir, {
    targetRepository: 'kungfu-systems/kungfu',
    targetRunId: 84,
    targetHeadSha: QUEUE_HEAD,
    targetSourceTree: TREE,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(verified.proof.proofRoot, proof.proofRoot);
  assert.equal(verified.payloadSourceSha, HEAD);
  assert.equal(verified.producer.event, 'pull_request');
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cache promotion authority preserves the exact family delivery binding', () => {
  const value = fixture();
  const binding = createDeliveryBinding(deliveryFixture().values);
  const descriptor = createProofDescriptor(
    value.value,
    TREE,
    2,
    TOOLCHAIN,
    binding,
  );
  writeBundle(descriptor, value);
  const authority = createCachePromotionAuthority(descriptor, value.bundle, {
    targetRepository: 'kungfu-systems/kungfu',
    targetRunId: 84,
    targetEvent: 'merge_group',
    targetHeadSha: HEAD,
    targetSourceTree: TREE,
    producerRepository: 'kungfu-systems/kungfu',
    producerRunId: 42,
    producerEvent: 'merge_group',
    producerHeadSha: HEAD,
    maxAgeSeconds: 6 * 60 * 60,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(authority.deliveryBindingRoot, binding.bindingRoot);
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cache promotion authority fails closed on target or proof drift', () => {
  const value = fixture();
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  writeBundle(descriptor, value);
  assert.throws(
    () =>
      createCachePromotionAuthority(descriptor, value.bundle, {
        targetRepository: 'kungfu-systems/kungfu',
        targetRunId: 84,
        targetEvent: 'merge_group',
        targetHeadSha: QUEUE_HEAD,
        targetSourceTree: '6'.repeat(40),
        producerRepository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /target source tree drift/,
  );
  assert.throws(
    () =>
      createCachePromotionAuthority(descriptor, value.bundle, {
        targetRepository: 'other/repository',
        targetRunId: 84,
        targetEvent: 'merge_group',
        targetHeadSha: QUEUE_HEAD,
        targetSourceTree: TREE,
        producerRepository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /producer repository drift/,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('successful queue proof binds SDK qualification before repeat reuse', () => {
  const value = fixture();
  value.value = plan(HEAD, {
    sdkQualification: { required: true, reasons: ['public-sdk-contract'] },
  });
  for (const index of [0, 1]) {
    fs.writeFileSync(
      path.join(value.inputs, `partition-${index}`, 'receipt.json'),
      `${JSON.stringify(receipt(value.value, index), null, 2)}\n`,
    );
  }
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  const proof = writeBundle(descriptor, value);
  assert.equal(descriptor.sdkRequired, true);
  assert.equal(proof.verdict.sdkRequired, true);
  assert.doesNotThrow(() =>
    verifyProofBundle(descriptor, value.bundle, {
      repository: 'kungfu-systems/kungfu',
      producerRunId: 42,
      producerEvent: 'merge_group',
      producerHeadSha: HEAD,
      maxAgeSeconds: 6 * 60 * 60,
      now: '2026-07-22T01:00:00Z',
    }),
  );
  const proofPath = path.join(value.bundle, 'proof.json');
  const incomplete = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  const { sdkRequired: _sdkRequired, ...legacyVerdict } = incomplete.verdict;
  incomplete.verdict = legacyVerdict;
  const { proofRoot: _proofRoot, ...body } = incomplete;
  incomplete.proofRoot = digest(body);
  fs.writeFileSync(proofPath, `${JSON.stringify(incomplete, null, 2)}\n`);
  assert.throws(
    () =>
      verifyProofBundle(descriptor, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /proof verdict drift/,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('missing, tampered, or stale proof evidence fails closed', () => {
  const value = fixture();
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  fs.rmSync(path.join(value.inputs, 'partition-1'), {
    recursive: true,
    force: true,
  });
  assert.throws(
    () => sealProof(descriptor, value.inputs, producer()),
    /partition set is incomplete/,
  );

  fs.mkdirSync(path.join(value.inputs, 'partition-1'), { recursive: true });
  fs.writeFileSync(
    path.join(value.inputs, 'partition-1', 'receipt.json'),
    `${JSON.stringify(receipt(value.value, 1), null, 2)}\n`,
  );
  writeBundle(descriptor, value);
  const proofPath = path.join(value.bundle, 'proof.json');
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  proof.partitions[0].receiptDigest = 'sha256:tampered';
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  assert.throws(
    () =>
      verifyProofBundle(descriptor, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /proof root drift/,
  );

  writeBundle(descriptor, value);
  assert.throws(
    () =>
      verifyProofBundle(descriptor, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /freshness window/,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('tree, producer, and unsuccessful receipt drift cannot reuse proof', () => {
  const value = fixture();
  const descriptor = createProofDescriptor(value.value, TREE, 2, TOOLCHAIN);
  writeBundle(descriptor, value);
  assert.throws(
    () =>
      verifyProofBundle(
        createProofDescriptor(value.value, '6'.repeat(40), 2, TOOLCHAIN),
        value.bundle,
        {
          repository: 'kungfu-systems/kungfu',
          producerRunId: 42,
          producerEvent: 'merge_group',
          producerHeadSha: HEAD,
          maxAgeSeconds: 6 * 60 * 60,
          now: '2026-07-22T01:00:00Z',
        },
      ),
    /proof identity drift/,
  );
  assert.throws(
    () =>
      verifyProofBundle(descriptor, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 43,
        producerEvent: 'merge_group',
        producerHeadSha: HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /producer authority drift/,
  );
  writeBundle(descriptor, value, producer({ triggerHeadSha: OTHER_HEAD }));
  assert.throws(
    () =>
      verifyProofBundle(descriptor, value.bundle, {
        repository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'merge_group',
        producerHeadSha: OTHER_HEAD,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /producer authority drift/,
  );

  const failedPath = path.join(value.inputs, 'partition-1', 'receipt.json');
  const toolchainDrift = receipt(value.value, 1);
  toolchainDrift.toolchain = {
    ...TOOLCHAIN,
    compiler: 'g++-14 changed after proof probe',
  };
  fs.writeFileSync(failedPath, `${JSON.stringify(toolchainDrift, null, 2)}\n`);
  assert.throws(
    () => sealProof(descriptor, value.inputs, producer()),
    /toolchain identity drift/,
  );

  const failed = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
  failed.toolchain = TOOLCHAIN;
  failed.status = 'failed';
  fs.writeFileSync(failedPath, `${JSON.stringify(failed, null, 2)}\n`);
  assert.throws(
    () => sealProof(descriptor, value.inputs, producer()),
    /receipt is not passed/,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('lookup admits one exact successful same-SHA merge-group artifact', () => {
  const artifacts = [
    {
      id: 7,
      name: 'proof-name',
      expired: false,
      created_at: '2026-07-22T00:30:00Z',
      workflow_run: {
        id: 42,
        repository_id: 100,
        head_repository_id: 100,
      },
    },
  ];
  const runsById = new Map([
    [
      42,
      {
        event: 'merge_group',
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
        path: '.github/workflows/affected-native-pr.yml',
      },
    ],
  ]);
  assert.deepEqual(
    selectReusableArtifact({
      artifacts,
      runsById,
      artifactName: 'proof-name',
      repositoryId: 100,
      headSha: HEAD,
      now: '2026-07-22T01:00:00Z',
    }),
    {
      reusable: true,
      reason: 'exact trusted producer proof artifact found',
      candidateCount: 1,
      runId: 42,
      artifactId: 7,
      producerEvent: 'merge_group',
      producerHeadSha: HEAD,
    },
  );
});

test('lookup admits PR proofs, deterministically deduplicates, and rejects untrusted artifacts', () => {
  const run = {
    event: 'merge_group',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/affected-native-pr.yml',
  };
  const artifact = (id, overrides = {}) => ({
    id,
    name: 'proof-name',
    expired: false,
    created_at: '2026-07-22T00:30:00Z',
    workflow_run: {
      id,
      repository_id: 100,
      head_repository_id: 100,
    },
    ...overrides,
  });
  const duplicate = selectReusableArtifact({
    artifacts: [
      artifact(1, { created_at: '2026-07-22T00:20:00Z' }),
      artifact(2, { created_at: '2026-07-22T00:30:00Z' }),
    ],
    runsById: new Map([
      [1, run],
      [2, run],
    ]),
    artifactName: 'proof-name',
    repositoryId: 100,
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(duplicate.reusable, true);
  assert.equal(duplicate.candidateCount, 2);
  assert.equal(duplicate.runId, 2);
  assert.equal(duplicate.artifactId, 2);
  assert.match(duplicate.reason, /newest/);

  const tied = selectReusableArtifact({
    artifacts: [artifact(8), artifact(9)],
    runsById: new Map([
      [8, run],
      [9, run],
    ]),
    artifactName: 'proof-name',
    repositoryId: 100,
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(tied.reusable, true);
  assert.equal(tied.runId, 9);
  assert.equal(tied.artifactId, 9);

  const rejected = selectReusableArtifact({
    artifacts: [
      artifact(3, {
        workflow_run: {
          id: 3,
          repository_id: 100,
          head_repository_id: 200,
        },
      }),
      artifact(4, { expired: true }),
      artifact(5),
    ],
    runsById: new Map([
      [3, run],
      [4, run],
      [5, { ...run, conclusion: 'failure' }],
    ]),
    artifactName: 'proof-name',
    repositoryId: 100,
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(rejected.reusable, false);
  assert.equal(rejected.candidateCount, 0);

  const movedHead = selectReusableArtifact({
    artifacts: [artifact(6)],
    runsById: new Map([[6, { ...run, head_sha: OTHER_HEAD }]]),
    artifactName: 'proof-name',
    repositoryId: 100,
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(movedHead.reusable, false);
  assert.match(movedHead.reason, /no exact trusted producer/);

  const pullRequestProducer = selectReusableArtifact({
    artifacts: [artifact(7)],
    runsById: new Map([
      [7, { ...run, event: 'pull_request', head_sha: OTHER_HEAD }],
    ]),
    artifactName: 'proof-name',
    repositoryId: 100,
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(pullRequestProducer.reusable, true);
  assert.equal(pullRequestProducer.producerEvent, 'pull_request');
  assert.equal(pullRequestProducer.producerHeadSha, OTHER_HEAD);
});

test('workflow keeps one context while PR proof replaces duplicate queue builds', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(workflow, /^\s{2}merge_group\s*:/mu);
  assert.doesNotMatch(workflow, /^\s{2}push\s*:/mu);
  assert.match(
    workflow,
    /concurrency:[\s\S]*merge_group\.head_sha \|\| github\.ref \|\| github\.run_id[\s\S]*cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u,
  );
  assert.doesNotMatch(workflow, /^\s*queue:/mu);
  assert.match(workflow, /^\s{2}dco:$/mu);
  assert.match(workflow, /^\s{2}source_acceptance:$/mu);
  assert.match(workflow, /^\s{2}candidate_preflight:$/mu);
  assert.match(workflow, /^\s{2}proof_probe:$/mu);
  assert.match(
    workflow,
    /name: Verify protected merge-queue replay[\s\S]*github\.event_name == 'pull_request'[\s\S]*project-cut:queue-admission --[\s\S]*--base "\$base_sha"[\s\S]*--head "\$head_sha"/u,
  );
  assert.match(
    workflow,
    /affected_native_shards:[\s\S]*- candidate_preflight[\s\S]*- proof_probe[\s\S]*needs\.proof_probe\.outputs\.reuse != 'true'/u,
  );
  assert.match(
    workflow,
    /name: affected-native \/ linux[\s\S]*DCO_RESULT:[\s\S]*SOURCE_RESULT:[\s\S]*PREFLIGHT_RESULT:[\s\S]*require_optional_gate "PR affected-native"[\s\S]*PR staged qualification passed/u,
  );
  assert.match(workflow, /producer-run-id/u);
  assert.match(workflow, /producer-event/u);
  assert.match(workflow, /producer-head-sha/u);
  assert.match(workflow, /Exact PR or same-SHA queue proof reuse/u);
  assert.match(
    workflow,
    /name: Upload current proof descriptor[\s\S]*core-affected-native-proof-descriptor-\$\{\{ github\.run_id \}\}/u,
  );
  assert.match(
    workflow,
    /name: Download current proof descriptor[\s\S]*name: Revalidate exact affected-native source binding[\s\S]*cmp "\$descriptor" "\$admission\/recomputed-descriptor\.json"/u,
  );
  const aggregate = workflow.slice(workflow.indexOf('  affected_native:\n'));
  assert.doesNotMatch(aggregate, /affected-native-proof\.mjs toolchain/u);
  assert.match(
    workflow,
    /--producer-event "\$\{\{ steps\.lookup\.outputs\.producer-event \}\}"/u,
  );
  assert.match(workflow, /--head-sha "\$GITHUB_SHA"/u);
  assert.match(
    workflow,
    /name: Seal reconstructable family delivery attempt[\s\S]*delta_args=\(\)[\s\S]*--dev-delta-plan "\$delta_plan"[\s\S]*seal-attempt[\s\S]*"\$\{delta_args\[@\]\}"/u,
  );
  assert.match(workflow, /needs\.proof_probe\.outputs\.reuse != 'true'/u);
  assert.doesNotMatch(
    workflow,
    /steps\.descriptor\.outputs\.sdk-required != 'true'/u,
  );
  assert.match(workflow, /echo "native-required=\$\{native_required\}"/u);
  assert.match(workflow, /echo "sdk-required=\$\{sdk_required\}"/u);
  assert.match(workflow, /echo "shifu-required=\$\(jq/u);
  assert.match(workflow, /echo "kfd-required=\$\(jq/u);
  const shifuWorkspace = workflow.slice(
    workflow.indexOf('  shifu_workspace:\n'),
    workflow.indexOf('  kfd_verifier:\n'),
  );
  assert.match(
    shifuWorkspace,
    /- proof_probe[\s\S]*needs\.proof_probe\.outputs\.reuse != 'true'/u,
  );
  assert.match(
    shifuWorkspace,
    /uses: actions\/checkout@v4[\s\S]*fetch-depth: 0/u,
  );
  assert.match(
    shifuWorkspace,
    /name: Shifu workspace \/ linux[\s\S]*runs-on: ubuntu-22\.04[\s\S]*Run required Linux Shifu workspace Gate[\s\S]*\.\/shifu install --frozen-lockfile[\s\S]*\.\/shifu gate run shifu\.workspace/u,
  );
  assert.doesNotMatch(shifuWorkspace, /strategy:|matrix:|xinfa:|pwsh/u);
  const coreObservation = fs.readFileSync(
    path.join(ROOT, '.github/workflows/core-build-profiles.yml'),
    'utf8',
  );
  assert.match(
    coreObservation,
    /shifu_observation:[\s\S]*os: \[macos-14, ubuntu-22\.04, windows-2022\][\s\S]*Run observed Shifu and Xinfa checks \(POSIX\)[\s\S]*xinfa:check[\s\S]*xinfa:quality --check[\s\S]*Run observed Shifu and Xinfa checks \(Windows\)[\s\S]*xinfa:check[\s\S]*xinfa:quality --check/u,
  );
  assert.match(
    workflow,
    /Run all expensive native qualification under the live Warrant[\s\S]*uses: \.\/\.github\/actions\/native-execution-under-warrant[\s\S]*steps\.plan\.outputs\.sdk-required[\s\S]*matrix\.partition[\s\S]*\.\/shifu layers:qualify:sdk/u,
  );
  assert.match(
    workflow,
    /KUNGFU_CANDIDATE_TIMELINE_EVENTS: \$\{\{ github\.workspace \}\}\/product\/qualification\/affected-native\/candidate-events\.jsonl/u,
  );
  assert.match(
    workflow,
    /cmake_js_bin[\s\S]*\.\/shifu build:core:sdk[\s\S]*\.\/shifu pack:sdk[\s\S]*\.\/shifu layers:qualify:sdk/u,
  );
  assert.match(
    workflow,
    /native-execution-under-warrant[\s\S]*\.\/shifu build:core:sdk/u,
  );
  assert.match(
    workflow,
    /steps\.plan\.outputs\.native-required[\s\S]*\.\/shifu gate run source\.changed-scope/u,
  );
  assert.match(workflow, /^\s{2}shifu_workspace:$/mu);
  assert.match(workflow, /^\s{2}kfd_verifier:$/mu);
  const kfdVerifier = workflow.slice(
    workflow.indexOf('  kfd_verifier:\n'),
    workflow.indexOf('  affected_native:\n'),
  );
  assert.match(
    kfdVerifier,
    /- proof_probe[\s\S]*needs\.proof_probe\.outputs\.reuse != 'true'/u,
  );
  assert.match(
    workflow,
    /reused queue Shifu workspace[\s\S]*reused queue KFD verifier/u,
  );
  assert.match(
    workflow,
    /name: Upload authoritative producer proof[\s\S]*retention-days: 14/u,
  );
  assert.doesNotMatch(workflow, /retention-days: 1$/mu);
  const verifier = fs.readFileSync(
    path.join(ROOT, 'scripts/affected-native-proof.mjs'),
    'utf8',
  );
  const artifactLookup = fs.readFileSync(
    new URL(
      '../framework/release/affected-native-artifact-lookup.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(artifactLookup, /head_repository_id === repositoryId/u);
  assert.match(
    artifactLookup,
    /run\.event === 'pull_request' \|\| run\.head_sha === headSha/u,
  );
  assert.match(
    verifier,
    /stableJson\(nativeToolchainIdentity\(receipt\.toolchain, true\)\) !==\s+stableJson\(descriptor\.identity\.toolchain/u,
  );
  assert.match(
    verifier,
    /options\.command === 'seal-attempt'[\s\S]*deltaPlan: options\['dev-delta-plan'\]/u,
  );
});
