// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPortableDevCachePlan,
  createPortableDevCacheReceipt,
} from '@kungfu-tech/buildchain/portable-dev-cache';

import {
  createCachePromotionAuthority,
  createDeliveryBinding,
  createProofDescriptor,
  deliveryAttemptGithubOutputs,
  sealProof,
  verifyCachePromotionAuthority,
} from './affected-native-proof.mjs';
import { partitionAffectedNativePlan } from './run-core-affected-native.mjs';
import {
  affectedNativeCompilerPlanDigest,
  createAffectedNativeCachePromotion,
  sealAffectedNativeCachePayload,
} from './write-affected-native-cache-manifests.mjs';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const AUTH_BASE = '1'.repeat(40);
const AUTH_HEAD = '2'.repeat(40);
const AUTH_DEV_HEAD = '3'.repeat(40);
const AUTH_TREE = '4'.repeat(40);
const AUTH_QUEUE_HEAD = '5'.repeat(40);
const AUTH_TOOLCHAIN = {
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

function authorityPlan(base, head, changedPath, affected) {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base,
    head,
    authority: { layers: 'sha256:layers', buildCapabilities: 'sha256:build' },
    changedPaths: [changedPath],
    directComponents: [],
    closureComponents: affected ? ['core'] : [],
    targets: affected ? ['kungfu'] : [],
    tests: [],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [{ path: changedPath, kind: 'architecture-or-gate-authority' }],
  };
  return { ...body, planDigest: digest(body) };
}

function authorityReceipt(value) {
  const lanes = [{ index: 0, targets: value.targets, tests: value.tests }];
  const partition = {
    schema: 'kungfu.core-affected-native-partition/v1',
    index: 0,
    count: 1,
    targets: value.targets,
    tests: value.tests,
    partitionDigest: digest({
      planDigest: value.planDigest,
      index: 0,
      count: 1,
      targets: value.targets,
      tests: value.tests,
    }),
    coverageDigest: digest({ planDigest: value.planDigest, count: 1, lanes }),
  };
  return {
    schema: 'kungfu.core-affected-native-receipt/v1',
    status: 'passed',
    source: { base: value.base, head: value.head },
    plan: value,
    planDigest: value.planDigest,
    executionPartition: partition,
    platform: 'linux-x64',
    toolchain: AUTH_TOOLCHAIN,
  };
}

function authorityBinding(devHead, candidateHead) {
  return createDeliveryBinding({
    event: 'pull_request',
    pullRequest: 3150,
    pullRequestHead: AUTH_HEAD,
    devHead,
    candidateHead,
    candidateTree: AUTH_TREE,
    pullRequestBody: '',
    combinedStatus: {},
    requiredContexts: [
      'affected-native / linux',
      'project-cut / queue-admission',
    ],
    queueAdmissionContext: 'project-cut / queue-admission',
  });
}

test('non-family delivery attempt projects empty family outputs', () => {
  assert.deepEqual(
    deliveryAttemptGithubOutputs({
      attemptRoot: 'attempt-root',
      deliveryBindingRoot: 'binding-root',
      family: null,
      source: { pullRequestHead: 'pull-request-head' },
      proof: { decision: 'reused' },
    }),
    {
      'attempt-root': 'attempt-root',
      'delivery-binding-root': 'binding-root',
      'family-lease-root': '',
      'delivery-class': '',
      'pull-request-head': 'pull-request-head',
      'proof-decision': 'reused',
    },
  );
});

function createPlan() {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: 'b'.repeat(40),
    head: 'a'.repeat(40),
    profile: 'embedded-sqlite',
    platformTier: 'github-hosted-linux-native-pr',
    closureComponents: ['storage-runtime'],
    targets: ['kungfu', 'test-a', 'yijinjing', 'test-b'],
    tests: ['test-a', 'test-b'],
    authority: {
      layers: `sha256:${'c'.repeat(64)}`,
      buildCapabilities: `sha256:${'d'.repeat(64)}`,
    },
  };
  return { ...body, planDigest: digest(body) };
}

function createCachePlan(layer, sourceSha, planDigest) {
  return createPortableDevCachePlan({
    schema: 'buildchain.portable-dev-cache-manifest/v1',
    layer,
    roots:
      layer === 'dependency'
        ? [{ id: 'conan-packages', path: '~/.conan2/p' }]
        : [{ id: 'ccache', path: '~/.cache/ccache' }],
    identity: {
      platform: 'linux',
      arch: 'x64',
      runnerImage: 'ubuntu24',
      toolchainDigest: `sha256:${'1'.repeat(64)}`,
      dependencyLockDigest: `sha256:${'2'.repeat(64)}`,
      profileDigest: `sha256:${'3'.repeat(64)}`,
      sourceSha,
      planDigest,
    },
  });
}

function createArchive(home, archive, layer, marker, symlinkTarget = '') {
  const relative = layer === 'dependency' ? '.conan2/p' : '.cache/ccache';
  const root = path.join(home, relative);
  fs.mkdirSync(root, { recursive: true });
  const markerPath = path.join(root, marker);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  if (symlinkTarget) fs.symlinkSync(symlinkTarget, markerPath);
  else fs.writeFileSync(markerPath, marker);
  const result = spawnSync(
    'tar',
    ['--format=ustar', '-cf', archive, '-C', home, relative],
    {
      encoding: 'utf8',
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function createPartitionArtifact({
  artifactsRoot,
  plan,
  partitionIndex,
  partitionCount,
  repository,
  runId,
  event = 'merge_group',
  compilerSymlinkTarget = '',
  dependencyMarker = 'package',
  dependencySymlinkTarget = '',
}) {
  const artifact = path.join(
    artifactsRoot,
    `core-affected-native-${plan.head}-partition-${partitionIndex}-of-${partitionCount}`,
  );
  const qualification = path.join(
    artifact,
    'product/qualification/affected-native',
  );
  const payloadRoot = path.join(qualification, 'cache/payload');
  fs.mkdirSync(payloadRoot, { recursive: true });
  writeJson(path.join(qualification, 'plan.json'), plan);
  const partition = partitionAffectedNativePlan(
    plan,
    partitionCount,
    partitionIndex,
  );
  const dependencyPlan = createCachePlan(
    'dependency',
    plan.head,
    plan.planDigest,
  );
  const compilerPlan = createCachePlan(
    'compiler',
    plan.head,
    affectedNativeCompilerPlanDigest(plan.planDigest, partition),
  );
  for (const [layer, cachePlan] of [
    ['dependency', dependencyPlan],
    ['compiler', compilerPlan],
  ]) {
    writeJson(path.join(qualification, `cache/${layer}.plan.json`), cachePlan);
    writeJson(
      path.join(qualification, `cache/${layer}.receipt.json`),
      createPortableDevCacheReceipt({
        plan: cachePlan,
        validationStatus: 'pass',
        coldFallbackStatus: 'passed',
      }),
    );
  }
  const home = path.join(artifact, 'home');
  const compilerArchive = path.join(payloadRoot, 'compiler.tar');
  createArchive(
    home,
    compilerArchive,
    'compiler',
    `object-${partitionIndex}`,
    compilerSymlinkTarget,
  );
  let dependencyArchive = '';
  if (partitionIndex === 0) {
    dependencyArchive = path.join(payloadRoot, 'dependency.tar');
    createArchive(
      home,
      dependencyArchive,
      'dependency',
      dependencyMarker,
      dependencySymlinkTarget,
    );
  }
  sealAffectedNativeCachePayload({
    qualificationDir: qualification,
    output: path.join(payloadRoot, 'payload.manifest.json'),
    partitionIndex,
    partitionCount,
    repository,
    runId,
    event,
    headSha: plan.head,
    compilerArchive,
    dependencyArchive,
  });
  return artifact;
}

test('qualified merge-group partitions form one default-branch cache promotion', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createPlan();
  const repository = 'kungfu-systems/kungfu';
  const runId = 12345;
  for (const partitionIndex of [0, 1]) {
    createPartitionArtifact({
      artifactsRoot: root,
      plan,
      partitionIndex,
      partitionCount: 2,
      repository,
      runId,
    });
  }
  const promotion = createAffectedNativeCachePromotion({
    artifactsDir: root,
    expectedTargetHeadSha: plan.head,
    expectedMergeGroupRunId: runId,
    expectedPayloadHeadSha: plan.head,
    expectedProducerRunId: runId,
    expectedProducerEvent: 'merge_group',
    expectedRepository: repository,
    authorityMode: 'direct',
    deliveryAttemptRoot: `sha256:${'a'.repeat(64)}`,
    deliveryBindingRoot: `sha256:${'b'.repeat(64)}`,
  });
  assert.equal(promotion.schema, 'kungfu.affected-native-cache-promotion/v3');
  assert.equal(promotion.targetSourceSha, plan.head);
  assert.equal(promotion.payloadSourceSha, plan.head);
  assert.equal(promotion.authority.mode, 'direct');
  assert.equal(
    promotion.authority.deliveryAttemptRoot,
    `sha256:${'a'.repeat(64)}`,
  );
  assert.equal(promotion.partitionCount, 2);
  assert.equal(promotion.dependency.partitionIndex, 0);
  assert.equal(promotion.compiler.archives.length, 2);
  assert.equal(
    promotion.compiler.compatibilityDigest,
    `sha256:${promotion.compiler.compatibilityDigest.slice(7)}`,
  );
});

test('cache promotion fails closed on an incomplete partition set', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-incomplete-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createPlan();
  createPartitionArtifact({
    artifactsRoot: root,
    plan,
    partitionIndex: 0,
    partitionCount: 2,
    repository: 'kungfu-systems/kungfu',
    runId: 12345,
  });
  assert.throws(
    () =>
      createAffectedNativeCachePromotion({
        artifactsDir: root,
        expectedTargetHeadSha: plan.head,
        expectedMergeGroupRunId: 12345,
        expectedPayloadHeadSha: plan.head,
        expectedProducerRunId: 12345,
        expectedProducerEvent: 'merge_group',
        expectedRepository: 'kungfu-systems/kungfu',
        authorityMode: 'direct',
      }),
    /partition set is incomplete/,
  );
});

test('push promotion waits for the exact required Gate instead of whole-run completion', () => {
  const workflow = fs.readFileSync(
    '.github/workflows/affected-native-cache-promote.yml',
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:[\s\S]*?target_sha:/u);
  assert.match(workflow, /dev\/v\*\/v\*\) ;;/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$target_sha" HEAD/u);
  assert.match(workflow, /head_sha="\$TARGET_SHA"/u);
  assert.match(
    workflow,
    /--target-head-sha "\$\{\{ steps\.target\.outputs\.sha \}\}"/u,
  );
  assert.match(
    workflow,
    /--target-source-tree "\$\{\{ steps\.target\.outputs\.tree \}\}"/u,
  );
  assert.match(workflow, /actions\/runs\/\$\{run_id\}\/jobs/u);
  assert.match(workflow, /\.name == "affected-native \/ linux"/u);
  assert.match(
    workflow,
    /core-affected-native-delivery-attempt-\$\{TARGET_SHA\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /core-affected-native-delivery-attempt-\$\{GITHUB_SHA\}/u,
  );
  assert.match(workflow, /direct_state.*complete/su);
  assert.match(workflow, /authority_count.*reused-proof/su);
  assert.match(workflow, /attempt_count.*delivery-attempt/su);
  assert.match(workflow, /verify-attempt/u);
  assert.match(workflow, /--delivery-attempt-root/u);
  assert.match(workflow, /--delivery-binding-root/u);
  assert.match(workflow, /while \[ "\$attempt" -le 60 \]/u);
  assert.doesNotMatch(workflow, /status=completed/u);
});

test('PR payload transport requires merge-group reused-proof authority', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-reused-proof-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createPlan();
  const repository = 'kungfu-systems/kungfu';
  for (const partitionIndex of [0, 1]) {
    createPartitionArtifact({
      artifactsRoot: root,
      plan,
      partitionIndex,
      partitionCount: 2,
      repository,
      runId: 12345,
      event: 'pull_request',
    });
  }
  const authorityDigest = `sha256:${'e'.repeat(64)}`;
  const promotion = createAffectedNativeCachePromotion({
    artifactsDir: root,
    expectedTargetHeadSha: 'f'.repeat(40),
    expectedMergeGroupRunId: 12346,
    expectedPayloadHeadSha: plan.head,
    expectedProducerRunId: 12345,
    expectedProducerEvent: 'pull_request',
    expectedRepository: repository,
    authorityMode: 'reused-proof',
    authorityDigest,
    deliveryAttemptRoot: `sha256:${'a'.repeat(64)}`,
    deliveryBindingRoot: `sha256:${'b'.repeat(64)}`,
  });
  assert.equal(promotion.targetSourceSha, 'f'.repeat(40));
  assert.equal(promotion.payloadSourceSha, plan.head);
  assert.deepEqual(promotion.producer, {
    runId: 12345,
    event: 'pull_request',
  });
  assert.deepEqual(promotion.authority, {
    mode: 'reused-proof',
    digest: authorityDigest,
    deliveryAttemptRoot: `sha256:${'a'.repeat(64)}`,
    deliveryBindingRoot: `sha256:${'b'.repeat(64)}`,
  });

  const workflow = fs.readFileSync(
    '.github/workflows/affected-native-pr.yml',
    'utf8',
  );
  assert.match(
    workflow,
    /name: Seal cache promotion payload[\s\S]*?github\.event_name == 'pull_request'[\s\S]*?github\.event_name == 'merge_group'[\s\S]*?steps\.native-gate\.outcome == 'success'/u,
  );
  assert.match(
    workflow,
    /name: Seal reused-proof cache promotion authority[\s\S]*?seal-cache-authority[\s\S]*?--dev-delta-plan "\$admission\/proof-admission\/dev-delta-plan\.json"/u,
  );
  const promotionWorkflow = fs.readFileSync(
    '.github/workflows/affected-native-cache-promote.yml',
    'utf8',
  );
  assert.match(
    promotionWorkflow,
    /verify-cache-authority[\s\S]*?expected-payload-head-sha/u,
  );
});

test('cache payload sealing accepts Conan-relative symlinks inside its root', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-conan-symlink-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() =>
    createPartitionArtifact({
      artifactsRoot: root,
      plan: createPlan(),
      partitionIndex: 0,
      partitionCount: 2,
      repository: 'kungfu-systems/kungfu',
      runId: 12345,
      dependencyMarker:
        'flatbuffers/s/src/tests/ts/bazel_repository_test_dir/.npmrc',
      dependencySymlinkTarget: '../../../.npmrc',
    }),
  );
});

test('cache payload sealing rejects symlinks escaping its cache root', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-symlink-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      createPartitionArtifact({
        artifactsRoot: root,
        plan: createPlan(),
        partitionIndex: 0,
        partitionCount: 2,
        repository: 'kungfu-systems/kungfu',
        runId: 12345,
        compilerSymlinkTarget: '/etc/passwd',
      }),
    /unsafe symlink/,
  );
  assert.throws(
    () =>
      createPartitionArtifact({
        artifactsRoot: root,
        plan: createPlan(),
        partitionIndex: 1,
        partitionCount: 2,
        repository: 'kungfu-systems/kungfu',
        runId: 12346,
        compilerSymlinkTarget: '../../outside',
      }),
    /escaping symlink/,
  );
});

test('cache promotion authority binds unrelated dev delta attribution', (t) => {
  const sourcePlan = authorityPlan(
    AUTH_BASE,
    AUTH_HEAD,
    'framework/core/CMakeLists.txt',
    true,
  );
  const queuePlan = authorityPlan(
    AUTH_DEV_HEAD,
    AUTH_QUEUE_HEAD,
    'framework/core/CMakeLists.txt',
    true,
  );
  const deltaPlan = authorityPlan(
    AUTH_BASE,
    AUTH_DEV_HEAD,
    'docs/qualification/gates/release-and-promotion.md',
    false,
  );
  const sourceDescriptor = createProofDescriptor(
    sourcePlan,
    AUTH_TREE,
    1,
    AUTH_TOOLCHAIN,
    authorityBinding(AUTH_BASE, AUTH_HEAD),
  );
  const queueDescriptor = createProofDescriptor(
    queuePlan,
    AUTH_TREE,
    1,
    AUTH_TOOLCHAIN,
    authorityBinding(AUTH_DEV_HEAD, AUTH_QUEUE_HEAD),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs');
  const proofBundle = path.join(root, 'proof-bundle');
  writeJson(
    path.join(inputs, 'partition-0', 'receipt.json'),
    authorityReceipt(sourcePlan),
  );
  const proof = sealProof(sourceDescriptor, inputs, {
    repository: 'kungfu-systems/kungfu',
    runId: 42,
    event: 'pull_request',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: AUTH_DEV_HEAD,
    checkoutSha: AUTH_HEAD,
    createdAt: '2026-07-22T00:00:00Z',
  });
  writeJson(path.join(proofBundle, 'proof.json'), proof);
  fs.copyFileSync(
    path.join(inputs, 'partition-0', 'receipt.json'),
    path.join(proofBundle, 'partition-0.receipt.json'),
  );

  const authority = createCachePromotionAuthority(
    queueDescriptor,
    proofBundle,
    {
      targetRepository: 'kungfu-systems/kungfu',
      targetRunId: 84,
      targetEvent: 'merge_group',
      targetHeadSha: AUTH_QUEUE_HEAD,
      targetSourceTree: AUTH_TREE,
      producerRepository: 'kungfu-systems/kungfu',
      producerRunId: 42,
      producerEvent: 'pull_request',
      producerHeadSha: AUTH_DEV_HEAD,
      deltaPlan,
      maxAgeSeconds: 6 * 60 * 60,
      now: '2026-07-22T01:00:00Z',
    },
  );
  assert.deepEqual(authority.devDeltaPlan, deltaPlan);

  const authorityDir = path.join(root, 'authority');
  writeJson(path.join(authorityDir, 'descriptor.json'), queueDescriptor);
  writeJson(path.join(authorityDir, 'authority.json'), authority);
  fs.cpSync(proofBundle, path.join(authorityDir, 'proof'), { recursive: true });
  assert.doesNotThrow(() =>
    verifyCachePromotionAuthority(authorityDir, {
      targetRepository: 'kungfu-systems/kungfu',
      targetRunId: 84,
      targetHeadSha: AUTH_QUEUE_HEAD,
      targetSourceTree: AUTH_TREE,
      maxAgeSeconds: 6 * 60 * 60,
      now: '2026-07-22T01:00:00Z',
    }),
  );
  const tampered = structuredClone(authority);
  tampered.devDeltaPlan.changedPaths = ['docs/other.md'];
  writeJson(path.join(authorityDir, 'authority.json'), tampered);
  assert.throws(
    () =>
      verifyCachePromotionAuthority(authorityDir, {
        targetRepository: 'kungfu-systems/kungfu',
        targetRunId: 84,
        targetHeadSha: AUTH_QUEUE_HEAD,
        targetSourceTree: AUTH_TREE,
        maxAgeSeconds: 6 * 60 * 60,
        now: '2026-07-22T01:00:00Z',
      }),
    /cache promotion authority digest drift/,
  );
});
