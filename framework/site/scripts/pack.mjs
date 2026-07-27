#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..', '..');
const destination = path.join(repoRoot, 'product', 'release', 'site');

fs.mkdirSync(destination, { recursive: true });
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  command,
  ['pack', '--foreground-scripts', '--pack-destination', destination],
  {
    cwd: siteRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
if (result.error || result.status !== 0) {
  const output = result.stdout?.trim();
  if (output) console.error(output);
  console.error(
    `[site:pack] failed: ${result.error?.message || `npm pack exited ${result.status}`}`,
  );
  process.exit(1);
}
const filename = result.stdout.trim().split('\n').at(-1);
if (!filename) {
  console.error('[site:pack] failed: npm pack did not report an artifact');
  process.exit(1);
}
console.log(`[site:pack] ${path.join(destination, filename)}`);
