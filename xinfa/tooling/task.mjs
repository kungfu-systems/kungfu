#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'Cargo.toml');

function run(label, command, args) {
  console.log(`[xinfa] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.error?.message || result.status}`,
    );
  }
}

function main() {
  const task = process.argv[2] || 'check';
  if (task === 'build') {
    run('build', 'cargo', ['build', '--locked', '--manifest-path', MANIFEST]);
    return;
  }
  if (task === 'standalone') {
    run('standalone smoke', process.execPath, [
      path.join(ROOT, 'tooling', 'standalone-smoke.mjs'),
    ]);
    return;
  }
  if (task === 'fix') {
    run('Rust format', 'cargo', ['fmt', '--manifest-path', MANIFEST]);
    return;
  }
  if (task !== 'check') throw new Error(`unknown task: ${task}`);

  run('boundary contract', process.execPath, [
    path.join(ROOT, 'tooling', 'check-boundary.mjs'),
  ]);
  run('boundary negative fixtures', process.execPath, [
    '--test',
    path.join(ROOT, 'tooling', 'check-boundary.test.mjs'),
  ]);
  run('schema-set contract', process.execPath, [
    path.join(ROOT, 'tooling', 'check-schema-set.mjs'),
  ]);
  run('schema-set negative fixtures', process.execPath, [
    '--test',
    path.join(ROOT, 'tooling', 'check-schema-set.test.mjs'),
  ]);
  run('Rust format', 'cargo', [
    'fmt',
    '--manifest-path',
    MANIFEST,
    '--',
    '--check',
  ]);
  run('Rust lint', 'cargo', [
    'clippy',
    '--locked',
    '--manifest-path',
    MANIFEST,
    '--',
    '-D',
    'warnings',
  ]);
  run('Rust tests', 'cargo', ['test', '--locked', '--manifest-path', MANIFEST]);
}

try {
  main();
} catch (error) {
  console.error(
    `[xinfa] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
