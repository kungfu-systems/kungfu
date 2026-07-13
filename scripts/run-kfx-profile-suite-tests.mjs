#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(label, command, args, env = process.env) {
  process.stdout.write(`[kfx-profile-suite] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('Node contract fixtures', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/kfx/src/profile-suite.test.ts'),
]);

run('GUI Profile navigation projection', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/gui/src/navigation.test.ts'),
]);

const pythonPath = [
  path.join(root, 'framework/core/src/python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'Python contract fixtures',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework/core'),
    '--frozen',
    'pytest',
    path.join(root, 'framework/core/tests/python/test_kfx_contract.py'),
    '-k',
    'profile_suite',
  ],
  { ...process.env, PYTHONPATH: pythonPath },
);
