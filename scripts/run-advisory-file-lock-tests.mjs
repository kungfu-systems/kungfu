// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const buildDir = path.join(root, 'framework', 'core', 'build');
// shifu-entry-contract: allow this ./shifu test task to build its exact native target instead of trusting stale artifacts
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'yijinjing_advisory_file_lock_tests',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error) {
    console.error(`[advisory-file-lock-test] build: ${build.error.message}`);
  }
  console.error(
    '[advisory-file-lock-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'yijinjing_advisory_file_lock_tests.exe'
    : 'yijinjing_advisory_file_lock_tests';
const candidates = [
  path.join(buildDir, 'Release', executable),
  path.join(buildDir, executable),
  path.join(buildDir, 'src', 'libyijinjing', 'Release', executable),
  path.join(buildDir, 'src', 'libyijinjing', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[advisory-file-lock-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

const sources = [
  'framework/core/src/libyijinjing/include/kungfu/yijinjing/io/advisory_file_lock.h',
  'framework/core/src/libyijinjing/src/io/advisory_file_lock.cpp',
  'framework/core/src/libyijinjing/tests/advisory_file_lock_tests.cpp',
].map((source) => path.join(root, source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[advisory-file-lock-test] refusing stale binary; newer source: ${path.relative(root, newerSource)}`,
  );
  process.exit(2);
}

console.log(`[advisory-file-lock-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  if (result.error) {
    console.error(`[advisory-file-lock-test] ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

console.log('[advisory-file-lock-test] lock contract passed');
