#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateDeliveryAttempt } from '../../scripts/affected-native-proof.mjs';
import {
  qualifiedAssignmentCoreRoot,
  verifyQualifiedAssignmentCoreArtifact,
} from '../../scripts/check-shifu-cache-contract.mjs';
import { requireSha } from './affected-native-artifact-lookup.mjs';

export const QUALIFIED_CORE_CANDIDATE_SCHEMA =
  'kungfu.qualified-assignment-core-candidate/v1';
const ARTIFACT_SCHEMA = 'shifu.qualified-assignment-core-artifact/v1';
const QUALIFICATION_SCHEMA = 'shifu.qualified-assignment-core-qualification/v1';
const PROMOTION_SCHEMA =
  'kungfu.qualified-assignment-core-promotion-authority/v1';
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
const TARGET_ROOT = 'framework/core/dist/kungfu';
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LOCKS = [
  '.buildchain/contract-lock.json',
  'framework/core/conanfile.py',
  'framework/core/uv.lock',
  'pnpm-lock.yaml',
];
const SHIFU_CONTRACTS = [
  'shifu',
  'shifu.mjs',
  'docs/shifu/artifact-contract.json',
  'docs/shifu/cache-contract.json',
  'docs/shifu/schema/qualified-assignment-core-artifact-v1.schema.json',
  'docs/shifu/schema/qualified-assignment-core-qualification-v1.schema.json',
  'scripts/check-shifu-cache-contract.mjs',
  'framework/assignment-capture/qualified-assignment-core-consumer.mjs',
  'framework/assignment-capture/qualified-assignment-core-observability.mjs',
];
const BUILDCHAIN_CONTRACTS = [
  '.buildchain/buildchain.toml',
  '.buildchain/contract-lock.json',
];
const QUALIFICATION_FIELDS = [
  'buildchainContractRoot',
  'dependencyLockDigest',
  'planRoot',
  'shifuContractRoot',
  'sourceTreeRoot',
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function bytesRoot(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function requireRoot(value, label) {
  if (!SHA256_ROOT.test(value || '')) {
    throw new Error(`${label} must be an exact sha256 root`);
  }
  return value;
}

function requireRunId(value, label) {
  const runId = Number(value);
  if (!Number.isInteger(runId) || runId < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return runId;
}

function requireRepository(value, label) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value || '')) {
    throw new Error(`${label} must be an exact repository`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value || '')) {
    throw new Error(`${label} must be an exact bounded identifier`);
  }
  return value;
}

function requireRelativePath(value, label) {
  if (
    !value ||
    path.posix.normalize(value) !== value ||
    path.posix.isAbsolute(value) ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a bounded relative path`);
  }
  return value;
}

function fileSetRoot(repositoryRoot, relativePaths, schema) {
  const entries = relativePaths.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(repositoryRoot, relativePath));
    return {
      path: relativePath,
      sizeBytes: bytes.byteLength,
      digest: bytesRoot(bytes),
    };
  });
  return qualifiedAssignmentCoreRoot({ schema, entries });
}

export function qualifiedCoreCheckoutRoots(repositoryRoot, candidate) {
  const sourceTreeRoot = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.git-source-tree/v1',
    tree: candidate.source.tree,
  });
  const dependencyLockDigest = fileSetRoot(
    repositoryRoot,
    LOCKS,
    'kungfu.qualified-assignment-core-dependency-locks/v1',
  );
  const shifuContractRoot = fileSetRoot(
    repositoryRoot,
    SHIFU_CONTRACTS,
    'kungfu.qualified-assignment-core-shifu-contract/v1',
  );
  const buildchainContractRoot = fileSetRoot(
    repositoryRoot,
    BUILDCHAIN_CONTRACTS,
    'kungfu.qualified-assignment-core-buildchain-contract/v1',
  );
  const toolchainDigest = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.qualified-assignment-core-toolchain/v1',
    toolchain: candidate.build.toolchain,
  });
  const nativeInputRoot = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.qualified-assignment-core-native-input/v1',
    commit: candidate.source.commit,
    sourceTreeRoot,
    planDigest: candidate.qualification.planRoot,
    dependencyLockDigest,
    shifuContractRoot,
    buildchainContractRoot,
    profile: candidate.build.profile,
  });
  return {
    sourceTreeRoot,
    dependencyLockDigest,
    shifuContractRoot,
    buildchainContractRoot,
    toolchainDigest,
    nativeInputRoot,
  };
}

function payloadNames(payloadRoot) {
  const names = fs.readdirSync(payloadRoot).filter((name) => {
    return (
      name === 'kungfubuildinfo.json' ||
      name === 'libkungfu_runtime.dylib' ||
      /^libnode\.[0-9]+\.dylib$/u.test(name) ||
      /^pykungfu(?:[._-][A-Za-z0-9._-]+)?\.so$/u.test(name)
    );
  });
  names.sort();
  const pykungfu = names.filter((name) =>
    /^pykungfu(?:[._-][A-Za-z0-9._-]+)?\.so$/u.test(name),
  );
  const libnode = names.filter((name) =>
    /^libnode\.[0-9]+\.dylib$/u.test(name),
  );
  if (
    !names.includes('kungfubuildinfo.json') ||
    !names.includes('libkungfu_runtime.dylib') ||
    pykungfu.length !== 1 ||
    libnode.length !== 1 ||
    names.length !== 4
  ) {
    throw new Error(
      'qualified Core macOS runtime payload must contain build metadata, one pykungfu binding, one versioned libnode, and libkungfu_runtime',
    );
  }
  return names;
}

function payloadEntry(payloadRoot, name) {
  if (
    path.posix.normalize(name) !== name ||
    path.isAbsolute(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`qualified Core payload path is unsafe: ${name}`);
  }
  const source = path.join(payloadRoot, name);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(source);
    if (
      path.posix.isAbsolute(linkTarget) ||
      linkTarget.includes('/') ||
      linkTarget.includes('\\') ||
      linkTarget.includes('\0') ||
      linkTarget === '.' ||
      linkTarget === '..'
    ) {
      throw new Error(`qualified Core symlink is unsafe: ${name}`);
    }
    const bytes = Buffer.from(linkTarget);
    return {
      path: name,
      type: 'symlink',
      sizeBytes: bytes.byteLength,
      digest: bytesRoot(bytes),
      mode: '0777',
      linkTarget,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`qualified Core payload entry is not a file: ${name}`);
  }
  const bytes = fs.readFileSync(source);
  return {
    path: name,
    type: 'regular-file',
    sizeBytes: bytes.byteLength,
    digest: bytesRoot(bytes),
    mode: stat.mode & 0o111 ? '0755' : '0644',
    linkTarget: null,
  };
}

function readPayloads(bundleRoot, entries) {
  return Object.fromEntries(
    entries.map((entry) => {
      const source = path.join(bundleRoot, 'payload', entry.path);
      const stat = fs.lstatSync(source);
      if (
        (entry.type === 'symlink' && !stat.isSymbolicLink()) ||
        (entry.type === 'regular-file' && !stat.isFile())
      ) {
        throw new Error(
          `qualified Core candidate payload type drift: ${entry.path}`,
        );
      }
      return [
        entry.path,
        entry.type === 'symlink'
          ? fs.readlinkSync(source)
          : fs.readFileSync(source),
      ];
    }),
  );
}

function copyPayload(sourceRoot, destinationRoot, entries) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.path);
    const destination = path.join(destinationRoot, entry.path);
    if (entry.type === 'symlink') {
      fs.symlinkSync(entry.linkTarget, destination);
    } else {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, entry.mode === '0755' ? 0o755 : 0o644);
    }
  }
}

function pythonAbi(buildInfo) {
  const match = /^(\d+)\.(\d+)/u.exec(buildInfo.pythonVersion || '');
  if (!match) throw new Error('qualified Core Python version is invalid');
  return `cp${match[1]}${match[2]}`;
}

function validateRunner(runner, { shared }) {
  if (
    runner?.os !== 'macOS' ||
    runner?.arch !== 'ARM64' ||
    !['github-hosted', 'canonical-local'].includes(runner?.environment)
  ) {
    throw new Error('qualified Core producer must be a macOS ARM64 runner');
  }
  if (shared && runner.environment !== 'github-hosted') {
    throw new Error(
      'automatic shared qualification requires a GitHub-hosted producer',
    );
  }
}

export function validateQualifiedCoreCandidate(
  candidate,
  bundleRoot,
  expected = {},
) {
  if (candidate?.schema !== QUALIFIED_CORE_CANDIDATE_SCHEMA) {
    throw new Error('qualified Core candidate schema is unsupported');
  }
  const exactKeys = (value, keys, label) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify([...keys].sort())
    ) {
      throw new Error(`qualified Core candidate ${label} fields are invalid`);
    }
  };
  exactKeys(
    candidate,
    [
      'schema',
      'source',
      'producer',
      'build',
      'contracts',
      'payload',
      'consumer',
      'qualification',
      'candidateRoot',
    ],
    'top-level',
  );
  exactKeys(
    candidate.source,
    ['repository', 'commit', 'tree', 'sourceTreeRoot'],
    'source',
  );
  exactKeys(
    candidate.producer,
    ['runId', 'event', 'workflowPath', 'runner', 'createdAt'],
    'producer',
  );
  exactKeys(
    candidate.build,
    [
      'operatingSystem',
      'architecture',
      'pythonAbi',
      'profile',
      'toolchain',
      'toolchainDigest',
      'dependencyLockDigest',
      'nativeInputRoot',
      'buildInfo',
    ],
    'build',
  );
  exactKeys(candidate.contracts, ['shifu', 'buildchain'], 'contracts');
  exactKeys(candidate.payload, ['artifactRoot', 'entries'], 'payload');
  exactKeys(candidate.consumer, ['targetRoot'], 'consumer');
  const { candidateRoot: _candidateRoot, ...body } = candidate;
  if (
    candidate.candidateRoot !== qualifiedAssignmentCoreRoot(body) ||
    !SHA256_ROOT.test(candidate.candidateRoot)
  ) {
    throw new Error('qualified Core candidate root drift');
  }
  validateRunner(candidate.producer?.runner, {
    shared: expected.shared === true,
  });
  if (
    candidate.build?.operatingSystem !== 'darwin' ||
    candidate.build?.architecture !== 'arm64' ||
    !/^cp[0-9]{2,4}$/u.test(candidate.build?.pythonAbi || '')
  ) {
    throw new Error('qualified Core candidate platform identity is invalid');
  }
  if (
    expected.repository &&
    candidate.source?.repository !== expected.repository
  ) {
    throw new Error('qualified Core candidate repository drift');
  }
  if (expected.commit && candidate.source?.commit !== expected.commit) {
    throw new Error('qualified Core candidate source is stale');
  }
  if (
    expected.sourceTreeRoot &&
    candidate.source?.sourceTreeRoot !== expected.sourceTreeRoot
  ) {
    throw new Error('qualified Core candidate source tree drift');
  }
  if (expected.runId && candidate.producer?.runId !== Number(expected.runId)) {
    throw new Error('qualified Core candidate producer run drift');
  }
  if (expected.event && candidate.producer?.event !== expected.event) {
    throw new Error('qualified Core candidate producer event drift');
  }
  const entries = candidate.payload?.entries || [];
  const names = entries.map(({ path: entryPath }) => entryPath);
  const pykungfu = names.filter((name) =>
    /^pykungfu(?:[._-][A-Za-z0-9._-]+)?\.so$/u.test(name),
  );
  const libnode = names.filter((name) =>
    /^libnode\.[0-9]+\.dylib$/u.test(name),
  );
  if (
    JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort()) ||
    !names.includes('kungfubuildinfo.json') ||
    !names.includes('libkungfu_runtime.dylib') ||
    pykungfu.length !== 1 ||
    libnode.length !== 1 ||
    names.length !== 4
  ) {
    throw new Error('qualified Core candidate path set is unauthorized');
  }
  const payloads = readPayloads(bundleRoot, entries);
  for (const entry of entries) {
    if (
      !['regular-file', 'symlink'].includes(entry.type) ||
      !['0644', '0755', '0777'].includes(entry.mode) ||
      (entry.type === 'regular-file' &&
        (entry.linkTarget !== null || entry.mode === '0777')) ||
      (entry.type === 'symlink' &&
        (typeof entry.linkTarget !== 'string' || entry.mode !== '0777'))
    ) {
      throw new Error(
        `qualified Core candidate payload metadata is invalid: ${entry.path}`,
      );
    }
    const payload = payloads[entry.path];
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (
      bytes.byteLength !== entry.sizeBytes ||
      bytesRoot(bytes) !== entry.digest
    ) {
      throw new Error(`qualified Core candidate payload drift: ${entry.path}`);
    }
    if (entry.type === 'symlink') {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.path), entry.linkTarget),
      );
      if (
        resolved === '..' ||
        resolved.startsWith('../') ||
        !names.includes(resolved)
      ) {
        throw new Error(
          `qualified Core candidate symlink is unsafe: ${entry.path}`,
        );
      }
    }
  }
  const artifactRoot = qualifiedAssignmentCoreRoot({
    schema: 'shifu.qualified-assignment-core-payload/v1',
    entries,
  });
  if (candidate.payload.artifactRoot !== artifactRoot) {
    throw new Error('qualified Core candidate artifact root drift');
  }
  if (
    JSON.stringify(Object.keys(candidate.qualification || {}).sort()) !==
    JSON.stringify(QUALIFICATION_FIELDS)
  ) {
    throw new Error(
      'qualified Core candidate qualification roots are incomplete',
    );
  }
  for (const [field, value] of Object.entries(candidate.qualification)) {
    if (!SHA256_ROOT.test(value)) {
      throw new Error(`qualified Core candidate ${field} root is absent`);
    }
  }
  const checkoutRoots = qualifiedCoreCheckoutRoots(ROOT, candidate);
  const buildInfo = candidate.build.buildInfo || {};
  if (
    buildInfo.git?.revision !== candidate.source.commit ||
    buildInfo.git?.pristine !== true ||
    pythonAbi(buildInfo) !== candidate.build.pythonAbi ||
    !String(buildInfo.build?.osVersion || '').startsWith('macOS-') ||
    !String(buildInfo.build?.osVersion || '').includes('-arm64-')
  ) {
    throw new Error('qualified Core candidate build metadata drift');
  }
  for (const [actual, wanted, label] of [
    [
      candidate.source.sourceTreeRoot,
      checkoutRoots.sourceTreeRoot,
      'source tree',
    ],
    [
      candidate.build.dependencyLockDigest,
      checkoutRoots.dependencyLockDigest,
      'checkout dependency lock',
    ],
    [
      candidate.build.dependencyLockDigest,
      candidate.qualification.dependencyLockDigest,
      'dependency lock',
    ],
    [
      candidate.contracts.shifu.root,
      checkoutRoots.shifuContractRoot,
      'checkout Shifu contract',
    ],
    [
      candidate.contracts.shifu.root,
      candidate.qualification.shifuContractRoot,
      'Shifu contract',
    ],
    [
      candidate.contracts.buildchain.root,
      checkoutRoots.buildchainContractRoot,
      'checkout Buildchain contract',
    ],
    [
      candidate.contracts.buildchain.root,
      candidate.qualification.buildchainContractRoot,
      'Buildchain contract',
    ],
    [
      candidate.build.toolchainDigest,
      checkoutRoots.toolchainDigest,
      'toolchain',
    ],
    [
      candidate.build.nativeInputRoot,
      qualifiedAssignmentCoreRoot({
        schema: 'kungfu.qualified-assignment-core-native-input/v1',
        commit: candidate.source.commit,
        sourceTreeRoot: candidate.source.sourceTreeRoot,
        planDigest: candidate.qualification.planRoot,
        dependencyLockDigest: candidate.build.dependencyLockDigest,
        shifuContractRoot: candidate.contracts.shifu.root,
        buildchainContractRoot: candidate.contracts.buildchain.root,
        profile: candidate.build.profile,
      }),
      'native input',
    ],
  ]) {
    if (actual !== wanted) {
      throw new Error(`qualified Core candidate ${label} root drift`);
    }
  }
  return { candidate, payloads };
}

export function sealQualifiedCoreCandidate({
  repositoryRoot,
  payloadRoot,
  outputRoot,
  repository,
  commit,
  tree,
  plan,
  producer,
  toolchain,
  profile = 'release',
}) {
  const exactRepository = requireRepository(
    repository,
    'qualified Core repository',
  );
  const exactCommit = requireSha(commit, 'qualified Core commit');
  const exactTree = requireSha(tree, 'qualified Core tree');
  validateRunner(producer.runner, { shared: false });
  const buildInfo = readJson(path.join(payloadRoot, 'kungfubuildinfo.json'));
  if (
    buildInfo.git?.revision !== exactCommit ||
    buildInfo.git?.pristine !== true
  ) {
    throw new Error('qualified Core build metadata is stale or impure');
  }
  if (
    !String(buildInfo.build?.osVersion || '').startsWith('macOS-') ||
    !String(buildInfo.build?.osVersion || '').includes('-arm64-')
  ) {
    throw new Error('qualified Core build metadata is not macOS ARM64');
  }
  const entries = payloadNames(payloadRoot).map((name) =>
    payloadEntry(payloadRoot, name),
  );
  const sourceTreeRoot = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.git-source-tree/v1',
    tree: exactTree,
  });
  const dependencyLockDigest = fileSetRoot(
    repositoryRoot,
    LOCKS,
    'kungfu.qualified-assignment-core-dependency-locks/v1',
  );
  const shifuContractRoot = fileSetRoot(
    repositoryRoot,
    SHIFU_CONTRACTS,
    'kungfu.qualified-assignment-core-shifu-contract/v1',
  );
  const buildchainContractRoot = fileSetRoot(
    repositoryRoot,
    BUILDCHAIN_CONTRACTS,
    'kungfu.qualified-assignment-core-buildchain-contract/v1',
  );
  const toolchainDigest = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.qualified-assignment-core-toolchain/v1',
    toolchain,
  });
  const nativeInputRoot = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.qualified-assignment-core-native-input/v1',
    commit: exactCommit,
    sourceTreeRoot,
    planDigest: requireRoot(plan.planDigest, 'affected-native plan digest'),
    dependencyLockDigest,
    shifuContractRoot,
    buildchainContractRoot,
    profile,
  });
  const artifactRoot = qualifiedAssignmentCoreRoot({
    schema: 'shifu.qualified-assignment-core-payload/v1',
    entries,
  });
  const body = {
    schema: QUALIFIED_CORE_CANDIDATE_SCHEMA,
    source: {
      repository: exactRepository,
      commit: exactCommit,
      tree: exactTree,
      sourceTreeRoot,
    },
    producer: {
      runId: requireRunId(producer.runId, 'qualified Core producer run id'),
      event: requireIdentifier(producer.event, 'qualified Core producer event'),
      workflowPath: requireRelativePath(
        producer.workflowPath,
        'qualified Core producer workflow',
      ),
      runner: producer.runner,
      createdAt: producer.createdAt,
    },
    build: {
      operatingSystem: 'darwin',
      architecture: 'arm64',
      pythonAbi: pythonAbi(buildInfo),
      profile: requireIdentifier(profile, 'qualified Core build profile'),
      toolchain,
      toolchainDigest,
      dependencyLockDigest,
      nativeInputRoot,
      buildInfo,
    },
    contracts: {
      shifu: { version: buildInfo.version, root: shifuContractRoot },
      buildchain: { version: 'v3', root: buildchainContractRoot },
    },
    payload: { artifactRoot, entries },
    consumer: { targetRoot: TARGET_ROOT },
    qualification: {
      planRoot: plan.planDigest,
      sourceTreeRoot,
      dependencyLockDigest,
      shifuContractRoot,
      buildchainContractRoot,
    },
  };
  const candidate = {
    ...body,
    candidateRoot: qualifiedAssignmentCoreRoot(body),
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  copyPayload(payloadRoot, path.join(outputRoot, 'payload'), entries);
  writeJson(path.join(outputRoot, 'candidate.json'), candidate);
  validateQualifiedCoreCandidate(candidate, outputRoot);
  return candidate;
}

function manifestAndQualification(candidate, promotion) {
  const promotionAuthorityRoot = qualifiedAssignmentCoreRoot(promotion);
  const manifestBody = {
    schema: ARTIFACT_SCHEMA,
    producer: {
      repository: candidate.source.repository,
      commit: candidate.source.commit,
      sourceTreeRoot: candidate.source.sourceTreeRoot,
    },
    target: {
      repository: promotion.repository,
      commit: promotion.targetCommit,
    },
    compatibility: {
      mode: 'exact-commit',
      equivalenceReceiptRoot: null,
    },
    build: {
      nativeInputRoot: candidate.build.nativeInputRoot,
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
      profile: candidate.build.profile,
      toolchainDigest: candidate.build.toolchainDigest,
      dependencyLockDigest: candidate.build.dependencyLockDigest,
    },
    contracts: {
      artifactContractVersion: 1,
      qualificationContractVersion: 1,
      shifu: candidate.contracts.shifu,
      buildchain: candidate.contracts.buildchain,
    },
    payload: candidate.payload,
    consumer: {
      targetRoot: candidate.consumer.targetRoot,
      staging: 'outside-target',
      cleanCheckoutRequired: true,
      publication: 'atomic-replace',
      partialStateRunnable: false,
    },
  };
  const manifestRoot = qualifiedAssignmentCoreRoot(manifestBody);
  const qualificationBody = {
    schema: QUALIFICATION_SCHEMA,
    manifestRoot,
    artifactRoot: candidate.payload.artifactRoot,
    identity: {
      producerRepository: candidate.source.repository,
      producerCommit: candidate.source.commit,
      targetRepository: promotion.repository,
      targetCommit: promotion.targetCommit,
      compatibilityMode: 'exact-commit',
      equivalenceReceiptRoot: null,
    },
    targetCheckout: {
      commit: promotion.targetCommit,
      clean: true,
    },
    checks: {
      artifactDigest: 'pass',
      boundedPaths: 'pass',
      safeSymlinks: 'pass',
      platformAndAbi: 'pass',
      buildIdentity: 'pass',
      sourceIdentity: 'pass',
      checkoutCleanliness: 'pass',
    },
    promotionAuthority: promotion,
    promotionAuthorityRoot,
  };
  const qualification = {
    ...qualificationBody,
    receiptRoot: qualifiedAssignmentCoreRoot(qualificationBody),
  };
  const manifest = {
    ...manifestBody,
    manifestRoot,
    qualificationReceiptRoot: qualification.receiptRoot,
    promotionAuthorityRoot,
  };
  return { manifest, qualification };
}

function verificationExpectation(candidate, promotion, now) {
  return {
    producerRepository: candidate.source.repository,
    targetRepository: promotion.repository,
    producerCommit: candidate.source.commit,
    targetCommit: promotion.targetCommit,
    sourceTreeRoot: candidate.source.sourceTreeRoot,
    nativeInputRoot: candidate.build.nativeInputRoot,
    operatingSystem: candidate.build.operatingSystem,
    architecture: candidate.build.architecture,
    pythonAbi: candidate.build.pythonAbi,
    profile: candidate.build.profile,
    toolchainDigest: candidate.build.toolchainDigest,
    dependencyLockDigest: candidate.build.dependencyLockDigest,
    shifuContractVersion: candidate.contracts.shifu.version,
    shifuContractRoot: candidate.contracts.shifu.root,
    buildchainContractVersion: candidate.contracts.buildchain.version,
    buildchainContractRoot: candidate.contracts.buildchain.root,
    targetRoot: candidate.consumer.targetRoot,
    checkoutClean: true,
    protectedRef: promotion.protectedRef,
    promotionAuthorityCandidates: [candidate.candidateRoot],
    now,
  };
}

export async function promoteQualifiedCoreCandidate({
  candidateRoot,
  outputRoot,
  repository,
  targetCommit,
  targetTree,
  protectedRef,
  deliveryAttempt,
  deliveryEvidenceRoot,
  mergeGroupRunId,
  validFrom,
  validThrough,
  now,
  allowLocal = false,
  root = ROOT,
}) {
  const candidate = readJson(path.join(candidateRoot, 'candidate.json'));
  const exactRepository = requireRepository(
    repository,
    'qualified Core promotion repository',
  );
  const exactTargetCommit = requireSha(
    targetCommit,
    'qualified Core promotion target',
  );
  const exactTree = requireSha(targetTree, 'qualified Core promotion tree');
  const sourceTreeRoot = qualifiedAssignmentCoreRoot({
    schema: 'kungfu.git-source-tree/v1',
    tree: exactTree,
  });
  const shared = !allowLocal;
  const validated = validateQualifiedCoreCandidate(candidate, candidateRoot, {
    shared,
    repository: exactRepository,
    commit: exactTargetCommit,
    sourceTreeRoot,
    runId: shared ? mergeGroupRunId : undefined,
    event: shared ? 'merge_group' : undefined,
  });
  let exactDeliveryRoot = deliveryEvidenceRoot;
  if (shared) {
    const attempt = validateDeliveryAttempt(deliveryAttempt);
    if (
      attempt.workflow.repository !== exactRepository ||
      attempt.workflow.runId !== Number(mergeGroupRunId) ||
      attempt.source.mergeGroupHead !== exactTargetCommit ||
      attempt.source.checkout !== exactTargetCommit ||
      attempt.source.replayedTree !== exactTree
    ) {
      throw new Error('qualified Core delivery authority drift');
    }
    exactDeliveryRoot = attempt.attemptRoot;
  }
  requireRoot(exactDeliveryRoot, 'qualified Core delivery evidence root');
  const promotion = {
    schema: PROMOTION_SCHEMA,
    mode: 'protected-dev-direct',
    repository: exactRepository,
    targetCommit: exactTargetCommit,
    protectedRef,
    deliveryEvidenceRoot: exactDeliveryRoot,
    authorityCandidates: [candidate.candidateRoot],
    status: 'active',
    validFrom,
    validThrough,
  };
  const { manifest, qualification } = manifestAndQualification(
    candidate,
    promotion,
  );
  const verification = await verifyQualifiedAssignmentCoreArtifact({
    manifest,
    qualification,
    payloads: validated.payloads,
    expected: verificationExpectation(candidate, promotion, now),
    root,
  });
  fs.mkdirSync(outputRoot, { recursive: true });
  copyPayload(
    path.join(candidateRoot, 'payload'),
    path.join(outputRoot, 'payload'),
    candidate.payload.entries,
  );
  writeJson(path.join(outputRoot, 'candidate.json'), candidate);
  writeJson(path.join(outputRoot, 'manifest.json'), manifest);
  writeJson(path.join(outputRoot, 'qualification.json'), qualification);
  writeJson(path.join(outputRoot, 'verification.json'), verification);
  return { manifest, qualification, verification, candidate };
}

export async function verifyQualifiedCoreBundle(bundleRoot, expected, root) {
  const candidate = readJson(path.join(bundleRoot, 'candidate.json'));
  validateQualifiedCoreCandidate(candidate, bundleRoot, {
    repository: expected.producerRepository,
    commit: expected.producerCommit,
    sourceTreeRoot: expected.sourceTreeRoot,
  });
  return verifyQualifiedAssignmentCoreArtifact({
    manifest: readJson(path.join(bundleRoot, 'manifest.json')),
    qualification: readJson(path.join(bundleRoot, 'qualification.json')),
    payloads: readPayloads(bundleRoot, candidate.payload.entries),
    expected,
    root,
  });
}

function commandFact(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  const fact = (result.stdout || result.stderr || '').split('\n')[0].trim();
  if (result.error || result.status !== 0 || !fact) {
    throw new Error(`qualified Core toolchain probe failed for ${command}`);
  }
  return fact;
}

function observeToolchain() {
  return {
    compiler: commandFact(process.env.CXX || 'c++'),
    cmake: commandFact('cmake'),
    ninja: commandFact('ninja'),
    runner: {
      environment: process.env.RUNNER_ENVIRONMENT || 'local',
      os: process.env.RUNNER_OS || process.platform,
      arch: process.env.RUNNER_ARCH || process.arch,
      imageOS: process.env.ImageOS || null,
      imageVersion: process.env.ImageVersion || null,
    },
  };
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) {
      throw new Error(`unknown argument: ${argument}`);
    }
    options[argument.slice(2)] = rest[++index];
  }
  return options;
}

function appendGithubOutput(file, values) {
  if (!file) return;
  fs.appendFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'seal') {
    const repositoryRoot = path.resolve(options['repository-root'] || '.');
    const candidate = sealQualifiedCoreCandidate({
      repositoryRoot,
      payloadRoot: path.resolve(
        options['payload-root'] || path.join(repositoryRoot, TARGET_ROOT),
      ),
      outputRoot: path.resolve(options['output-dir']),
      repository: options.repository,
      commit: options.commit || git('rev-parse', 'HEAD'),
      tree: options.tree || git('rev-parse', 'HEAD^{tree}'),
      plan: readJson(path.resolve(options.plan)),
      producer: {
        runId: options['run-id'],
        event: options.event,
        workflowPath: options['workflow-path'],
        runner: {
          environment: options['runner-environment'],
          os: options['runner-os'],
          arch: options['runner-arch'],
          imageOS: options['runner-image-os'] || '',
          imageVersion: options['runner-image-version'] || '',
        },
        createdAt: options['created-at'] || new Date().toISOString(),
      },
      toolchain: observeToolchain(),
      profile: options.profile || 'release',
    });
    appendGithubOutput(options['github-output'], {
      'candidate-root': candidate.candidateRoot,
      'artifact-root': candidate.payload.artifactRoot,
      'python-abi': candidate.build.pythonAbi,
    });
    console.log(JSON.stringify(candidate, null, 2));
    return;
  }
  if (options.command === 'promote') {
    const now = options.now || new Date().toISOString();
    const result = await promoteQualifiedCoreCandidate({
      candidateRoot: path.resolve(options.bundle),
      outputRoot: path.resolve(options['output-dir']),
      repository: options.repository,
      targetCommit: options['target-commit'] || git('rev-parse', 'HEAD'),
      targetTree: options['target-tree'] || git('rev-parse', 'HEAD^{tree}'),
      protectedRef: options['protected-ref'],
      deliveryAttempt: options['delivery-attempt']
        ? readJson(path.resolve(options['delivery-attempt']))
        : null,
      deliveryEvidenceRoot: options['delivery-evidence-root'],
      mergeGroupRunId: options['merge-group-run-id'],
      validFrom: options['valid-from'] || now,
      validThrough:
        options['valid-through'] ||
        new Date(Date.parse(now) + 14 * 24 * 60 * 60 * 1000).toISOString(),
      now,
      allowLocal: options['allow-local'] === 'true',
      root: path.resolve(options['repository-root'] || '.'),
    });
    appendGithubOutput(options['github-output'], {
      'manifest-root': result.manifest.manifestRoot,
      'artifact-root': result.manifest.payload.artifactRoot,
      'qualification-receipt-root': result.qualification.receiptRoot,
      'promotion-authority-root': result.qualification.promotionAuthorityRoot,
    });
    console.log(JSON.stringify(result.verification, null, 2));
    return;
  }
  throw new Error(
    'usage: qualified-assignment-core-artifact.mjs <seal|promote>',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[qualified-core] ${error.message}`);
    process.exitCode = 1;
  });
}
