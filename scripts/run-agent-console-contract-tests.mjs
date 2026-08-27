#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const nativePath =
  process.env.KUNGFU_NATIVE_PATH ??
  path.join(root, 'framework', 'core', 'build', 'Release');
const pythonPath = [
  path.join(root, 'framework', 'core', 'src', 'python'),
  nativePath,
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
      'test_agent_command_contract.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_console_ambient_adoption.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_assignment_profile_source.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_native_terminal_contract.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_native_first_run_pty.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_work_advisory.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_rewind_progress.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_work_projection.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_session_module_boundaries.py',
    ),
    '-q',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      KUNGFU_NATIVE_PATH: nativePath,
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
