// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
    'kungfu_projection_bootstrap_tests',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[projection-bootstrap-test] build: ${build.error.message}`);
  console.error(
    '[projection-bootstrap-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_projection_bootstrap_tests.exe'
    : 'kungfu_projection_bootstrap_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[projection-bootstrap-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/projection_bootstrap.h',
  'framework/core/src/libkungfu/src/runtime/projection_bootstrap.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/state_service.h',
  'framework/core/src/libkungfu/src/runtime/state_service.cpp',
  'framework/core/src/libkungfu/tests/projection_bootstrap_tests.cpp',
].map((source) => path.join(process.cwd(), source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[projection-bootstrap-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
  );
  process.exit(2);
}

console.log(`[projection-bootstrap-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[projection-bootstrap-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}

for (const source of [
  'framework/core/src/libkungfu/src/runtime/live/coordinator.cpp',
  'framework/core/src/libyijinjing/src/journal/writer.cpp',
]) {
  const content = fs.readFileSync(path.join(process.cwd(), source), 'utf8');
  if (
    content.includes('projection_bootstrap_store') ||
    content.includes('rebuild_projection_shadow')
  ) {
    console.error(
      `[projection-bootstrap-test] shadow bootstrap leaked into the production hot path: ${source}`,
    );
    process.exit(1);
  }
}

console.log('[projection-bootstrap-test] snapshot/replay contracts passed');
