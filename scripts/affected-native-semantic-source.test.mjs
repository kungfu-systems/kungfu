// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCachePromotionAuthority,
  createDeliveryBinding,
  createProofDescriptor,
  createSemanticSourceProjection,
  digest,
  sealProof,
  semanticSourceProjectionFromGit,
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

test('delivery attempt sealing preserves the verified dev delta plan', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /name: Seal reconstructable family delivery attempt[\s\S]*delta_args=\(\)[\s\S]*--dev-delta-plan "\$delta_plan"[\s\S]*affected-native-proof\.mjs seal-attempt[\s\S]*"\$\{delta_args\[@\]\}"/u,
  );
  const proofSource = fs.readFileSync(
    path.join(ROOT, 'scripts/affected-native-proof.mjs'),
    'utf8',
  );
  assert.match(
    proofSource,
    /options\.command === 'seal-attempt'[\s\S]*deltaPlan: options\['dev-delta-plan'\][\s\S]*readJson\(path\.resolve\(options\['dev-delta-plan'\]\)\)/u,
  );
  assert.match(
    workflow,
    /name: Seal reused-proof cache promotion authority[\s\S]*delta_args=\(\)[\s\S]*--dev-delta-plan "\$delta_plan"[\s\S]*affected-native-proof\.mjs seal-cache-authority[\s\S]*"\$\{delta_args\[@\]\}"/u,
  );
  assert.match(
    proofSource,
    /verifyCachePromotionAuthority[\s\S]*deltaPlan: authority\.proof\?\.deltaPlan[\s\S]*options\.command === 'seal-cache-authority'[\s\S]*deltaPlan: options\['dev-delta-plan'\][\s\S]*readJson\(path\.resolve\(options\['dev-delta-plan'\]\)\)/u,
  );
});

function plan(head = HEAD, overrides = {}) {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: BASE,
    head,
    authority: { layers: 'sha256:layers', buildCapabilities: 'sha256:build' },
    changedPaths: ['framework/core/native.cpp'],
    directComponents: ['core'],
    closureComponents: ['core'],
    targets: ['kungfu'],
    tests: [],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [{ path: 'framework/core/native.cpp', kind: 'component-source' }],
    ...overrides,
  };
  return { ...body, planDigest: digest(body) };
}

function sourceBinding(sourceHead) {
  return createDeliveryBinding({
    event: 'pull_request',
    pullRequest: 3037,
    pullRequestHead: sourceHead,
    requiredContexts: ['affected-native / linux'],
    queueAdmissionContext: 'project-cut / queue-admission',
  });
}

function proofFixture(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-proof-delta-'));
  const inputs = path.join(root, 'inputs');
  const bundle = path.join(root, 'bundle');
  const targets = value.targets;
  const tests = value.tests;
  const partition = {
    schema: 'kungfu.core-affected-native-partition/v1',
    index: 0,
    count: 1,
    targets,
    tests,
    partitionDigest: digest({
      planDigest: value.planDigest,
      index: 0,
      count: 1,
      targets,
      tests,
    }),
    coverageDigest: digest({
      planDigest: value.planDigest,
      count: 1,
      lanes: [{ index: 0, targets, tests }],
    }),
  };
  fs.mkdirSync(path.join(inputs, 'partition-0'), { recursive: true });
  fs.writeFileSync(
    path.join(inputs, 'partition-0', 'receipt.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        source: { base: value.base, head: value.head },
        plan: value,
        planDigest: value.planDigest,
        executionPartition: partition,
        platform: 'linux-x64',
        toolchain: TOOLCHAIN,
      },
      null,
      2,
    )}\n`,
  );
  return { root, inputs, bundle };
}

test('cache authority carries unrelated dev attribution into proof reuse', () => {
  const sourcePlan = plan();
  const value = proofFixture(sourcePlan);
  try {
    const pullDescriptor = createProofDescriptor(
      sourcePlan,
      TREE,
      1,
      TOOLCHAIN,
      sourceBinding(HEAD),
    );
    const queueDescriptor = createProofDescriptor(
      plan('5'.repeat(40), { base: OTHER_HEAD }),
      TREE,
      1,
      TOOLCHAIN,
      sourceBinding('5'.repeat(40)),
    );
    const deltaPlan = plan(OTHER_HEAD, {
      changedPaths: ['docs/readme.md'],
      directComponents: [],
      closureComponents: [],
      targets: [],
      reasons: [{ path: 'docs/readme.md', kind: 'outside-core' }],
    });
    const proof = sealProof(pullDescriptor, value.inputs, {
      repository: 'kungfu-systems/kungfu',
      runId: 42,
      event: 'pull_request',
      workflowPath: '.github/workflows/affected-native-pr.yml',
      triggerHeadSha: HEAD,
      checkoutSha: HEAD,
      createdAt: '2026-08-15T00:00:00Z',
    });
    fs.mkdirSync(value.bundle, { recursive: true });
    fs.writeFileSync(
      path.join(value.bundle, 'proof.json'),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
    fs.copyFileSync(
      path.join(value.inputs, 'partition-0', 'receipt.json'),
      path.join(value.bundle, 'partition-0.receipt.json'),
    );
    const authority = createCachePromotionAuthority(
      queueDescriptor,
      value.bundle,
      {
        targetRepository: 'kungfu-systems/kungfu',
        targetRunId: 84,
        targetEvent: 'merge_group',
        targetHeadSha: '5'.repeat(40),
        targetSourceTree: TREE,
        producerRepository: 'kungfu-systems/kungfu',
        producerRunId: 42,
        producerEvent: 'pull_request',
        producerHeadSha: HEAD,
        now: '2026-08-15T01:00:00Z',
        deltaPlan,
      },
    );
    assert.equal(authority.proof.deltaPlan.planDigest, deltaPlan.planDigest);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

function runGit(repository, args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kungfu Test',
      GIT_AUTHOR_EMAIL: 'test@kungfu.dev',
      GIT_COMMITTER_NAME: 'Kungfu Test',
      GIT_COMMITTER_EMAIL: 'test@kungfu.dev',
    },
  }).trim();
}

test('semantic source projection binds exact changed blobs and deletions', () => {
  const first = createSemanticSourceProjection(plan(), [
    {
      path: 'framework/core/native.cpp',
      state: 'present',
      mode: '100644',
      type: 'blob',
      objectId: '6'.repeat(40),
    },
  ]);
  const repeated = createSemanticSourceProjection(plan(OTHER_HEAD), [
    {
      path: './framework/core/native.cpp',
      state: 'present',
      mode: '100644',
      type: 'blob',
      objectId: '6'.repeat(40),
    },
  ]);
  assert.equal(first.semanticSourceRoot, repeated.semanticSourceRoot);
  assert.notEqual(
    first.semanticSourceRoot,
    createSemanticSourceProjection(plan(), [
      {
        path: 'framework/core/native.cpp',
        state: 'present',
        mode: '100644',
        type: 'blob',
        objectId: '7'.repeat(40),
      },
    ]).semanticSourceRoot,
  );
  assert.notEqual(
    first.semanticSourceRoot,
    createSemanticSourceProjection(plan(), [
      { path: 'framework/core/native.cpp', state: 'deleted' },
    ]).semanticSourceRoot,
  );
  assert.throws(
    () => createSemanticSourceProjection(plan(), []),
    /do not match changed paths/u,
  );
});

test('semantic source projection survives an unrelated dev replay', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'affected-semantic-source-'),
  );
  try {
    runGit(repository, ['init', '--initial-branch=dev']);
    fs.mkdirSync(path.join(repository, 'framework/core'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'framework/core/native.cpp'),
      'int value = 1;\n',
    );
    fs.writeFileSync(path.join(repository, 'docs/readme.md'), 'base\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'base']);
    const base = runGit(repository, ['rev-parse', 'HEAD']);

    runGit(repository, ['checkout', '-b', 'candidate']);
    fs.writeFileSync(
      path.join(repository, 'framework/core/native.cpp'),
      'int value = 2;\n',
    );
    runGit(repository, ['commit', '-am', 'candidate']);
    const candidate = runGit(repository, ['rev-parse', 'HEAD']);

    runGit(repository, ['checkout', '-b', 'advanced-dev', base]);
    fs.writeFileSync(path.join(repository, 'docs/readme.md'), 'advanced\n');
    runGit(repository, ['commit', '-am', 'unrelated dev movement']);
    const advancedBase = runGit(repository, ['rev-parse', 'HEAD']);
    runGit(repository, ['cherry-pick', candidate]);
    const replayed = runGit(repository, ['rev-parse', 'HEAD']);

    const first = semanticSourceProjectionFromGit(
      plan(candidate, { base }),
      repository,
    );
    const second = semanticSourceProjectionFromGit(
      plan(replayed, { base: advancedBase }),
      repository,
    );
    assert.notEqual(
      runGit(repository, ['rev-parse', `${candidate}^{tree}`]),
      runGit(repository, ['rev-parse', `${replayed}^{tree}`]),
    );
    assert.equal(first.semanticSourceRoot, second.semanticSourceRoot);
    assert.deepEqual(first.entries, second.entries);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('base-only replay keeps proof identity when semantic inputs match', () => {
  const semanticSourceRoot = digest({ semantic: 'same-native-inputs' });
  const first = createProofDescriptor(
    plan(HEAD),
    TREE,
    2,
    TOOLCHAIN,
    sourceBinding(HEAD),
    semanticSourceRoot,
  );
  const replayed = createProofDescriptor(
    plan(OTHER_HEAD, { base: '6'.repeat(40) }),
    '7'.repeat(40),
    2,
    TOOLCHAIN,
    sourceBinding(OTHER_HEAD),
    semanticSourceRoot,
  );
  assert.notEqual(first.identity.sourceTree, replayed.identity.sourceTree);
  assert.equal(
    first.identity.semanticSourceRoot,
    replayed.identity.semanticSourceRoot,
  );
  assert.equal(first.proofId, replayed.proofId);
  assert.deepEqual(first.qualificationIdentity, replayed.qualificationIdentity);
});
