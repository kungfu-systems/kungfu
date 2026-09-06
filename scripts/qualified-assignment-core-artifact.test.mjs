// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  promoteQualifiedCoreCandidate,
  qualifiedCoreCheckoutRoots,
  reuseQualifiedCoreBundle,
  sealQualifiedCoreCandidate,
  validateQualifiedCoreCandidate,
  verifyQualifiedCoreBundle,
} from '@kungfu-tech/product-kungfu/release/qualified-assignment-core-artifact';
import {
  consumeQualifiedCoreForCheckout,
  discoverGithubBundle,
  downloadGithubArtifact,
  downloadHttpArtifact,
  materializeQualifiedCoreBundle,
  resolveShifuCachedTool,
} from '@kungfu-tech/work/assignment-capture/qualified-assignment-core-consumer';
import {
  appendQualifiedCoreUsage,
  qualifiedCoreUsageObservation,
  summarizeQualifiedCoreUsage,
} from '@kungfu-tech/work/assignment-capture/qualified-assignment-core-observability';
import {
  REQUIRED_ROWS,
  qualifiedCoreArtifactName,
  qualifiedCorePlatformMatrix,
  qualifiedCorePlatformRow,
} from '@kungfu-tech/work/assignment-capture/qualified-assignment-core-platform-matrix';
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
const CONSUMER_NOW = '2026-07-29T06:00:00Z';
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

const ROW_FIXTURES = {
  'darwin-arm64-cp313': {
    osVersion: 'macOS-26.5.2-arm64-arm-64bit-Mach-O',
    files: [
      ['pykungfu.cpython-313-darwin.so', '0755'],
      ['libnode.127.dylib', '0755'],
      ['libkungfu_runtime.dylib', '0755'],
    ],
  },
  'linux-x86_64-cp313': {
    osVersion: 'Linux-6.11.0-x86_64-with-glibc2.39',
    files: [
      ['pykungfu.cpython-313-x86_64-linux-gnu.so', '0755'],
      ['libnode.so.127', '0755'],
      ['libkungfu_runtime.so', '0755'],
    ],
  },
  'windows-x86_64-cp313': {
    osVersion: 'Windows-Server-2022-10.0.20348-SP0-AMD64',
    files: [
      ['pykungfu.cp313-win_amd64.pyd', '0644'],
      ['libnode.dll', '0644'],
    ],
  },
};

function writeBuild(
  payloadRoot,
  commit = QUEUE_HEAD,
  rowId = 'darwin-arm64-cp313',
) {
  const fixture = ROW_FIXTURES[rowId];
  const row = qualifiedCorePlatformRow(rowId, ROOT);
  assert.ok(fixture, `missing row fixture ${rowId}`);
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.writeFileSync(
    path.join(payloadRoot, 'kungfubuildinfo.json'),
    `${JSON.stringify({
      version: '4.0.0-alpha.1',
      pythonVersion: '3.13.14',
      build: {
        osVersion: fixture.osVersion,
        operatingSystem: row.operatingSystem,
        architecture: row.architecture,
      },
      git: { revision: commit, pristine: true },
    })}\n`,
  );
  for (const [name, mode] of fixture.files) {
    fs.writeFileSync(path.join(payloadRoot, name), `${name} bytes`, {
      mode: mode === '0755' ? 0o755 : 0o644,
    });
  }
}

function sealFixture(
  temporary,
  commit = QUEUE_HEAD,
  rowId = 'darwin-arm64-cp313',
  producerOverrides = {},
) {
  const payloadRoot = path.join(temporary, 'dist');
  const candidateRoot = path.join(temporary, 'candidate');
  const row = qualifiedCorePlatformRow(rowId, ROOT);
  const producerRunner = {
    label: row.runner.label,
    environment: 'github-hosted',
    os: row.runner.os,
    arch: row.runner.arch,
    imageOS: row.runner.label.replaceAll('-', ''),
    imageVersion: '20260729.1',
  };
  writeBuild(payloadRoot, commit, rowId);
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
      runner: producerRunner,
      createdAt: '2026-07-29T00:00:00Z',
      ...producerOverrides,
    },
    toolchain: {
      compiler: 'fixture compiler 17',
      cmake: '4.1',
      ninja: '1.13',
      runner: producerRunner,
    },
    profile: 'full',
    platformRowId: rowId,
  });
  return { payloadRoot, candidateRoot, candidate };
}

async function promotedConsumerFixture(
  temporary,
  rowId = 'darwin-arm64-cp313',
) {
  const { candidateRoot, candidate } = sealFixture(
    temporary,
    QUEUE_HEAD,
    rowId,
  );
  const bundleRoot = path.join(temporary, 'promoted-consumer');
  await promoteQualifiedCoreCandidate({
    candidateRoot,
    outputRoot: bundleRoot,
    repository: 'kungfu-systems/kungfu',
    targetCommit: QUEUE_HEAD,
    targetTree: TREE,
    protectedRef: 'refs/heads/dev/v4/v4.0',
    deliveryEvidenceRoot: digest({
      schema: 'test-delivery/v1',
      commit: QUEUE_HEAD,
    }),
    validFrom: '2026-07-29T05:00:00Z',
    validThrough: '2026-07-30T05:00:00Z',
    now: CONSUMER_NOW,
    allowLocal: true,
    root: ROOT,
  });
  return { bundleRoot, candidate };
}

function consumerCheckout(overrides = {}) {
  return {
    repository: 'kungfu-systems/kungfu',
    commit: QUEUE_HEAD,
    tree: TREE,
    clean: true,
    ...overrides,
  };
}

function usageObservation(overrides = {}) {
  return qualifiedCoreUsageObservation({
    recordedAt: CONSUMER_NOW,
    result: 'materialized',
    reason: 'fixture-hit',
    phases: { checkout: 1, total: 2 },
    repository: 'kungfu-systems/kungfu',
    sourceCommit: QUEUE_HEAD,
    compatibilityIdentity: null,
    platform: 'darwin',
    architecture: 'arm64',
    pythonAbi: 'cp313',
    artifact: null,
    fallback: { required: false, command: '' },
    ...overrides,
  });
}

function compatibilityCheckoutFixture(temporary) {
  const repositoryRoot = path.join(temporary, 'compatibility-checkout');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  const pathspecs = [
    '.github/actions/qualified-core-candidate-build/action.yml',
    '.github/actions/upload-qualified-core-matrix/action.yml',
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
    '.github/workflows/dev-post-merge-advisory.yml',
    'framework/core',
    '.buildchain/contract-lock.json',
    '.buildchain/buildchain.toml',
    'pnpm-lock.yaml',
    'shifu',
    'shifu.mjs',
    'docs/shifu/artifact-contract.json',
    'docs/shifu/cache-contract.json',
    'docs/shifu/schema/qualified-assignment-core-artifact-v1.schema.json',
    'docs/shifu/schema/qualified-assignment-core-qualification-v1.schema.json',
    'docs/shifu/schema/qualified-assignment-core-artifact-v2.schema.json',
    'docs/shifu/schema/qualified-assignment-core-qualification-v2.schema.json',
    'docs/shifu/schema/qualified-assignment-core-platform-matrix-v1.schema.json',
    'docs/shifu/qualified-assignment-core-platform-matrix.json',
    'scripts/check-shifu-cache-contract.mjs',
    fileURLToPath(
      import.meta.resolve(
        '@kungfu-tech/work/assignment-capture/qualified-assignment-core-consumer',
      ),
    ),
    'framework/work/assignment-capture/qualified-assignment-core-observability.mjs',
    'product/release/qualified-assignment-core-artifact.mjs',
    'framework/work/assignment-capture/qualified-assignment-core-platform-matrix.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  const files = new Set(listed.stdout.split('\0').filter(Boolean));
  for (const relative of pathspecs) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      const stat = fs.statSync(path.join(ROOT, relative));
      if (stat.isFile()) files.add(relative);
    }
  }
  for (const relative of [...files].sort()) {
    const destination = path.join(repositoryRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  for (const args of [
    ['init', '-b', 'dev'],
    ['config', 'user.name', 'Compatibility Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['add', '.'],
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  return repositoryRoot;
}

test('cached Shifu tool resolution binds pin, platform, and executable file', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-cached-tool-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  const uv = path.join(
    cache,
    'kungfu',
    'tools',
    'uv',
    '0.11.23',
    'linux-x86_64',
    'uv',
  );
  fs.mkdirSync(path.dirname(uv), { recursive: true });
  fs.writeFileSync(path.join(root, '.uv-version'), '0.11.23\n');
  fs.writeFileSync(uv, '');
  fs.chmodSync(uv, 0o755);
  const options = {
    tool: 'uv',
    repositoryRoot: root,
    platform: 'linux',
    architecture: 'x64',
    env: { XDG_CACHE_HOME: cache },
  };
  assert.equal(resolveShifuCachedTool(options), uv);
  assert.equal(
    resolveShifuCachedTool({
      ...options,
      env: {
        KUNGFU_UV_VERSION: '../0.11.23',
        XDG_CACHE_HOME: cache,
      },
    }),
    '',
  );
  fs.chmodSync(uv, 0o644);
  assert.equal(resolveShifuCachedTool(options), '');
  assert.equal(resolveShifuCachedTool({ ...options, tool: 'fnm' }), '');
});

test('platform matrix binds exactly three supported producer rows', (t) => {
  const matrix = qualifiedCorePlatformMatrix(ROOT);
  assert.deepEqual(
    matrix.rows.map(({ id }) => id),
    ['darwin-arm64-cp313', 'linux-x86_64-cp313', 'windows-x86_64-cp313'],
  );
  assert.deepEqual(matrix.shared.toolchainFacts, [
    'compiler',
    'cmake',
    'ninja',
    'runner',
  ]);
  assert.equal(matrix.shared.qualificationPolicy.missingRow, 'unqualified');
  assert.equal(matrix.shared.qualificationPolicy.substitution, 'forbidden');
  const candidateNames = matrix.rows.map(({ id }) =>
    qualifiedCoreArtifactName('candidate', QUEUE_HEAD, id, ROOT),
  );
  const promotedNames = matrix.rows.map(({ id }) =>
    qualifiedCoreArtifactName('promoted', QUEUE_HEAD, id, ROOT),
  );
  assert.equal(new Set(candidateNames).size, REQUIRED_ROWS.length);
  assert.equal(new Set(promotedNames).size, REQUIRED_ROWS.length);
  assert.equal(
    qualifiedCoreArtifactName('matrixIndex', QUEUE_HEAD, '', ROOT),
    `qualified-assignment-core-matrix-${QUEUE_HEAD}`,
  );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-platform-matrix-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const row of matrix.rows) {
    const { candidateRoot, candidate } = sealFixture(
      path.join(temporary, row.id),
      QUEUE_HEAD,
      row.id,
    );
    assert.equal(candidate.build.operatingSystem, row.operatingSystem);
    assert.equal(candidate.build.architecture, row.architecture);
    assert.equal(candidate.build.pythonAbi, row.pythonAbi);
    assert.equal(candidate.producer.runner.label, row.runner.label);
    assert.deepEqual(
      candidate.payload.entries.map(({ path: entryPath }) => entryPath),
      ROW_FIXTURES[row.id].files
        .map(([name]) => name)
        .concat('kungfubuildinfo.json')
        .sort(),
    );
    validateQualifiedCoreCandidate(candidate, candidateRoot, {
      shared: true,
      repository: 'kungfu-systems/kungfu',
      commit: QUEUE_HEAD,
      runId: 42,
      event: 'merge_group',
      workflowPath: '.github/workflows/affected-native-pr.yml',
      repositoryRoot: ROOT,
    });
  }
});

test('producer seals minimum macOS ARM64 bytes and protected promotion', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-producer-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { candidateRoot, candidate } = sealFixture(temporary);
  assert.deepEqual(
    candidate.payload.entries.map(({ path: entryPath }) => entryPath),
    [
      'kungfubuildinfo.json',
      'libkungfu_runtime.dylib',
      'libnode.127.dylib',
      'pykungfu.cpython-313-darwin.so',
    ],
  );
  assert.equal(candidate.build.pythonAbi, 'cp313');
  validateQualifiedCoreCandidate(candidate, candidateRoot, {
    shared: true,
    repository: 'kungfu-systems/kungfu',
    commit: QUEUE_HEAD,
    runId: 42,
    event: 'merge_group',
    workflowPath: '.github/workflows/affected-native-pr.yml',
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
    deliveryEvidenceRoot: attempt.attemptRoot,
    mergeGroupRunId: 42,
    validFrom: '2026-07-29T00:00:00Z',
    validThrough: '2026-07-30T00:00:00Z',
    now: '2026-07-29T01:00:00Z',
    allowLocal: true,
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
    compatibilityRoot: candidate.build.compatibilityRoot,
    nativeClosureRoot: candidate.qualification.nativeClosureRoot,
    compatibilityPolicyRoot: candidate.qualification.compatibilityPolicyRoot,
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
  assert.equal(
    portable.compatibilityIdentity,
    candidate.build.compatibilityRoot,
  );

  fs.writeFileSync(
    path.join(candidateRoot, 'payload', 'pykungfu.cpython-313-darwin.so'),
    'tampered',
  );
  assert.throws(
    () => validateQualifiedCoreCandidate(candidate, candidateRoot),
    /payload drift/u,
  );
});

test('post-merge advisory producer provenance stays distinct from merge-group delivery', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-advisory-producer-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { candidateRoot, candidate } = sealFixture(
    temporary,
    QUEUE_HEAD,
    'darwin-arm64-cp313',
    {
      runId: 84,
      event: 'push',
      workflowPath: '.github/workflows/dev-post-merge-advisory.yml',
    },
  );
  validateQualifiedCoreCandidate(candidate, candidateRoot, {
    shared: true,
    repository: 'kungfu-systems/kungfu',
    commit: QUEUE_HEAD,
    runId: 84,
    event: 'push',
    workflowPath: '.github/workflows/dev-post-merge-advisory.yml',
    repositoryRoot: ROOT,
  });
  assert.throws(
    () =>
      validateQualifiedCoreCandidate(candidate, candidateRoot, {
        runId: 42,
      }),
    /producer run drift/u,
  );
  assert.throws(
    () =>
      validateQualifiedCoreCandidate(candidate, candidateRoot, {
        event: 'merge_group',
      }),
    /producer event drift/u,
  );
  assert.throws(
    () =>
      validateQualifiedCoreCandidate(candidate, candidateRoot, {
        workflowPath: '.github/workflows/affected-native-pr.yml',
      }),
    /producer workflow drift/u,
  );
});

test('promotion emits an immutable equivalence receipt without rewriting producer provenance', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-equivalence-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { candidateRoot, candidate } = sealFixture(temporary);
  const outputRoot = path.join(temporary, 'promoted-reuse');
  const promoted = await promoteQualifiedCoreCandidate({
    candidateRoot,
    outputRoot,
    repository: 'kungfu-systems/kungfu',
    targetCommit: OTHER_HEAD,
    targetTree: '6'.repeat(40),
    protectedRef: 'refs/heads/dev/v4/v4.0',
    deliveryEvidenceRoot: digest({ target: OTHER_HEAD }),
    validFrom: '2026-07-29T05:00:00Z',
    validThrough: '2026-07-30T05:00:00Z',
    now: CONSUMER_NOW,
    allowLocal: true,
    root: ROOT,
  });
  assert.equal(promoted.manifest.producer.commit, candidate.source.commit);
  assert.equal(promoted.manifest.target.commit, OTHER_HEAD);
  assert.equal(promoted.manifest.compatibility.mode, 'explicit-equivalence');
  assert.equal(
    promoted.verification.compatibilityIdentity,
    candidate.build.compatibilityRoot,
  );
  const equivalence = JSON.parse(
    fs.readFileSync(path.join(outputRoot, 'equivalence.json'), 'utf8'),
  );
  assert.equal(equivalence.producer.commit, candidate.source.commit);
  assert.equal(equivalence.target.commit, OTHER_HEAD);
  assert.equal(
    equivalence.producer.compatibilityRoot,
    equivalence.target.compatibilityRoot,
  );
  const tampered = structuredClone(equivalence);
  tampered.target.compatibilityRoot = digest({ incompatible: true });
  fs.writeFileSync(
    path.join(outputRoot, 'equivalence.json'),
    `${JSON.stringify(tampered, null, 2)}\n`,
  );
  await assert.rejects(
    verifyQualifiedCoreBundle(
      outputRoot,
      {
        ...promoted.verification,
        producerRepository: candidate.source.repository,
        targetRepository: candidate.source.repository,
        producerCommit: candidate.source.commit,
        targetCommit: OTHER_HEAD,
        sourceTreeRoot: candidate.source.sourceTreeRoot,
        nativeInputRoot: candidate.build.nativeInputRoot,
        compatibilityRoot: candidate.build.compatibilityRoot,
        nativeClosureRoot: candidate.qualification.nativeClosureRoot,
        compatibilityPolicyRoot:
          candidate.qualification.compatibilityPolicyRoot,
        operatingSystem: 'darwin',
        architecture: 'arm64',
        pythonAbi: 'cp313',
        profile: candidate.build.profile,
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
        now: CONSUMER_NOW,
      },
      ROOT,
    ),
    /equivalence/u,
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
    /platform row darwin-arm64-cp313/u,
  );
  assert.throws(
    () =>
      validateQualifiedCoreCandidate(candidate, candidateRoot, {
        commit: OTHER_HEAD,
      }),
    /source is stale/u,
  );
  const wrongBuildIdentity = structuredClone(candidate);
  wrongBuildIdentity.build.buildInfo.build.architecture = 'x64';
  const { candidateRoot: _wrongBuildIdentityRoot, ...wrongBuildIdentityBody } =
    wrongBuildIdentity;
  wrongBuildIdentity.candidateRoot = digest(wrongBuildIdentityBody);
  assert.throws(
    () => validateQualifiedCoreCandidate(wrongBuildIdentity, candidateRoot),
    /build metadata drift/u,
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
    /path set is unauthorized|exactly one python-binding/u,
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
  fs.copyFileSync(
    path.join(payloadRoot, 'libnode.127.dylib'),
    path.join(unsafeRoot, 'libnode.127.dylib'),
  );
  fs.copyFileSync(
    path.join(payloadRoot, 'libkungfu_runtime.dylib'),
    path.join(unsafeRoot, 'libkungfu_runtime.dylib'),
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
            label: 'macos-15',
            environment: 'github-hosted',
            os: 'macOS',
            arch: 'ARM64',
            imageOS: 'macos15',
            imageVersion: '20260729.1',
          },
          createdAt: '2026-07-29T00:00:00Z',
        },
        toolchain: {
          compiler: 'Apple clang',
          cmake: '4.1',
          ninja: '1.13',
          runner: {
            label: 'macos-15',
            environment: 'github-hosted',
            os: 'macOS',
            arch: 'ARM64',
            imageOS: 'macos15',
            imageVersion: '20260729.1',
          },
        },
      }),
    /symlink is unsafe|executable metadata drift/u,
  );
});

test('consumer materializes an exact runtime closure and repeats idempotently', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-consumer-hit-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot, candidate } = await promotedConsumerFixture(temporary);
  const publicationRoot = path.join(temporary, 'checkout');
  const cacheRoot = path.join(temporary, 'cache');
  const first = await materializeQualifiedCoreBundle({
    bundleRoot,
    repositoryRoot: ROOT,
    publicationRoot,
    checkout: consumerCheckout(),
    cacheRoot,
    now: CONSUMER_NOW,
  });
  assert.equal(first.status, 'materialized');
  assert.deepEqual(
    fs
      .readdirSync(path.join(publicationRoot, 'framework/core/dist/kungfu'))
      .sort(),
    [
      '.qualified-core-materialization.json',
      ...candidate.payload.entries.map((entry) => entry.path),
    ].sort(),
  );
  const second = await materializeQualifiedCoreBundle({
    bundleRoot,
    repositoryRoot: ROOT,
    publicationRoot,
    checkout: consumerCheckout(),
    cacheRoot,
    now: CONSUMER_NOW,
  });
  assert.equal(second.status, 'already-materialized');
  assert.equal(second.objectRoot, first.objectRoot);

  const concurrentRoot = path.join(temporary, 'concurrent-checkout');
  const concurrentCache = path.join(temporary, 'concurrent-cache');
  const results = await Promise.all([
    materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: concurrentRoot,
      checkout: consumerCheckout(),
      cacheRoot: concurrentCache,
      now: CONSUMER_NOW,
    }),
    materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: concurrentRoot,
      checkout: consumerCheckout(),
      cacheRoot: concurrentCache,
      now: CONSUMER_NOW,
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    'already-materialized',
    'materialized',
  ]);
  assert.equal(
    fs
      .readdirSync(path.join(concurrentRoot, 'framework/core/dist'))
      .some((name) => name.includes('.qualified-core-stage-')),
    false,
  );
});

test('Linux x86_64 consumer materializes a protected bundle and reuses local CAS in a second checkout', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-linux-consumer-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot, candidate } = await promotedConsumerFixture(
    temporary,
    'linux-x86_64-cp313',
  );
  const cacheRoot = path.join(temporary, 'cache');
  const first = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'checkout-one'),
    cacheRoot,
    now: CONSUMER_NOW,
    checkout: consumerCheckout(),
    platform: 'linux',
    architecture: 'x64',
    discoverRemote: async (_checkout, _temporary, options) => {
      assert.equal(options.platformRowId, 'linux-x86_64-cp313');
      return {
        bundleRoot,
        transport: {
          provider: 'github-workflow-artifact',
          artifactId: 42,
          artifactName: `qualified-assignment-core-${QUEUE_HEAD}-linux-x86_64-cp313`,
          runId: 43,
          workflowPath: '.github/workflows/affected-native-cache-promote.yml',
          event: 'push',
          protectedRef: 'refs/heads/dev/v4/v4.0',
          headSha: QUEUE_HEAD,
          platformRow: 'linux-x86_64-cp313',
        },
      };
    },
  });
  assert.equal(first.status, 'materialized');
  assert.deepEqual(
    candidate.payload.entries.map(({ path: entryPath }) => entryPath),
    [
      'kungfubuildinfo.json',
      'libkungfu_runtime.so',
      'libnode.so.127',
      'pykungfu.cpython-313-x86_64-linux-gnu.so',
    ],
  );
  for (const entry of candidate.payload.entries) {
    const installed = path.join(
      temporary,
      'checkout-one',
      'framework/core/dist/kungfu',
      entry.path,
    );
    assert.equal(
      fs.statSync(installed).mode & 0o777,
      entry.mode === '0755' ? 0o755 : 0o644,
    );
  }

  const second = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'checkout-two'),
    cacheRoot,
    now: '2026-07-29T06:00:01Z',
    checkout: consumerCheckout(),
    platform: 'linux',
    architecture: 'x64',
    discoverRemote: async () => {
      assert.fail(
        'the second Linux checkout must reuse the retained local CAS',
      );
    },
  });
  assert.equal(second.status, 'materialized');
  assert.equal(second.objectRoot, first.objectRoot);
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.counts.reasons['remote-hit'], 1);
  assert.equal(summary.counts.reasons['local-cas-hit'], 1);
});

test('Windows x86_64 consumer materializes a protected bundle and reuses local CAS in a second checkout', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-windows-consumer-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot, candidate } = await promotedConsumerFixture(
    temporary,
    'windows-x86_64-cp313',
  );
  const cacheRoot = path.join(temporary, 'cache');
  const first = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'checkout-one'),
    cacheRoot,
    now: CONSUMER_NOW,
    checkout: consumerCheckout(),
    platform: 'win32',
    architecture: 'x64',
    discoverRemote: async (_checkout, _temporary, options) => {
      assert.equal(options.platformRowId, 'windows-x86_64-cp313');
      return {
        bundleRoot,
        transport: {
          provider: 'github-workflow-artifact',
          artifactId: 44,
          artifactName: `qualified-assignment-core-${QUEUE_HEAD}-windows-x86_64-cp313`,
          runId: 45,
          workflowPath: '.github/workflows/affected-native-cache-promote.yml',
          event: 'push',
          protectedRef: 'refs/heads/dev/v4/v4.0',
          headSha: QUEUE_HEAD,
          platformRow: 'windows-x86_64-cp313',
        },
      };
    },
  });
  assert.equal(first.status, 'materialized');
  assert.deepEqual(
    candidate.payload.entries.map(({ path: entryPath }) => entryPath),
    ['kungfubuildinfo.json', 'libnode.dll', 'pykungfu.cp313-win_amd64.pyd'],
  );

  const second = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'checkout-two'),
    cacheRoot,
    now: '2026-07-29T06:00:01Z',
    checkout: consumerCheckout(),
    platform: 'win32',
    architecture: 'x64',
    discoverRemote: async () => {
      assert.fail(
        'the second Windows checkout must reuse the retained local CAS',
      );
    },
  });
  assert.equal(second.status, 'materialized');
  assert.equal(second.objectRoot, first.objectRoot);
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.counts.reasons['remote-hit'], 1);
  assert.equal(summary.counts.reasons['local-cas-hit'], 1);
});

test('compatibility identity is stable for three non-native commits and rejects native input drift', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-compatibility-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repositoryRoot = compatibilityCheckoutFixture(temporary);
  const { candidate } = sealFixture(path.join(temporary, 'producer'));
  const baseline = qualifiedCoreCheckoutRoots(repositoryRoot, candidate);
  assert.equal(baseline.compatibilityRoot, candidate.build.compatibilityRoot);

  const nonNativeRoots = [];
  for (let index = 1; index <= 3; index += 1) {
    const relative = `docs/compatibility-non-native-${index}.md`;
    fs.mkdirSync(path.join(repositoryRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, relative), `commit ${index}\n`);
    for (const args of [
      ['add', relative],
      [
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        `docs: protected non-native fixture ${index}`,
      ],
    ]) {
      const result = spawnSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    }
    nonNativeRoots.push(
      qualifiedCoreCheckoutRoots(repositoryRoot, candidate).compatibilityRoot,
    );
  }
  assert.deepEqual(nonNativeRoots, [
    baseline.compatibilityRoot,
    baseline.compatibilityRoot,
    baseline.compatibilityRoot,
  ]);

  const changedRoots = [];
  for (const [relative, bytes] of [
    ['framework/core/CMakeLists.txt', '\n# native closure drift\n'],
    ['pnpm-lock.yaml', '\n# dependency lock drift\n'],
    ['docs/shifu/artifact-contract.json', '\n'],
  ]) {
    fs.appendFileSync(path.join(repositoryRoot, relative), bytes);
    changedRoots.push(
      qualifiedCoreCheckoutRoots(repositoryRoot, candidate).compatibilityRoot,
    );
  }
  const compiler = structuredClone(candidate);
  compiler.build.toolchain.compiler = 'different compiler';
  const abi = structuredClone(candidate);
  abi.build.pythonAbi = 'cp314';
  const profile = structuredClone(candidate);
  profile.build.profile = 'debug';
  const payload = structuredClone(candidate);
  payload.payload.artifactRoot = digest({ payload: 'different bytes' });
  for (const variant of [compiler, abi, profile, payload]) {
    changedRoots.push(
      qualifiedCoreCheckoutRoots(repositoryRoot, variant).compatibilityRoot,
    );
  }
  assert.equal(changedRoots.length, 7);
  assert.equal(
    changedRoots.every((root) => root !== baseline.compatibilityRoot),
    true,
  );
});

test('one compatibility object yields exact receipts for three consuming commits', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-three-commit-reuse-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot, candidate } = await promotedConsumerFixture(temporary);
  const cacheRoot = path.join(temporary, 'cache');
  const commits = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const receipts = [];
  for (const [index, commit] of commits.entries()) {
    const result =
      index === 0
        ? await materializeQualifiedCoreBundle({
            bundleRoot,
            repositoryRoot: ROOT,
            publicationRoot: path.join(temporary, `checkout-${index}`),
            checkout: consumerCheckout({ commit }),
            cacheRoot,
            now: new Date(
              Date.parse(CONSUMER_NOW) + index * 1000,
            ).toISOString(),
            transport: {
              provider: 'protected-replay-fixture',
              protectedRef: 'refs/heads/dev/v4/v4.0',
            },
          })
        : await consumeQualifiedCoreForCheckout({
            repositoryRoot: ROOT,
            publicationRoot: path.join(temporary, `checkout-${index}`),
            checkout: consumerCheckout({ commit }),
            cacheRoot,
            now: new Date(
              Date.parse(CONSUMER_NOW) + index * 1000,
            ).toISOString(),
            platform: 'darwin',
            architecture: 'arm64',
            discoverRemote: async () => {
              throw new Error('compatible local object should win');
            },
          });
    receipts.push(result.receipt);
  }
  assert.deepEqual(
    receipts.map((receipt) => receipt.commit),
    commits,
  );
  assert.deepEqual(
    [...new Set(receipts.map((receipt) => receipt.producerCommit))],
    [candidate.source.commit],
  );
  assert.equal(
    new Set(receipts.map((receipt) => receipt.compatibilityRoot)).size,
    1,
  );
});

test('protected workflow can republish one independently verified compatible bundle', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-republish-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot, candidate } = await promotedConsumerFixture(temporary);
  const outputRoot = path.join(temporary, 'reused');
  const repositoryRoot = compatibilityCheckoutFixture(
    path.join(temporary, 'consumer'),
  );
  const currentCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).stdout.trim();
  const result = await reuseQualifiedCoreBundle({
    bundleRoot,
    outputRoot,
    repositoryRoot,
    repository: 'kungfu-systems/kungfu',
    currentCommit,
    now: CONSUMER_NOW,
  });
  assert.equal(result.currentCommit, currentCommit);
  assert.equal(result.candidate.source.commit, candidate.source.commit);
  assert.equal(
    result.verification.compatibilityIdentity,
    candidate.build.compatibilityRoot,
  );
  assert.deepEqual(
    fs.readdirSync(outputRoot).sort(),
    fs.readdirSync(bundleRoot).sort(),
  );
});

test('usage ledger publishes immutable concurrent observations and reports malformed residue', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-usage-ledger-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cacheRoot = path.join(temporary, 'cache');
  const observation = usageObservation();
  const input = path.join(temporary, 'observation.json');
  fs.writeFileSync(input, `${JSON.stringify(observation)}\n`);
  const moduleUrl = pathToFileURL(
    path.join(
      ROOT,
      'framework/work/assignment-capture/qualified-assignment-core-observability.mjs',
    ),
  ).href;
  const worker = [
    `import fs from 'node:fs';`,
    `import { appendQualifiedCoreUsage } from ${JSON.stringify(moduleUrl)};`,
    `appendQualifiedCoreUsage(process.argv[1], JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));`,
  ].join('');
  await Promise.all(
    Array.from({ length: 8 }, () => {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', worker, cacheRoot, input],
          { stdio: 'ignore' },
        );
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`usage writer exited ${code}`));
        });
      });
    }),
  );
  fs.mkdirSync(path.join(cacheRoot, 'observations/staging'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(cacheRoot, 'observations/staging/interrupted.json'),
    '{"partial":',
  );
  const first = summarizeQualifiedCoreUsage(cacheRoot, {
    repository: 'kungfu-systems/kungfu',
    sourceCommit: QUEUE_HEAD,
  });
  assert.equal(first.ok, true);
  assert.equal(first.totals.observations, 1);
  assert.equal(first.totals.invalidRecords, 0);
  assert.equal(first.totals.scanTruncated, false);
  assert.equal(first.authority, 'optimization-evidence-only');

  const artifactCache = path.join(cacheRoot, 'objects/sha256/aa/object');
  const retiredWorktree = path.join(temporary, 'retired-worktree');
  fs.mkdirSync(artifactCache, { recursive: true });
  fs.mkdirSync(retiredWorktree);
  fs.rmSync(path.join(cacheRoot, 'objects'), { recursive: true });
  fs.rmSync(retiredWorktree, { recursive: true });
  const retainedAfterEviction = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(retainedAfterEviction.ok, true);
  assert.equal(retainedAfterEviction.totals.observations, 1);

  const malformedDirectory = path.join(cacheRoot, 'observations/sha256/aa');
  fs.mkdirSync(malformedDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(malformedDirectory, `${'a'.repeat(64)}.json`),
    '{"schema":',
  );
  const degraded = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(degraded.ok, false);
  assert.equal(degraded.totals.observations, 1);
  assert.equal(degraded.totals.invalidRecords, 1);
  assert.equal(JSON.stringify(degraded).includes('interrupted.json'), false);
});

test('usage ledger rejects unbounded identities and retains only selected non-secret facts', () => {
  const observation = usageObservation();
  const encoded = JSON.stringify(observation);
  assert.equal(encoded.includes('token='), false);
  assert.equal(encoded.includes('https://'), false);
  assert.throws(
    () =>
      qualifiedCoreUsageObservation({
        ...observation,
        repository: '/Users/example/private/repository',
      }),
    /bounded identity/u,
  );
});

test('usage status refuses an observation-root symlink instead of scanning outside the cache', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-usage-symlink-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cacheRoot = path.join(temporary, 'cache');
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(path.join(cacheRoot, 'observations'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, `${'a'.repeat(64)}.json`),
    'private provider response token=must-not-be-read',
  );
  fs.symlinkSync(outside, path.join(cacheRoot, 'observations', 'sha256'));
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.ok, false);
  assert.equal(summary.totals.observations, 0);
  assert.equal(summary.totals.invalidRecords, 1);
  assert.equal(JSON.stringify(summary).includes('must-not-be-read'), false);
});

test('usage status reads only the bounded cache root and reports current checkout eligibility', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-usage-status-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporary, 'checkout');
  const cacheRoot = path.join(temporary, 'cache');
  fs.mkdirSync(repositoryRoot);
  for (const args of [
    ['init', '-b', 'dev'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'fixture\n');
  for (const args of [
    ['add', 'README.md'],
    ['commit', '-m', 'fixture'],
    ['remote', 'add', 'origin', 'git@github.com:kungfu-systems/kungfu.git'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  appendQualifiedCoreUsage(cacheRoot, usageObservation());
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        import.meta.resolve(
          '@kungfu-tech/work/assignment-capture/qualified-assignment-core-consumer',
        ),
      ),
      'status',
      '--repository-root',
      repositoryRoot,
      '--cache-root',
      cacheRoot,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(
    summary.schema,
    'shifu.qualified-assignment-core-usage-summary/v1',
  );
  assert.equal(summary.currentCheckout.repository, 'kungfu-systems/kungfu');
  assert.equal(
    summary.currentCheckout.eligible,
    (process.platform === 'darwin' && process.arch === 'arm64') ||
      (process.platform === 'linux' && process.arch === 'x64'),
  );
  assert.equal(summary.totals.observations, 1);
});

test('consumer reuses across commit provenance but rejects tamper, expiry, and dirty target', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-consumer-reject-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const tampered = path.join(temporary, 'tampered');
  fs.cpSync(bundleRoot, tampered, { recursive: true });
  fs.writeFileSync(
    path.join(tampered, 'payload', 'pykungfu.cpython-313-darwin.so'),
    'tampered',
  );
  const tamperedPublication = path.join(temporary, 'tampered-checkout');
  await assert.rejects(
    materializeQualifiedCoreBundle({
      bundleRoot: tampered,
      repositoryRoot: ROOT,
      publicationRoot: tamperedPublication,
      checkout: consumerCheckout(),
      cacheRoot: path.join(temporary, 'tampered-cache'),
      now: CONSUMER_NOW,
    }),
    /payload drift|digest drift/u,
  );
  assert.equal(
    fs.existsSync(path.join(tamperedPublication, 'framework/core/dist/kungfu')),
    false,
  );
  const reusedCommit = 'f'.repeat(40);
  const compatible = await materializeQualifiedCoreBundle({
    bundleRoot,
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'identity-checkout'),
    checkout: consumerCheckout({ commit: reusedCommit }),
    cacheRoot: path.join(temporary, 'identity-cache'),
    now: CONSUMER_NOW,
  });
  assert.equal(compatible.status, 'materialized');
  assert.equal(compatible.receipt.commit, reusedCommit);
  assert.equal(compatible.receipt.producerCommit, QUEUE_HEAD);
  assert.match(compatible.receipt.compatibilityRoot, /^sha256:/u);
  await assert.rejects(
    materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, 'expired-checkout'),
      checkout: consumerCheckout(),
      cacheRoot: path.join(temporary, 'expired-cache'),
      now: '2026-08-01T00:00:00Z',
    }),
    /stale|active/u,
  );
  const dirtyPublication = path.join(temporary, 'dirty-checkout');
  const dirtyTarget = path.join(dirtyPublication, 'framework/core/dist/kungfu');
  fs.mkdirSync(dirtyTarget, { recursive: true });
  fs.writeFileSync(path.join(dirtyTarget, 'user-build'), 'keep');
  await assert.rejects(
    materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: dirtyPublication,
      checkout: consumerCheckout(),
      cacheRoot: path.join(temporary, 'dirty-cache'),
      now: CONSUMER_NOW,
    }),
    /target-dirty/u,
  );
  assert.equal(
    fs.readFileSync(path.join(dirtyTarget, 'user-build'), 'utf8'),
    'keep',
  );
});

test('consumer CLI emits one source-build diagnosis and durable fallback observation', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-cli-fallback-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cacheRoot = path.join(temporary, 'cache');
  const repositoryRoot = path.join(temporary, 'checkout');
  fs.mkdirSync(repositoryRoot);
  for (const args of [
    ['init', '-b', 'dev'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ]) {
    const setup = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(setup.status, 0, setup.stderr);
  }
  fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'fixture\n');
  for (const args of [
    ['add', 'README.md'],
    ['commit', '-m', 'fixture'],
    ['remote', 'add', 'origin', 'git@github.com:kungfu-systems/kungfu.git'],
  ]) {
    const setup = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(setup.status, 0, setup.stderr);
  }
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        import.meta.resolve(
          '@kungfu-tech/work/assignment-capture/qualified-assignment-core-consumer',
        ),
      ),
      'materialize',
      '--repository-root',
      repositoryRoot,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        KUNGFU_QUALIFIED_CORE_CACHE_ROOT: cacheRoot,
        KUNGFU_QUALIFIED_CORE_GITHUB: '0',
      },
    },
  );
  assert.equal(result.status, 127);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, 'qualified-core-reuse-unavailable');
  assert.equal(output.next_actions[0].command, './shifu build:core');
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.ok, true);
  assert.equal(summary.totals.observations, 1);
  assert.equal(summary.counts.results['fallback-required'], 1);
  const expectedReason =
    (process.platform === 'darwin' && process.arch === 'arm64') ||
    (process.platform === 'linux' && process.arch === 'x64')
      ? 'qualified-core-cache-miss'
      : 'unsupported-host';
  assert.equal(summary.counts.reasons[expectedReason], 1);
});

test('consumer streams GitHub artifacts through bounded retries and removes partials', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-github-download-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'artifact.zip');
  let observedAttempts = 0;
  await downloadGithubArtifact({
    repository: 'kungfu-systems/kungfu',
    artifactId: 42,
    destination,
    runAttempt: async (_command, _args, partial, options) => {
      observedAttempts += 1;
      assert.equal(options.maxBytes, 512 * 1024 * 1024 + 1024);
      fs.writeFileSync(
        partial,
        observedAttempts < 3 ? 'incomplete' : 'complete',
        { flag: 'wx' },
      );
      if (observedAttempts < 3) throw new Error('bounded transport failure');
    },
  });
  assert.equal(observedAttempts, 3);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'complete');
  assert.deepEqual(
    fs.readdirSync(temporary).filter((name) => name.includes('.attempt-')),
    [],
  );
});

test('consumer leaves no GitHub artifact bytes after retry exhaustion', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-github-failure-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'artifact.zip');
  let observedAttempts = 0;
  await assert.rejects(
    downloadGithubArtifact({
      repository: 'kungfu-systems/kungfu',
      artifactId: 42,
      destination,
      runAttempt: async (_command, _args, partial) => {
        observedAttempts += 1;
        fs.writeFileSync(partial, 'incomplete', { flag: 'wx' });
        throw new Error('bounded transport failure');
      },
    }),
    /github-artifact-download-failed/u,
  );
  assert.equal(observedAttempts, 3);
  assert.deepEqual(fs.readdirSync(temporary), []);
});

test('consumer resumes only an identity-bound HTTP artifact partial', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-http-resume-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'artifact.zip');
  const expected = Buffer.from('identity-bound-complete-archive');
  const initial = expected.subarray(0, 11);
  fs.writeFileSync(`${destination}.partial`, initial);
  let range = null;
  await downloadHttpArtifact({
    url: 'http://cache.example.invalid/qualified-core/42.zip',
    destination,
    expectedBytes: expected.byteLength,
    attempts: 1,
    fetchImpl: async (_url, options) => {
      range = options.headers.Range;
      return new Response(expected.subarray(initial.byteLength), {
        status: 206,
        headers: {
          'content-range': `bytes ${initial.byteLength}-${expected.byteLength - 1}/${expected.byteLength}`,
        },
      });
    },
  });
  assert.equal(range, `bytes=${initial.byteLength}-`);
  assert.deepEqual(fs.readFileSync(destination), expected);
  assert.equal(fs.existsSync(`${destination}.partial`), false);
});

test('consumer retains interrupted HTTP bytes for verified resume without runnable output', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-http-interruption-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'artifact.zip');
  const expected = Buffer.from('resume-after-interruption');
  await assert.rejects(
    downloadHttpArtifact({
      url: 'http://cache.example.invalid/qualified-core/42.zip',
      destination,
      expectedBytes: expected.byteLength,
      attempts: 1,
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers(),
        body: {
          async *[Symbol.asyncIterator]() {
            yield expected.subarray(0, 7);
            throw new Error('simulated interruption');
          },
        },
      }),
    }),
    /http-artifact-download-failed/u,
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(
    fs.readFileSync(`${destination}.partial`),
    expected.subarray(0, 7),
  );
  await downloadHttpArtifact({
    url: 'http://cache.example.invalid/qualified-core/42.zip',
    destination,
    expectedBytes: expected.byteLength,
    attempts: 1,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=7-');
      return new Response(expected.subarray(7), {
        status: 206,
        headers: {
          'content-range': `bytes 7-${expected.byteLength - 1}/${expected.byteLength}`,
        },
      });
    },
  });
  assert.deepEqual(fs.readFileSync(destination), expected);
});

test('consumer treats office HTTP as replaceable transport after GitHub authority discovery', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-office-provider-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const archive = path.join(temporary, 'source.zip');
  const zip = spawnSync(
    'python3',
    [
      '-c',
      [
        'import os, sys, zipfile',
        'source, target = sys.argv[1:]',
        "with zipfile.ZipFile(target, 'w', zipfile.ZIP_STORED) as archive:",
        '  for root, _, files in os.walk(source):',
        '    for name in sorted(files):',
        '      path = os.path.join(root, name)',
        '      archive.write(path, os.path.relpath(path, source))',
      ].join('\n'),
      bundleRoot,
      archive,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(zip.status, 0, zip.stderr);
  const artifactBytes = fs.readFileSync(archive);
  const checkout = consumerCheckout();
  const runId = 43;
  const artifactId = 42;
  const extractionRoot = path.join(temporary, 'extract');
  fs.mkdirSync(extractionRoot);
  const discovered = await discoverGithubBundle(checkout, extractionRoot, {
    cacheRoot: path.join(temporary, 'cache'),
    httpBaseUrl: 'http://cache.example.invalid/',
    githubJson: (endpoint) => {
      if (endpoint.includes('actions/artifacts?')) {
        return {
          artifacts: [
            {
              id: artifactId,
              name: `qualified-assignment-core-${checkout.commit}-darwin-arm64-cp313`,
              expired: false,
              size_in_bytes: artifactBytes.byteLength,
              workflow_run: { id: runId },
            },
          ],
        };
      }
      if (endpoint.endsWith(`actions/runs/${runId}`)) {
        return {
          id: runId,
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          head_sha: checkout.commit,
          path: '.github/workflows/affected-native-cache-promote.yml',
          head_branch: 'dev/v4/v4.0',
        };
      }
      return { default_branch: 'dev/v4/v4.0' };
    },
    downloadHttp: async ({ url, destination }) => {
      assert.equal(
        url,
        `http://cache.example.invalid/qualified-core/${artifactId}.zip`,
      );
      fs.copyFileSync(archive, destination);
    },
    downloadGithub: async () => {
      assert.fail('GitHub byte transport must not run on an office hit');
    },
  });
  assert.equal(discovered.transport.provider, 'office-http-artifact');
  assert.equal(discovered.transport.artifactId, artifactId);
  assert.equal(
    discovered.transport.workflowPath,
    '.github/workflows/affected-native-cache-promote.yml',
  );
  assert.deepEqual(Object.keys(discovered.phaseDurations).sort(), [
    'discovery',
    'transfer',
  ]);
  assert.equal(
    fs.existsSync(path.join(discovered.bundleRoot, 'manifest.json')),
    true,
  );
});

test('consumer removes completed transport state when archive extraction rejects it', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-archive-rejection-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const checkout = consumerCheckout();
  const cacheRoot = path.join(temporary, 'cache');
  const artifactId = 42;
  await assert.rejects(
    discoverGithubBundle(checkout, path.join(temporary, 'extract'), {
      cacheRoot,
      httpBaseUrl: '',
      githubJson: (endpoint) => {
        if (endpoint.includes('actions/artifacts?')) {
          return {
            artifacts: [
              {
                id: artifactId,
                name: `qualified-assignment-core-${checkout.commit}-darwin-arm64-cp313`,
                expired: false,
                size_in_bytes: 7,
                workflow_run: { id: 43 },
              },
            ],
          };
        }
        if (endpoint.endsWith('actions/runs/43')) {
          return {
            id: 43,
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            head_sha: checkout.commit,
            path: '.github/workflows/affected-native-cache-promote.yml',
            head_branch: 'dev/v4/v4.0',
          };
        }
        return { default_branch: 'dev/v4/v4.0' };
      },
      downloadGithub: async ({ destination }) => {
        fs.writeFileSync(destination, 'not-zip');
      },
    }),
    /invalid-zip-directory/u,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        cacheRoot,
        'transfers',
        ...checkout.repository.split('/'),
        String(artifactId),
      ),
    ),
    false,
  );
});

test('consumer keeps an extracted archive alive through async retention', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-archive-lifetime-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const archive = path.join(temporary, 'qualified-core.zip');
  const zip = spawnSync(
    'python3',
    [
      '-c',
      [
        'import os, sys, zipfile',
        'source, target = sys.argv[1:]',
        "with zipfile.ZipFile(target, 'w', zipfile.ZIP_STORED) as archive:",
        '  for root, _, files in os.walk(source):',
        '    for name in sorted(files):',
        '      path = os.path.join(root, name)',
        '      archive.write(path, os.path.relpath(path, source))',
      ].join('\n'),
      bundleRoot,
      archive,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(zip.status, 0, zip.stderr);
  const previousBundle = process.env.KUNGFU_QUALIFIED_CORE_BUNDLE;
  process.env.KUNGFU_QUALIFIED_CORE_BUNDLE = archive;
  const cacheRoot = path.join(temporary, 'cache');
  try {
    const result = await consumeQualifiedCoreForCheckout({
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, 'checkout'),
      cacheRoot,
      now: CONSUMER_NOW,
      checkout: consumerCheckout(),
      platform: 'darwin',
      architecture: 'arm64',
    });
    assert.equal(result.status, 'materialized');
    const local = await consumeQualifiedCoreForCheckout({
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, 'second-checkout'),
      cacheRoot,
      now: '2026-07-29T06:00:01Z',
      checkout: consumerCheckout(),
      platform: 'darwin',
      architecture: 'arm64',
    });
    assert.equal(local.status, 'materialized');
    const summary = summarizeQualifiedCoreUsage(cacheRoot);
    assert.equal(summary.ok, true);
    assert.equal(summary.totals.observations, 2);
    assert.equal(summary.counts.reasons['explicit-bundle-hit'], 1);
    assert.equal(summary.counts.reasons['local-cas-hit'], 1);
  } finally {
    if (previousBundle === undefined) {
      Reflect.deleteProperty(process.env, 'KUNGFU_QUALIFIED_CORE_BUNDLE');
    } else {
      process.env.KUNGFU_QUALIFIED_CORE_BUNDLE = previousBundle;
    }
  }
});

test('consumer records a trusted remote hit with bounded artifact identity', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-remote-hit-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const cacheRoot = path.join(temporary, 'cache');
  const result = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'checkout'),
    cacheRoot,
    now: CONSUMER_NOW,
    checkout: consumerCheckout(),
    platform: 'darwin',
    architecture: 'arm64',
    discoverRemote: async () => ({
      bundleRoot,
      transport: {
        provider: 'github-workflow-artifact',
        artifactId: 42,
        artifactName: `qualified-assignment-core-${QUEUE_HEAD}-darwin-arm64-cp313`,
        runId: 43,
        workflowPath: '.github/workflows/affected-native-cache-promote.yml',
        event: 'push',
        protectedRef: 'refs/heads/dev/v4/v4.0',
        headSha: QUEUE_HEAD,
      },
    }),
  });
  assert.equal(result.status, 'materialized');
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.counts.reasons['remote-hit'], 1);
  assert.equal(summary.recent[0].artifactRoot.startsWith('sha256:'), true);
  const observationPath = path.join(
    cacheRoot,
    'observations',
    'sha256',
    summary.recent[0].observationRoot.slice(7, 9),
    `${summary.recent[0].observationRoot.slice(7)}.json`,
  );
  const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
  assert.equal(observation.artifact.artifactId, 42);
  assert.equal(
    observation.artifact.transportProvider,
    'github-workflow-artifact',
  );
});

test('consumer records verification rejection without retaining provider bytes', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-verification-rejection-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const tampered = path.join(temporary, 'tampered');
  fs.cpSync(bundleRoot, tampered, { recursive: true });
  fs.writeFileSync(
    path.join(tampered, 'payload', 'pykungfu.cpython-313-darwin.so'),
    'private provider response token=must-not-survive',
  );
  const cacheRoot = path.join(temporary, 'cache');
  const previousBundle = process.env.KUNGFU_QUALIFIED_CORE_BUNDLE;
  process.env.KUNGFU_QUALIFIED_CORE_BUNDLE = tampered;
  try {
    await assert.rejects(
      consumeQualifiedCoreForCheckout({
        repositoryRoot: ROOT,
        publicationRoot: path.join(temporary, 'checkout'),
        cacheRoot,
        now: CONSUMER_NOW,
        checkout: consumerCheckout(),
        platform: 'darwin',
        architecture: 'arm64',
      }),
      /payload drift|digest drift/u,
    );
  } finally {
    if (previousBundle === undefined) {
      Reflect.deleteProperty(process.env, 'KUNGFU_QUALIFIED_CORE_BUNDLE');
    } else {
      process.env.KUNGFU_QUALIFIED_CORE_BUNDLE = previousBundle;
    }
  }
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.counts.results.rejected, 1);
  assert.equal(summary.counts.reasons['verification-failed'], 1);
  const observationRoot = summary.recent[0].observationRoot.slice(7);
  const ledgerBytes = fs.readFileSync(
    path.join(
      cacheRoot,
      'observations',
      'sha256',
      observationRoot.slice(0, 2),
      `${observationRoot}.json`,
    ),
    'utf8',
  );
  assert.equal(ledgerBytes.includes('must-not-survive'), false);
});

test('consumer retains unsupported-platform outcomes without claiming support', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-unsupported-host-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cacheRoot = path.join(temporary, 'cache');
  const unsupportedHosts = [
    { platform: 'darwin', architecture: 'x64' },
    { platform: 'linux', architecture: 'arm64' },
  ];
  for (const [index, host] of unsupportedHosts.entries()) {
    await assert.rejects(
      consumeQualifiedCoreForCheckout({
        repositoryRoot: ROOT,
        publicationRoot: path.join(temporary, `checkout-${index}`),
        cacheRoot,
        now: new Date(Date.parse(CONSUMER_NOW) + index * 1000).toISOString(),
        checkout: consumerCheckout(),
        ...host,
      }),
      /unsupported-host/u,
    );
  }
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  assert.equal(summary.totals.observations, unsupportedHosts.length);
  assert.equal(
    summary.counts.results['fallback-required'],
    unsupportedHosts.length,
  );
  assert.equal(
    summary.counts.reasons['unsupported-host'],
    unsupportedHosts.length,
  );
});

test('consumer deduplicates transport variants of one content authority', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-consumer-ambiguous-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { bundleRoot } = await promotedConsumerFixture(temporary);
  const cacheRoot = path.join(temporary, 'cache');
  for (const provider of ['fixture-a', 'fixture-b']) {
    await materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, provider),
      checkout: consumerCheckout(),
      cacheRoot,
      now: CONSUMER_NOW,
      transport: { provider },
    });
  }
  const result = await consumeQualifiedCoreForCheckout({
    repositoryRoot: ROOT,
    publicationRoot: path.join(temporary, 'consumer-checkout'),
    cacheRoot,
    now: CONSUMER_NOW,
    checkout: consumerCheckout(),
    platform: 'darwin',
    architecture: 'arm64',
  });
  assert.equal(result.status, 'materialized');
});

test('consumer rejects two distinct qualified authorities for one compatibility root', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qualified-core-authority-ambiguous-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { candidateRoot } = sealFixture(temporary);
  const cacheRoot = path.join(temporary, 'cache');
  for (const index of [1, 2]) {
    const bundleRoot = path.join(temporary, `authority-${index}`);
    await promoteQualifiedCoreCandidate({
      candidateRoot,
      outputRoot: bundleRoot,
      repository: 'kungfu-systems/kungfu',
      targetCommit: QUEUE_HEAD,
      targetTree: TREE,
      protectedRef: 'refs/heads/dev/v4/v4.0',
      deliveryEvidenceRoot: digest({ authority: index }),
      validFrom: '2026-07-29T05:00:00Z',
      validThrough: '2026-07-30T05:00:00Z',
      now: CONSUMER_NOW,
      allowLocal: true,
      root: ROOT,
    });
    await materializeQualifiedCoreBundle({
      bundleRoot,
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, `publication-${index}`),
      checkout: consumerCheckout(),
      cacheRoot,
      now: CONSUMER_NOW,
      transport: { provider: `authority-${index}` },
    });
  }
  await assert.rejects(
    consumeQualifiedCoreForCheckout({
      repositoryRoot: ROOT,
      publicationRoot: path.join(temporary, 'consumer-checkout'),
      cacheRoot,
      now: CONSUMER_NOW,
      checkout: consumerCheckout(),
      platform: 'darwin',
      architecture: 'arm64',
    }),
    /ambiguous-local-authority/u,
  );
});

test('workflows keep candidate and promotion outside untrusted PR authority', () => {
  const shifu = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  assert.match(
    shifu,
    /build \| rebuild \| cache \| docs \| gate \| qualified-core \| proxy \| config/u,
  );
  const shifuL2 = fs.readFileSync(path.join(ROOT, 'shifu.mjs'), 'utf8');
  assert.match(
    shifuL2,
    /cmd === 'qualified-core'[\s\S]*runQualifiedCoreUsageStatusCommand/u,
  );
  const mergeGroupWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.doesNotMatch(mergeGroupWorkflow, /^ {2}qualified_core_candidate:/mu);
  assert.doesNotMatch(mergeGroupWorkflow, /^ {2}production_graph_parity:/mu);
  assert.match(
    mergeGroupWorkflow,
    /affected_native:[\s\S]*name: affected-native \/ linux/u,
  );

  const advisoryWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-post-merge-advisory.yml'),
    'utf8',
  );
  assert.match(
    advisoryWorkflow,
    /name: Dev post-merge advisory[\s\S]*push:[\s\S]*dev\/v\*\/v\*[\s\S]*workflow_dispatch:[\s\S]*dev-post-merge-advisory-\$\{\{ github\.ref \}\}[\s\S]*cancel-in-progress: false/u,
  );
  assert.doesNotMatch(advisoryWorkflow, /^\s{2}(pull_request|merge_group):/mu);
  assert.match(
    advisoryWorkflow,
    /REF_PROTECTED: \$\{\{ github\.ref_protected \}\}[\s\S]*REF_PROTECTED" != true[\s\S]*affected-native-pr\.yml\/runs[\s\S]*-f event=merge_group[\s\S]*gh api --method GET[\s\S]*actions\/runs\/\$\{run_id\}\/jobs[\s\S]*affected-native \/ linux[\s\S]*dev-candidate-plan-\$\{TARGET_SHA\}/u,
  );
  assert.match(
    advisoryWorkflow,
    /production_graph_parity:[\s\S]*Production Graph parity advisory \/ linux[\s\S]*qualified_core_candidate:[\s\S]*native-required == 'true'[\s\S]*fail-fast: false[\s\S]*darwin-arm64-cp313[\s\S]*runner: macos-15[\s\S]*linux-x86_64-cp313[\s\S]*runner: ubuntu-24\.04[\s\S]*cc: gcc-14[\s\S]*cxx: g\+\+-14[\s\S]*windows-x86_64-cp313[\s\S]*runner: windows-2022[\s\S]*runs-on: \$\{\{ matrix\.runner \}\}/u,
  );
  assert.match(
    advisoryWorkflow,
    /KUNGFU_BUILDCHAIN_SOURCE_BUILD: "1"[\s\S]*Build and seal minimum relocatable Assignment Core candidate[\s\S]*uses: \.\/\.github\/actions\/qualified-core-candidate-build[\s\S]*producer-event: push[\s\S]*producer-workflow-path: \.github\/workflows\/dev-post-merge-advisory\.yml[\s\S]*qualified-assignment-core-candidate-\$\{\{ needs\.prepare\.outputs\.target-sha \}\}-\$\{\{ matrix\.row \}\}/u,
  );
  const candidateAction = fs.readFileSync(
    path.join(
      ROOT,
      '.github/actions/qualified-core-candidate-build/action.yml',
    ),
    'utf8',
  );
  assert.match(
    candidateAction,
    /native-already-built:[\s\S]*default: "false"[\s\S]*producer-event:[\s\S]*default: merge_group[\s\S]*producer-workflow-path:[\s\S]*default: \.github\/workflows\/affected-native-pr\.yml[\s\S]*runner\.os != 'Windows'[\s\S]*inputs\.native-already-built[\s\S]*--event "\$\{\{ inputs\.producer-event \}\}"[\s\S]*--workflow-path "\$\{\{ inputs\.producer-workflow-path \}\}"[\s\S]*runner\.os == 'Windows'[\s\S]*inputs\.native-already-built[\s\S]*--event "\$\{\{ inputs\.producer-event \}\}"[\s\S]*--workflow-path "\$\{\{ inputs\.producer-workflow-path \}\}"/u,
  );

  const promotionWorkflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-cache-promote.yml'),
    'utf8',
  );
  assert.match(promotionWorkflow, /^\s{2}push\s*:/mu);
  assert.match(
    promotionWorkflow,
    /promote:[\s\S]*affected-native-pr\.yml\/runs[\s\S]*-f event=merge_group[\s\S]*-f head_sha="\$TARGET_SHA"[\s\S]*affected-native \/ linux/u,
  );
  assert.match(
    promotionWorkflow,
    /github\.ref_protected == true[\s\S]*dev-post-merge-advisory\.yml\/runs[\s\S]*-f event=push[\s\S]*-f head_sha="\$TARGET_SHA"[\s\S]*Multiple Qualified Core producer authorities/u,
  );
  assert.match(
    promotionWorkflow,
    /@kungfu-tech\/product-kungfu\/release\/qualified-assignment-core-artifact promote[\s\S]*--target-commit "\$TARGET_SHA"[\s\S]*--protected-ref "\$GITHUB_REF"[\s\S]*--merge-group-run-id "\$\{\{ steps\.producer\.outputs\.run-id \}\}"[\s\S]*--producer-run-id "\$\{\{ steps\.qualified_core_producer\.outputs\.run-id \}\}"[\s\S]*--producer-event push[\s\S]*--producer-workflow-path \.github\/workflows\/dev-post-merge-advisory\.yml[\s\S]*--delivery-attempt/u,
  );
  assert.match(
    promotionWorkflow,
    /No exact Qualified Core producer became available; source build remains authoritative/u,
  );
  assert.match(
    promotionWorkflow,
    /Install pinned Qualified Core verifier[\s\S]*Check out exact Qualified Core recovery target[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*git checkout --detach "\$TARGET_SHA"[\s\S]*test "\$\(git rev-parse HEAD\)" = "\$TARGET_SHA"[\s\S]*Promote or resolve the exact Qualified Core platform matrix/u,
  );
  assert.match(
    promotionWorkflow,
    /Promote or resolve the exact Qualified Core platform matrix[\s\S]*darwin-arm64-cp313[\s\S]*linux-x86_64-cp313[\s\S]*windows-x86_64-cp313[\s\S]*qualified-assignment-core-candidate-\$\{TARGET_SHA\}-\$\{row\}[\s\S]*@kungfu-tech\/product-kungfu\/release\/qualified-assignment-core-artifact reuse[\s\S]*Multiple distinct compatible Qualified Core authorities are active for \$\{row\}[\s\S]*status:"unqualified"[\s\S]*reason:"no-exact-or-compatible-authority"[\s\S]*uses: \.\/\.github\/actions\/upload-qualified-core-matrix/u,
  );
  assert.match(
    promotionWorkflow,
    /sed -n -e 's\/\^manifest-root=\/manifest:\/p' -e 's\/\^qualification-receipt-root=\/qualification:\/p' -e 's\/\^promotion-authority-root=\/promotion:\/p'/u,
  );
  assert.match(
    promotionWorkflow,
    /Qualify Linux x86_64 consumer remote and local-CAS paths[\s\S]*linux_x86_64_cp313_available[\s\S]*git worktree add --detach "\$first_checkout" "\$TARGET_SHA"[\s\S]*KUNGFU_QUALIFIED_CORE_BUNDLE="\$bundle"[\s\S]*pykungfu\.cpython-313-x86_64-linux-gnu\.so[\s\S]*ELF 64-bit[\s\S]*\.\/shifu work --help[\s\S]*KUNGFU_QUALIFIED_CORE_GITHUB=0[\s\S]*local-cas-hit/u,
  );
  assert.match(
    promotionWorkflow,
    /qualify_windows_x86_64_consumer:[\s\S]*needs: promote[\s\S]*windows_x86_64_available[\s\S]*runs-on: windows-2022[\s\S]*qualified-assignment-core-\$\{\{ needs\.promote\.outputs\.target_sha \}\}-windows-x86_64-cp313[\s\S]*git worktree add --detach \$firstCheckout \$env:TARGET_SHA[\s\S]*KUNGFU_QUALIFIED_CORE_BUNDLE[\s\S]*pykungfu\.cp313-win_amd64\.pyd[\s\S]*libnode\.dll[\s\S]*0x4d[\s\S]*0x5a[\s\S]*shifu\.cmd work --help[\s\S]*KUNGFU_QUALIFIED_CORE_GITHUB[\s\S]*local-cas-hit/u,
  );
  assert.doesNotMatch(
    promotionWorkflow,
    /Qualified Windows runtime closure is incomplete|nativeFiles\.Count -lt 3/u,
  );
  assert.match(
    promotionWorkflow,
    /run_status[\s\S]*candidate_state[\s\S]*candidate_state" = ambiguous[\s\S]*run_status" != completed[\s\S]*pending_run=true[\s\S]*candidate_state" = available[\s\S]*producers=.*run_id[\s\S]*Completed advisory run[\s\S]*every matrix row remains unqualified[\s\S]*observed_run[\s\S]*pending_run/u,
  );
  const matrixUpload = fs.readFileSync(
    path.join(ROOT, '.github/actions/upload-qualified-core-matrix/action.yml'),
    'utf8',
  );
  for (const row of REQUIRED_ROWS) {
    assert.match(
      matrixUpload,
      new RegExp(
        `qualified-assignment-core-\\$\\{\\{ inputs\\.target-sha \\}\\}-${row}`,
        'u',
      ),
    );
  }
  assert.match(
    matrixUpload,
    /qualified-assignment-core-matrix-\$\{\{ inputs\.target-sha \}\}[\s\S]*actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u,
  );
});
