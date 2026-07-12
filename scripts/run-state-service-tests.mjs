// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const executable =
  process.platform === 'win32'
    ? 'kungfu_state_service_contract_tests.exe'
    : 'kungfu_state_service_contract_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error(
    '[state-service-test] binary not found; run ./shifu build:core first',
  );
  process.exit(2);
}

function run(args, label) {
  const result = spawnSync(testBinary, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    if (result.error)
      console.error(`[state-service-test] ${label}: ${result.error.message}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[state-service-test] running ${testBinary}`);
run([], 'in-process contracts');

const coordinatorSources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/live/coordinator.h',
  'framework/core/src/libkungfu/src/runtime/live/coordinator.cpp',
];
for (const source of coordinatorSources) {
  const content = fs.readFileSync(path.join(process.cwd(), source), 'utf8');
  if (
    content.includes('state_cache::manager') ||
    content.includes('state_cache_')
  ) {
    console.error(
      `[state-service-test] coordinator regained projection-store ownership: ${source}`,
    );
    process.exit(1);
  }
}

const crashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-owner-crash-'));
try {
  run(['--crash-owner', crashRoot], 'crash fixture');
  run(['--expect-recovered-owner', crashRoot], 'stale-owner recovery');
} finally {
  fs.rmSync(crashRoot, { recursive: true, force: true });
}

const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-owner-live-'));
const ready = path.join(liveRoot, 'holder.ready');
const stop = path.join(liveRoot, 'holder.stop');
const holder = spawn(testBinary, ['--hold-owner', liveRoot, ready, stop], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
try {
  for (let attempt = 0; attempt < 250 && !fs.existsSync(ready); attempt += 1) {
    await delay(20);
  }
  if (!fs.existsSync(ready)) throw new Error('live owner did not become ready');
  run(['--expect-owner-busy', liveRoot], 'live-owner fencing');
  fs.writeFileSync(stop, 'stop\n');
  const exitCode = await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`live owner exited with ${exitCode}`);
  run(['--expect-clean-reopen', liveRoot], 'clean supervisor reopen');
} finally {
  if (holder.exitCode === null) holder.kill();
  fs.rmSync(liveRoot, { recursive: true, force: true });
}

console.log(
  '[state-service-test] ownership and writer fencing contracts passed',
);
