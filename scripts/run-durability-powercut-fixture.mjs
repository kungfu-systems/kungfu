// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const buildDir = path.join(root, 'framework', 'core', 'build');
const target = 'kungfu_durability_powercut_fixture';
const build = spawnSync(
  'cmake',
  ['--build', buildDir, '--config', 'Release', '--target', target],
  { cwd: root, stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(
      `[durability-powercut-fixture] build: ${build.error.message}`,
    );
  console.error(
    '[durability-powercut-fixture] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable = process.platform === 'win32' ? `${target}.exe` : target;
const candidates = [
  path.join(buildDir, 'Release', executable),
  path.join(buildDir, executable),
  path.join(buildDir, 'src', 'libkungfu', 'Release', executable),
  path.join(buildDir, 'src', 'libkungfu', executable),
];
const binary = candidates.find((candidate) => fs.existsSync(candidate));
if (!binary) {
  console.error('[durability-powercut-fixture] built binary was not found');
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/durable_ingest.h',
  'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
  'framework/core/src/libkungfu/tests/durability_powercut_fixture.cpp',
].map((source) => path.join(root, source));
const binaryMtime = fs.statSync(binary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[durability-powercut-fixture] refusing stale binary; newer source: ${path.relative(root, newerSource)}`,
  );
  process.exit(2);
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const run = spawnSync(binary, args.length > 0 ? args : ['--help'], {
  cwd: root,
  stdio: 'inherit',
});
if (run.error) {
  console.error(`[durability-powercut-fixture] ${run.error.message}`);
  process.exit(2);
}
process.exit(run.status ?? 2);
