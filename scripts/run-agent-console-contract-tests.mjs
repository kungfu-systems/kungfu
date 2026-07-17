#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const pythonPath = [
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
      'test_agent_console_contract.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_rewind_progress.py',
    ),
    '-q',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: pythonPath,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[agent-console-contract-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}
