// SPDX-License-Identifier: Apache-2.0
// shifu-entry-contract: allow qualification implementation behind ./shifu qualify:cpp-modules

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tests', 'qualification', 'cpp-modules');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-cpp-modules-'));
const ninja = path.join(
  root,
  'framework',
  'core',
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'ninja.exe' : 'ninja',
);
if (!fs.existsSync(ninja)) {
  throw new Error(
    'managed Ninja is not materialized; run ./shifu build:core first',
  );
}

function run(command, args, cwd = root) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (result.status !== 0) {
    const error = new Error(
      `${command} ${args.join(' ')} failed (${result.status})`,
    );
    error.stdout = result.stdout ?? '';
    error.stderr = result.stderr ?? '';
    throw error;
  }
  return {
    elapsedMs,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function qualify(mode) {
  const build = path.join(work, mode);
  const configure = run('cmake', [
    '-S',
    source,
    '-B',
    build,
    '-G',
    'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${ninja}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DKUNGFU_QUALIFICATION_MODE=${mode}`,
  ]);
  const compile = run('cmake', ['--build', build, '--parallel']);
  const test = run('ctest', ['--test-dir', build, '--output-on-failure']);
  return {
    configure_ms: Number(configure.elapsedMs.toFixed(1)),
    compile_ms: Number(compile.elapsedMs.toFixed(1)),
    test_ms: Number(test.elapsedMs.toFixed(1)),
  };
}

try {
  try {
    const moduleResult = qualify('module');
    const headerResult = qualify('header');
    const improvement =
      ((headerResult.compile_ms - moduleResult.compile_ms) /
        headerResult.compile_ms) *
      100;
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          platform: `${process.platform}-${process.arch}`,
          compiler: process.env.CXX || 'platform-default',
          fan_in: 48,
          module: moduleResult,
          header: headerResult,
          compile_improvement_percent: Number(improvement.toFixed(1)),
          production_gate: improvement >= 15 ? 'candidate' : 'hold',
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          platform: `${process.platform}-${process.arch}`,
          compiler: process.env.CXX || 'platform-default',
          fan_in: 48,
          module: { status: 'unsupported', diagnostic },
          production_gate: 'hold',
        },
        null,
        2,
      ),
    );
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
