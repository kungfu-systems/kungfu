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
const workloadDir = path.join(
  root,
  'framework',
  'core',
  'tests',
  'qualification',
  'fact-kernel-fold-performance',
);
const common = [
  'run',
  '--project',
  path.join(root, 'framework', 'core'),
  '--frozen',
];
const invocations = [
  [...common, 'pytest', path.join(workloadDir, 'workload_test.py'), '-q'],
  [
    ...common,
    'python',
    path.join(workloadDir, 'workload.py'),
    ...process.argv.slice(2),
  ],
];

for (const invocation of invocations) {
  const result = spawnSync('uv', invocation, {
    cwd: root,
    env: {
      ...process.env,
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
      PYTHONPATH: pythonPath,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[fact-kernel-fold-performance] ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
