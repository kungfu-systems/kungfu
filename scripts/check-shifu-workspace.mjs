#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATES = path.join(ROOT, 'crates');
const isWin = process.platform === 'win32';

/** @param {string} label @param {string[]} args */
function cargo(label, args) {
  console.log(`[shifu-workspace] ${label}`);
  const result = spawnSync('cargo', args, {
    cwd: CRATES,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(
      `cargo could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
  }
}

try {
  cargo('format', ['fmt', '--all', '--check']);
  cargo('clippy', [
    'clippy',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  cargo('test', ['test', '--workspace']);
  cargo('release build', ['build', '--workspace', '--release']);

  const launcher = path.join(
    CRATES,
    'target',
    'release',
    isWin ? 'shifu.exe' : 'shifu',
  );
  if (!fs.existsSync(launcher)) {
    throw new Error(
      `release launcher missing: ${path.relative(ROOT, launcher)}`,
    );
  }
  const smoke = spawnSync(launcher, ['self-version'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (smoke.error || smoke.status !== 0) {
    throw new Error(
      `launcher self-version failed (exit ${smoke.status ?? smoke.signal ?? smoke.error?.code})`,
    );
  }
  console.log('[shifu-workspace] workspace matrix action passed');
} catch (error) {
  console.error(
    `[shifu-workspace] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
