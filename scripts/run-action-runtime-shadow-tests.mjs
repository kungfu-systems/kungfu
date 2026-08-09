#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const pythonPath = [
  path.join(root, 'framework', 'core', 'build', 'Release'),
  path.join(root, 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

const result = spawnSync(
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
      'test_action_runtime_shadow.py',
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

if (result.error)
  console.error(`[action-runtime-shadow-test] ${result.error.message}`);
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
