#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error)
    console.error(`[workspace-continuation-test] ${result.error.message}`);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [
  '--test',
  'scripts/check-workspace-continuation.test.mjs',
  'framework/gui/src/main/workspace-selection.test.ts',
]);

const pythonPath = [
  path.join(root, 'framework', 'core', 'src', 'python'),
  path.join(root, 'framework', 'core', 'build', 'Release'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);
run(
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
      'test_workspace.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_workspace_federation.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_assignment_orchestration.py',
    ),
    '-q',
  ],
  { env: { ...process.env, PYTHONPATH: pythonPath } },
);
