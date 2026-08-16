#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

const coreRelease = path.join(root, 'framework', 'core', 'build', 'Release');
const hasNativePython =
  existsSync(coreRelease) &&
  readdirSync(coreRelease).some((name) => /^pykungfu(?:\.|$)/u.test(name));
if (!hasNativePython) {
  run(
    'cold-source Core Python binding',
    path.join(root, process.platform === 'win32' ? 'shifu.cmd' : 'shifu'),
    ['build:core'],
  );
}

function run(label, command, args, options = {}) {
  process.stdout.write(`[agent-review-continuation] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error)
    console.error(`[agent-review-continuation] ${result.error.message}`);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

run('Work Dashboard shared review and continuation API', 'pnpm', [
  '--filter',
  '@kungfu-tech/kfx-view-work-dashboard',
  'test',
]);

const pythonPath = [
  path.join(root, 'framework', 'core', 'build', 'Release'),
  path.join(root, 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'independent review and exact continuation domain',
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
      'test_assignment_review_equivalence.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_assignment_orchestration.py',
    ),
    '-k',
    'work_close or nonterminal_continuation_decision',
    '-q',
  ],
  { env: { ...process.env, PYTHONPATH: pythonPath } },
);
