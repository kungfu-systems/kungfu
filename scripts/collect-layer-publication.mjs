#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function rejectRetiredDesktopArtifact(name) {
  if (/^Kungfu(?:[ -])Episodes.*\.(?:dmg|AppImage|exe)$/u.test(name))
    fail(`retired desktop product artifact name is not publishable: ${name}`);
}

function classify(file) {
  const name = path.basename(file);
  rejectRetiredDesktopArtifact(name);
  if (/^kungfu-tech-.+\.tgz$/.test(name)) return 'npm';
  if (/^kungfu_storage-.+\.whl$/.test(name)) return 'pypi';
  if (/^kungfu-sdk-.+\.crate$/.test(name)) return 'cargo';
  if (/^kungfu-cli-.+\.(?:tar\.gz|zip)$/.test(name)) return 'github';
  if (/^Kungfu-\d+\.\d+\.\d+.+\.dmg$/u.test(name)) return 'github';
  if (/^Kungfu-\d+\.\d+\.\d+.+\.AppImage$/u.test(name)) return 'github';
  if (/^Kungfu Setup \d+\.\d+\.\d+.+\.exe$/u.test(name)) return 'github';
  return '';
}

function expectedCounts(entries, expectedNpmCount) {
  const counts = Object.fromEntries(
    ['npm', 'pypi', 'cargo', 'github'].map((kind) => [
      kind,
      entries.filter((entry) => entry.kind === kind).length,
    ]),
  );
  const expected = { npm: expectedNpmCount, pypi: 3, cargo: 1, github: 6 };
  for (const [kind, count] of Object.entries(expected)) {
    if (counts[kind] !== count)
      fail(`expected ${count} unique ${kind} artifacts, found ${counts[kind]}`);
  }
}

function readExpectedNpmCount() {
  const npmRegistry = JSON.parse(
    fs.readFileSync(
      path.resolve('framework/release/npm-package-registry.json'),
      'utf8',
    ),
  );
  const expectedNpmCount = npmRegistry.releaseInventory?.expectedPackageCount;
  if (!Number.isInteger(expectedNpmCount))
    fail('npm package registry lacks an integer expectedPackageCount');
  return expectedNpmCount;
}

function main() {
  const args = process.argv.slice(2);
  const input = args[args.indexOf('--input') + 1];
  const output = args[args.indexOf('--output') + 1];
  if (!input || !output)
    fail('usage: collect-layer-publication.mjs --input DIR --output DIR');
  const sourceRoot = path.resolve(input);
  const outputRoot = path.resolve(output);
  const expectedNpmCount = readExpectedNpmCount();
  if (!fs.existsSync(sourceRoot)) fail(`input does not exist: ${sourceRoot}`);
  if (fs.existsSync(outputRoot))
    fail(`refusing to replace an existing output directory: ${outputRoot}`);
  const byName = new Map();
  for (const file of walk(sourceRoot)) {
    const kind = classify(file);
    if (!kind) continue;
    const name = path.basename(file);
    const digest = sha256(file);
    const existing = byName.get(name);
    if (existing && existing.digest !== digest)
      fail(`same publication basename has divergent content: ${name}`);
    if (!existing) byName.set(name, { kind, name, digest, source: file });
  }
  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  expectedCounts(entries, expectedNpmCount);
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const entry of entries) {
    const directory = path.join(outputRoot, entry.kind);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(entry.source, path.join(directory, entry.name));
  }
  const manifest = {
    schema: 'kungfu.layer-publication.staging-manifest/v1',
    artifacts: entries.map(({ source: _source, ...entry }) => entry),
  };
  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `[layer-publication] staged ${entries.length} exact artifacts at ${outputRoot}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[layer-publication] collect failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
