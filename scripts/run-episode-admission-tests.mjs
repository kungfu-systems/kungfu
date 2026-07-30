#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const contract = spawnSync(
  process.execPath,
  ['--test', 'scripts/check-episode-admission-contract.test.mjs'],
  { cwd: root, stdio: 'inherit' },
);
if (contract.error || contract.status !== 0) process.exit(contract.status ?? 1);

const pythonPath = [
  path.join(root, 'framework', 'core', 'build', 'Release'),
  path.join(root, 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);
const python = spawnSync(
  'uv',
  [
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
      'test_episode_admission.py',
    ),
    '-q',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
      PYTHONPATH: pythonPath,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
if (python.error)
  console.error(`[episode-admission-test] ${python.error.message}`);
if (python.error || python.status !== 0) process.exit(python.status ?? 1);

const typescript = spawnSync(
  'pnpm',
  [
    '--filter',
    '@kungfu-tech/tui',
    'exec',
    'tsx',
    '--test',
    path.join(root, 'framework', 'api', 'tests', 'storage.test.ts'),
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (typescript.error)
  console.error(`[episode-admission-test] ${typescript.error.message}`);
if (typescript.error || typescript.status !== 0)
  process.exit(typescript.status ?? 1);
