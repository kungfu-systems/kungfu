#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const EXPECTED_ARTIFACT_COUNT = 44;
const EXPECTED_RUN_ID = '31051528142';
const EXPECTED_SOURCE = 'ad7c7db6df076f969c5939728bcbe70ccd4771b3';
const EXPECTED_TREE = '67a93b5831596555e7c29104421de3a0b97eb865';
const EXPECTED_VERSION = '4.0.0-alpha.1';
const BUILDCHAIN_REHEARSAL_MERGE = 'fadcdfbf87a5e8f16b80df2ab39384dee0c8a601';
const PLATFORM_IDS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'];

/** @typedef {Error & {alphaDebugCode?: string, alphaDebugClass?: string, rehearsalCode?: string, rehearsalClass?: string, bindingRoot?: string}} DebugError */

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function required(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function explicitDirectory(value, label, { existing = true } = {}) {
  const raw = required(value, label);
  if (!path.isAbsolute(raw))
    throw new Error(`${label} must be an explicit absolute path`);
  const resolved = path.resolve(raw);
  if (
    existing &&
    (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
  )
    throw new Error(`${label} must identify an existing directory`);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
    throw new Error(`${label} parent must identify an existing directory`);
  return path.join(fs.realpathSync(parent), path.basename(resolved));
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function validateCoordinates({
  artifactRoot,
  scratchRoot,
  buildchainRoot,
}) {
  const input = explicitDirectory(artifactRoot, '--artifact-root');
  const scratch = explicitDirectory(scratchRoot, '--scratch-root', {
    existing: false,
  });
  const buildchain = explicitDirectory(buildchainRoot, '--buildchain-root');
  const pairs = [
    ['--artifact-root', input, '--scratch-root', scratch],
    ['--artifact-root', input, '--buildchain-root', buildchain],
    ['--scratch-root', scratch, '--buildchain-root', buildchain],
  ];
  for (const [leftLabel, left, rightLabel, right] of pairs) {
    if (inside(left, right) || inside(right, left))
      throw new Error(`${leftLabel} and ${rightLabel} must be disjoint`);
  }
  return {
    artifactRoot: input,
    scratchRoot: scratch,
    buildchainRoot: buildchain,
  };
}

function regularFile(filePath, label) {
  if (
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile() ||
    fs.lstatSync(filePath).isSymbolicLink()
  )
    throw new Error(`${label} must be a regular non-symlink file`);
  return filePath;
}

function parseChecksums(contents) {
  const entries = new Map();
  for (const [index, line] of contents.trim().split(/\r?\n/u).entries()) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match) throw new Error(`SHA256SUMS line ${index + 1} is invalid`);
    if (entries.has(match[2]))
      throw new Error(`SHA256SUMS duplicates ${match[2]}`);
    entries.set(match[2], `sha256:${match[1]}`);
  }
  return entries;
}

function artifactSnapshot(artifactRoot) {
  const checksumsPath = regularFile(
    path.join(artifactRoot, 'SHA256SUMS'),
    'SHA256SUMS',
  );
  const metadataPath = regularFile(
    path.join(artifactRoot, 'artifacts.json'),
    'artifacts.json',
  );
  const checksums = parseChecksums(fs.readFileSync(checksumsPath, 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (
    metadata.total_count !== EXPECTED_ARTIFACT_COUNT ||
    metadata.artifacts?.length !== EXPECTED_ARTIFACT_COUNT
  )
    throw new Error(
      `artifacts.json must declare exactly ${EXPECTED_ARTIFACT_COUNT} artifacts`,
    );
  if (checksums.size !== EXPECTED_ARTIFACT_COUNT)
    throw new Error(
      `SHA256SUMS must declare exactly ${EXPECTED_ARTIFACT_COUNT} archives`,
    );
  const files = [];
  const names = new Set();
  for (const artifact of metadata.artifacts) {
    const name = required(artifact.name, 'artifacts.json artifact name');
    const fileName = `${name}.zip`;
    if (names.has(fileName))
      throw new Error(`artifacts.json duplicates ${name}`);
    names.add(fileName);
    const expectedRoot = checksums.get(fileName);
    if (!expectedRoot) throw new Error(`SHA256SUMS is missing ${fileName}`);
    const filePath = regularFile(
      path.join(artifactRoot, 'artifacts', fileName),
      fileName,
    );
    const size = fs.statSync(filePath).size;
    if (size !== artifact.size_in_bytes)
      throw new Error(`${fileName} size differs from artifacts.json`);
    const root = fileDigest(filePath);
    if (root !== expectedRoot)
      throw new Error(`${fileName} differs from SHA256SUMS`);
    if (String(artifact.workflow_run?.id || '') !== EXPECTED_RUN_ID)
      throw new Error(`${fileName} is not from build run ${EXPECTED_RUN_ID}`);
    files.push({ name, fileName, path: filePath, size, root });
  }
  if ([...checksums.keys()].some((name) => !names.has(name)))
    throw new Error('SHA256SUMS and artifacts.json name sets differ');
  const manifests = [
    {
      path: 'SHA256SUMS',
      size: fs.statSync(checksumsPath).size,
      root: fileDigest(checksumsPath),
    },
    {
      path: 'artifacts.json',
      size: fs.statSync(metadataPath).size,
      root: fileDigest(metadataPath),
    },
  ];
  files.sort((left, right) => left.fileName.localeCompare(right.fileName));
  return {
    files,
    manifests,
    root: digest({
      files: files.map(({ fileName, size, root }) => ({
        fileName,
        size,
        root,
      })),
      manifests,
    }),
  };
}

function exactlyOne(snapshot, pattern, label) {
  const matches = snapshot.files.filter((entry) =>
    pattern.test(entry.fileName),
  );
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${label}, found ${matches.length}`);
  return matches[0];
}

function readZipMember(archive, member) {
  const result = childProcess.spawnSync('unzip', ['-p', archive, member], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.length)
    throw new Error(`cannot read ${member} from ${path.basename(archive)}`);
  return result.stdout;
}

function writeExact(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function debugFailure(code, message) {
  /** @type {DebugError} */
  const error = new Error(message);
  error.alphaDebugCode = code;
  error.alphaDebugClass = 'input';
  throw error;
}

function writeCandidateFile(filePath, contents, code) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (fs.existsSync(filePath)) {
    if (
      !fs.statSync(filePath).isFile() ||
      fs.lstatSync(filePath).isSymbolicLink() ||
      !fs.readFileSync(filePath).equals(bytes)
    )
      debugFailure(code, `candidate binding drift: ${path.basename(filePath)}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function stageFile(source, target, expected) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (
      fs.statSync(target).isFile() &&
      !fs.lstatSync(target).isSymbolicLink() &&
      fs.statSync(target).size === expected.size &&
      fileDigest(target) === expected.root
    )
      return;
    debugFailure(
      'candidate-payload-drift',
      `candidate payload drift: ${path.basename(target)}`,
    );
  }
  for (const options of [['--reflink=auto'], ['-c'], []]) {
    const result = childProcess.spawnSync('cp', [...options, source, target], {
      encoding: 'utf8',
    });
    if (result.status === 0) return;
  }
  throw new Error(
    `cannot stage ${path.basename(source)} under the scratch root`,
  );
}

function git(repo, args) {
  const result = childProcess.spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function assertCleanCheckout(repo, label = 'Git checkout') {
  const status = git(repo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status)
    throw new Error(`${label} must be clean; refusing an unreviewed runtime`);
}

function verifyBuildchain(buildchainRoot) {
  assertCleanCheckout(buildchainRoot, '--buildchain-root');
  regularFile(
    path.join(buildchainRoot, 'packages/core/publication-rehearsal-runtime.js'),
    'Buildchain publication rehearsal runtime',
  );
  regularFile(
    path.join(buildchainRoot, 'packages/core/release-tail-provider-plane.js'),
    'Buildchain provider plane',
  );
  const ancestor = childProcess.spawnSync(
    'git',
    [
      '-C',
      buildchainRoot,
      'merge-base',
      '--is-ancestor',
      BUILDCHAIN_REHEARSAL_MERGE,
      'HEAD',
    ],
    { encoding: 'utf8' },
  );
  if (ancestor.status !== 0)
    throw new Error(
      `--buildchain-root must contain protected merge ${BUILDCHAIN_REHEARSAL_MERGE}`,
    );
  return {
    commit: git(buildchainRoot, ['rev-parse', 'HEAD']),
    tree: git(buildchainRoot, ['rev-parse', 'HEAD^{tree}']),
  };
}

function hydrateDeclaration(
  template,
  {
    passportRoot,
    artifactRoles,
    channelRoot,
    activationRoot,
    receiptRoot,
    transactionRoot,
  },
) {
  const declaration = structuredClone(template);
  declaration.subject = {
    repository: 'kungfu-systems/kungfu',
    sourceSha: EXPECTED_SOURCE,
    version: EXPECTED_VERSION,
    tag: `v${EXPECTED_VERSION}`,
    channel: 'alpha',
  };
  const roots = {
    'artifact.publish': {
      subject: passportRoot,
      target: digest(artifactRoles),
    },
    'signed-channel.commit': { subject: passportRoot, target: channelRoot },
    'release.activate': { subject: channelRoot, target: activationRoot },
    'released-evidence.synthesize': {
      subject: receiptRoot,
      target: digest({ activationRoot, receiptRoot }),
    },
  };
  for (const capability of declaration.capabilities) {
    capability.operationIdentity.transactionRoot = transactionRoot;
    capability.operationIdentity.subjectRoot = roots[capability.id].subject;
    capability.operationIdentity.targetRoot = roots[capability.id].target;
    if (capability.id === 'artifact.publish')
      capability.artifactRoles = artifactRoles;
    else if (capability.id === 'signed-channel.commit')
      capability.artifactRoles = [
        { role: 'signed-channel-index', root: channelRoot },
        { role: 'release-passport', root: passportRoot },
      ];
    else
      capability.artifactRoles = [
        { role: 'activation-receipt-set', root: receiptRoot },
      ];
  }
  return declaration;
}

function inventoryEntry(role, relativePath, filePath) {
  return {
    role,
    path: relativePath,
    size: fs.statSync(filePath).size,
    root: fileDigest(filePath),
  };
}

function regularFilesUnder(root, relative = '') {
  const directory = path.join(root, relative);
  const files = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(root, childRelative);
    if (entry.isSymbolicLink())
      debugFailure(
        'candidate-inventory-symbolic-link',
        `candidate inventory contains a symbolic link: ${childRelative}`,
      );
    if (entry.isDirectory())
      files.push(...regularFilesUnder(root, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    else
      debugFailure(
        'candidate-inventory-non-regular',
        `candidate inventory contains a non-regular entry: ${childRelative}`,
      );
  }
  return files;
}

export function completeRegularFileInventory(capsuleRoot, declaredFiles) {
  const actual = regularFilesUnder(capsuleRoot);
  const declared = [...declaredFiles]
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(declared))
    debugFailure(
      'candidate-inventory-drift',
      `candidate regular-file inventory differs: actual=${actual.join(',')}; declared=${declared.join(',')}`,
    );
  const files = declaredFiles
    .map((entry) => {
      const filePath = path.join(capsuleRoot, entry.path);
      const size = fs.statSync(filePath).size;
      const root = fileDigest(filePath);
      if (size !== entry.size || root !== entry.root)
        debugFailure(
          'candidate-file-binding-drift',
          `candidate file binding drift: ${entry.path}`,
        );
      return { ...entry, size, root };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    schema: 'kungfu.alpha-local-exact-candidate-inventory/v1',
    fileCount: files.length,
    files,
  };
  return { ...body, inventoryRoot: digest(body) };
}

async function loadBuildchainRuntime(buildchainRoot) {
  return import(
    pathToFileURL(
      path.join(
        buildchainRoot,
        'packages/core/publication-rehearsal-runtime.js',
      ),
    ).href
  );
}

export async function runPortableSmoke(rawOptions) {
  const capsulePath = required(rawOptions.capsule, '--capsule');
  if (!path.isAbsolute(capsulePath))
    throw new Error('--capsule must be an explicit absolute path');
  const exactCapsulePath = fs.realpathSync(
    regularFile(capsulePath, '--capsule'),
  );
  const capsuleRoot = explicitDirectory(
    rawOptions.capsuleRoot,
    '--capsule-root',
  );
  const buildchainRoot = explicitDirectory(
    rawOptions.buildchainRoot,
    '--buildchain-root',
  );
  const expectedBindingRoot = required(
    rawOptions.expectedBindingRoot,
    '--expected-binding-root',
  );
  const expectedTransactionRoot = required(
    rawOptions.expectedTransactionRoot,
    '--expected-transaction-root',
  );
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(expectedBindingRoot) ||
    !/^sha256:[0-9a-f]{64}$/u.test(expectedTransactionRoot)
  )
    throw new Error('expected roots must be sha256 content roots');
  const buildchain = verifyBuildchain(buildchainRoot);
  const runtime = await loadBuildchainRuntime(buildchainRoot);
  const capsule = JSON.parse(fs.readFileSync(exactCapsulePath, 'utf8'));
  const result = await runtime.executePublicationRehearsal({
    capsule,
    capsuleRoot,
    mode: 'simulate',
    environment: {},
  });
  if (
    result.evidence.bindingRoot !== expectedBindingRoot ||
    result.transaction.transactionRoot !== expectedTransactionRoot
  )
    throw new Error(
      'portable deterministic roots differ from the admitted Mac run',
    );
  if (result.evidence.externalPublicationClaimed !== false)
    throw new Error('portable smoke claimed external publication');
  return {
    schema: 'kungfu.alpha-local-publication-portable-smoke/v1',
    status: 'passed',
    platform: process.platform,
    architecture: process.arch,
    mode: 'simulate',
    capsuleRoot: capsule.root,
    bindingRoot: result.evidence.bindingRoot,
    transactionRoot: result.transaction.transactionRoot,
    stateRoot: result.transaction.stateRoot,
    evidenceRoot: result.evidence.evidenceRoot,
    externalPublicationClaimed: false,
    buildchainSha: buildchain.commit,
    buildchainTree: buildchain.tree,
    buildchainRequiredMerge: BUILDCHAIN_REHEARSAL_MERGE,
  };
}

async function runAlphaLocalPublicationDebugInternal(
  rawOptions,
  injectedRuntime,
) {
  const coordinates = validateCoordinates(rawOptions);
  assertCleanCheckout(ROOT, 'Kungfu source checkout');
  const before = artifactSnapshot(coordinates.artifactRoot);
  const buildchain = verifyBuildchain(coordinates.buildchainRoot);
  const outputRoot = path.join(
    coordinates.scratchRoot,
    'alpha-publication-debug',
  );
  const capsuleRoot = path.join(outputRoot, 'candidate');
  fs.mkdirSync(capsuleRoot, { recursive: true });

  const sourceTree = git(ROOT, ['rev-parse', `${EXPECTED_SOURCE}^{tree}`]);
  if (sourceTree !== EXPECTED_TREE)
    debugFailure('candidate-source-drift', 'candidate source tree mismatch');
  const sourceBinding = {
    schema: 'kungfu.alpha-local-source-binding/v1',
    sourceCommit: EXPECTED_SOURCE,
    sourceTree,
  };
  writeExact(
    path.join(outputRoot, 'source-binding.json'),
    `${JSON.stringify(sourceBinding, null, 2)}\n`,
  );
  const sourceBindingPath = path.join(capsuleRoot, 'bindings/source.json');
  writeCandidateFile(
    sourceBindingPath,
    `${JSON.stringify(sourceBinding, null, 2)}\n`,
    'candidate-source-drift',
  );

  const passportArchive = exactlyOne(
    before,
    /^kungfu-release-candidate-[0-9a-f]{40}\.zip$/u,
    'Release Candidate Passport archive',
  );
  const tailArchive = exactlyOne(
    before,
    /^kungfu-alpha-publication-tail-[0-9a-f]{40}\.zip$/u,
    'Alpha publication-tail archive',
  );
  const receiptArchive = exactlyOne(
    before,
    /^kungfu-release-candidate-controller-receipt-[0-9a-f]{40}\.zip$/u,
    'candidate receipt archive',
  );
  const passportBytes = readZipMember(
    passportArchive.path,
    'release-candidate-passport.json',
  );
  const tailBytes = readZipMember(
    tailArchive.path,
    'alpha-publication-tail-plan.json',
  );
  const receiptBytes = readZipMember(
    receiptArchive.path,
    'release-candidate-receipt.json',
  );
  const passport = JSON.parse(passportBytes.toString('utf8'));
  const tailPlan = JSON.parse(tailBytes.toString('utf8'));
  if (
    String(passport.workflow?.runId) !== EXPECTED_RUN_ID ||
    passport.source?.builtSourceSha !== EXPECTED_SOURCE ||
    passport.source?.builtSourceTreeSha !== EXPECTED_TREE ||
    passport.target?.version !== EXPECTED_VERSION ||
    tailPlan.identity?.sourceCommit !== EXPECTED_SOURCE ||
    tailPlan.identity?.sourceTree !== EXPECTED_TREE ||
    tailPlan.identity?.version !== EXPECTED_VERSION
  )
    throw new Error(
      'Passport and publication-tail candidate identities do not match',
    );

  const passportPath = path.join(
    capsuleRoot,
    'evidence/release-candidate-passport.json',
  );
  const tailPath = path.join(
    capsuleRoot,
    'evidence/alpha-publication-tail-plan.json',
  );
  const receiptPath = path.join(
    capsuleRoot,
    'evidence/release-candidate-receipt.json',
  );
  writeCandidateFile(passportPath, passportBytes, 'candidate-passport-drift');
  writeCandidateFile(tailPath, tailBytes, 'candidate-policy-drift');
  writeCandidateFile(
    receiptPath,
    receiptBytes,
    'candidate-activation-receipt-drift',
  );

  const platformEntries = [];
  for (const platformId of PLATFORM_IDS) {
    const artifact = exactlyOne(
      before,
      new RegExp(`^kungfu-${platformId}-${EXPECTED_SOURCE}\\.zip$`, 'u'),
      `${platformId} product archive`,
    );
    const relativePath = `artifacts/${artifact.fileName}`;
    const target = path.join(capsuleRoot, relativePath);
    stageFile(artifact.path, target, artifact);
    platformEntries.push({
      role: `installable-product-${platformId}`,
      path: relativePath,
      size: artifact.size,
      root: artifact.root,
    });
  }

  const passportEntry = inventoryEntry(
    'release-passport',
    'evidence/release-candidate-passport.json',
    passportPath,
  );
  const tailEntry = inventoryEntry(
    'alpha-publication-tail-plan',
    'evidence/alpha-publication-tail-plan.json',
    tailPath,
  );
  const receiptEntry = inventoryEntry(
    'activation-receipt-set',
    'evidence/release-candidate-receipt.json',
    receiptPath,
  );
  const channel = {
    schema: 'kungfu.alpha-local-publication-debug-channel/v1',
    source: EXPECTED_SOURCE,
    version: EXPECTED_VERSION,
    tag: `v${EXPECTED_VERSION}`,
    passportRoot: passportEntry.root,
    publicationTailPlanRoot: tailPlan.planRoot,
  };
  const activation = {
    schema: 'kungfu.alpha-local-publication-debug-activation/v1',
    channel: 'alpha',
    source: EXPECTED_SOURCE,
    version: EXPECTED_VERSION,
    candidateRoot: before.root,
  };
  const channelPath = path.join(capsuleRoot, 'documents/channel.json');
  const activationPath = path.join(capsuleRoot, 'documents/activation.json');
  writeCandidateFile(
    channelPath,
    `${JSON.stringify(channel, null, 2)}\n`,
    'candidate-channel-drift',
  );
  writeCandidateFile(
    activationPath,
    `${JSON.stringify(activation, null, 2)}\n`,
    'candidate-activation-drift',
  );
  const channelEntry = inventoryEntry(
    'signed-channel-index',
    'documents/channel.json',
    channelPath,
  );
  const activationEntry = inventoryEntry(
    'activation-document',
    'documents/activation.json',
    activationPath,
  );

  const template = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'docs/qualification/alpha-local-publication-debug.declaration.json',
      ),
      'utf8',
    ),
  );
  const policyRoots = [
    tailPlan.binding?.workflowRoot,
    tailPlan.binding?.gateRoot,
    tailPlan.binding?.toolchainRoot,
    tailPlan.binding?.dependencyLockRoot,
    tailPlan.binding?.policyRoot,
    tailPlan.planRoot,
  ].sort();
  if (policyRoots.some((root) => !/^sha256:[0-9a-f]{64}$/u.test(root)))
    debugFailure(
      'candidate-policy-drift',
      'publication-tail policy roots are incomplete',
    );
  const transactionRoot = digest({
    candidateRoot: before.root,
    passportRoot: passportEntry.root,
    policyRoots,
  });
  const declaration = hydrateDeclaration(template, {
    passportRoot: passportEntry.root,
    artifactRoles: [...platformEntries, passportEntry].map(
      ({ role, root }) => ({ role, root }),
    ),
    channelRoot: channelEntry.root,
    activationRoot: activationEntry.root,
    receiptRoot: receiptEntry.root,
    transactionRoot,
  });
  const files = [
    ...platformEntries,
    passportEntry,
    tailEntry,
    receiptEntry,
    channelEntry,
    activationEntry,
  ].sort((left, right) => left.path.localeCompare(right.path));
  const providerBindings = {
    schema: 'kungfu.buildchain.release-tail.provider-bindings/v1',
    artifacts: Object.fromEntries(
      [...platformEntries, passportEntry].map((entry) => [
        entry.role,
        { path: entry.path, name: path.basename(entry.path) },
      ]),
    ),
    documents: {
      'signed-channel.commit': { path: channelEntry.path, method: 'PUT' },
      'release.activate': { path: activationEntry.path, method: 'POST' },
    },
    evidence: {
      inputs: [receiptEntry.path, tailEntry.path],
      output: 'output/released-evidence.json',
    },
  };
  const sourceBindingEntry = inventoryEntry(
    'candidate-source-binding',
    'bindings/source.json',
    sourceBindingPath,
  );
  const policyBinding = {
    schema: 'kungfu.alpha-local-policy-binding/v1',
    publicationTailPlanRoot: tailPlan.planRoot,
    policyRoots,
  };
  const policyBindingPath = path.join(capsuleRoot, 'bindings/policy.json');
  const declarationPath = path.join(capsuleRoot, 'bindings/declaration.json');
  const providerBindingsPath = path.join(
    capsuleRoot,
    'bindings/provider-bindings.json',
  );
  const transactionPath = path.join(capsuleRoot, 'bindings/transaction.json');
  writeCandidateFile(
    policyBindingPath,
    `${JSON.stringify(policyBinding, null, 2)}\n`,
    'candidate-policy-drift',
  );
  writeCandidateFile(
    declarationPath,
    `${JSON.stringify(declaration, null, 2)}\n`,
    'candidate-declaration-drift',
  );
  writeCandidateFile(
    providerBindingsPath,
    `${JSON.stringify(providerBindings, null, 2)}\n`,
    'candidate-provider-binding-drift',
  );
  const runtime =
    injectedRuntime ||
    (await loadBuildchainRuntime(coordinates.buildchainRoot));
  for (const name of [
    'createPublicationRehearsalCapsule',
    'executePublicationRehearsal',
    'publicationRehearsalDiagnostic',
  ])
    if (typeof runtime[name] !== 'function')
      throw new Error(`Buildchain public runtime is missing ${name}`);
  const preliminaryCapsule = runtime.createPublicationRehearsalCapsule({
    declaration,
    policyRoots,
    passport: { path: passportEntry.path, root: passportEntry.root },
    files,
    providerBindings,
  });
  writeCandidateFile(
    transactionPath,
    `${JSON.stringify(preliminaryCapsule.transaction, null, 2)}\n`,
    'candidate-transaction-drift',
  );
  const completeFiles = [
    ...files,
    sourceBindingEntry,
    inventoryEntry(
      'publication-policy-binding',
      'bindings/policy.json',
      policyBindingPath,
    ),
    inventoryEntry(
      'release-tail-declaration',
      'bindings/declaration.json',
      declarationPath,
    ),
    inventoryEntry(
      'provider-bindings',
      'bindings/provider-bindings.json',
      providerBindingsPath,
    ),
    inventoryEntry(
      'release-tail-transaction',
      'bindings/transaction.json',
      transactionPath,
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const candidateInventory = completeRegularFileInventory(
    capsuleRoot,
    completeFiles,
  );
  const capsule = runtime.createPublicationRehearsalCapsule({
    declaration,
    policyRoots,
    passport: { path: passportEntry.path, root: passportEntry.root },
    transaction: preliminaryCapsule.transaction,
    files: candidateInventory.files,
    providerBindings,
  });
  if (
    capsule.transaction.transactionRoot !==
    preliminaryCapsule.transaction.transactionRoot
  )
    debugFailure(
      'candidate-transaction-drift',
      'complete inventory changed the release-tail transaction',
    );
  const capsulePath = path.join(outputRoot, 'rehearsal-capsule.json');
  const statePath = path.join(outputRoot, 'rehearsal-state.json');
  const evidencePath = path.join(outputRoot, 'rehearsal-evidence.json');
  const diagnosticPath = path.join(outputRoot, 'rehearsal-diagnostic.json');
  writeExact(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);
  writeExact(
    path.join(outputRoot, 'candidate-inventory.json'),
    `${JSON.stringify(candidateInventory, null, 2)}\n`,
  );
  let result;
  try {
    result = await runtime.executePublicationRehearsal({
      capsule,
      capsuleRoot,
      mode: 'simulate',
      environment: {},
      checkpoint: (transaction) =>
        writeExact(statePath, `${JSON.stringify(transaction, null, 2)}\n`),
    });
  } catch (error) {
    const diagnostic = runtime.publicationRehearsalDiagnostic(error, {
      capsule,
    });
    writeExact(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
    throw error;
  }
  writeExact(statePath, `${JSON.stringify(result.transaction, null, 2)}\n`);
  writeExact(evidencePath, `${JSON.stringify(result.evidence, null, 2)}\n`);
  if (result.evidence.externalPublicationClaimed !== false)
    throw new Error('simulation attempted to claim external publication');
  const after = artifactSnapshot(coordinates.artifactRoot);
  if (after.root !== before.root)
    throw new Error('retained artifact input changed during rehearsal');
  const diagnosticBody = {
    contract: 'kungfu.alpha-local-publication-debug-diagnostic/v1',
    status: 'passed',
    code: 'simulate-complete',
    bindingRoot: result.evidence.bindingRoot,
    transactionRoot: result.transaction.transactionRoot,
    stateRoot: result.transaction.stateRoot,
    evidenceRoot: result.evidence.evidenceRoot,
    candidateInputRoot: before.root,
    inputUnchanged: true,
  };
  const diagnostic = {
    ...diagnosticBody,
    diagnosticRoot: digest(diagnosticBody),
  };
  writeExact(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
  const report = {
    schema: 'kungfu.alpha-local-publication-debug-report/v1',
    status: 'passed',
    mode: 'simulate',
    artifactCount: before.files.length,
    buildRunId: EXPECTED_RUN_ID,
    sourceCommit: EXPECTED_SOURCE,
    sourceTree: EXPECTED_TREE,
    version: EXPECTED_VERSION,
    buildchainSha: buildchain.commit,
    buildchainTree: buildchain.tree,
    buildchainRequiredMerge: BUILDCHAIN_REHEARSAL_MERGE,
    candidateInputRoot: before.root,
    candidateInventoryRoot: candidateInventory.inventoryRoot,
    candidateRegularFileCount: candidateInventory.fileCount,
    capsuleRoot: capsule.root,
    bindingRoot: result.evidence.bindingRoot,
    transactionRoot: result.transaction.transactionRoot,
    stateRoot: result.transaction.stateRoot,
    evidenceRoot: result.evidence.evidenceRoot,
    diagnosticRoot: diagnostic.diagnosticRoot,
    externalPublicationClaimed: false,
    inputUnchanged: true,
    outputRoot,
  };
  writeExact(
    path.join(outputRoot, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

export async function runAlphaLocalPublicationDebug(
  rawOptions,
  injectedRuntime,
) {
  let coordinates;
  try {
    coordinates = validateCoordinates(rawOptions);
    return await runAlphaLocalPublicationDebugInternal(
      coordinates,
      injectedRuntime,
    );
  } catch (caught) {
    /** @type {DebugError} */
    const error = caught instanceof Error ? caught : new Error(String(caught));
    if (coordinates) {
      const outputRoot = path.join(
        coordinates.scratchRoot,
        'alpha-publication-debug',
      );
      const body = {
        contract: 'kungfu.alpha-local-publication-debug-diagnostic/v1',
        status: 'failed',
        code:
          error.alphaDebugCode ||
          error.rehearsalCode ||
          'alpha-local-debug-failed',
        classification:
          error.alphaDebugClass || error.rehearsalClass || 'input',
        message: error.message,
        bindingRoot: error.bindingRoot || '',
      };
      writeExact(
        path.join(outputRoot, 'rehearsal-diagnostic.json'),
        `${JSON.stringify({ ...body, diagnosticRoot: digest(body) }, null, 2)}\n`,
      );
    }
    throw error;
  }
}

export function parseArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith('--') || index + 1 >= args.length)
      throw new Error(`invalid option: ${flag || '<missing>'}`);
    const name = flag.slice(2);
    if (!['artifact-root', 'scratch-root', 'buildchain-root'].includes(name))
      throw new Error(`unknown option: ${flag}`);
    if (Object.hasOwn(options, name))
      throw new Error(`duplicate option: ${flag}`);
    options[name] = args[index + 1];
  }
  for (const name of ['artifact-root', 'scratch-root', 'buildchain-root'])
    required(options[name], `--${name}`);
  return options;
}

export function parsePortableArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith('--') || index + 1 >= args.length)
      throw new Error(`invalid option: ${flag || '<missing>'}`);
    const name = flag.slice(2);
    if (
      ![
        'capsule',
        'capsule-root',
        'buildchain-root',
        'expected-binding-root',
        'expected-transaction-root',
      ].includes(name)
    )
      throw new Error(`unknown option: ${flag}`);
    if (Object.hasOwn(options, name))
      throw new Error(`duplicate option: ${flag}`);
    options[name] = args[index + 1];
  }
  for (const name of [
    'capsule',
    'capsule-root',
    'buildchain-root',
    'expected-binding-root',
    'expected-transaction-root',
  ])
    required(options[name], `--${name}`);
  return options;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'portable-smoke') {
    const options = parsePortableArguments(argv.slice(1));
    const report = await runPortableSmoke({
      capsule: options.capsule,
      capsuleRoot: options['capsule-root'],
      buildchainRoot: options['buildchain-root'],
      expectedBindingRoot: options['expected-binding-root'],
      expectedTransactionRoot: options['expected-transaction-root'],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const options = parseArguments(argv);
  const report = await runAlphaLocalPublicationDebug({
    artifactRoot: options['artifact-root'],
    scratchRoot: options['scratch-root'],
    buildchainRoot: options['buildchain-root'],
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`alpha-local-publication-debug: ${error.message}`);
    process.exitCode = 1;
  });
}
