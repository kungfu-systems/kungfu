// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDeliveryAttempt,
  createDeliveryBinding,
  createIntegrationDeliveryInput,
  createProofDescriptor,
  createSourceQualificationInput,
  digest,
  sealProof,
  verifyQueueAdmissionLease,
} from './affected-native-proof.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const BASE = '1'.repeat(40);
const SOURCE = '2'.repeat(40);
const TREE = '3'.repeat(40);
const MERGE_GROUP = '4'.repeat(40);
const PULL_REQUEST_CHECKOUT = '5'.repeat(40);
const ROOT_A = `sha256:${'a'.repeat(64)}`;
const ROOT_B = `sha256:${'b'.repeat(64)}`;
const ROOT_C = `sha256:${'c'.repeat(64)}`;
const ROOT_D = `sha256:${'d'.repeat(64)}`;
const ROOT_E = `sha256:${'e'.repeat(64)}`;
const WARRANT = {
  schema: 'kungfu.buildchain.dev-delivery-warrant/v1',
  candidateId: ROOT_C,
  fencingToken: ROOT_B,
  generation: 7,
  pullRequestNumber: 42,
  sourceHead: SOURCE,
  phase: 'qualified',
  nativeProofRoot: ROOT_D,
  nativeProofReuseRoot: ROOT_E,
  issuedAt: '2026-08-04T02:00:00.000Z',
  expiresAt: '2026-08-04T03:00:00.000Z',
};
const TOOLCHAIN = {
  compiler: 'g++-14',
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

function plan(head = SOURCE) {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: BASE,
    head,
    authority: { layers: ROOT_A, buildCapabilities: ROOT_B },
    changedPaths: ['framework/core/CMakeLists.txt'],
    directComponents: ['core'],
    closureComponents: ['core'],
    targets: ['core'],
    tests: [],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [
      {
        path: 'framework/core/CMakeLists.txt',
        kind: 'native-source',
      },
    ],
  };
  return { ...body, planDigest: digest(body) };
}

function partitionReceipt(value) {
  const executionPartition = {
    schema: 'kungfu.core-affected-native-partition/v1',
    index: 0,
    count: 1,
    targets: ['core'],
    tests: [],
  };
  executionPartition.partitionDigest = digest({
    planDigest: value.planDigest,
    index: 0,
    count: 1,
    targets: ['core'],
    tests: [],
  });
  executionPartition.coverageDigest = digest({
    planDigest: value.planDigest,
    count: 1,
    lanes: [{ index: 0, targets: ['core'], tests: [] }],
  });
  return {
    schema: 'kungfu.core-affected-native-receipt/v1',
    status: 'passed',
    source: { base: BASE, head: value.head },
    plan: value,
    planDigest: value.planDigest,
    executionPartition,
    platform: 'linux-x64',
    toolchain: TOOLCHAIN,
  };
}

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-consumer-'));
  const input = path.join(root, 'input');
  fs.mkdirSync(input, { recursive: true });
  const value = plan(PULL_REQUEST_CHECKOUT);
  fs.writeFileSync(
    path.join(input, 'receipt.json'),
    `${JSON.stringify(partitionReceipt(value), null, 2)}\n`,
  );
  const binding = createDeliveryBinding({
    event: 'pull_request',
    pullRequest: 42,
    pullRequestHead: SOURCE,
    devHead: BASE,
    candidateHead: SOURCE,
    candidateTree: TREE,
    pullRequestBody: '',
    combinedStatus: {},
    requiredContexts: ['affected-native / linux'],
    queueAdmissionContext: 'Queue admission lease',
  });
  const descriptor = createProofDescriptor(value, TREE, 1, TOOLCHAIN, binding);
  const proof = sealProof(descriptor, input, {
    repository: 'kungfu-systems/kungfu',
    runId: 99,
    event: 'pull_request',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: SOURCE,
    checkoutSha: PULL_REQUEST_CHECKOUT,
    createdAt: '2026-08-04T02:00:00.000Z',
  });
  return { root, value, descriptor, proof };
}

function queueView(sourceProofRoot, overrides = {}) {
  return {
    schema: 'kungfu.buildchain.dev-delivery-command-result/v1',
    observation: {
      schema: 'kungfu.buildchain.dev-delivery-queue-observation/v1',
      repository: 'kungfu-systems/kungfu',
      protectedBase: 'dev/v4/v4.0',
      stateRoot: ROOT_A,
      observedAt: '2026-08-04T02:10:00.000Z',
      activeWarrant: { ...WARRANT, sourceProofRoot },
      activeCandidate: {
        candidateId: WARRANT.candidateId,
        pullRequestNumber: 42,
        sourceHead: SOURCE,
        sourceProofRoot,
        status: 'qualified',
        ...overrides,
      },
    },
  };
}

function deliveryAttempt(proof) {
  const lease = createFamilyQueueLease(
    {
      ok: true,
      decision: 'qualified',
      schema: 'project.cut.merge-queue-admission/v1',
      baseCommitOid: BASE,
      headCommitOid: SOURCE,
      candidateCommitOid: MERGE_GROUP,
      candidateTreeOid: TREE,
      replayedCommitCount: 1,
      compositionChanged: false,
      compositionRoot: null,
      reasonCodes: [],
    },
    {
      initiativeId: 'continuous-delivery',
      assignmentId: 'proof-consumers',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'attempt-one',
      admissionProofRoots: [ROOT_A],
    },
  );
  const binding = createDeliveryBinding({
    event: 'merge_group',
    pullRequest: 42,
    pullRequestHead: SOURCE,
    devHead: BASE,
    candidateHead: MERGE_GROUP,
    candidateTree: TREE,
    pullRequestBody: lease.marker,
    combinedStatus: {
      statuses: [
        { context: lease.statusContext, state: 'pending' },
        { context: 'Queue admission lease', state: 'success' },
      ],
    },
    requiredContexts: ['affected-native / linux', 'Queue admission lease'],
    queueAdmissionContext: 'Queue admission lease',
  });
  const descriptor = createProofDescriptor(
    plan(MERGE_GROUP),
    TREE,
    1,
    TOOLCHAIN,
    binding,
  );
  return createDeliveryAttempt(descriptor, proof, 'reused', {
    repository: 'kungfu-systems/kungfu',
    runId: 100,
    event: 'merge_group',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: MERGE_GROUP,
    checkoutSha: MERGE_GROUP,
  });
}

test('projects exact affected-native proof into Buildchain Source Proof input', () => {
  const value = sourceFixture();
  const result = createSourceQualificationInput({
    repository: 'kungfu-systems/kungfu',
    protectedBase: 'dev/v4/v4.0',
    pullRequestNumber: 42,
    sourceHeadSha: SOURCE,
    descriptor: value.descriptor,
    proof: value.proof,
    plan: value.value,
  });
  assert.equal(result.sourceHeadSha, SOURCE);
  assert.equal(result.requiredContexts[0].evidenceRoot, value.proof.proofRoot);
  assert.deepEqual(result.affectedClosure.shards[0].pathPrefixes, [
    'framework',
  ]);
  assert.deepEqual(result.affectedClosure.unrelatedPathPrefixes, ['docs']);
  assert.match(result.semanticSourceRoot, /^sha256:[0-9a-f]{64}$/u);
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('refuses rewritten source, proof drift, and unknown Warrant source', () => {
  const value = sourceFixture();
  assert.throws(
    () =>
      createSourceQualificationInput({
        repository: 'kungfu-systems/kungfu',
        protectedBase: 'dev/v4/v4.0',
        pullRequestNumber: 42,
        sourceHeadSha: '9'.repeat(40),
        descriptor: value.descriptor,
        proof: value.proof,
        plan: value.value,
      }),
    /exact successful PR head/u,
  );
  assert.throws(
    () =>
      verifyQueueAdmissionLease({
        view: queueView(ROOT_A),
        pullRequestNumber: 42,
        sourceHeadSha: '9'.repeat(40),
      }),
    /exact source readback mismatch/u,
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('queue lease readback binds revision, Warrant, fence, and exact source', () => {
  const receipt = verifyQueueAdmissionLease({
    view: queueView(ROOT_A),
    pullRequestNumber: 42,
    sourceHeadSha: SOURCE,
    now: '2026-08-04T02:30:00.000Z',
  });
  assert.equal(receipt.queueStateRoot, ROOT_A);
  assert.equal(receipt.candidateId, WARRANT.candidateId);
  assert.equal(receipt.fencingToken, WARRANT.fencingToken);
  assert.equal(receipt.generation, WARRANT.generation);
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () =>
      verifyQueueAdmissionLease({
        view: queueView(ROOT_A),
        pullRequestNumber: 42,
        sourceHeadSha: SOURCE,
        now: WARRANT.expiresAt,
      }),
    /expired/u,
  );
});

test('queue lease consumes an atomically qualified two-phase Warrant', () => {
  const receipt = verifyQueueAdmissionLease({
    view: queueView(ROOT_A, { status: 'qualified' }),
    pullRequestNumber: 42,
    sourceHeadSha: SOURCE,
    now: '2026-08-04T02:30:00.000Z',
  });
  assert.equal(receipt.candidateState, 'qualified');
  assert.equal(receipt.candidateId, WARRANT.candidateId);
  assert.equal(receipt.fencingToken, WARRANT.fencingToken);
  assert.equal(receipt.generation, WARRANT.generation);
  assert.throws(
    () =>
      verifyQueueAdmissionLease({
        view: queueView(ROOT_A, { status: 'merged' }),
        pullRequestNumber: 42,
        sourceHeadSha: SOURCE,
        now: '2026-08-04T02:30:00.000Z',
      }),
    /not delivery-ready: merged/u,
  );
  assert.throws(
    () =>
      verifyQueueAdmissionLease({
        view: queueView(ROOT_A, { status: 'queued' }),
        pullRequestNumber: 42,
        sourceHeadSha: SOURCE,
        now: '2026-08-04T02:30:00.000Z',
      }),
    /not delivery-ready: queued/u,
  );
});

test('integration input binds merge-group authority and live queue entry', () => {
  const source = sourceFixture();
  const sourceInput = createSourceQualificationInput({
    repository: 'kungfu-systems/kungfu',
    protectedBase: 'dev/v4/v4.0',
    pullRequestNumber: 42,
    sourceHeadSha: SOURCE,
    descriptor: source.descriptor,
    proof: source.proof,
    plan: source.value,
  });
  const sourceProofRoot = digest(sourceInput);
  const view = queueView(sourceProofRoot);
  const lease = verifyQueueAdmissionLease({
    view,
    pullRequestNumber: 42,
    sourceHeadSha: SOURCE,
    now: '2026-08-04T02:20:00.000Z',
  });
  const result = createIntegrationDeliveryInput({
    view,
    deliveryAttempt: deliveryAttempt(source.proof),
    pullRequestNumber: 42,
    queueEntry: {
      id: 'MQE_42',
      state: 'QUEUED',
      pullRequestNumber: 42,
      pullRequestHeadSha: SOURCE,
    },
    queueLeaseReceipt: lease,
    verifiedAt: '2026-08-04T02:30:00.000Z',
  });
  assert.equal(result.proofInput.mergeGroupHead, MERGE_GROUP);
  assert.equal(result.proofInput.mergeGroupTree, TREE);
  assert.equal(result.proofInput.currentBase, BASE);
  assert.equal(result.proofInput.sourceProofRoot, sourceProofRoot);
  assert.equal(result.providerReceipt.queueEntryId, 'MQE_42');
  assert.equal(result.proofInput.requiredContextRoots.length, 3);
  assert.throws(
    () =>
      createIntegrationDeliveryInput({
        view,
        deliveryAttempt: deliveryAttempt(source.proof),
        pullRequestNumber: 42,
        queueEntry: {
          id: 'MQE_42',
          state: 'QUEUED',
          pullRequestNumber: 42,
          pullRequestHeadSha: '9'.repeat(40),
        },
        queueLeaseReceipt: lease,
        verifiedAt: '2026-08-04T02:30:00.000Z',
      }),
    /exact-head readback mismatch/u,
  );
  fs.rmSync(source.root, { recursive: true, force: true });
});

test('workflow consumes exact Buildchain Source and Integration Proofs', () => {
  const workflow = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  const aggregate = workflow.slice(workflow.indexOf('  affected_native:\n'));
  assert.match(
    aggregate,
    /Project exact PR qualification into Buildchain Source Proof[\s\S]*affected-native-proof\.mjs source-input[\s\S]*dev-delivery-warrant-input\.mjs[\s\S]*buildchain\.mjs dev proof source[\s\S]*--source-identity-root[\s\S]*--toolchain-root/u,
  );
  assert.match(
    aggregate,
    /Consume Warrant and record exact Integration Delivery Proof[\s\S]*dev warrant observe[\s\S]*affected-native-proof\.mjs queue-lease-verify[\s\S]*affected-native-proof\.mjs integration-input[\s\S]*dev proof integration[\s\S]*--warrant-result/u,
  );
  assert.match(aggregate, /--branch "\$protected_base"/u);
  assert.match(aggregate, /ref: 0f4004d0d2b2474c2135a3e88d29d9c85bc37834/u);
  assert.match(
    aggregate,
    /name: Install pinned Buildchain proof runtime[\s\S]*working-directory: \.buildchain\/dev-delivery-runtime[\s\S]*corepack pnpm install --frozen-lockfile --ignore-scripts/u,
  );
});
