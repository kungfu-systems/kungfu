// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tests = ['yijinjing_mmap_tests', 'yijinjing_content_hash_tests'];

for (const test of tests) {
  const executable = process.platform === 'win32' ? `${test}.exe` : test;
  const candidates = [
    path.join(root, 'framework', 'core', 'build', 'Release', executable),
    path.join(root, 'framework', 'core', 'build', executable),
  ];
  const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!testBinary) {
    console.error(
      `[native-test] ${test} binary not found; run ./shifu build first`,
    );
    process.exit(2);
  }

  console.log(`[native-test] running ${test}`);
  const result = spawnSync(testBinary, [], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(
      `[native-test] failed to start ${testBinary}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
