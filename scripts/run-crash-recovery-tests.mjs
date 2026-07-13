// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const buildDir = path.join(process.cwd(), 'framework', 'core', 'build');
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'kungfu_crash_recovery_tests',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[crash-recovery-test] build: ${build.error.message}`);
  console.error(
    '[crash-recovery-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_crash_recovery_tests.exe'
    : 'kungfu_crash_recovery_tests';
const candidates = [
  path.join(buildDir, 'Release', executable),
  path.join(buildDir, executable),
  path.join(buildDir, 'src', 'libkungfu', 'Release', executable),
  path.join(buildDir, 'src', 'libkungfu', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[crash-recovery-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/durable_ingest.h',
  'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/crash_recovery.h',
  'framework/core/src/libkungfu/src/runtime/crash_recovery.cpp',
  'framework/core/src/libkungfu/tests/crash_recovery_tests.cpp',
].map((source) => path.join(process.cwd(), source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[crash-recovery-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
  );
  process.exit(2);
}

console.log(`[crash-recovery-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[crash-recovery-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const restartRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-crash-recovery-process-restart-'),
);
try {
  for (const mode of [
    '--create-whole-data-root-fixture',
    '--verify-whole-data-root-fixture',
  ]) {
    const child = spawnSync(testBinary, [mode, restartRoot], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    if (child.error || child.status !== 0) {
      if (child.error)
        console.error(`[crash-recovery-test] ${mode}: ${child.error.message}`);
      process.exit(child.status ?? 2);
    }
  }
  console.log('[crash-recovery-test] whole-data-root process restart passed');
} finally {
  fs.rmSync(restartRoot, { recursive: true, force: true });
}

console.log('[crash-recovery-test] recovery completion contracts passed');
