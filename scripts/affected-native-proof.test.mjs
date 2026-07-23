// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createProofDescriptor,
  digest,
  sealProof,
  selectReusableArtifact,
  verifyProofBundle,
} from './affected-native-proof.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const OTHER_HEAD = '3'.repeat(40);
const TREE = '4'.repeat(40);
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
    checkoutSha: HEAD,
    createdAt: '2026-07-22T00:00:00Z',
    ...overrides,
  };
}

function writeBundle(descriptor, value) {
  const proof = sealProof(descriptor, value.inputs, producer());
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
      producerEvent: 'merge_group',
      headSha: HEAD,
      now: '2026-07-22T01:00:00Z',
    }),
    {
      reusable: true,
      reason: 'exact trusted producer proof artifact found',
      candidateCount: 1,
      runId: 42,
      artifactId: 7,
    },
  );
});

test('lookup degrades duplicate, fork, failed, and expired artifacts to full run', () => {
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
    artifacts: [artifact(1), artifact(2)],
    runsById: new Map([
      [1, run],
      [2, run],
    ]),
    artifactName: 'proof-name',
    repositoryId: 100,
    producerEvent: 'merge_group',
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(duplicate.reusable, false);
  assert.match(duplicate.reason, /ambiguous/);

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
    producerEvent: 'merge_group',
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
    producerEvent: 'merge_group',
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(movedHead.reusable, false);
  assert.match(movedHead.reason, /no exact trusted producer/);

  const pullRequestProducer = selectReusableArtifact({
    artifacts: [artifact(7)],
    runsById: new Map([[7, { ...run, event: 'pull_request' }]]),
    artifactName: 'proof-name',
    repositoryId: 100,
    producerEvent: 'pull_request',
    headSha: HEAD,
    now: '2026-07-22T01:00:00Z',
  });
  assert.equal(pullRequestProducer.reusable, false);
  assert.match(pullRequestProducer.reason, /only merge-group queue proofs/);
});

test('workflow keeps one required context while staging authoritative queue builds', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(workflow, /^\s{2}merge_group\s*:/mu);
  assert.doesNotMatch(workflow, /^\s{2}push\s*:/mu);
  assert.match(
    workflow,
    /concurrency:[\s\S]*merge_group\.head_sha \|\| github\.run_id[\s\S]*queue: max/u,
  );
  assert.match(workflow, /^\s{2}dco:$/mu);
  assert.match(workflow, /^\s{2}source_acceptance:$/mu);
  assert.match(workflow, /^\s{2}candidate_preflight:$/mu);
  assert.match(workflow, /^\s{2}proof_probe:$/mu);
  assert.match(
    workflow,
    /affected_native_shards:[\s\S]*- source_acceptance[\s\S]*- candidate_preflight[\s\S]*github\.event_name == 'merge_group'/u,
  );
  assert.match(
    workflow,
    /name: affected-native \/ linux[\s\S]*DCO_RESULT:[\s\S]*SOURCE_RESULT:[\s\S]*PREFLIGHT_RESULT:[\s\S]*PR fast admission passed without compiler or installed-artifact work/u,
  );
  assert.match(workflow, /producer-run-id/u);
  assert.match(workflow, /Merge Queue is the only native proof producer/u);
  assert.match(workflow, /--producer-event merge_group/u);
  assert.match(workflow, /--head-sha "\$GITHUB_SHA"/u);
  assert.match(workflow, /needs\.proof_probe\.outputs\.reuse != 'true'/u);
  assert.match(workflow, /echo "native-required=\$\{native_required\}"/u);
  assert.match(workflow, /echo "sdk-required=\$\{sdk_required\}"/u);
  assert.match(workflow, /echo "shifu-required=\$\(jq/u);
  assert.match(workflow, /echo "kfd-required=\$\(jq/u);
  assert.match(
    workflow,
    /Qualify installed four-language SDK wire contract[\s\S]*steps\.plan\.outputs\.sdk-required == 'true'[\s\S]*matrix\.partition == 0/u,
  );
  assert.match(
    workflow,
    /Run affected native closure[\s\S]*steps\.plan\.outputs\.native-required == 'true'/u,
  );
  assert.match(workflow, /^\s{2}shifu_workspace:$/mu);
  assert.match(workflow, /^\s{2}kfd_verifier:$/mu);
  assert.doesNotMatch(workflow, /retention-days: 1$/mu);
  const verifier = fs.readFileSync(
    path.join(ROOT, 'scripts/affected-native-proof.mjs'),
    'utf8',
  );
  assert.match(verifier, /head_repository_id === repositoryId/u);
  assert.match(verifier, /run\?\.head_sha === headSha/u);
  assert.match(
    verifier,
    /stableJson\(receipt\.toolchain\) !==\s+stableJson\(descriptor\.identity\.toolchain/u,
  );
});
