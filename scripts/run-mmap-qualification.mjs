// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const buildDir = path.join(root, 'framework', 'core', 'build');
const executable =
  process.platform === 'win32'
    ? 'yijinjing_mmap_qualification.exe'
    : 'yijinjing_mmap_qualification';
const candidates = [
  path.join(root, 'framework', 'core', 'build', 'Release', executable),
  path.join(root, 'framework', 'core', 'build', executable),
];
if (!fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
  console.error(
    '[mmap-qualification] configured core build not found; run ./shifu build first',
  );
  process.exit(2);
}
// This script is itself entered through ./shifu qualify:mmap. Building one
// evidence-only target avoids making unrelated product adapters part of the
// qualification loop after the normal core configure step.
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'yijinjing_mmap_qualification',
    'yijinjing_mmap_tests',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  console.error('[mmap-qualification] failed to build native evidence tool');
  process.exit(build.status ?? 1);
}
const qualificationBinary = candidates.find((candidate) =>
  fs.existsSync(candidate),
);
if (!qualificationBinary) {
  console.error('[mmap-qualification] build completed without the native tool');
  process.exit(2);
}

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === '--') forwardedArgs.shift();
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
const gitStatus = spawnSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
});
const result = spawnSync(qualificationBinary, forwardedArgs, {
  cwd: root,
  env: {
    ...process.env,
    KUNGFU_QUALIFICATION_GIT_HEAD:
      gitHead.status === 0 ? gitHead.stdout.trim() : 'unknown',
    KUNGFU_QUALIFICATION_GIT_DIRTY:
      gitStatus.status === 0 && gitStatus.stdout.trim() === ''
        ? 'false'
        : 'true',
  },
  stdio: 'inherit',
});
if (result.error) {
  console.error(
    `[mmap-qualification] failed to start ${qualificationBinary}: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
