#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function run(label, command, args, options = {}) {
  process.stdout.write(`[mission-authority-cutover] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error)
    console.error(`[mission-authority-cutover] ${result.error.message}`);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

run('Work Dashboard shared Profile API', 'pnpm', [
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
  'Mission/Go authority domain and CLI',
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
      'test_atlas_storage.py',
    ),
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'test_agent_profile_sdk.py',
    ),
    '-k',
    'mission_go_authority or mission_control_queries_and_assesses_progress_at_pinned_cuts or mission_control_native_go_completion_claim_fails_closed_then_passes or native_mission_full_bundle_roundtrip_and_thin_degraded_import or system_profile_release_receipt_is_exact_root_and_shared_with_status',
    '-q',
  ],
  { env: { ...process.env, PYTHONPATH: pythonPath } },
);
