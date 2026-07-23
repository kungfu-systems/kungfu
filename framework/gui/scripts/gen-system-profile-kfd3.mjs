// SPDX-License-Identifier: Apache-2.0
// Run the shipped runtime's factory qualification harness after first-party
// extensions have been built, then place its exact-root manifest beside the
// frozen CLI. Product runtime reads this file; Profile identity or API authority
// drift makes the receipt stale instead of preserving a cosmetic badge.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const coreDist = join(root, 'framework', 'core', 'dist', 'kungfu');
const executable = join(
  coreDist,
  process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
);
const missionControl = join(root, 'extensions', 'mission-control');
const out = join(coreDist, 'profile-kfd3.json');
const runtime = join(root, 'framework', 'gui', 'out', 'kfd3-release-runtime');

const result = spawnSync(
  executable,
  ['profile', 'kfd3-release-build', missionControl, '--out', out, '--json'],
  {
    env: { ...process.env, KF_RUNTIME_DIR: runtime },
    encoding: 'utf8',
  },
);

if (result.status !== 0) {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error('system Profile KFD-3 factory qualification failed');
}
process.stdout.write(result.stdout);
