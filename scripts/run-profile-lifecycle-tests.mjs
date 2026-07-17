#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const buildDir = path.join(process.cwd(), 'framework', 'core', 'build');
// shifu-entry-contract: this task builds the exact native target before use.
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'kungfu_profile_lifecycle_tests',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[profile-lifecycle-test] build: ${build.error.message}`);
  console.error(
    '[profile-lifecycle-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_profile_lifecycle_tests.exe'
    : 'kungfu_profile_lifecycle_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error('[profile-lifecycle-test] binary not found after target build');
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/profile/profile_lifecycle.h',
  'framework/core/src/libkungfu/src/runtime/profile/profile_lifecycle.cpp',
  'framework/core/src/libkungfu/schemas/profile_lifecycle_event.fbs',
  'framework/core/src/libkungfu/tests/profile_lifecycle_tests.cpp',
].map((source) => path.join(process.cwd(), source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[profile-lifecycle-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
  );
  process.exit(2);
}

console.log(`[profile-lifecycle-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[profile-lifecycle-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT ||
  path.join(process.cwd(), 'framework', 'core', '.venv');
const python =
  process.platform === 'win32'
    ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
    : path.join(pythonEnvironment, 'bin', 'python');
const pythonPath = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release'),
  path.join(process.cwd(), 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);
console.log(
  '[profile-lifecycle-test] checking Python service and CLI surfaces',
);
const pythonResult = spawnSync(
  python,
  [
    '-m',
    'pytest',
    path.join(
      process.cwd(),
      'framework',
      'core',
      'tests',
      'python',
      'test_profile_lifecycle_cli.py',
    ),
    '-q',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
      PYTHONPATH: pythonPath,
    },
    stdio: 'inherit',
  },
);
if (pythonResult.error || pythonResult.status !== 0) {
  if (pythonResult.error)
    console.error(
      `[profile-lifecycle-test] Python: ${pythonResult.error.message}`,
    );
  process.exit(pythonResult.status ?? 1);
}

console.log('[profile-lifecycle-test] checking Node binding surface');
const bindingDir = [
  path.join(process.cwd(), 'framework', 'core', 'dist', 'kungfu'),
  path.join(buildDir, 'Release'),
  buildDir,
].find((candidate) => fs.existsSync(path.join(candidate, 'kungfu_node.node')));
if (!bindingDir) {
  console.error('[profile-lifecycle-test] Node binding not found');
  process.exit(2);
}
process.env.KUNGFU_DIR = bindingDir;
const require = createRequire(import.meta.url);
const binding = require('../framework/core/lib/kungfu.js')();
const nodeRuntime = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-profile-node-'),
);
try {
  const contract = binding.runStorageServiceOperation(
    'profile_lifecycle',
    nodeRuntime,
    { action: 'contract' },
  );
  if (contract.schema !== 'kungfu.profile-lifecycle/v1') {
    throw new Error('Node binding returned another Profile lifecycle contract');
  }
} finally {
  fs.rmSync(nodeRuntime, { recursive: true, force: true });
}
