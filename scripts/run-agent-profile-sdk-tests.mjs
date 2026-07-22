#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT ||
  path.join(root, 'framework', 'core', '.venv');
const python =
  process.platform === 'win32'
    ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
    : path.join(pythonEnvironment, 'bin', 'python');
const pythonPath = [
  path.join(root, 'framework', 'core', 'build', 'Release'),
  path.join(root, 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

const result = spawnSync(
  python,
  [
    '-m',
    'pytest',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_profile_sdk.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_profile_composition.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_mission_control_profile.py',
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
  },
);
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[agent-profile-sdk-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}
