// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const executable =
  process.platform === 'win32'
    ? 'kungfu_runtime_error_tests.exe'
    : 'kungfu_runtime_error_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));

if (!testBinary) {
  console.error(
    '[runtime-error-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

console.log(`[runtime-error-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error) {
  console.error(
    `[runtime-error-test] failed to start: ${result.error.message}`,
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT ||
  path.join(process.cwd(), 'framework', 'core', '.venv');
const python =
  process.platform === 'win32'
    ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
    : path.join(pythonEnvironment, 'bin', 'python');
const bindingDir = path.join(
  process.cwd(),
  'framework',
  'core',
  'build',
  'Release',
);
console.log('[runtime-error-test] checking Python exception surface');
const pythonResult = spawnSync(
  python,
  [
    '-c',
    'import pykungfu; assert issubclass(pykungfu.runtime.ReplayExhaustedError, RuntimeError)',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [bindingDir, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    stdio: 'inherit',
  },
);
if (pythonResult.error) {
  console.error(
    `[runtime-error-test] failed to start Python surface check: ${pythonResult.error.message}`,
  );
  process.exit(1);
}
process.exit(pythonResult.status ?? 1);
