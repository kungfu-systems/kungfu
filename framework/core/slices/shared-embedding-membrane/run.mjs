// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import {
  assertNoExtraDylibs,
  fail,
  findBin,
  locate,
  run,
  tmpDir,
} from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);
const host = findBin(
  buildDir,
  'shared_embedding_host',
  'slices/shared-embedding-membrane',
);
if (!host) fail('shared_embedding_host not found');

const moduleNames =
  process.platform === 'win32'
    ? ['shared_embedding_native_kfx.dll']
    : process.platform === 'darwin'
      ? ['shared_embedding_native_kfx.so', 'shared_embedding_native_kfx.dylib']
      : ['shared_embedding_native_kfx.so'];
const bases = [
  path.join(buildDir, 'Release'),
  path.join(buildDir, 'slices', 'shared-embedding-membrane'),
  buildDir,
];
let nativeKfx = null;
for (const base of bases) {
  for (const name of moduleNames) {
    const candidate = path.join(base, name);
    if (fs.existsSync(candidate)) nativeKfx = candidate;
  }
}
if (!nativeKfx) fail('shared_embedding_native_kfx module not found');
assertNoExtraDylibs(nativeKfx);

// Keep every raw trial visible, but gate the median of three independent p99
// samples so one scheduler preemption cannot masquerade as sustained latency.
const trialReports = [];
for (let trial = 0; trial < 3; trial += 1) {
  const work = tmpDir(`shared-embedding-membrane-${trial}-`);
  const result = run(host, [work, nativeKfx]);
  process.stdout.write(result.stdout);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  if (report.abi_version !== 1) fail('unexpected ABI version');
  if (report.payload_bytes_copied !== 0) fail('payload copy detected');
  if (report.extension_owned_idle_bytes <= 0)
    fail('extension-owned idle state was not reported');
  trialReports.push(report);
}

const median = (field) =>
  trialReports.map((report) => report[field]).sort((a, b) => a - b)[1];
const aggregate = {
  consumer: 'native-kfx-aggregate',
  trials: trialReports.length,
  control_p50_ns: median('control_p50_ns'),
  control_p99_ns: median('control_p99_ns'),
  batch_4k_p50_ns: median('batch_4k_p50_ns'),
  batch_4k_p99_ns: median('batch_4k_p99_ns'),
};
console.log(JSON.stringify(aggregate));
if (aggregate.control_p99_ns > 1000)
  fail(`control p99 ${aggregate.control_p99_ns}ns exceeds 1us gate`);
if (aggregate.batch_4k_p99_ns > 5000)
  fail(`4KiB batch p99 ${aggregate.batch_4k_p99_ns}ns exceeds 5us gate`);
console.log('shared embedding membrane: PASS');
