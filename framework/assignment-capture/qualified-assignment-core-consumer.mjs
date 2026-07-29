#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { qualifiedAssignmentCoreRoot } from '../../scripts/check-shifu-cache-contract.mjs';
import {
  qualifiedCoreCheckoutRoots,
  validateQualifiedCoreCandidate,
  verifyQualifiedCoreBundle,
} from '../release/qualified-assignment-core-artifact.mjs';

const TARGET_ROOT = 'framework/core/dist/kungfu';
const RECEIPT = '.qualified-core-materialization.json';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 32;
const GITHUB_DOWNLOAD_ATTEMPTS = 3;
const SHA = /^[0-9a-f]{40}$/u;
const ROOT_HASH = /^sha256:[0-9a-f]{64}$/u;

class QualifiedCoreUnavailable extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
}

function bytesRoot(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function safeRelative(value, label) {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new QualifiedCoreUnavailable('unsafe-bundle', label);
  }
  return value;
}

function exactBundleTree(bundleRoot) {
  const top = fs.readdirSync(bundleRoot).sort();
  const expected = [
    'candidate.json',
    'manifest.json',
    'payload',
    'qualification.json',
    'verification.json',
  ];
  if (JSON.stringify(top) !== JSON.stringify(expected)) {
    throw new QualifiedCoreUnavailable(
      'unsupported-bundle-shape',
      top.join(','),
    );
  }
  for (const name of expected.filter((name) => name !== 'payload')) {
    if (!fs.lstatSync(path.join(bundleRoot, name)).isFile()) {
      throw new QualifiedCoreUnavailable('unsupported-bundle-shape', name);
    }
  }
  if (!fs.lstatSync(path.join(bundleRoot, 'payload')).isDirectory()) {
    throw new QualifiedCoreUnavailable('unsupported-bundle-shape', 'payload');
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.binary ? null : 'utf8',
    shell: false,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    throw new QualifiedCoreUnavailable(
      options.reason || 'command-failed',
      command,
    );
  }
  return result.stdout;
}

function git(repositoryRoot, ...args) {
  return String(
    run('git', args, { cwd: repositoryRoot, reason: 'git-fact-unavailable' }),
  ).trim();
}

function repositoryFromRemote(remote) {
  const match = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(
    remote,
  );
  if (!match) {
    throw new QualifiedCoreUnavailable('unsupported-repository-remote');
  }
  return `${match[1]}/${match[2]}`;
}

export function observeQualifiedCoreCheckout(repositoryRoot) {
  const commit = git(repositoryRoot, 'rev-parse', 'HEAD');
  const tree = git(repositoryRoot, 'rev-parse', 'HEAD^{tree}');
  if (!SHA.test(commit) || !SHA.test(tree)) {
    throw new QualifiedCoreUnavailable('invalid-checkout-identity');
  }
  if (git(repositoryRoot, 'status', '--porcelain', '--untracked-files=no')) {
    throw new QualifiedCoreUnavailable('tracked-checkout-dirty');
  }
  return {
    repository: repositoryFromRemote(
      git(repositoryRoot, 'remote', 'get-url', 'origin'),
    ),
    commit,
    tree,
    clean: true,
  };
}

function artifactContract(repositoryRoot) {
  return readJson(
    path.join(repositoryRoot, 'docs/shifu/artifact-contract.json'),
  ).qualifiedAssignmentCore;
}

function verificationExpectation({
  repositoryRoot,
  candidate,
  checkout,
  protectedRef,
  now,
}) {
  const roots = qualifiedCoreCheckoutRoots(repositoryRoot, candidate);
  if (
    artifactContract(repositoryRoot).authority.protectedRefPolicy !==
      'github-default-branch' ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(protectedRef)
  ) {
    throw new QualifiedCoreUnavailable('untrusted-protected-ref');
  }
  return {
    producerRepository: checkout.repository,
    targetRepository: checkout.repository,
    producerCommit: checkout.commit,
    targetCommit: checkout.commit,
    sourceTreeRoot: qualifiedAssignmentCoreRoot({
      schema: 'kungfu.git-source-tree/v1',
      tree: checkout.tree,
    }),
    nativeInputRoot: roots.nativeInputRoot,
    operatingSystem: 'darwin',
    architecture: 'arm64',
    pythonAbi: 'cp313',
    profile: candidate.build.profile,
    toolchainDigest: roots.toolchainDigest,
    dependencyLockDigest: roots.dependencyLockDigest,
    shifuContractVersion: candidate.contracts.shifu.version,
    shifuContractRoot: roots.shifuContractRoot,
    buildchainContractVersion: candidate.contracts.buildchain.version,
    buildchainContractRoot: roots.buildchainContractRoot,
    targetRoot: TARGET_ROOT,
    checkoutClean: true,
    protectedRef,
    promotionAuthorityCandidates: [candidate.candidateRoot],
    now,
  };
}

async function verifyBundle(
  bundleRoot,
  repositoryRoot,
  checkout,
  now,
  transport,
) {
  exactBundleTree(bundleRoot);
  const candidate = readJson(path.join(bundleRoot, 'candidate.json'));
  const qualification = readJson(path.join(bundleRoot, 'qualification.json'));
  const protectedRef =
    transport.protectedRef || qualification.promotionAuthority?.protectedRef;
  validateQualifiedCoreCandidate(candidate, bundleRoot, {
    shared: true,
    repository: checkout.repository,
    commit: checkout.commit,
  });
  const expectation = verificationExpectation({
    repositoryRoot,
    candidate,
    checkout,
    protectedRef,
    now,
  });
  const verification = await verifyQualifiedCoreBundle(
    bundleRoot,
    expectation,
    repositoryRoot,
  );
  return { candidate, qualification, verification, expectation };
}

function cacheRootFromEnvironment() {
  if (process.env.KUNGFU_QUALIFIED_CORE_CACHE_ROOT) {
    return path.resolve(process.env.KUNGFU_QUALIFIED_CORE_CACHE_ROOT);
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'kungfu', 'qualified-core', 'v1');
}

function objectIdentity(verified, transport) {
  return qualifiedAssignmentCoreRoot({
    schema: 'shifu.qualified-assignment-core-local-object/v1',
    manifestRoot: verified.verification.manifestRoot,
    artifactRoot: verified.verification.artifactRoot,
    qualificationReceiptRoot: verified.verification.qualificationReceiptRoot,
    promotionAuthorityRoot: verified.verification.promotionAuthorityRoot,
    transport,
  });
}

function objectPath(cacheRoot, objectRoot) {
  const hex = objectRoot.slice('sha256:'.length);
  return path.join(cacheRoot, 'objects', 'sha256', hex.slice(0, 2), hex);
}

function indexPath(cacheRoot, checkout, objectRoot) {
  return path.join(
    cacheRoot,
    'indexes',
    ...checkout.repository.split('/'),
    checkout.commit,
    `${objectRoot.slice('sha256:'.length)}.json`,
  );
}

function copyBundle(source, destination) {
  exactBundleTree(source);
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

async function retainBundle({
  bundleRoot,
  cacheRoot,
  checkout,
  verified,
  transport,
  repositoryRoot,
  now,
}) {
  const objectRoot = objectIdentity(verified, transport);
  const destination = objectPath(cacheRoot, objectRoot);
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const stage = `${destination}.stage-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.mkdirSync(stage);
      copyBundle(bundleRoot, path.join(stage, 'bundle'));
      writeJson(path.join(stage, 'transport.json'), {
        schema: 'shifu.qualified-assignment-core-transport/v1',
        objectRoot,
        transport,
      });
      try {
        fs.renameSync(stage, destination);
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  const retained = path.join(destination, 'bundle');
  const retainedTransport = readJson(path.join(destination, 'transport.json'));
  const retainedVerification = await verifyBundle(
    retained,
    repositoryRoot,
    checkout,
    now,
    retainedTransport.transport,
  );
  if (
    retainedTransport.objectRoot !== objectRoot ||
    objectIdentity(retainedVerification, retainedTransport.transport) !==
      objectRoot
  ) {
    throw new QualifiedCoreUnavailable('local-object-root-drift');
  }
  const index = indexPath(cacheRoot, checkout, objectRoot);
  fs.mkdirSync(path.dirname(index), { recursive: true });
  if (!fs.existsSync(index)) {
    const temporary = `${index}.stage-${process.pid}-${crypto.randomUUID()}`;
    try {
      writeJson(temporary, {
        schema: 'shifu.qualified-assignment-core-index/v1',
        repository: checkout.repository,
        commit: checkout.commit,
        objectRoot,
      });
      try {
        fs.renameSync(temporary, index);
      } catch (error) {
        if (!fs.existsSync(index)) throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return { bundleRoot: retained, verified: retainedVerification, objectRoot };
}

async function discoverLocal({ cacheRoot, checkout, repositoryRoot, now }) {
  const directory = path.dirname(
    indexPath(cacheRoot, checkout, `sha256:${'0'.repeat(64)}`),
  );
  if (!fs.existsSync(directory)) return null;
  const indexes = fs.readdirSync(directory).sort();
  if (indexes.some((name) => !/^[0-9a-f]{64}\.json$/u.test(name))) {
    throw new QualifiedCoreUnavailable('local-index-drift');
  }
  if (indexes.length > 1) {
    throw new QualifiedCoreUnavailable('ambiguous-local-authority');
  }
  if (indexes.length === 0) return null;
  const index = readJson(path.join(directory, indexes[0]));
  if (
    index.schema !== 'shifu.qualified-assignment-core-index/v1' ||
    index.repository !== checkout.repository ||
    index.commit !== checkout.commit ||
    !ROOT_HASH.test(index.objectRoot)
  ) {
    throw new QualifiedCoreUnavailable('local-index-drift');
  }
  const destination = objectPath(cacheRoot, index.objectRoot);
  const transport = readJson(path.join(destination, 'transport.json'));
  const bundleRoot = path.join(destination, 'bundle');
  const verified = await verifyBundle(
    bundleRoot,
    repositoryRoot,
    checkout,
    now,
    transport.transport,
  );
  if (
    transport.objectRoot !== index.objectRoot ||
    objectIdentity(verified, transport.transport) !== index.objectRoot
  ) {
    throw new QualifiedCoreUnavailable('local-object-root-drift');
  }
  return { bundleRoot, verified, objectRoot: index.objectRoot };
}

function extractZip(bytes, destination) {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new QualifiedCoreUnavailable('archive-too-large');
  }
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > bytes.byteLength) {
    throw new QualifiedCoreUnavailable('invalid-zip-directory');
  }
  const count = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count < 1 || count > MAX_ENTRIES) {
    throw new QualifiedCoreUnavailable('invalid-zip-entry-count');
  }
  fs.mkdirSync(destination);
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (
      cursor + 46 > bytes.byteLength ||
      bytes.readUInt32LE(cursor) !== 0x02014b50
    ) {
      throw new QualifiedCoreUnavailable('invalid-zip-central-entry');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1 || (method !== 0 && method !== 8)) {
      throw new QualifiedCoreUnavailable('unsupported-zip-entry');
    }
    const isDirectory = name.endsWith('/');
    const normalized = safeRelative(
      isDirectory ? name.slice(0, -1) : name,
      'zip entry',
    );
    const mode = (external >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type === 0o120000 || (type && type !== 0o100000 && type !== 0o040000)) {
      throw new QualifiedCoreUnavailable('unsupported-zip-entry-type');
    }
    if (size > MAX_ENTRY_BYTES || total + size > MAX_ARCHIVE_BYTES) {
      throw new QualifiedCoreUnavailable('archive-too-large');
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      method === 0
        ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, {
            maxOutputLength: MAX_ENTRY_BYTES,
          });
    if (data.byteLength !== size) {
      throw new QualifiedCoreUnavailable('zip-entry-size-drift');
    }
    const output = path.join(destination, normalized);
    if (isDirectory) {
      fs.mkdirSync(output, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, data, { flag: 'wx', mode: 0o600 });
    }
    total += size;
  }
}

function ghJson(endpoint) {
  return JSON.parse(
    String(run('gh', ['api', endpoint], { reason: 'github-unavailable' })),
  );
}

function runBinaryToFile(command, args, destination, { maxBytes, reason }) {
  return new Promise((resolve, reject) => {
    let descriptor;
    try {
      descriptor = fs.openSync(destination, 'wx', 0o600);
    } catch {
      reject(new QualifiedCoreUnavailable(reason));
      return;
    }
    let bytes = 0;
    let failure = null;
    let finished = false;
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const complete = (error = null) => {
      if (finished) return;
      finished = true;
      try {
        fs.closeSync(descriptor);
      } catch {
        failure ||= new QualifiedCoreUnavailable(reason);
      }
      if (error || failure) reject(error || failure);
      else resolve({ bytes });
    };
    child.stdout.on('data', (chunk) => {
      if (finished || failure) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        failure = new QualifiedCoreUnavailable('archive-too-large');
        child.kill('SIGTERM');
        return;
      }
      try {
        fs.writeSync(descriptor, chunk);
      } catch {
        failure = new QualifiedCoreUnavailable(reason);
        child.kill('SIGTERM');
      }
    });
    // Provider errors can contain short-lived signed URLs. Drain but never retain
    // or surface those bytes.
    child.stderr.resume();
    child.on('error', () => complete(new QualifiedCoreUnavailable(reason)));
    child.on('close', (code) => {
      if (code !== 0 || bytes === 0) {
        failure ||= new QualifiedCoreUnavailable(reason);
      }
      complete();
    });
  });
}

export async function downloadGithubArtifact({
  repository,
  artifactId,
  destination,
  attempts = GITHUB_DOWNLOAD_ATTEMPTS,
  runAttempt = runBinaryToFile,
}) {
  if (fs.existsSync(destination)) {
    throw new QualifiedCoreUnavailable('github-download-target-dirty');
  }
  const endpoint = `repos/${repository}/actions/artifacts/${artifactId}/zip`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const partial = `${destination}.attempt-${attempt}`;
    try {
      await runAttempt('gh', ['api', endpoint], partial, {
        maxBytes: MAX_ARCHIVE_BYTES + 1024,
        reason: 'github-artifact-download-failed',
      });
      fs.renameSync(partial, destination);
      return destination;
    } catch {
      fs.rmSync(partial, { force: true });
    }
  }
  throw new QualifiedCoreUnavailable('github-artifact-download-failed');
}

async function discoverGithubBundle(checkout, temporary) {
  const name = `qualified-assignment-core-${checkout.commit}`;
  const listing = ghJson(
    `repos/${checkout.repository}/actions/artifacts?name=${name}&per_page=100`,
  );
  const artifacts = (listing.artifacts || []).filter(
    (artifact) => artifact.name === name && artifact.expired === false,
  );
  if (artifacts.length === 0) {
    throw new QualifiedCoreUnavailable('github-artifact-miss');
  }
  if (artifacts.length !== 1) {
    throw new QualifiedCoreUnavailable('ambiguous-github-authority');
  }
  const artifact = artifacts[0];
  const runId = artifact.workflow_run?.id;
  const workflowRun = ghJson(
    `repos/${checkout.repository}/actions/runs/${runId}`,
  );
  const repository = ghJson(`repos/${checkout.repository}`);
  if (
    workflowRun.id !== runId ||
    workflowRun.event !== 'push' ||
    workflowRun.status !== 'completed' ||
    workflowRun.conclusion !== 'success' ||
    workflowRun.head_sha !== checkout.commit ||
    workflowRun.path !==
      '.github/workflows/affected-native-cache-promote.yml' ||
    workflowRun.head_branch !== repository.default_branch
  ) {
    throw new QualifiedCoreUnavailable('untrusted-github-workflow');
  }
  const zip = path.join(temporary, 'artifact.zip');
  await downloadGithubArtifact({
    repository: checkout.repository,
    artifactId: artifact.id,
    destination: zip,
  });
  const bundleRoot = path.join(temporary, 'bundle');
  extractZip(fs.readFileSync(zip), bundleRoot);
  return {
    bundleRoot,
    transport: {
      provider: 'github-workflow-artifact',
      artifactId: artifact.id,
      artifactName: artifact.name,
      runId,
      workflowPath: workflowRun.path,
      event: workflowRun.event,
      protectedRef: `refs/heads/${workflowRun.head_branch}`,
      headSha: workflowRun.head_sha,
    },
  };
}

function verifyTarget(target, candidate, objectRoot) {
  const expectedNames = [
    ...candidate.payload.entries.map((entry) => entry.path),
    RECEIPT,
  ].sort();
  if (
    !fs.existsSync(target) ||
    !fs.lstatSync(target).isDirectory() ||
    fs.lstatSync(target).isSymbolicLink() ||
    JSON.stringify(fs.readdirSync(target).sort()) !==
      JSON.stringify(expectedNames)
  ) {
    throw new QualifiedCoreUnavailable('materialization-target-dirty');
  }
  const receipt = readJson(path.join(target, RECEIPT));
  const { receiptRoot, ...receiptBody } = receipt;
  if (
    receipt.schema !== 'shifu.qualified-assignment-core-materialization/v1' ||
    receipt.objectRoot !== objectRoot ||
    receiptRoot !== qualifiedAssignmentCoreRoot(receiptBody) ||
    receipt.complete !== true
  ) {
    throw new QualifiedCoreUnavailable('materialization-receipt-drift');
  }
  for (const entry of candidate.payload.entries) {
    const file = path.join(target, entry.path);
    const stat = fs.lstatSync(file);
    const bytes =
      entry.type === 'symlink' ? fs.readlinkSync(file) : fs.readFileSync(file);
    if (
      (entry.type === 'symlink' && !stat.isSymbolicLink()) ||
      (entry.type === 'regular-file' && !stat.isFile()) ||
      bytesRoot(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) !==
        entry.digest
    ) {
      throw new QualifiedCoreUnavailable('materialization-payload-drift');
    }
  }
  return receipt;
}

function publishTarget(repositoryRoot, retained, checkout) {
  const target = path.join(repositoryRoot, TARGET_ROOT);
  const targetParent = path.dirname(target);
  if (
    fs.existsSync(targetParent) &&
    (!fs.lstatSync(targetParent).isDirectory() ||
      fs.lstatSync(targetParent).isSymbolicLink())
  ) {
    throw new QualifiedCoreUnavailable('materialization-target-dirty');
  }
  if (fs.existsSync(target)) {
    return {
      status: 'already-materialized',
      receipt: verifyTarget(
        target,
        retained.verified.candidate,
        retained.objectRoot,
      ),
    };
  }
  fs.mkdirSync(targetParent, { recursive: true });
  const stage = `${target}.qualified-core-stage-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(stage);
    for (const entry of retained.verified.candidate.payload.entries) {
      const source = path.join(retained.bundleRoot, 'payload', entry.path);
      const destination = path.join(stage, entry.path);
      if (entry.type === 'symlink') {
        fs.symlinkSync(entry.linkTarget, destination);
      } else {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, entry.mode === '0755' ? 0o755 : 0o644);
      }
    }
    const receiptBody = {
      schema: 'shifu.qualified-assignment-core-materialization/v1',
      repository: checkout.repository,
      commit: checkout.commit,
      objectRoot: retained.objectRoot,
      manifestRoot: retained.verified.verification.manifestRoot,
      artifactRoot: retained.verified.verification.artifactRoot,
      qualificationReceiptRoot:
        retained.verified.verification.qualificationReceiptRoot,
      promotionAuthorityRoot:
        retained.verified.verification.promotionAuthorityRoot,
      targetRoot: TARGET_ROOT,
      complete: true,
    };
    writeJson(path.join(stage, RECEIPT), {
      ...receiptBody,
      receiptRoot: qualifiedAssignmentCoreRoot(receiptBody),
    });
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      if (!fs.existsSync(target)) throw error;
      verifyTarget(target, retained.verified.candidate, retained.objectRoot);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return {
    status: 'materialized',
    receipt: verifyTarget(
      target,
      retained.verified.candidate,
      retained.objectRoot,
    ),
  };
}

export async function materializeQualifiedCoreBundle({
  bundleRoot,
  repositoryRoot,
  publicationRoot = repositoryRoot,
  checkout,
  cacheRoot,
  now = new Date().toISOString(),
  transport = { provider: 'explicit-local-bundle' },
}) {
  const verified = await verifyBundle(
    path.resolve(bundleRoot),
    repositoryRoot,
    checkout,
    now,
    transport,
  );
  const retained = await retainBundle({
    bundleRoot: path.resolve(bundleRoot),
    cacheRoot,
    checkout,
    verified,
    transport,
    repositoryRoot,
    now,
  });
  return { ...publishTarget(publicationRoot, retained, checkout), ...retained };
}

export async function consumeQualifiedCoreForCheckout({
  repositoryRoot,
  publicationRoot = repositoryRoot,
  cacheRoot = cacheRootFromEnvironment(),
  now = new Date().toISOString(),
  checkout: suppliedCheckout = null,
  platform = process.platform,
  architecture = process.arch,
}) {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new QualifiedCoreUnavailable('unsupported-host');
  }
  const checkout =
    suppliedCheckout || observeQualifiedCoreCheckout(repositoryRoot);
  const local = await discoverLocal({
    cacheRoot,
    checkout,
    repositoryRoot,
    now,
  });
  if (local)
    return { ...publishTarget(publicationRoot, local, checkout), ...local };

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-qualified-core-consumer-'),
  );
  try {
    let discovered;
    if (process.env.KUNGFU_QUALIFIED_CORE_BUNDLE) {
      const source = path.resolve(process.env.KUNGFU_QUALIFIED_CORE_BUNDLE);
      if (fs.statSync(source).isDirectory()) {
        discovered = {
          bundleRoot: source,
          transport: { provider: 'explicit-local-bundle' },
        };
      } else {
        const bundleRoot = path.join(temporary, 'bundle');
        extractZip(fs.readFileSync(source), bundleRoot);
        discovered = {
          bundleRoot,
          transport: { provider: 'explicit-local-archive' },
        };
      }
    } else if (process.env.KUNGFU_QUALIFIED_CORE_GITHUB !== '0') {
      discovered = await discoverGithubBundle(checkout, temporary);
    } else {
      throw new QualifiedCoreUnavailable('qualified-core-cache-miss');
    }
    return materializeQualifiedCoreBundle({
      ...discovered,
      repositoryRoot,
      publicationRoot,
      checkout,
      cacheRoot,
      now,
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function diagnosis(error) {
  const reason =
    error instanceof QualifiedCoreUnavailable
      ? error.reason
      : 'qualified-core-verification-failed';
  return {
    schema: 'kungfu.assignment-orchestration.diagnosis/v1',
    ok: false,
    code: 'qualified-core-reuse-unavailable',
    message:
      'No exact verified Qualified Core is reusable for this checkout; assemble Core from current source',
    reason,
    next_actions: [
      {
        action: 'build-core',
        command: './shifu build:core',
        description: 'Assemble pykungfu from the current checkout',
      },
    ],
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'materialize') {
    throw new QualifiedCoreUnavailable('invalid-command');
  }
  let repositoryRoot = '.';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--repository-root' || !args[index + 1]) {
      throw new QualifiedCoreUnavailable('invalid-argument');
    }
    repositoryRoot = args[++index];
  }
  await consumeQualifiedCoreForCheckout({
    repositoryRoot: path.resolve(repositoryRoot),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.log(JSON.stringify(diagnosis(error)));
    process.exitCode = 127;
  });
}
