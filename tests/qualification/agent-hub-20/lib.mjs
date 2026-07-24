// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const qualificationRoot = path.dirname(
  new URL(import.meta.url).pathname,
);
export const adapterPath = path.join(qualificationRoot, 'adapter.mjs');
export const lockPath = path.join(qualificationRoot, 'kfd-lock.json');

export function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonical(value) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert.equal(Number.isSafeInteger(value) && value >= 0, true);
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export function semanticRoot(value) {
  return sha256(Buffer.from(`${canonical(value)}\n`));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file} must be a regular file`);
  }
  return fs.readFileSync(file);
}

export function validateKfdPackage(kfdRoot) {
  const lock = readJson(lockPath);
  const packageBytes = regular(path.join(kfdRoot, 'package.json'));
  const packageJson = JSON.parse(packageBytes);
  const profileBytes = regular(
    path.join(kfdRoot, 'profiles/agent-hub/manifest.json'),
  );
  const protocolBytes = regular(
    path.join(kfdRoot, 'protocols/agent-hub/manifest.json'),
  );
  const vectorBytes = regular(
    path.join(kfdRoot, 'profiles/agent-hub/vectors/hub-20.json'),
  );
  const inventoryBytes = regular(
    path.join(kfdRoot, 'profiles/agent-hub/failure-codes.json'),
  );
  const verifierBytes = regular(
    path.join(kfdRoot, 'scripts/agent-hub-report-verifier.mjs'),
  );
  const observed = {
    package: packageJson.name,
    version: packageJson.version,
    packageManifestDigest: sha256(packageBytes),
    profileManifestDigest: sha256(profileBytes),
    protocolManifestDigest: sha256(protocolBytes),
    suiteVectorRoot: sha256(vectorBytes),
    failureInventoryRoot: sha256(inventoryBytes),
    verifierArtifactDigest: sha256(verifierBytes),
  };
  for (const field of [
    'package',
    'version',
    'packageManifestDigest',
    'profileManifestDigest',
    'protocolManifestDigest',
    'suiteVectorRoot',
    'failureInventoryRoot',
    'verifierArtifactDigest',
  ]) {
    assert.equal(observed[field], lock[field], `KFD lock drift: ${field}`);
  }
  return { lock, observed };
}

export function exactRequests(kfdRoot) {
  const manifest = readJson(
    path.join(kfdRoot, 'profiles/agent-hub/manifest.json'),
  );
  const registry = readJson(
    path.join(kfdRoot, 'profiles/agent-hub/vectors/hub-20.json'),
  );
  const handshake = {
    schemaVersion: 1,
    contract: 'kfd.agent-hub-adapter-request/v1',
    requestId: 'handshake',
    operation: 'handshake',
    input: {
      profile: `${manifest.protocol.id}@${manifest.protocol.version}`,
      profileManifestDigest: manifest.protocol.manifestDigest,
      suiteRoot: manifest.suite.vectorRoot,
      minimumHubCount: 2,
    },
  };
  const vectors = registry.vectors.map((entry) => ({
    request: {
      schemaVersion: 1,
      contract: 'kfd.agent-hub-adapter-request/v1',
      requestId: entry.id,
      operation: 'evaluate',
      input: {
        category: entry.category,
        scenario: entry.request.scenario,
        input: entry.request.input,
      },
    },
    expect: entry.expect,
  }));
  return { handshake, vectors };
}

export function runAdapter({ kungfu, root, requests }) {
  const result = childProcess.spawnSync(
    process.execPath,
    [adapterPath, '--kungfu', kungfu, '--qualification-root', root],
    {
      input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
      encoding: 'utf8',
      env: { ...process.env, KFD_AGENT_HUB_OFFLINE: '1' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error(
      `adapter failed: status=${result.status} stderr=${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function productIdentity(kungfu) {
  const executable = path.resolve(kungfu);
  const resolvedExecutable = fs.realpathSync(executable);
  const bytes = regular(resolvedExecutable);
  const version = childProcess.spawnSync(executable, ['--version'], {
    encoding: 'utf8',
  });
  if (version.status !== 0) {
    throw new Error(`cannot inspect Kungfu version: ${version.stderr.trim()}`);
  }
  const resources = path.dirname(path.dirname(resolvedExecutable));
  const buildInfoPath = path.join(resources, 'kungfu', 'kungfubuildinfo.json');
  const releaseManifestPath = path.join(
    resources,
    'upgrade',
    'kungfu-release-manifest.json',
  );
  const runtimeEntrypoint = path.join(resources, 'kungfu', 'kungfu');
  const buildInfoBytes = regular(buildInfoPath);
  const releaseManifestBytes = regular(releaseManifestPath);
  const runtimeBytes = regular(runtimeEntrypoint);
  const buildInfo = JSON.parse(buildInfoBytes);
  const releaseManifest = JSON.parse(releaseManifestBytes);
  return {
    installedEntrypoint: executable,
    resolvedExecutable,
    artifactDigest: sha256(bytes),
    runtimeArtifactDigest: sha256(runtimeBytes),
    buildInfoDigest: sha256(buildInfoBytes),
    releaseManifestDigest: sha256(releaseManifestBytes),
    sourceCommit: buildInfo.git.revision,
    sourceBranch: buildInfo.git.branch,
    sourcePristine: buildInfo.git.pristine,
    releaseManifestSourceCommit: releaseManifest.sourceCommit,
    version: version.stdout.trim(),
    platform: { os: os.platform(), arch: os.arch() },
    provenance: 'installed-product',
  };
}

function walkMetadata(root, current, rows, counts) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const stat = fs.lstatSync(absolute);
    const relative = path.relative(root, absolute);
    const type = entry.isDirectory()
      ? 'directory'
      : entry.isSymbolicLink()
        ? 'symlink'
        : entry.isFile()
          ? 'file'
          : 'other';
    rows.push({
      relative,
      type,
      size: stat.size,
      mode: stat.mode,
      mtimeMs: Math.trunc(stat.mtimeMs),
    });
    counts[type] = (counts[type] ?? 0) + 1;
    if (entry.isFile()) counts.totalBytes += stat.size;
    if (entry.isDirectory()) walkMetadata(root, absolute, rows, counts);
  }
}

export function privateHomeSnapshot() {
  const root = path.join(os.homedir(), '.kungfu');
  const counts = {
    file: 0,
    directory: 0,
    symlink: 0,
    other: 0,
    totalBytes: 0,
  };
  const rows = [];
  if (fs.existsSync(root)) walkMetadata(root, root, rows, counts);
  rows.sort((left, right) => left.relative.localeCompare(right.relative));
  return {
    pathClass: 'user-kungfu-home',
    exists: fs.existsSync(root),
    counts,
    metadataRoot: semanticRoot(rows),
    contentRead: false,
  };
}

export function parseOptions(argv, { outputName }) {
  const selected = {
    kungfu: '/usr/local/bin/kungfu',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--kungfu' && value) {
      selected.kungfu = path.resolve(value);
      index += 1;
    } else if (flag === '--kfd-root' && value) {
      selected.kfdRoot = path.resolve(value);
      index += 1;
    } else if (flag === '--output' && value) {
      selected.output = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unsupported or incomplete argument: ${flag}`);
    }
  }
  if (!selected.kfdRoot) throw new Error('--kfd-root is required');
  if (!selected.output)
    throw new Error(`--output is required for ${outputName}`);
  if (!fs.existsSync(path.dirname(selected.output))) {
    throw new Error(
      `output parent does not exist: ${path.dirname(selected.output)}`,
    );
  }
  return selected;
}
