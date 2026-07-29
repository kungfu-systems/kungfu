// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  promoteQualifiedCoreCandidate,
  sealQualifiedCoreCandidate,
  validateQualifiedCoreCandidate,
  verifyQualifiedCoreBundle,
} from '../framework/release/qualified-assignment-core-artifact.mjs';
import {
  createDeliveryAttempt,
  createDeliveryBinding,
  createProofDescriptor,
  digest,
} from './affected-native-proof.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const OTHER_HEAD = '3'.repeat(40);
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

function plan(head = HEAD) {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: BASE,
    head,
    authority: { layers: 'sha256:layers', buildCapabilities: 'sha256:build' },
    changedPaths: ['framework/core/CMakeLists.txt'],
    directComponents: [],
    closureComponents: ['core'],
    targets: ['a', 'test-a'],
    tests: ['test-a'],
    profile: 'full',
    platformTier: 'github-hosted-linux-native-pr',
    reviewRoutes: [],
    reasons: [],
  };
  return { ...body, planDigest: digest(body) };
}

function producer(overrides = {}) {
  return {
    repository: 'kungfu-systems/kungfu',
    runId: 42,
    event: 'merge_group',
    workflowPath: '.github/workflows/affected-native-pr.yml',
    triggerHeadSha: QUEUE_HEAD,
    checkoutSha: QUEUE_HEAD,
    createdAt: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

function deliveryBinding() {
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
    },
    {
      initiativeId: 'go-family-native-state-contract',
      assignmentId: 'go-family-proof-evidence-binding',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'attempt-one',
      admissionProofRoots: [digest({ work: 'proof-evidence-binding' })],
    },
  );
  return createDeliveryBinding({
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
    requiredContexts: [
      'affected-native / linux',
      'project-cut / queue-admission',
    ],
    queueAdmissionContext: 'project-cut / queue-admission',
  });
}

function writeBuild(payloadRoot, commit = QUEUE_HEAD) {
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.writeFileSync(
    path.join(payloadRoot, 'kungfubuildinfo.json'),
    `${JSON.stringify({
      version: '4.0.0-alpha.1',
      pythonVersion: '3.13.14',
      build: { osVersion: 'macOS-26.5.2-arm64-arm-64bit-Mach-O' },
      git: { revision: commit, pristine: true },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(payloadRoot, 'pykungfu.cpython-313-darwin.so'),
    'real native bytes',
    { mode: 0o755 },
  );
}

function sealFixture(temporary, commit = QUEUE_HEAD) {
  const payloadRoot = path.join(temporary, 'dist');
  const candidateRoot = path.join(temporary, 'candidate');
  writeBuild(payloadRoot, commit);
  fs.writeFileSync(path.join(payloadRoot, 'unrelated.dylib'), 'not authorized');
  const candidate = sealQualifiedCoreCandidate({
    repositoryRoot: ROOT,
    payloadRoot,
    outputRoot: candidateRoot,
    repository: 'kungfu-systems/kungfu',
    commit,
    tree: TREE,
    plan: plan(commit),
    producer: {
      runId: 42,
      event: 'merge_group',
      workflowPath: '.github/workflows/affected-native-pr.yml',
      runner: {
        environment: 'github-hosted',
        os: 'macOS',
        arch: 'ARM64',
        imageOS: 'macos15',
        imageVersion: '20260729.1',
      },
      createdAt: '2026-07-29T00:00:00Z',
    },
    toolchain: { compiler: 'Apple clang 17', cmake: '4.1', ninja: '1.13' },
    profile: 'full',
  });
  return { payloadRoot, candidateRoot, candidate };
}

test('producer seals minimum macOS ARM64 bytes and protected promotion', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-producer-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { candidateRoot, candidate } = sealFixture(temporary);
  assert.deepEqual(
    candidate.payload.entries.map(({ path: entryPath }) => entryPath),
    ['kungfubuildinfo.json', 'pykungfu.cpython-313-darwin.so'],
  );
  assert.equal(candidate.build.pythonAbi, 'cp313');
  validateQualifiedCoreCandidate(candidate, candidateRoot, {
    shared: true,
    repository: 'kungfu-systems/kungfu',
    commit: QUEUE_HEAD,
    runId: 42,
    event: 'merge_group',
  });

  const descriptor = createProofDescriptor(
    plan(QUEUE_HEAD),
    TREE,
    2,
    TOOLCHAIN,
    deliveryBinding(),
  );
  const proof = {
    proofId: descriptor.proofId,
    proofRoot: digest({ proofId: descriptor.proofId }),
    producer: producer({ runId: 41 }),
  };
  const attempt = createDeliveryAttempt(
    descriptor,
    proof,
    'reused',
    producer(),
  );
  const promotedRoot = path.join(temporary, 'promoted');
  const promoted = await promoteQualifiedCoreCandidate({
    candidateRoot,
    outputRoot: promotedRoot,
    repository: 'kungfu-systems/kungfu',
    targetCommit: QUEUE_HEAD,
    targetTree: TREE,
    protectedRef: 'refs/heads/dev/v4/v4.0',
    deliveryAttempt: attempt,
    mergeGroupRunId: 42,
    validFrom: '2026-07-29T00:00:00Z',
    validThrough: '2026-07-30T00:00:00Z',
    now: '2026-07-29T01:00:00Z',
    root: ROOT,
  });
  assert.equal(promoted.verification.ok, true);
  const expected = {
    producerRepository: 'kungfu-systems/kungfu',
    targetRepository: 'kungfu-systems/kungfu',
    producerCommit: QUEUE_HEAD,
    targetCommit: QUEUE_HEAD,
    sourceTreeRoot: candidate.source.sourceTreeRoot,
    nativeInputRoot: candidate.build.nativeInputRoot,
    operatingSystem: 'darwin',
    architecture: 'arm64',
    pythonAbi: 'cp313',
    profile: 'full',
    toolchainDigest: candidate.build.toolchainDigest,
    dependencyLockDigest: candidate.build.dependencyLockDigest,
    shifuContractVersion: candidate.contracts.shifu.version,
    shifuContractRoot: candidate.contracts.shifu.root,
    buildchainContractVersion: candidate.contracts.buildchain.version,
    buildchainContractRoot: candidate.contracts.buildchain.root,
    targetRoot: 'framework/core/dist/kungfu',
    checkoutClean: true,
    protectedRef: 'refs/heads/dev/v4/v4.0',
    promotionAuthorityCandidates: [candidate.candidateRoot],
    now: '2026-07-29T01:00:00Z',
  };
  const portable = await verifyQualifiedCoreBundle(
    promotedRoot,
    expected,
    ROOT,
  );
  assert.equal(portable.artifactRoot, candidate.payload.artifactRoot);

  fs.writeFileSync(
    path.join(candidateRoot, 'payload', 'pykungfu.cpython-313-darwin.so'),
    'tampered',
  );
  assert.throws(
    () => validateQualifiedCoreCandidate(candidate, candidateRoot),
    /payload drift/u,
  );
});

test('producer rejects wrong runner, stale source, unsafe links, and missing roots', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-reject-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { payloadRoot, candidateRoot, candidate } = sealFixture(
    temporary,
    HEAD,
  );
  const wrongRunner = structuredClone(candidate);
  wrongRunner.producer.runner.arch = 'X64';
  const { candidateRoot: _wrongRoot, ...wrongBody } = wrongRunner;
  wrongRunner.candidateRoot = digest(wrongBody);
  assert.throws(
    () => validateQualifiedCoreCandidate(wrongRunner, candidateRoot),
    /macOS ARM64 runner/u,
  );
  assert.throws(
    () =>
      validateQualifiedCoreCandidate(candidate, candidateRoot, {
        commit: OTHER_HEAD,
      }),
    /source is stale/u,
  );
  const missingRoot = structuredClone(candidate);
  const { planRoot: _planRoot, ...remainingQualification } =
    missingRoot.qualification;
  missingRoot.qualification = remainingQualification;
  const { candidateRoot: _missingRoot, ...missingBody } = missingRoot;
  missingRoot.candidateRoot = digest(missingBody);
  assert.throws(
    () => validateQualifiedCoreCandidate(missingRoot, candidateRoot),
    /qualification roots are incomplete/u,
  );
  const duplicatePath = structuredClone(candidate);
  duplicatePath.payload.entries.push(
    structuredClone(duplicatePath.payload.entries.at(-1)),
  );
  const { candidateRoot: _duplicateRoot, ...duplicateBody } = duplicatePath;
  duplicatePath.candidateRoot = digest(duplicateBody);
  assert.throws(
    () => validateQualifiedCoreCandidate(duplicatePath, candidateRoot),
    /path set is unauthorized/u,
  );

  const substituted = path.join(
    candidateRoot,
    'payload',
    'pykungfu.cpython-313-darwin.so',
  );
  fs.rmSync(substituted);
  fs.symlinkSync('kungfubuildinfo.json', substituted);
  assert.throws(
    () => validateQualifiedCoreCandidate(candidate, candidateRoot),
    /payload type drift/u,
  );

  const unsafeRoot = path.join(temporary, 'unsafe');
  fs.mkdirSync(unsafeRoot);
  fs.copyFileSync(
    path.join(payloadRoot, 'kungfubuildinfo.json'),
    path.join(unsafeRoot, 'kungfubuildinfo.json'),
  );
  fs.symlinkSync(
    '../../escape',
    path.join(unsafeRoot, 'pykungfu.cpython-313-darwin.so'),
  );
  assert.throws(
    () =>
      sealQualifiedCoreCandidate({
        repositoryRoot: ROOT,
        payloadRoot: unsafeRoot,
        outputRoot: path.join(temporary, 'unsafe-candidate'),
        repository: 'kungfu-systems/kungfu',
        commit: HEAD,
        tree: TREE,
        plan: plan(),
        producer: {
          runId: 42,
          event: 'merge_group',
          workflowPath: '.github/workflows/affected-native-pr.yml',
          runner: {
            environment: 'github-hosted',
            os: 'macOS',
            arch: 'ARM64',
          },
          createdAt: '2026-07-29T00:00:00Z',
        },
        toolchain: { compiler: 'Apple clang' },
      }),
    /symlink is unsafe/u,
  );
});

test('workflows keep candidate and promotion outside untrusted PR authority', () => {
  const producerWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  const candidateJob = producerWorkflow.slice(
    producerWorkflow.indexOf('  qualified_core_candidate:\n'),
  );
  assert.match(
    candidateJob,
    /github\.event_name == 'merge_group'[\s\S]*native-required == 'true'[\s\S]*needs\['affected-native'\]\.result == 'success'[\s\S]*continue-on-error: true[\s\S]*runs-on: macos-15/u,
  );
  assert.match(
    candidateJob,
    /Build and seal minimum relocatable Assignment Core candidate[\s\S]*RUNNER_OS[\s\S]*RUNNER_ARCH[\s\S]*rebuild:core[\s\S]*framework\/release\/qualified-assignment-core-artifact\.mjs seal/u,
  );
  assert.doesNotMatch(candidateJob, /pull_request/);

  const promotionWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-cache-promote.yml'),
    'utf8',
  );
  assert.match(promotionWorkflow, /^\s{2}push\s*:/mu);
  assert.match(
    promotionWorkflow,
    /promote:[\s\S]*github\.ref_protected == true[\s\S]*TARGET_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}[\s\S]*event=merge_group[\s\S]*head_sha="\$TARGET_SHA"[\s\S]*affected-native \/ linux[\s\S]*Multiple Qualified Core producer authorities[\s\S]*framework\/release\/qualified-assignment-core-artifact\.mjs promote[\s\S]*--target-commit "\$TARGET_SHA"[\s\S]*--protected-ref "\$GITHUB_REF"[\s\S]*--delivery-attempt/u,
  );
  assert.match(
    promotionWorkflow,
    /No exact Qualified Core producer became available; source build remains authoritative/u,
  );
  assert.match(
    promotionWorkflow,
    /run_status[\s\S]*length <= 1 then \\"incomplete\\"[\s\S]*pending_run=true[\s\S]*Completed producer run[\s\S]*observed_run[\s\S]*pending_run/u,
  );
});
