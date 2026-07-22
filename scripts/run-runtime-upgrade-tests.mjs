#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runtimeUpgradeUvCommand(args, platform = process.platform) {
  return {
    command: path.join(root, platform === 'win32' ? 'shifu.cmd' : 'shifu'),
    args: ['exec', 'uv', ...args],
  };
}

export function runRuntimeUpgradeTests() {
  const pythonPath = [
    path.join(root, 'framework', 'core', 'src', 'python'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const uv = runtimeUpgradeUvCommand([
    'run',
    '--project',
    path.join(root, 'framework', 'core'),
    '--frozen',
    'pytest',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_runtime_upgrade.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_distribution_update.py',
    ),
    '-q',
  ]);
  const result = spawnSync(uv.command, uv.args, {
    cwd: root,
    env: { ...process.env, PYTHONPATH: pythonPath },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[runtime-upgrade-test] ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(runRuntimeUpgradeTests());
}
