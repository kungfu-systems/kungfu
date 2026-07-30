// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const buildDir = path.join(process.cwd(), 'framework', 'core', 'build');
// shifu-entry-contract: allow this ./shifu test task to build its exact native target instead of trusting stale artifacts
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'kungfu_durable_ingest_tests',
    'kungfu_durability_powercut_fixture',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[durable-ingest-test] build: ${build.error.message}`);
  console.error(
    '[durable-ingest-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_durable_ingest_tests.exe'
    : 'kungfu_durable_ingest_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[durable-ingest-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}
const fixtureExecutable =
  process.platform === 'win32'
    ? 'kungfu_durability_powercut_fixture.exe'
    : 'kungfu_durability_powercut_fixture';
const fixtureCandidates = [
  path.join(
    process.cwd(),
    'framework',
    'core',
    'build',
    'Release',
    fixtureExecutable,
  ),
  path.join(process.cwd(), 'framework', 'core', 'build', fixtureExecutable),
  path.join(
    process.cwd(),
    'framework',
    'core',
    'build',
    'src',
    'libkungfu',
    'Release',
    fixtureExecutable,
  ),
  path.join(
    process.cwd(),
    'framework',
    'core',
    'build',
    'src',
    'libkungfu',
    fixtureExecutable,
  ),
];
const fixtureBinary = fixtureCandidates.find((candidate) =>
  fs.existsSync(candidate),
);
if (!fixtureBinary) {
  console.error('[durable-ingest-test] power-cut fixture binary not found');
  process.exit(2);
}

const sharedSources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/durable_ingest.h',
  'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
  'framework/core/src/libkungfu/include/kungfu/runtime/state_service.h',
  'framework/core/src/libkungfu/src/runtime/state_service.cpp',
  'framework/core/src/libyijinjing/include/kungfu/yijinjing/ownership.h',
  'framework/core/src/libyijinjing/src/io/ownership.cpp',
].map((source) => path.join(process.cwd(), source));
for (const [binary, sources] of [
  [
    testBinary,
    [
      ...sharedSources,
      path.join(
        process.cwd(),
        'framework/core/src/libkungfu/tests/durable_ingest_tests.cpp',
      ),
    ],
  ],
  [
    fixtureBinary,
    [
      ...sharedSources,
      path.join(
        process.cwd(),
        'framework/core/src/libkungfu/tests/durability_powercut_fixture.cpp',
      ),
    ],
  ],
]) {
  const binaryMtime = fs.statSync(binary).mtimeMs;
  const newerSource = sources.find(
    (source) => fs.statSync(source).mtimeMs > binaryMtime,
  );
  if (newerSource) {
    console.error(
      `[durable-ingest-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
    );
    process.exit(2);
  }
}
console.log(`[durable-ingest-test] running ${testBinary}`);
function run(args, label) {
  const result = spawnSync(testBinary, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    if (result.error)
      console.error(`[durable-ingest-test] ${label}: ${result.error.message}`);
    process.exit(result.status ?? 1);
  }
}

run([], 'native contracts');

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-powercut-fixture-smoke-'),
);
try {
  fs.writeFileSync(
    path.join(fixtureRoot, '.kungfu-disposable-powercut-fixture'),
    'kungfu.durability.disposable-root/v1\n',
    { flag: 'wx' },
  );
  const fixtureEnv = {
    ...process.env,
    KUNGFU_DURABILITY_QUALIFICATION: 'disposable-powercut',
  };
  for (const [args, label] of [
    [['write', fixtureRoot, 'durable_sync', 'none'], 'fixture write'],
    [['verify', fixtureRoot, '1', '1'], 'fixture verify'],
  ]) {
    const result = spawnSync(fixtureBinary, args, {
      cwd: process.cwd(),
      env: fixtureEnv,
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      if (result.error)
        console.error(
          `[durable-ingest-test] ${label}: ${result.error.message}`,
        );
      process.exit(result.status ?? 1);
    }
  }
  const outsideRange = spawnSync(
    fixtureBinary,
    ['verify', fixtureRoot, '0', '0'],
    {
      cwd: process.cwd(),
      env: fixtureEnv,
      encoding: 'utf8',
    },
  );
  if (
    outsideRange.status !== 1 ||
    !`${outsideRange.stdout || ''}${outsideRange.stderr || ''}`.includes(
      '"expected_max_sequence":0',
    )
  ) {
    console.error(
      '[durable-ingest-test] power-cut fixture accepted a durable sequence outside its expected range',
    );
    process.exit(1);
  }
  const refused = spawnSync(fixtureBinary, ['verify', fixtureRoot, '1'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUNGFU_DURABILITY_QUALIFICATION: '',
    },
    encoding: 'utf8',
  });
  if (
    refused.status !== 1 ||
    !`${refused.stdout || ''}${refused.stderr || ''}`.includes(
      'KUNGFU_DURABILITY_QUALIFICATION=disposable-powercut is required',
    )
  ) {
    console.error(
      '[durable-ingest-test] power-cut fixture did not fail closed without its execution boundary',
    );
    process.exit(1);
  }
  console.log(
    '[durable-ingest-test] disposable power-cut fixture smoke passed',
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

for (const source of [
  'framework/core/src/libyijinjing/src/journal/writer.cpp',
  'framework/core/src/libkungfu/src/runtime/live/coordinator.cpp',
]) {
  const content = fs.readFileSync(path.join(process.cwd(), source), 'utf8');
  if (
    content.includes('durable_ingest') ||
    content.includes('durable_shadow')
  ) {
    console.error(
      `[durable-ingest-test] visible hot path gained synchronous durable ingestion: ${source}`,
    );
    process.exit(1);
  }
}

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-writer-attestation-'),
);
const ready = path.join(root, 'writer.ready');
const stop = path.join(root, 'writer.stop');
const holder = spawn(testBinary, ['--hold-writer', root, ready, stop], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
try {
  for (let attempt = 0; attempt < 250 && !fs.existsSync(ready); attempt += 1) {
    await delay(20);
  }
  if (!fs.existsSync(ready))
    throw new Error('cross-process writer did not become ready');
  run(['--inspect-writer', root], 'cross-process writer attestation');
  fs.writeFileSync(stop, 'stop\n');
  const exitCode = await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', resolve);
  });
  if (exitCode !== 0)
    throw new Error(`cross-process writer exited with ${exitCode}`);
} finally {
  if (holder.exitCode === null) holder.kill();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('[durable-ingest-test] cross-process writer attestation passed');
