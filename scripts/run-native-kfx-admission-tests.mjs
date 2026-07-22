#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(label, command, args, env = process.env) {
  process.stdout.write(`[native-kfx-admission] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('Core contract and admission fixtures', 'ctest', [
  '--test-dir',
  path.join(root, 'framework/core/build'),
  '--build-config',
  'Release',
  '--output-on-failure',
  '--tests-regex',
  '^kungfu_native_kfx_contract_tests$',
]);

const pythonPath = [
  path.join(root, 'framework/core/build/Release'),
  path.join(root, 'framework/core/src/python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'Python binding and CLI projection',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework/core'),
    '--frozen',
    'pytest',
    path.join(root, 'framework/core/tests/python/test_native_kfx_contract.py'),
  ],
  {
    ...process.env,
    KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    PYTHONPATH: pythonPath,
  },
);

run('public API transport projection', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/api/tests/storage.test.ts'),
]);

run('public API type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/api',
  'run',
  'build',
]);

run('KFX type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/kfx',
  'run',
  'build',
]);
