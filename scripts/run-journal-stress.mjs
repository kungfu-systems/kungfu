// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const buildDir = path.join(root, 'framework', 'core', 'build');
const executable =
  process.platform === 'win32'
    ? 'yijinjing_journal_stress.exe'
    : 'yijinjing_journal_stress';
const candidates = [
  path.join(root, 'framework', 'core', 'build', 'Release', executable),
  path.join(root, 'framework', 'core', 'build', executable),
];
if (!fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
  console.error(
    '[journal-stress] configured core build not found; run ./shifu build first',
  );
  process.exit(2);
}
// Entered through ./shifu qualify:journal-stress. Building one evidence-only
// target keeps unrelated product adapters out of the stress loop after the
// normal core configure step.
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'yijinjing_journal_stress',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  console.error('[journal-stress] failed to build native evidence tool');
  process.exit(build.status ?? 1);
}
const stressBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!stressBinary) {
  console.error('[journal-stress] build completed without the native tool');
  process.exit(2);
}

// Default to the fast smoke profile so an argument-free run stays usable; the
// >=30 minute soak is an explicit `-- --profile soak`.
const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === '--') forwardedArgs.shift();
if (forwardedArgs.length === 0) forwardedArgs.push('--profile', 'smoke');

const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
const gitStatus = spawnSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
});
const result = spawnSync(stressBinary, forwardedArgs, {
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
    `[journal-stress] failed to start ${stressBinary}: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
