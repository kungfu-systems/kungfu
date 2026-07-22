#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const release = path.join(root, 'framework', 'core', 'build', 'Release');
const shifu = path.join(
  root,
  process.platform === 'win32' ? 'shifu.cmd' : 'shifu',
);

function run(label, command, args, options = {}) {
  process.stdout.write(`[action-loop-native-authority] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error)
    console.error(`[action-loop-native-authority] ${result.error.message}`);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

run('coordinator and native entry contracts', process.execPath, [
  '--test',
  'framework/action/action-loop-begin.test.mjs',
  'framework/action/action-loop-source-dogfood.test.mjs',
]);

const hasNativeBinding =
  existsSync(release) &&
  readdirSync(release).some((name) => /^pykungfu(?:\.|$)/u.test(name));
if (!hasNativeBinding) {
  run('cold-source Core Python binding', shifu, ['build:core']);
}

const pythonPath = [
  path.join(root, 'framework', 'core', 'src', 'python'),
  release,
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'fresh and reused Mission Control authority receipts',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework', 'core'),
    '--frozen',
    'pytest',
    '-q',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_atlas_storage.py',
    ),
    '-k',
    'mission_control_native_go_completion_claim_fails_closed_then_passes',
  ],
  { env: { ...process.env, PYTHONPATH: pythonPath } },
);

run(
  'same-root first Atlas refresh and exact replay',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework', 'core'),
    '--frozen',
    'pytest',
    '-q',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_action_loop_adapter.py',
    ),
  ],
  { env: { ...process.env, PYTHONPATH: pythonPath } },
);
