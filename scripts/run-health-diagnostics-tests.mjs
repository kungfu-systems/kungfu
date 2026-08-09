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

for (const testCase of [
  { file: 'test_health_diagnostics.py', args: [] },
  { file: 'test_recovery.py', args: [] },
  { file: 'test_health_diagnostics_native.py', args: [] },
]) {
  const testFile = testCase.file;
  const result = spawnSync(
    'uv',
    [
      'run',
      '--project',
      path.join(root, 'framework', 'core'),
      '--frozen',
      'pytest',
      path.join(root, 'framework', 'core', 'tests', 'python', testFile),
      ...testCase.args,
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
    console.error(`[health-diagnostics-test] ${result.error.message}`);
  const nativeUnavailable =
    testFile === 'test_health_diagnostics_native.py' &&
    result.status === 5 &&
    process.env.KUNGFU_HEALTH_REQUIRE_NATIVE !== '1';
  if (result.error || (result.status !== 0 && !nativeUnavailable))
    process.exit(result.status ?? 1);
}
