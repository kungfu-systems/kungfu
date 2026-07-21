// SPDX-License-Identifier: Apache-2.0
// shifu-entry-contract: allow qualification implementation behind ./shifu qualify:embedding-membranes

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'framework', 'core');
const build = path.join(core, 'build');
const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT || path.join(core, '.venv');
const python = path.join(
  pythonEnvironment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python3',
);
const ninja = path.join(
  pythonEnvironment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'ninja.exe' : 'ninja',
);

function cmakePath(value) {
  return value.replaceAll('\\', '/');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(python)) {
  throw new Error(`managed Python is not materialized: ${python}`);
}
if (!fs.existsSync(ninja)) {
  throw new Error(`managed Ninja is not materialized: ${ninja}`);
}
if (process.platform === 'darwin' && process.arch !== 'arm64') {
  throw new Error(
    `macOS membrane qualification requires arm64, found ${process.arch}`,
  );
}

const buildTargets = [
  'libwasm_shared_membrane_host',
  'kungfu_libwasm_self_test',
  'kungfu_api_contract_tests',
  'kungfu-kfd-agent-runtime',
];

run('cmake', [
  '-S',
  core,
  '-B',
  build,
  '-G',
  'Ninja',
  `-DCMAKE_MAKE_PROGRAM=${cmakePath(ninja)}`,
  `-DCMAKE_TOOLCHAIN_FILE=${cmakePath(path.join(build, 'conan_toolchain.cmake'))}`,
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DPYTHON_EXECUTABLE=${cmakePath(python)}`,
  '-DKUNGFU_WITH_SLICES=ON',
  '-DKF_LIBWASM_CARGO_REGISTRY=sparse+https://rsproxy.cn/index/',
]);
run('cmake', [
  '--build',
  build,
  '--config',
  'Release',
  '--parallel',
  '2',
  '--target',
  ...buildTargets,
]);

// The standard-only ABI contract is correctness, not latency, so it runs before
// the settle rather than alongside the latency harness.
run('ctest', [
  '--test-dir',
  build,
  '--output-on-failure',
  '-R',
  'kungfu_api_contract_tests',
]);

// Keep latency qualification separate from sustained compiler load. This is
// one fixed settle, not a benchmark retry.
await delay(60_000);

for (const harness of ['libwasm-shared-membrane']) {
  run(process.execPath, [path.join(core, 'slices', harness, 'run.mjs'), build]);
}
