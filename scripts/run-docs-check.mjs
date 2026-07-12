#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} label @param {string[]} args */
function run(label, args) {
  console.log(`[docs] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(
      `${label} could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
  }
}

try {
  run('Markdown structure', [
    path.join('node_modules', 'markdownlint-cli2', 'markdownlint-cli2-bin.mjs'),
  ]);
  run('local links, anchors, and contracts', [
    path.join('scripts', 'check-docs.mjs'),
  ]);
  run('negative fixtures', [
    '--test',
    path.join('scripts', 'check-docs.test.mjs'),
    path.join('scripts', 'vocabulary-contract.test.mjs'),
  ]);
  console.log('[docs] deterministic documentation gate passed');
} catch (error) {
  console.error(
    `[docs] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
