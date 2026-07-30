#!/usr/bin/env node

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
      'test_fact_kernel_integrity.py',
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
  console.error(`[fact-kernel-integrity-test] ${result.error.message}`);
process.exit(result.status ?? 1);
