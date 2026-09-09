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

import {
  qualifiedCoreCheckoutRoots,
  validateQualifiedCoreCandidate,
  verifyQualifiedCoreBundle,
} from '@kungfu-tech/product-kungfu/release/qualified-assignment-core-artifact';
import { qualifiedAssignmentCoreRoot } from '@kungfu-tech/workspaces/tooling/check-shifu-cache-contract';
import {
  appendQualifiedCoreUsage,
  qualifiedCoreUsageObservation,
  summarizeQualifiedCoreUsage,
} from './qualified-assignment-core-observability.mjs';
import {
  REQUIRED_ROWS,
  qualifiedCoreArtifactName,
  qualifiedCorePlatformRowForHost,
  qualifiedCorePlatformRowForIdentity,
} from './qualified-assignment-core-platform-matrix.mjs';

const TARGET_ROOT = 'framework/core/dist/kungfu';
const RECEIPT = '.qualified-core-materialization.json';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 32;
const GITHUB_DOWNLOAD_ATTEMPTS = 3;
const HTTP_DOWNLOAD_ATTEMPTS = 3;
const SHA = /^[0-9a-f]{40}$/u;
const ROOT_HASH = /^sha256:[0-9a-f]{64}$/u;
const ACTIVE_CONSUMER_ROWS = new Set(REQUIRED_ROWS);
const TOOL_CACHE_TARGETS = {
  'darwin-arm64': 'macos-aarch64',
  'linux-arm64': 'linux-aarch64',
  'linux-x64': 'linux-x86_64',
  'win32-x64': 'windows-x86_64',
};
const SAFE_CACHE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

class QualifiedCoreUnavailable extends Error {
  constructor(reason, detail = '', context = null) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.context = context;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
}

export function resolveShifuCachedTool({
  tool,
  repositoryRoot = process.cwd(),
  platform = process.platform,
  architecture = process.arch,
  env = process.env,
}) {
  if (tool !== 'uv') return '';
  const pin = path.join(repositoryRoot, '.uv-version');
  const version = String(
    env.KUNGFU_UV_VERSION ||
      (fs.existsSync(pin)
        ? fs
            .readFileSync(pin, 'utf8')
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .find(Boolean)
        : '') ||
      '',
  ).trim();
  const target = TOOL_CACHE_TARGETS[`${platform}-${architecture}`] || '';
  if (!SAFE_CACHE_SEGMENT.test(version) || !SAFE_CACHE_SEGMENT.test(target)) {
    return '';
  }
  const binary = path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'kungfu',
    'tools',
    tool,
    version,
    target,
    platform === 'win32' ? `${tool}.exe` : tool,
  );
  if (!fs.existsSync(binary)) return '';
  const stat = fs.statSync(binary);
  if (!stat.isFile() || (platform !== 'win32' && !(stat.mode & 0o111))) {
    return '';
  }
  return binary;
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
  const base = [
    'candidate.json',
    'manifest.json',
    'payload',
    'qualification.json',
    'verification.json',
  ];
  const expected = fs.existsSync(path.join(bundleRoot, 'equivalence.json'))
    ? [...base, 'equivalence.json'].sort()
    : base;
  if (JSON.stringify(top) !== JSON.stringify([...expected].sort())) {
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
  const checkout = {
    repository: repositoryFromRemote(
      git(repositoryRoot, 'remote', 'get-url', 'origin'),
    ),
    commit,
    tree,
    clean: true,
  };
  if (git(repositoryRoot, 'status', '--porcelain', '--untracked-files=no')) {
    throw new QualifiedCoreUnavailable('tracked-checkout-dirty', '', {
      checkout,
    });
  }
  return checkout;
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
  qualifiedTargetCommit,
  protectedRef,
  now,
  transport,
}) {
  const roots = qualifiedCoreCheckoutRoots(repositoryRoot, candidate);
  const platformRow = qualifiedCorePlatformRowForIdentity(
    {
      operatingSystem: candidate.build.operatingSystem,
      architecture: candidate.build.architecture,
      pythonAbi: candidate.build.pythonAbi,
    },
    repositoryRoot,
  );
  if (transport.platformRow && transport.platformRow !== platformRow.id) {
    throw new QualifiedCoreUnavailable('platform-row-substitution');
  }
  if (
    artifactContract(repositoryRoot).authority.protectedRefPolicy !==
      'github-default-branch' ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(protectedRef)
  ) {
    throw new QualifiedCoreUnavailable('untrusted-protected-ref');
  }
  const targetSourceTreeRoot =
    candidate.source.commit === qualifiedTargetCommit
      ? candidate.source.sourceTreeRoot
      : qualifiedAssignmentCoreRoot({
          schema: 'kungfu.git-source-tree/v1',
          tree: git(
            repositoryRoot,
            'rev-parse',
            `${qualifiedTargetCommit}^{tree}`,
          ),
        });
  return {
    producerRepository: candidate.source.repository,
    targetRepository: checkout.repository,
    producerCommit: candidate.source.commit,
    targetCommit: qualifiedTargetCommit,
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
    commit: candidate.source.commit,
    repositoryRoot,
  });
  const expectation = verificationExpectation({
    repositoryRoot,
    candidate,
    checkout,
    qualifiedTargetCommit: qualification.identity.targetCommit,
    protectedRef,
    now,
    transport,
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
  if (verified.verification.compatibilityIdentity) {
    return qualifiedAssignmentCoreRoot({
      schema: 'shifu.qualified-assignment-core-local-object/v2',
      manifestRoot: verified.verification.manifestRoot,
      artifactRoot: verified.verification.artifactRoot,
      qualificationReceiptRoot: verified.verification.qualificationReceiptRoot,
      promotionAuthorityRoot: verified.verification.promotionAuthorityRoot,
      compatibilityRoot: verified.verification.compatibilityIdentity,
    });
  }
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

function legacyIndexPath(cacheRoot, checkout, objectRoot) {
  return path.join(
    cacheRoot,
    'indexes',
    ...checkout.repository.split('/'),
    checkout.commit,
    `${objectRoot.slice('sha256:'.length)}.json`,
  );
}

function compatibilityIndexPath(
  cacheRoot,
  repository,
  compatibilityRoot,
  objectRoot,
) {
  return path.join(
    cacheRoot,
    'indexes-v2',
    ...repository.split('/'),
    compatibilityRoot.slice('sha256:'.length),
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
  const compatibilityIdentity =
    retainedVerification.verification.compatibilityIdentity || null;
  const index = compatibilityIdentity
    ? compatibilityIndexPath(
        cacheRoot,
        checkout.repository,
        compatibilityIdentity,
        objectRoot,
      )
    : legacyIndexPath(cacheRoot, checkout, objectRoot);
  fs.mkdirSync(path.dirname(index), { recursive: true });
  if (!fs.existsSync(index)) {
    const temporary = `${index}.stage-${process.pid}-${crypto.randomUUID()}`;
    try {
      writeJson(
        temporary,
        compatibilityIdentity
          ? {
              schema: 'shifu.qualified-assignment-core-index/v2',
              repository: checkout.repository,
              producerCommit: retainedVerification.candidate.source.commit,
              qualifiedTargetCommit:
                retainedVerification.qualification.identity.targetCommit,
              compatibilityRoot: compatibilityIdentity,
              objectRoot,
            }
          : {
              schema: 'shifu.qualified-assignment-core-index/v1',
              repository: checkout.repository,
              commit: checkout.commit,
              objectRoot,
            },
      );
      try {
        fs.renameSync(temporary, index);
      } catch (error) {
        if (!fs.existsSync(index)) throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return {
    bundleRoot: retained,
    verified: retainedVerification,
    objectRoot,
    transport: retainedTransport.transport,
  };
}

async function discoverLocal({ cacheRoot, checkout, repositoryRoot, now }) {
  const candidates = [];
  const legacyDirectory = path.dirname(
    legacyIndexPath(cacheRoot, checkout, `sha256:${'0'.repeat(64)}`),
  );
  if (fs.existsSync(legacyDirectory)) {
    for (const name of fs.readdirSync(legacyDirectory).sort()) {
      if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
        throw new QualifiedCoreUnavailable('local-index-drift');
      }
      candidates.push(path.join(legacyDirectory, name));
    }
  }
  const compatibilityDirectory = path.join(
    cacheRoot,
    'indexes-v2',
    ...checkout.repository.split('/'),
  );
  if (fs.existsSync(compatibilityDirectory)) {
    for (const rootName of fs.readdirSync(compatibilityDirectory).sort()) {
      if (!/^[0-9a-f]{64}$/u.test(rootName)) {
        throw new QualifiedCoreUnavailable('local-index-drift');
      }
      const rootDirectory = path.join(compatibilityDirectory, rootName);
      for (const name of fs.readdirSync(rootDirectory).sort()) {
        if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
          throw new QualifiedCoreUnavailable('local-index-drift');
        }
        candidates.push(path.join(rootDirectory, name));
      }
    }
  }
  const matches = [];
  for (const indexFile of candidates) {
    const index = readJson(indexFile);
    if (
      ![
        'shifu.qualified-assignment-core-index/v1',
        'shifu.qualified-assignment-core-index/v2',
      ].includes(index.schema) ||
      index.repository !== checkout.repository ||
      !ROOT_HASH.test(index.objectRoot) ||
      (index.schema.endsWith('/v1') && index.commit !== checkout.commit) ||
      (index.schema.endsWith('/v2') && !ROOT_HASH.test(index.compatibilityRoot))
    ) {
      throw new QualifiedCoreUnavailable('local-index-drift');
    }
    const destination = objectPath(cacheRoot, index.objectRoot);
    const transport = readJson(path.join(destination, 'transport.json'));
    const bundleRoot = path.join(destination, 'bundle');
    if (index.schema.endsWith('/v2')) {
      const candidate = readJson(path.join(bundleRoot, 'candidate.json'));
      const currentCompatibility = qualifiedCoreCheckoutRoots(
        repositoryRoot,
        candidate,
      ).compatibilityRoot;
      if (
        candidate.build?.compatibilityRoot !== index.compatibilityRoot ||
        currentCompatibility !== index.compatibilityRoot
      ) {
        continue;
      }
    }
    const verified = await verifyBundle(
      bundleRoot,
      repositoryRoot,
      checkout,
      now,
      transport.transport,
    );
    if (
      transport.objectRoot !== index.objectRoot ||
      objectIdentity(verified, transport.transport) !== index.objectRoot ||
      (index.schema.endsWith('/v2') &&
        verified.verification.compatibilityIdentity !== index.compatibilityRoot)
    ) {
      throw new QualifiedCoreUnavailable('local-object-root-drift');
    }
    matches.push({
      bundleRoot,
      verified,
      objectRoot: index.objectRoot,
      transport: transport.transport,
    });
  }
  if (matches.length > 1) {
    throw new QualifiedCoreUnavailable('ambiguous-local-authority');
  }
  return matches[0] || null;
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
  expectedBytes = null,
  attempts = GITHUB_DOWNLOAD_ATTEMPTS,
  runAttempt = runBinaryToFile,
}) {
  if (fs.existsSync(destination)) {
    if (
      Number.isSafeInteger(expectedBytes) &&
      expectedBytes > 0 &&
      fs.statSync(destination).size === expectedBytes
    ) {
      return destination;
    }
    fs.rmSync(destination, { force: true });
  }
  const endpoint = `repos/${repository}/actions/artifacts/${artifactId}/zip`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const partial = `${destination}.attempt-${attempt}`;
    fs.rmSync(partial, { force: true });
    try {
      await runAttempt('gh', ['api', endpoint], partial, {
        maxBytes: MAX_ARCHIVE_BYTES + 1024,
        reason: 'github-artifact-download-failed',
      });
      if (
        Number.isSafeInteger(expectedBytes) &&
        expectedBytes > 0 &&
        fs.statSync(partial).size !== expectedBytes
      ) {
        throw new QualifiedCoreUnavailable(
          'github-artifact-download-size-drift',
        );
      }
      fs.renameSync(partial, destination);
      return destination;
    } catch {
      fs.rmSync(partial, { force: true });
    }
  }
  throw new QualifiedCoreUnavailable('github-artifact-download-failed');
}

function checkedHttpProviderUrl(baseUrl, artifactId) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new QualifiedCoreUnavailable('invalid-http-provider-url');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new QualifiedCoreUnavailable('invalid-http-provider-url');
  }
  const basePath = parsed.pathname.endsWith('/')
    ? parsed.pathname
    : `${parsed.pathname}/`;
  parsed.pathname = `${basePath}qualified-core/${artifactId}.zip`;
  return parsed.href;
}

export async function downloadHttpArtifact({
  url,
  destination,
  expectedBytes,
  attempts = HTTP_DOWNLOAD_ATTEMPTS,
  fetchImpl = globalThis.fetch,
}) {
  const partial = `${destination}.partial`;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new QualifiedCoreUnavailable('http-artifact-size-invalid');
  }
  if (
    fs.existsSync(destination) &&
    fs.statSync(destination).size === expectedBytes
  ) {
    return destination;
  }
  fs.rmSync(destination, { force: true });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (offset > expectedBytes) {
      fs.truncateSync(partial, 0);
      offset = 0;
    }
    if (offset === expectedBytes) {
      fs.renameSync(partial, destination);
      return destination;
    }
    try {
      const response = await fetchImpl(url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        redirect: 'follow',
      });
      let append = offset > 0;
      if (offset > 0 && response.status === 200) {
        fs.truncateSync(partial, 0);
        offset = 0;
        append = false;
      } else if (offset > 0) {
        const contentRange = response.headers.get('content-range');
        if (
          response.status !== 206 ||
          !contentRange?.startsWith(`bytes ${offset}-`) ||
          !contentRange.endsWith(`/${expectedBytes}`)
        ) {
          throw new QualifiedCoreUnavailable('http-resume-rejected');
        }
      } else if (response.status !== 200) {
        throw new QualifiedCoreUnavailable('http-artifact-download-failed');
      }
      if (!response.body) {
        throw new QualifiedCoreUnavailable('http-artifact-download-failed');
      }
      const descriptor = fs.openSync(partial, append ? 'a' : 'w', 0o600);
      let bytes = offset;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > expectedBytes || bytes > MAX_ARCHIVE_BYTES) {
            throw new QualifiedCoreUnavailable('archive-too-large');
          }
          fs.writeSync(descriptor, chunk);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      if (bytes !== expectedBytes) {
        throw new QualifiedCoreUnavailable('http-artifact-size-drift');
      }
      fs.renameSync(partial, destination);
      return destination;
    } catch {
      if (attempt === attempts) {
        throw new QualifiedCoreUnavailable('http-artifact-download-failed');
      }
    }
  }
  throw new QualifiedCoreUnavailable('http-artifact-download-failed');
}

function transferState(cacheRoot, checkout, artifact, platformRowId) {
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_ARCHIVE_BYTES
  ) {
    throw new QualifiedCoreUnavailable('invalid-github-artifact-identity');
  }
  const directory = path.join(
    cacheRoot,
    'transfers',
    ...checkout.repository.split('/'),
    String(artifact.id),
  );
  const identityBody = {
    schema: 'shifu.qualified-assignment-core-transfer/v1',
    repository: checkout.repository,
    artifactId: artifact.id,
    artifactName: artifact.name,
    platformRow: platformRowId,
    expectedBytes: artifact.size_in_bytes,
  };
  const identity = {
    ...identityBody,
    transferRoot: qualifiedAssignmentCoreRoot(identityBody),
  };
  fs.mkdirSync(directory, { recursive: true });
  const identityPath = path.join(directory, 'identity.json');
  if (fs.existsSync(identityPath)) {
    if (JSON.stringify(readJson(identityPath)) !== JSON.stringify(identity)) {
      throw new QualifiedCoreUnavailable('transfer-identity-drift');
    }
  } else {
    writeJson(identityPath, identity);
  }
  return directory;
}

export async function discoverGithubBundle(
  checkout,
  temporary,
  {
    cacheRoot,
    clock = () => Date.now(),
    httpBaseUrl = process.env.KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL || '',
    githubJson = ghJson,
    downloadHttp = downloadHttpArtifact,
    downloadGithub = downloadGithubArtifact,
    platformRowId = 'darwin-arm64-cp313',
  } = {},
) {
  const discoveryStarted = clock();
  const name = qualifiedCoreArtifactName(
    'promoted',
    checkout.commit,
    platformRowId,
  );
  const listing = githubJson(
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
  const workflowRun = githubJson(
    `repos/${checkout.repository}/actions/runs/${runId}`,
  );
  const repository = githubJson(`repos/${checkout.repository}`);
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
  const discovery = elapsed(discoveryStarted, clock);
  const transferRoot = transferState(
    cacheRoot,
    checkout,
    artifact,
    platformRowId,
  );
  let zip = '';
  const transferStarted = clock();
  let provider = 'github-workflow-artifact';
  if (httpBaseUrl) {
    const httpZip = path.join(transferRoot, 'office-http-artifact.zip');
    try {
      await downloadHttp({
        url: checkedHttpProviderUrl(httpBaseUrl, artifact.id),
        destination: httpZip,
        expectedBytes: artifact.size_in_bytes,
      });
      zip = httpZip;
      provider = 'office-http-artifact';
    } catch (error) {
      if (error?.reason === 'invalid-http-provider-url') throw error;
    }
  }
  if (!zip) {
    const githubZip = path.join(transferRoot, 'github-workflow-artifact.zip');
    await downloadGithub({
      repository: checkout.repository,
      artifactId: artifact.id,
      destination: githubZip,
      expectedBytes: artifact.size_in_bytes,
    });
    zip = githubZip;
  }
  const transfer = elapsed(transferStarted, clock);
  const bundleRoot = path.join(temporary, 'bundle');
  try {
    extractZip(fs.readFileSync(zip), bundleRoot);
  } catch (error) {
    fs.rmSync(transferRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    bundleRoot,
    phaseDurations: { discovery, transfer },
    transferRoot,
    transport: {
      provider,
      artifactId: artifact.id,
      artifactName: artifact.name,
      runId,
      workflowPath: workflowRun.path,
      event: workflowRun.event,
      protectedRef: `refs/heads/${workflowRun.head_branch}`,
      headSha: workflowRun.head_sha,
      platformRow: platformRowId,
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
  const supportedReceipt = [
    'shifu.qualified-assignment-core-materialization/v1',
    'shifu.qualified-assignment-core-materialization/v2',
  ].includes(receipt.schema);
  if (
    !supportedReceipt ||
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
      schema: retained.verified.verification.compatibilityIdentity
        ? 'shifu.qualified-assignment-core-materialization/v2'
        : 'shifu.qualified-assignment-core-materialization/v1',
      repository: checkout.repository,
      commit: checkout.commit,
      ...(retained.verified.verification.compatibilityIdentity
        ? {
            producerCommit: retained.verified.candidate.source.commit,
            qualifiedTargetCommit:
              retained.verified.qualification.identity.targetCommit,
            compatibilityRoot:
              retained.verified.verification.compatibilityIdentity,
          }
        : {}),
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

function elapsed(start, clock) {
  return Math.max(0, Math.round(clock() - start));
}

function usageArtifact(result) {
  if (!result?.verified || !result?.objectRoot) return null;
  return {
    transportProvider: result.transport?.provider || 'unknown',
    artifactId:
      Number.isSafeInteger(result.transport?.artifactId) &&
      result.transport.artifactId > 0
        ? result.transport.artifactId
        : null,
    artifactRoot: result.verified.verification.artifactRoot || null,
    manifestRoot: result.verified.verification.manifestRoot || null,
    objectRoot: result.objectRoot,
  };
}

function terminalUsage({
  cacheRoot,
  checkout,
  platform,
  architecture,
  recordedAt,
  result,
  reason,
  phases,
  materialization = null,
}) {
  return appendQualifiedCoreUsage(
    cacheRoot,
    qualifiedCoreUsageObservation({
      recordedAt,
      result,
      reason,
      phases,
      repository: checkout.repository,
      sourceCommit: checkout.commit,
      compatibilityIdentity:
        materialization?.verified?.verification?.compatibilityIdentity || null,
      platform,
      architecture,
      pythonAbi: 'cp313',
      artifact: usageArtifact(materialization),
      fallback: {
        required: ['fallback-required', 'rejected'].includes(result),
        command: ['fallback-required', 'rejected'].includes(result)
          ? './shifu build:core'
          : '',
      },
    }),
  );
}

function terminalResult(error) {
  if (
    error instanceof QualifiedCoreUnavailable &&
    [
      'github-artifact-download-failed',
      'github-artifact-miss',
      'github-unavailable',
      'qualified-core-cache-miss',
      'tracked-checkout-dirty',
      'unsupported-host',
    ].includes(error.reason)
  ) {
    return 'fallback-required';
  }
  return 'rejected';
}

export async function consumeQualifiedCoreForCheckout({
  repositoryRoot,
  publicationRoot = repositoryRoot,
  cacheRoot = cacheRootFromEnvironment(),
  now = new Date().toISOString(),
  checkout: suppliedCheckout = null,
  platform = process.platform,
  architecture = process.arch,
  clock = () => Date.now(),
  discoverRemote = discoverGithubBundle,
}) {
  const started = clock();
  let phaseStarted = started;
  const phases = {};
  let checkout = suppliedCheckout;
  let platformRow = null;
  let recorded = false;
  try {
    checkout ||= observeQualifiedCoreCheckout(repositoryRoot);
    phases.checkout = elapsed(phaseStarted, clock);
    phaseStarted = clock();
    try {
      platformRow = qualifiedCorePlatformRowForHost(platform, architecture);
    } catch {
      throw new QualifiedCoreUnavailable('unsupported-host');
    }
    // Consumer activation is admitted one platform Assignment at a time even
    // though all rows share the same producer and verification contracts.
    if (!ACTIVE_CONSUMER_ROWS.has(platformRow.id)) {
      throw new QualifiedCoreUnavailable('unsupported-host');
    }
    const local = await discoverLocal({
      cacheRoot,
      checkout,
      repositoryRoot,
      now,
    });
    phases.localLookup = elapsed(phaseStarted, clock);
    phaseStarted = clock();
    if (local) {
      const materialization = {
        ...publishTarget(publicationRoot, local, checkout),
        ...local,
      };
      phases.publication = elapsed(phaseStarted, clock);
      phases.total = elapsed(started, clock);
      recorded = true;
      terminalUsage({
        cacheRoot,
        checkout,
        platform,
        architecture,
        recordedAt: now,
        result: materialization.status,
        reason: 'local-cas-hit',
        phases,
        materialization,
      });
      return materialization;
    }

    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-qualified-core-consumer-'),
    );
    let transferCleanup = null;
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
        discovered = await discoverRemote(checkout, temporary, {
          cacheRoot,
          clock,
          platformRowId: platformRow.id,
        });
      } else {
        throw new QualifiedCoreUnavailable('qualified-core-cache-miss');
      }
      phases.remoteLookup = elapsed(phaseStarted, clock);
      transferCleanup = discovered.transferRoot || null;
      phases.discovery = discovered.phaseDurations?.discovery || 0;
      phases.transfer =
        discovered.phaseDurations?.transfer ??
        Math.max(0, phases.remoteLookup - phases.discovery);
      phaseStarted = clock();
      const verified = await verifyBundle(
        discovered.bundleRoot,
        repositoryRoot,
        checkout,
        now,
        discovered.transport,
      );
      phases.verification = elapsed(phaseStarted, clock);
      phaseStarted = clock();
      const retained = await retainBundle({
        bundleRoot: discovered.bundleRoot,
        cacheRoot,
        checkout,
        verified,
        transport: discovered.transport,
        repositoryRoot,
        now,
      });
      phases.retention = elapsed(phaseStarted, clock);
      phases.verificationAndRetention = phases.verification + phases.retention;
      phaseStarted = clock();
      const materialization = {
        ...publishTarget(publicationRoot, retained, checkout),
        ...retained,
      };
      phases.publication = elapsed(phaseStarted, clock);
      phases.total = elapsed(started, clock);
      recorded = true;
      terminalUsage({
        cacheRoot,
        checkout,
        platform,
        architecture,
        recordedAt: now,
        result: materialization.status,
        reason: discovered.transport.provider.startsWith('explicit-')
          ? 'explicit-bundle-hit'
          : 'remote-hit',
        phases,
        materialization,
      });
      return materialization;
    } finally {
      if (transferCleanup) {
        fs.rmSync(transferCleanup, { recursive: true, force: true });
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    checkout ||= error?.context?.checkout || null;
    if (!recorded && checkout) {
      phases.total = elapsed(started, clock);
      recorded = true;
      terminalUsage({
        cacheRoot,
        checkout,
        platform,
        architecture,
        recordedAt: now,
        result: terminalResult(error),
        reason:
          error instanceof QualifiedCoreUnavailable
            ? error.reason
            : 'verification-failed',
        phases,
      });
    }
    throw error;
  }
}

export function qualifiedCoreUsageStatus({
  repositoryRoot,
  cacheRoot = cacheRootFromEnvironment(),
  platform = process.platform,
  architecture = process.arch,
}) {
  const checkout = observeQualifiedCoreCheckout(repositoryRoot);
  let eligible = false;
  try {
    eligible = ACTIVE_CONSUMER_ROWS.has(
      qualifiedCorePlatformRowForHost(platform, architecture).id,
    );
  } catch {
    eligible = false;
  }
  return summarizeQualifiedCoreUsage(cacheRoot, {
    repository: checkout.repository,
    sourceCommit: checkout.commit,
    platform,
    architecture,
    pythonAbi: 'cp313',
    eligible,
  });
}

export function runQualifiedCoreUsageStatusCommand(
  args,
  { defaultRepositoryRoot = '.' } = {},
) {
  if (args[0] !== 'status') {
    throw new QualifiedCoreUnavailable('invalid-command');
  }
  let repositoryRoot = defaultRepositoryRoot;
  let cacheRoot;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--json') {
      // The status surface is always JSON; retain the flag for CLI symmetry.
    } else if (args[index] === '--repository-root' && args[index + 1]) {
      repositoryRoot = args[++index];
    } else if (args[index] === '--cache-root' && args[index + 1]) {
      cacheRoot = args[++index];
    } else {
      throw new QualifiedCoreUnavailable('invalid-argument');
    }
  }
  return qualifiedCoreUsageStatus({
    repositoryRoot: path.resolve(repositoryRoot),
    cacheRoot: cacheRoot ? path.resolve(cacheRoot) : undefined,
  });
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
  if (command === 'resolve-cached-tool') {
    const resolved =
      args.length === 1 ? resolveShifuCachedTool({ tool: args[0] }) : '';
    if (resolved) process.stdout.write(`${resolved}\n`);
    return;
  }
  if (!['materialize', 'status'].includes(command)) {
    throw new QualifiedCoreUnavailable('invalid-command');
  }
  let repositoryRoot = '.';
  let cacheRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') {
      // The status surface is always JSON; retain the flag for CLI symmetry.
    } else if (args[index] === '--repository-root' && args[index + 1]) {
      repositoryRoot = args[++index];
    } else if (args[index] === '--cache-root' && args[index + 1]) {
      cacheRoot = args[++index];
    } else {
      throw new QualifiedCoreUnavailable('invalid-argument');
    }
  }
  if (command === 'status') {
    console.log(
      JSON.stringify(
        runQualifiedCoreUsageStatusCommand([
          'status',
          '--repository-root',
          repositoryRoot,
          ...(cacheRoot ? ['--cache-root', cacheRoot] : []),
        ]),
        null,
        2,
      ),
    );
    return;
  }
  await consumeQualifiedCoreForCheckout({
    repositoryRoot: path.resolve(repositoryRoot),
    cacheRoot: cacheRoot ? path.resolve(cacheRoot) : undefined,
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
