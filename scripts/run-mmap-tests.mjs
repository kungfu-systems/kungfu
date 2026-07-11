// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const executable =
  process.platform === 'win32'
    ? 'yijinjing_mmap_tests.exe'
    : 'yijinjing_mmap_tests';
const candidates = [
  path.join(root, 'framework', 'core', 'build', 'Release', executable),
  path.join(root, 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));

if (!testBinary) {
  console.error(
    '[mmap-test] native test binary not found; run ./shifu build first',
  );
  process.exit(2);
}

const result = spawnSync(testBinary, [], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(
    `[mmap-test] failed to start ${testBinary}: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
