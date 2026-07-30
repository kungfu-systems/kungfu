#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE =
  'lycheeverse/lychee:0.24.2@sha256:e2d19e57cf6ab037026f20b8e449a1f30d9d7f81eef4194763aab2eab20bd28d';
const INPUTS = ['--config', 'lychee.toml', '--no-progress', './**/*.md'];
const isWin = process.platform === 'win32';

/** @param {string} command @param {string[]} args */
function run(command, args) {
  console.log(`[docs:external] $ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) {
    throw new Error(
      `${command} could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `external link check failed (exit ${result.status ?? result.signal})`,
    );
  }
}

/** @param {string} command */
function has(command) {
  return (
    spawnSync(isWin ? 'where' : 'which', [command], { stdio: 'ignore' })
      .status === 0
  );
}

try {
  if (has('lychee')) {
    run('lychee', INPUTS);
  } else if (has('docker')) {
    run('docker', [
      'run',
      '--init',
      '--rm',
      '-w',
      '/input',
      '-v',
      `${ROOT}:/input`,
      IMAGE,
      ...INPUTS,
    ]);
  } else {
    throw new Error(
      'lychee is not installed and Docker is unavailable; use the scheduled Docs External Links workflow or install lychee',
    );
  }
  console.log('[docs:external] external links passed');
} catch (error) {
  console.error(
    `[docs:external] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
