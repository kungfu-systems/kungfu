#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const specRoot = path.resolve(__dirname, '..');
const root = path.resolve(specRoot, '..', '..');
const destination = path.join(root, 'product', 'release', 'spec');

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmSpawnOptions(platform = process.platform) {
  return { shell: platform === 'win32' };
}

function main() {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    npmCommand(),
    ['pack', '--pack-destination', destination],
    {
      cwd: specRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...npmSpawnOptions(),
    },
  );
  if (result.error || result.status !== 0) {
    console.error(
      `[spec:pack] failed: ${result.error?.message || `npm pack exited ${result.status}`}`,
    );
    process.exit(1);
  }
  const filename = result.stdout.trim().split('\n').at(-1);
  if (!filename) {
    console.error('[spec:pack] failed: npm pack did not report an artifact');
    process.exit(1);
  }
  console.log(`[spec:pack] ${path.join(destination, filename)}`);
}

if (require.main === module) main();

module.exports = { main, npmCommand, npmSpawnOptions };
