#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';

import tar from 'tar-stream';

import {
  platformCommand,
  platformCommandOptions,
} from './platform-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'release',
  'npm-package-registry.json',
);

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

async function readPackedEntries(archive) {
  const extract = tar.extract();
  const entries = [];
  extract.on('entry', (header, stream, next) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      entries.push({ header, body: Buffer.concat(chunks) });
      next();
    });
    stream.resume();
  });
  await pipeline(fs.createReadStream(archive), createGunzip(), extract);
  return entries;
}

function canonicalTarHeader(header, body) {
  return Object.fromEntries(
    Object.entries({
      name: header.name,
      mode: header.mode,
      uid: 0,
      gid: 0,
      size: body.length,
      mtime: new Date(0),
      type: header.type,
      linkname: header.linkname,
      uname: '',
      gname: '',
      devmajor: header.devmajor,
      devminor: header.devminor,
    }).filter(([, value]) => value !== undefined),
  );
}

function normalizeGzipHeader(archive) {
  const descriptor = fs.openSync(archive, 'r+');
  try {
    const header = Buffer.alloc(10);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length)
      fail(`canonical npm archive is truncated: ${archive}`);
    if (header[0] !== 0x1f || header[1] !== 0x8b)
      fail(`canonical npm archive has an invalid gzip header: ${archive}`);
    header.fill(0, 4, 8);
    header[9] = 0xff;
    fs.writeSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function canonicalizePackedArchive(archive) {
  const entries = await readPackedEntries(archive);
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.header.name))
      fail(`npm archive contains duplicate entry: ${entry.header.name}`);
    names.add(entry.header.name);
    if (entry.header.name === 'package/package.json') {
      const manifest = JSON.parse(entry.body.toString('utf8'));
      entry.body = Buffer.from(
        `${JSON.stringify(canonicalJson(manifest), null, 2)}\n`,
      );
    }
  }
  if (!names.has('package/package.json'))
    fail(`npm archive is missing package/package.json: ${archive}`);
  entries.sort((left, right) =>
    left.header.name < right.header.name
      ? -1
      : left.header.name > right.header.name
        ? 1
        : 0,
  );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-canonical-'),
  );
  const output = path.join(temporary, path.basename(archive));
  try {
    const pack = tar.pack();
    const write = pipeline(
      pack,
      createGzip({ level: 9 }),
      fs.createWriteStream(output),
    );
    for (const entry of entries) {
      await new Promise((resolve, reject) => {
        pack.entry(
          canonicalTarHeader(entry.header, entry.body),
          entry.body,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
    pack.finalize();
    await write;
    normalizeGzipHeader(output);
    fs.copyFileSync(output, archive);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function npmArchiveName(packageName, version) {
  return `${packageName.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

export function npmDistributionTag(version) {
  if (/-alpha\./u.test(version)) return 'alpha';
  if (/-beta\./u.test(version)) return 'beta';
  if (/-rc\./u.test(version)) return 'next';
  if (!version.includes('-')) return 'latest';
  fail(`unsupported npm prerelease channel: ${version}`);
}

export function bulkWorkspaceEntries(registry) {
  const dedicated = new Set(registry.workspacePacking?.dedicatedPackages || []);
  return (registry.packages || []).filter(
    (entry) => entry.kind === 'workspace' && !dedicated.has(entry.name),
  );
}

export function collectPublishabilityIssues({
  root = ROOT,
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')),
} = {}) {
  const issues = [];
  const names = (registry.packages || []).map((entry) => entry.name);
  const exactArtifacts =
    registry.trustedPublishing?.exactArtifactPackages || [];
  if (
    names.length !== registry.releaseInventory?.expectedPackageCount ||
    names.length !== 29
  )
    issues.push('release inventory must contain exactly 29 packages');
  if (
    exactArtifacts.length !== names.length ||
    JSON.stringify([...exactArtifacts].sort()) !==
      JSON.stringify([...names].sort())
  )
    issues.push(
      'every registered package must be an exact publication artifact',
    );
  const expectedVersion = JSON.parse(
    fs.readFileSync(
      path.join(root, registry.releaseInventory.versionAuthority),
    ),
  ).version;
  const workspaceEntries = (registry.packages || []).filter(
    (entry) => entry.kind === 'workspace',
  );
  for (const entry of workspaceEntries) {
    const packagePath = path.join(root, entry.source);
    if (!fs.existsSync(packagePath)) {
      issues.push(`${entry.name}: source is missing`);
      continue;
    }
    const source = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (source.name !== entry.name)
      issues.push(`${entry.name}: source name does not match`);
    if (Object.hasOwn(source, 'private'))
      issues.push(`${entry.name}: private must be removed`);
    if (source.version !== expectedVersion)
      issues.push(`${entry.name}: version must be ${expectedVersion}`);
    if (
      source.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
      source.publishConfig?.access !== 'public'
    )
      issues.push(`${entry.name}: npmjs public publishConfig is required`);
  }
  const bulk = bulkWorkspaceEntries(registry);
  if (bulk.length !== registry.workspacePacking?.bulkPackageCount)
    issues.push(
      `bulk workspace package count must be ${registry.workspacePacking?.bulkPackageCount}, found ${bulk.length}`,
    );
  return issues;
}

export function validateStagedNpmArtifacts(manifest, registry, version) {
  const npmArtifacts = (manifest.artifacts || []).filter(
    (entry) => entry.kind === 'npm',
  );
  const expected = new Map(
    registry.packages.map((entry) => [
      npmArchiveName(entry.name, version),
      entry.name,
    ]),
  );
  if (npmArtifacts.length !== expected.size)
    fail(
      `expected ${expected.size} npm artifacts, found ${npmArtifacts.length}`,
    );
  const byName = new Map(npmArtifacts.map((entry) => [entry.name, entry]));
  for (const [archive, packageName] of expected) {
    if (!byName.has(archive))
      fail(`${packageName} exact staged archive is missing: ${archive}`);
  }
  for (const artifact of npmArtifacts) {
    if (!expected.has(artifact.name))
      fail(`unexpected npm archive: ${artifact.name}`);
  }
  return byName;
}

function runPack(packageRoot, outputRoot) {
  const result = spawnSync(
    platformCommand('pnpm'),
    ['pack', '--pack-destination', outputRoot],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...platformCommandOptions('pnpm'),
    },
  );
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(
      `pnpm pack failed for ${path.relative(ROOT, packageRoot)} (status=${result.status})`,
    );
  }
  console.log(`[npm-release] packed ${path.relative(ROOT, packageRoot)}`);
}

export async function packPortableWorkspacePackages({
  root = ROOT,
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')),
  output = path.join(ROOT, 'product', 'release', 'npm'),
} = {}) {
  const issues = collectPublishabilityIssues({ root, registry });
  if (issues.length > 0) fail(issues.join('; '));
  const version = JSON.parse(
    fs.readFileSync(
      path.join(root, registry.releaseInventory.versionAuthority),
    ),
  ).version;
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-release-inventory-'),
  );
  const packed = [];
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const entry of bulkWorkspaceEntries(registry)) {
      runPack(path.dirname(path.join(root, entry.source)), temporary);
      const archive = npmArchiveName(entry.name, version);
      const source = path.join(temporary, archive);
      if (!fs.existsSync(source))
        fail(`${entry.name} did not produce ${archive}`);
      await canonicalizePackedArchive(source);
      const target = path.join(output, archive);
      if (fs.existsSync(target) && sha256(target) !== sha256(source))
        fail(`${entry.name} conflicts with an existing staged archive`);
      fs.copyFileSync(source, target);
      packed.push({
        name: entry.name,
        archive,
        sha256: sha256(source),
      });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const receipt = {
    schema: 'kungfu.npm-portable-workspace-packages/v1',
    version,
    packageCount: packed.length,
    packages: packed,
  };
  fs.writeFileSync(
    path.join(output, 'portable-workspace-packages.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(
    `[npm-release] staged ${packed.length} portable workspace packages`,
  );
  return receipt;
}

async function main(argv = process.argv.slice(2)) {
  const distTagIndex = argv.indexOf('--dist-tag');
  if (distTagIndex >= 0) {
    const version = argv[distTagIndex + 1];
    if (!version) fail('--dist-tag requires a version');
    console.log(npmDistributionTag(version));
    return;
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const issues = collectPublishabilityIssues({ registry });
  if (issues.length > 0) fail(issues.join('; '));
  if (argv.includes('--check')) {
    console.log('[npm-release] all 29 package sources are public and packable');
    return;
  }
  if (process.platform !== 'linux' && !argv.includes('--force')) {
    console.log(
      `[npm-release] publishability passed; portable pack owner is linux (current=${process.platform})`,
    );
    return;
  }
  const outputIndex = argv.indexOf('--output');
  const outputValue = outputIndex >= 0 ? argv[outputIndex + 1] : '';
  if (outputIndex >= 0 && !outputValue) fail('--output requires a path');
  const output =
    outputIndex >= 0
      ? path.resolve(outputValue)
      : path.join(ROOT, 'product', 'release', 'npm');
  await packPortableWorkspacePackages({ registry, output });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[npm-release] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
