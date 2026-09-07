#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  qualifiedCorePlatformMatrix,
  qualifiedCorePlatformRow,
  qualifiedCorePlatformRowForIdentity,
} from '@kungfu-tech/work/assignment-capture/qualified-assignment-core-platform-matrix';
import { validateDeliveryAttempt } from '@kungfu-tech/workspaces/tooling/affected-native-proof';
import {
  qualifiedAssignmentCoreRoot,
  verifyQualifiedAssignmentCoreArtifact,
} from '@kungfu-tech/workspaces/tooling/check-shifu-cache-contract';
import { requireSha } from './affected-native-artifact-lookup.mjs';

export const QUALIFIED_CORE_CANDIDATE_SCHEMA =
  'kungfu.qualified-assignment-core-candidate/v2';
const LEGACY_CANDIDATE_SCHEMA = 'kungfu.qualified-assignment-core-candidate/v1';
const ARTIFACT_SCHEMA = 'shifu.qualified-assignment-core-artifact/v2';
const QUALIFICATION_SCHEMA = 'shifu.qualified-assignment-core-qualification/v2';
const PROMOTION_SCHEMA =
  'kungfu.qualified-assignment-core-promotion-authority/v1';
const COMPATIBILITY_SCHEMA =
  'kungfu.qualified-assignment-core-compatibility/v2';
const EQUIVALENCE_SCHEMA =
  'kungfu.qualified-assignment-core-equivalence-receipt/v1';
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
const TARGET_ROOT = 'framework/core/dist/kungfu';
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LOCKS = qualifiedCorePlatformMatrix(ROOT).shared.dependencyLocks;
const SHIFU_CONTRACTS = [
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
  'framework/work/assignment-capture/qualified-assignment-core-consumer.mjs',
  'framework/work/assignment-capture/qualified-assignment-core-observability.mjs',
  'framework/work/assignment-capture/qualified-assignment-core-platform-matrix.mjs',
];
const COMPATIBILITY_POLICY = [
  '.github/actions/qualified-core-candidate-build/action.yml',
  '.github/actions/upload-qualified-core-matrix/action.yml',
  '.github/workflows/affected-native-cache-promote.yml',
  '.github/workflows/affected-native-pr.yml',
  '.github/workflows/dev-post-merge-advisory.yml',
  'docs/shifu/artifact-contract.json',
  'docs/shifu/schema/qualified-assignment-core-artifact-v2.schema.json',
  'docs/shifu/schema/qualified-assignment-core-qualification-v2.schema.json',
  'docs/shifu/schema/qualified-assignment-core-platform-matrix-v1.schema.json',
  'docs/shifu/qualified-assignment-core-platform-matrix.json',
  'scripts/check-shifu-cache-contract.mjs',
  'product/release/qualified-assignment-core-artifact.mjs',
  'framework/work/assignment-capture/qualified-assignment-core-platform-matrix.mjs',
  'framework/work/assignment-capture/qualified-assignment-core-consumer.mjs',
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
const QUALIFICATION_V2_FIELDS = [
  ...QUALIFICATION_FIELDS,
  'compatibilityPolicyRoot',
  'compatibilityRoot',
  'nativeClosureRoot',
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

function trackedFileSetRoot(repositoryRoot, relativePaths, schema) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...relativePaths], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (listed.status !== 0) {
    throw new Error(
      listed.stderr.trim() || 'qualified Core tracked closure is unavailable',
    );
  }
  const paths = listed.stdout.split('\0').filter(Boolean).sort();
  if (paths.length === 0) {
    throw new Error('qualified Core tracked closure is empty');
  }
  return fileSetRoot(repositoryRoot, paths, schema);
}

function compatibilityRoot({
  nativeClosureRoot,
  operatingSystem,
  architecture,
  pythonAbi: abi,
  toolchainDigest,
  dependencyLockDigest,
  profile,
  shifuContractRoot,
  buildchainContractRoot,
  compatibilityPolicyRoot,
  artifactRoot,
}) {
  return qualifiedAssignmentCoreRoot({
    schema: COMPATIBILITY_SCHEMA,
    nativeClosureRoot,
    operatingSystem,
    architecture,
    pythonAbi: abi,
    toolchainDigest,
    dependencyLockDigest,
    profile,
    shifuContractRoot,
    buildchainContractRoot,
    compatibilityPolicyRoot,
    artifactRoot,
  });
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
  if (candidate.schema === QUALIFIED_CORE_CANDIDATE_SCHEMA) {
    const nativeClosureRoot = trackedFileSetRoot(
      repositoryRoot,
      ['framework/core'],
      'kungfu.qualified-assignment-core-native-closure/v2',
    );
    const compatibilityPolicyRoot = fileSetRoot(
      repositoryRoot,
      COMPATIBILITY_POLICY,
      'kungfu.qualified-assignment-core-compatibility-policy/v2',
    );
    const exactCompatibilityRoot = compatibilityRoot({
      nativeClosureRoot,
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
      toolchainDigest,
      dependencyLockDigest,
      profile: candidate.build.profile,
      shifuContractRoot,
      buildchainContractRoot,
      compatibilityPolicyRoot,
      artifactRoot: candidate.payload.artifactRoot,
    });
    return {
      sourceTreeRoot,
      dependencyLockDigest,
      shifuContractRoot,
      buildchainContractRoot,
      toolchainDigest,
      nativeClosureRoot,
      compatibilityPolicyRoot,
      compatibilityRoot: exactCompatibilityRoot,
      nativeInputRoot: exactCompatibilityRoot,
    };
  }
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

function payloadRules(row, names) {
  const matches = new Map();
  for (const rule of row.payload.entries) {
    const pattern = new RegExp(rule.pathPattern, 'u');
    const exact = names.filter((name) => pattern.test(name));
    if (exact.length !== 1 || matches.has(exact[0])) {
      throw new Error(
        `qualified Core ${row.id} runtime payload must contain exactly one ${rule.role}`,
      );
    }
    matches.set(exact[0], rule);
  }
  if (matches.size !== names.length) {
    throw new Error(
      `qualified Core ${row.id} runtime payload contains an unauthorized path`,
    );
  }
  return matches;
}

function payloadNames(payloadRoot, row) {
  const allNames = fs.readdirSync(payloadRoot).sort();
  const names = allNames.filter((name) =>
    row.payload.entries.some((rule) =>
      new RegExp(rule.pathPattern, 'u').test(name),
    ),
  );
  payloadRules(row, names);
  return names;
}

function payloadEntry(payloadRoot, name, rule) {
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
    if (rule.type !== 'symlink' || rule.mode !== '0777') {
      throw new Error(
        `qualified Core payload executable metadata drift: ${name}`,
      );
    }
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
  const entry = {
    path: name,
    type: 'regular-file',
    sizeBytes: bytes.byteLength,
    digest: bytesRoot(bytes),
    mode: stat.mode & 0o111 ? '0755' : '0644',
    linkTarget: null,
  };
  if (entry.type !== rule.type || entry.mode !== rule.mode) {
    throw new Error(
      `qualified Core payload executable metadata drift: ${name}`,
    );
  }
  return entry;
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

function validateRunner(runner, { shared, row }) {
  if (
    runner?.label !== row.runner.label ||
    runner?.os !== row.runner.os ||
    runner?.arch !== row.runner.arch ||
    !['github-hosted', 'canonical-local'].includes(runner?.environment)
  ) {
    throw new Error(
      `qualified Core producer must match platform row ${row.id}`,
    );
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
  if (
    ![QUALIFIED_CORE_CANDIDATE_SCHEMA, LEGACY_CANDIDATE_SCHEMA].includes(
      candidate?.schema,
    )
  ) {
    throw new Error('qualified Core candidate schema is unsupported');
  }
  const compatibilityCandidate =
    candidate.schema === QUALIFIED_CORE_CANDIDATE_SCHEMA;
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
    candidate.producer.runner,
    ['label', 'environment', 'os', 'arch', 'imageOS', 'imageVersion'],
    'producer runner',
  );
  exactKeys(
    candidate.build,
    compatibilityCandidate
      ? [
          'operatingSystem',
          'architecture',
          'pythonAbi',
          'profile',
          'toolchain',
          'toolchainDigest',
          'dependencyLockDigest',
          'nativeInputRoot',
          'compatibilityRoot',
          'buildInfo',
        ]
      : [
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
  if (!/^cp[0-9]{2,4}$/u.test(candidate.build?.pythonAbi || '')) {
    throw new Error('qualified Core candidate platform identity is invalid');
  }
  const row = qualifiedCorePlatformRowForIdentity(
    {
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
    },
    expected.repositoryRoot || ROOT,
  );
  validateRunner(candidate.producer?.runner, {
    shared: expected.shared === true,
    row,
  });
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
  if (
    expected.workflowPath &&
    candidate.producer?.workflowPath !== expected.workflowPath
  ) {
    throw new Error('qualified Core candidate producer workflow drift');
  }
  const entries = candidate.payload?.entries || [];
  const names = entries.map(({ path: entryPath }) => entryPath);
  const rules = payloadRules(row, names);
  if (
    JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort()) ||
    names.length !== row.payload.entries.length
  ) {
    throw new Error('qualified Core candidate path set is unauthorized');
  }
  const payloads = readPayloads(bundleRoot, entries);
  for (const entry of entries) {
    const rule = rules.get(entry.path);
    if (
      !rule ||
      entry.type !== rule.type ||
      entry.mode !== rule.mode ||
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
  const qualificationFields = compatibilityCandidate
    ? QUALIFICATION_V2_FIELDS
    : QUALIFICATION_FIELDS;
  if (
    JSON.stringify(Object.keys(candidate.qualification || {}).sort()) !==
    JSON.stringify([...qualificationFields].sort())
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
  const checkoutRoots = qualifiedCoreCheckoutRoots(
    expected.repositoryRoot || ROOT,
    candidate,
  );
  const buildInfo = candidate.build.buildInfo || {};
  if (
    buildInfo.git?.revision !== candidate.source.commit ||
    buildInfo.git?.pristine !== true ||
    pythonAbi(buildInfo) !== candidate.build.pythonAbi ||
    buildInfo.build?.operatingSystem !== row.operatingSystem ||
    buildInfo.build?.architecture !== row.architecture ||
    !String(buildInfo.build?.osVersion || '').startsWith(
      row.buildInfo.osVersionPrefix,
    )
  ) {
    throw new Error('qualified Core candidate build metadata drift');
  }
  if (
    JSON.stringify(Object.keys(candidate.build.toolchain || {}).sort()) !==
      JSON.stringify(['cmake', 'compiler', 'ninja', 'runner']) ||
    JSON.stringify(candidate.build.toolchain.runner) !==
      JSON.stringify(candidate.producer.runner)
  ) {
    throw new Error('qualified Core candidate toolchain runner drift');
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
    ...(compatibilityCandidate
      ? [
          [
            candidate.qualification.nativeClosureRoot,
            checkoutRoots.nativeClosureRoot,
            'native closure',
          ],
          [
            candidate.qualification.compatibilityPolicyRoot,
            checkoutRoots.compatibilityPolicyRoot,
            'compatibility policy',
          ],
          [
            candidate.build.compatibilityRoot,
            checkoutRoots.compatibilityRoot,
            'compatibility',
          ],
          [
            candidate.qualification.compatibilityRoot,
            checkoutRoots.compatibilityRoot,
            'qualification compatibility',
          ],
          [
            candidate.build.nativeInputRoot,
            checkoutRoots.compatibilityRoot,
            'native input',
          ],
        ]
      : [
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
        ]),
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
  platformRowId = 'darwin-arm64-cp313',
}) {
  const exactRepository = requireRepository(
    repository,
    'qualified Core repository',
  );
  const exactCommit = requireSha(commit, 'qualified Core commit');
  const exactTree = requireSha(tree, 'qualified Core tree');
  const row = qualifiedCorePlatformRow(platformRowId, repositoryRoot);
  validateRunner(producer.runner, { shared: false, row });
  const buildInfo = readJson(path.join(payloadRoot, 'kungfubuildinfo.json'));
  if (
    buildInfo.git?.revision !== exactCommit ||
    buildInfo.git?.pristine !== true
  ) {
    throw new Error('qualified Core build metadata is stale or impure');
  }
  if (
    buildInfo.build?.operatingSystem !== row.operatingSystem ||
    buildInfo.build?.architecture !== row.architecture ||
    !String(buildInfo.build?.osVersion || '').startsWith(
      row.buildInfo.osVersionPrefix,
    )
  ) {
    throw new Error(`qualified Core build metadata does not match ${row.id}`);
  }
  if (
    pythonAbi(buildInfo) !== row.pythonAbi ||
    JSON.stringify(Object.keys(toolchain || {}).sort()) !==
      JSON.stringify(['cmake', 'compiler', 'ninja', 'runner']) ||
    JSON.stringify(toolchain.runner) !== JSON.stringify(producer.runner)
  ) {
    throw new Error(`qualified Core toolchain does not match ${row.id}`);
  }
  const names = payloadNames(payloadRoot, row);
  const rules = payloadRules(row, names);
  const entries = names.map((name) =>
    payloadEntry(payloadRoot, name, rules.get(name)),
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
  const artifactRoot = qualifiedAssignmentCoreRoot({
    schema: 'shifu.qualified-assignment-core-payload/v1',
    entries,
  });
  const nativeClosureRoot = trackedFileSetRoot(
    repositoryRoot,
    ['framework/core'],
    'kungfu.qualified-assignment-core-native-closure/v2',
  );
  const compatibilityPolicyRoot = fileSetRoot(
    repositoryRoot,
    COMPATIBILITY_POLICY,
    'kungfu.qualified-assignment-core-compatibility-policy/v2',
  );
  const exactCompatibilityRoot = compatibilityRoot({
    nativeClosureRoot,
    operatingSystem: row.operatingSystem,
    architecture: row.architecture,
    pythonAbi: pythonAbi(buildInfo),
    toolchainDigest,
    dependencyLockDigest,
    profile,
    shifuContractRoot,
    buildchainContractRoot,
    compatibilityPolicyRoot,
    artifactRoot,
  });
  requireRoot(plan.planDigest, 'affected-native plan digest');
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
      operatingSystem: row.operatingSystem,
      architecture: row.architecture,
      pythonAbi: row.pythonAbi,
      profile: requireIdentifier(profile, 'qualified Core build profile'),
      toolchain,
      toolchainDigest,
      dependencyLockDigest,
      nativeInputRoot: exactCompatibilityRoot,
      compatibilityRoot: exactCompatibilityRoot,
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
      nativeClosureRoot,
      compatibilityPolicyRoot,
      compatibilityRoot: exactCompatibilityRoot,
    },
  };
  const candidate = {
    ...body,
    candidateRoot: qualifiedAssignmentCoreRoot(body),
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  copyPayload(payloadRoot, path.join(outputRoot, 'payload'), entries);
  writeJson(path.join(outputRoot, 'candidate.json'), candidate);
  validateQualifiedCoreCandidate(candidate, outputRoot, { repositoryRoot });
  return candidate;
}

function manifestAndQualification(candidate, promotion, equivalence) {
  const promotionAuthorityRoot = qualifiedAssignmentCoreRoot(promotion);
  const mode = equivalence ? 'explicit-equivalence' : 'exact-commit';
  const equivalenceReceiptRoot = equivalence?.receiptRoot || null;
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
      schema: COMPATIBILITY_SCHEMA,
      root: candidate.build.compatibilityRoot,
      mode,
      equivalenceReceiptRoot,
    },
    build: {
      nativeInputRoot: candidate.build.nativeInputRoot,
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
      profile: candidate.build.profile,
      toolchainDigest: candidate.build.toolchainDigest,
      dependencyLockDigest: candidate.build.dependencyLockDigest,
      nativeClosureRoot: candidate.qualification.nativeClosureRoot,
      compatibilityPolicyRoot: candidate.qualification.compatibilityPolicyRoot,
    },
    contracts: {
      artifactContractVersion: 2,
      qualificationContractVersion: 2,
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
      compatibilityRoot: candidate.build.compatibilityRoot,
      compatibilityMode: mode,
      equivalenceReceiptRoot,
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
      compatibilityIdentity: 'pass',
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

function verificationExpectation(
  candidate,
  promotion,
  now,
  targetSourceTreeRoot = candidate.source.sourceTreeRoot,
) {
  return {
    producerRepository: candidate.source.repository,
    targetRepository: promotion.repository,
    producerCommit: candidate.source.commit,
    targetCommit: promotion.targetCommit,
    sourceTreeRoot: candidate.source.sourceTreeRoot,
    targetSourceTreeRoot,
    nativeInputRoot: candidate.build.nativeInputRoot,
    compatibilityRoot: candidate.build.compatibilityRoot,
    nativeClosureRoot: candidate.qualification.nativeClosureRoot,
    compatibilityPolicyRoot: candidate.qualification.compatibilityPolicyRoot,
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
  producerRunId,
  producerEvent,
  producerWorkflowPath,
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
  const suppliedProducerCoordinates = [
    producerRunId,
    producerEvent,
    producerWorkflowPath,
  ].filter((value) => value !== undefined && value !== null && value !== '');
  if (
    shared &&
    suppliedProducerCoordinates.length > 0 &&
    suppliedProducerCoordinates.length !== 3
  ) {
    throw new Error(
      'qualified Core promotion requires complete producer coordinates',
    );
  }
  const explicitProducer = shared && suppliedProducerCoordinates.length === 3;
  const expectedProducerRunId = explicitProducer
    ? requireRunId(producerRunId, 'qualified Core producer run id')
    : mergeGroupRunId;
  const expectedProducerEvent = explicitProducer
    ? requireIdentifier(producerEvent, 'qualified Core producer event')
    : 'merge_group';
  const expectedProducerWorkflow = explicitProducer
    ? requireRelativePath(
        producerWorkflowPath,
        'qualified Core producer workflow',
      )
    : '.github/workflows/affected-native-pr.yml';
  if (shared) {
    const head = spawnSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    });
    const status = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      {
        cwd: root,
        encoding: 'utf8',
        shell: false,
      },
    );
    const [checkoutCommit, checkoutTree] = head.stdout.trim().split('\n');
    if (
      head.status !== 0 ||
      status.status !== 0 ||
      status.stdout.trim() ||
      checkoutCommit !== exactTargetCommit ||
      checkoutTree !== exactTree
    ) {
      throw new Error(
        'qualified Core promotion requires the exact clean protected target checkout',
      );
    }
  }
  const validated = validateQualifiedCoreCandidate(candidate, candidateRoot, {
    shared,
    repository: exactRepository,
    repositoryRoot: root,
    commit: explicitProducer ? exactTargetCommit : undefined,
    runId: shared ? expectedProducerRunId : undefined,
    event: shared ? expectedProducerEvent : undefined,
    workflowPath: shared ? expectedProducerWorkflow : undefined,
  });
  const targetRoots = qualifiedCoreCheckoutRoots(root, candidate);
  if (targetRoots.compatibilityRoot !== candidate.build.compatibilityRoot) {
    throw new Error(
      'qualified Core target compatibility identity does not match producer',
    );
  }
  const reused = candidate.source.commit !== exactTargetCommit;
  const equivalenceBody = reused
    ? {
        schema: EQUIVALENCE_SCHEMA,
        producer: {
          repository: candidate.source.repository,
          commit: candidate.source.commit,
          tree: candidate.source.tree,
          sourceTreeRoot: candidate.source.sourceTreeRoot,
          compatibilityRoot: candidate.build.compatibilityRoot,
        },
        target: {
          repository: exactRepository,
          commit: exactTargetCommit,
          tree: exactTree,
          sourceTreeRoot,
          compatibilityRoot: targetRoots.compatibilityRoot,
        },
        comparison: {
          method: 'independent-native-closure-recomputation',
          nativeClosureRoot: targetRoots.nativeClosureRoot,
          dependencyLockDigest: targetRoots.dependencyLockDigest,
          shifuContractRoot: targetRoots.shifuContractRoot,
          buildchainContractRoot: targetRoots.buildchainContractRoot,
          compatibilityPolicyRoot: targetRoots.compatibilityPolicyRoot,
        },
      }
    : null;
  const equivalence = equivalenceBody
    ? {
        ...equivalenceBody,
        receiptRoot: qualifiedAssignmentCoreRoot(equivalenceBody),
      }
    : null;
  let exactDeliveryRoot = deliveryEvidenceRoot;
  if (shared) {
    const attempt = validateDeliveryAttempt(deliveryAttempt);
    if (
      attempt.workflow.repository !== exactRepository ||
      attempt.workflow.runId !== Number(mergeGroupRunId) ||
      attempt.source.mergeGroupHead !== candidate.source.commit ||
      attempt.source.checkout !== candidate.source.commit ||
      attempt.source.replayedTree !== candidate.source.tree
    ) {
      throw new Error('qualified Core delivery authority drift');
    }
    exactDeliveryRoot = attempt.attemptRoot;
  }
  requireRoot(exactDeliveryRoot, 'qualified Core delivery evidence root');
  const promotion = {
    schema: PROMOTION_SCHEMA,
    mode: reused ? 'protected-dev-reused-proof' : 'protected-dev-direct',
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
    equivalence,
  );
  const verification = await verifyQualifiedAssignmentCoreArtifact({
    manifest,
    qualification,
    equivalence,
    payloads: validated.payloads,
    expected: verificationExpectation(
      candidate,
      promotion,
      now,
      sourceTreeRoot,
    ),
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
  if (equivalence) {
    writeJson(path.join(outputRoot, 'equivalence.json'), equivalence);
  }
  writeJson(path.join(outputRoot, 'verification.json'), verification);
  return { manifest, qualification, verification, candidate };
}

export async function verifyQualifiedCoreBundle(bundleRoot, expected, root) {
  const candidate = readJson(path.join(bundleRoot, 'candidate.json'));
  validateQualifiedCoreCandidate(candidate, bundleRoot, {
    repository: expected.producerRepository,
    commit: expected.producerCommit,
    sourceTreeRoot: expected.sourceTreeRoot,
    repositoryRoot: root,
  });
  const equivalencePath = path.join(bundleRoot, 'equivalence.json');
  return verifyQualifiedAssignmentCoreArtifact({
    manifest: readJson(path.join(bundleRoot, 'manifest.json')),
    qualification: readJson(path.join(bundleRoot, 'qualification.json')),
    equivalence: fs.existsSync(equivalencePath)
      ? readJson(equivalencePath)
      : null,
    payloads: readPayloads(bundleRoot, candidate.payload.entries),
    expected,
    root,
  });
}

export async function reuseQualifiedCoreBundle({
  bundleRoot,
  outputRoot,
  repositoryRoot,
  repository,
  currentCommit,
  now,
}) {
  const checkoutCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
  });
  const checkoutStatus = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: false,
    },
  );
  if (
    checkoutCommit.status !== 0 ||
    checkoutStatus.status !== 0 ||
    checkoutCommit.stdout.trim() !== currentCommit ||
    checkoutStatus.stdout.trim()
  ) {
    throw new Error(
      'qualified Core reuse requires the exact clean consuming checkout',
    );
  }
  const candidate = readJson(path.join(bundleRoot, 'candidate.json'));
  const qualification = readJson(path.join(bundleRoot, 'qualification.json'));
  let targetSourceTreeRoot = candidate.source.sourceTreeRoot;
  if (qualification.identity.targetCommit !== candidate.source.commit) {
    const qualifiedTargetTree = spawnSync(
      'git',
      ['rev-parse', `${qualification.identity.targetCommit}^{tree}`],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        shell: false,
      },
    );
    if (
      qualifiedTargetTree.status !== 0 ||
      !/^[0-9a-f]{40}$/u.test(qualifiedTargetTree.stdout.trim())
    ) {
      throw new Error(
        'qualified Core protected target source tree is unavailable',
      );
    }
    targetSourceTreeRoot = qualifiedAssignmentCoreRoot({
      schema: 'kungfu.git-source-tree/v1',
      tree: qualifiedTargetTree.stdout.trim(),
    });
  }
  const roots = qualifiedCoreCheckoutRoots(repositoryRoot, candidate);
  const verification = await verifyQualifiedCoreBundle(
    bundleRoot,
    {
      producerRepository: candidate.source.repository,
      targetRepository: qualification.identity.targetRepository,
      producerCommit: candidate.source.commit,
      targetCommit: qualification.identity.targetCommit,
      sourceTreeRoot: candidate.source.sourceTreeRoot,
      targetSourceTreeRoot,
      nativeInputRoot: roots.nativeInputRoot,
      compatibilityRoot: roots.compatibilityRoot,
      nativeClosureRoot: roots.nativeClosureRoot,
      compatibilityPolicyRoot: roots.compatibilityPolicyRoot,
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
      profile: candidate.build.profile,
      toolchainDigest: roots.toolchainDigest,
      dependencyLockDigest: roots.dependencyLockDigest,
      shifuContractVersion: candidate.contracts.shifu.version,
      shifuContractRoot: roots.shifuContractRoot,
      buildchainContractVersion: candidate.contracts.buildchain.version,
      buildchainContractRoot: roots.buildchainContractRoot,
      targetRoot: candidate.consumer.targetRoot,
      checkoutClean: true,
      protectedRef: qualification.promotionAuthority.protectedRef,
      promotionAuthorityCandidates: [candidate.candidateRoot],
      now,
    },
    repositoryRoot,
  );
  requireRepository(repository, 'qualified Core reuse repository');
  requireSha(currentCommit, 'qualified Core consuming commit');
  if (
    repository !== candidate.source.repository ||
    !verification.compatibilityIdentity
  ) {
    throw new Error('qualified Core reusable identity is unavailable');
  }
  fs.cpSync(bundleRoot, outputRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return {
    verification,
    candidate,
    qualifiedTargetCommit: qualification.identity.targetCommit,
    currentCommit,
  };
}

function commandFact(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  const fact = (result.stdout || result.stderr || '').split('\n')[0].trim();
  if (result.error || result.status !== 0 || !fact) {
    throw new Error(`qualified Core toolchain probe failed for ${command}`);
  }
  return fact;
}

function observeCompiler(payloadRoot) {
  const buildIdentity = readJson(
    path.join(payloadRoot, 'kungfu-core-build-identity.json'),
  );
  if (
    buildIdentity.schema !== 'kungfu.core-build-identity/v1' ||
    typeof buildIdentity.compiler !== 'string' ||
    !buildIdentity.compiler ||
    typeof buildIdentity.compiler_version !== 'string' ||
    !buildIdentity.compiler_version
  ) {
    throw new Error('qualified Core compiler build identity is unavailable');
  }
  return `${buildIdentity.compiler} ${buildIdentity.compiler_version}`;
}

function observeToolchain(runner, payloadRoot) {
  return {
    compiler: observeCompiler(payloadRoot),
    cmake: commandFact('cmake'),
    ninja: commandFact('ninja'),
    runner,
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
    const payloadRoot = path.resolve(
      options['payload-root'] || path.join(repositoryRoot, TARGET_ROOT),
    );
    const producerRunner = {
      label: options['runner-label'],
      environment: options['runner-environment'],
      os: options['runner-os'],
      arch: options['runner-arch'],
      imageOS: options['runner-image-os'] || '',
      imageVersion: options['runner-image-version'] || '',
    };
    const candidate = sealQualifiedCoreCandidate({
      repositoryRoot,
      payloadRoot,
      outputRoot: path.resolve(options['output-dir']),
      repository: options.repository,
      commit: options.commit || git('rev-parse', 'HEAD'),
      tree: options.tree || git('rev-parse', 'HEAD^{tree}'),
      plan: readJson(path.resolve(options.plan)),
      producer: {
        runId: options['run-id'],
        event: options.event,
        workflowPath: options['workflow-path'],
        runner: producerRunner,
        createdAt: options['created-at'] || new Date().toISOString(),
      },
      toolchain: observeToolchain(producerRunner, payloadRoot),
      profile: options.profile || 'release',
      platformRowId: options['platform-row'],
    });
    appendGithubOutput(options['github-output'], {
      'candidate-root': candidate.candidateRoot,
      'artifact-root': candidate.payload.artifactRoot,
      'python-abi': candidate.build.pythonAbi,
      'platform-row': qualifiedCorePlatformRowForIdentity(
        {
          operatingSystem: candidate.build.operatingSystem,
          architecture: candidate.build.architecture,
          pythonAbi: candidate.build.pythonAbi,
        },
        repositoryRoot,
      ).id,
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
      producerRunId: options['producer-run-id'],
      producerEvent: options['producer-event'],
      producerWorkflowPath: options['producer-workflow-path'],
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
  if (options.command === 'reuse') {
    const repositoryRoot = path.resolve(options['repository-root'] || '.');
    const now = options.now || new Date().toISOString();
    const result = await reuseQualifiedCoreBundle({
      bundleRoot: path.resolve(options.bundle),
      outputRoot: path.resolve(options['output-dir']),
      repositoryRoot,
      repository: options.repository,
      currentCommit: options['current-commit'] || git('rev-parse', 'HEAD'),
      now,
    });
    appendGithubOutput(options['github-output'], {
      'manifest-root': result.verification.manifestRoot,
      'artifact-root': result.verification.artifactRoot,
      'qualification-receipt-root':
        result.verification.qualificationReceiptRoot,
      'promotion-authority-root': result.verification.promotionAuthorityRoot,
      'compatibility-root': result.verification.compatibilityIdentity,
      'producer-commit': result.candidate.source.commit,
      'qualified-target-commit': result.qualifiedTargetCommit,
    });
    console.log(JSON.stringify(result.verification, null, 2));
    return;
  }
  throw new Error(
    'usage: qualified-assignment-core-artifact.mjs <seal|promote|reuse>',
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
