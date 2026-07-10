// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fail, findBin, locate, run, tmpDir } from '../_harness.mjs';

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

const work = tmpDir('shared-embedding-membrane-');
const result = run(host, [work, nativeKfx]);
process.stdout.write(result.stdout);
const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
if (report.abi_version !== 1) fail('unexpected ABI version');
if (report.payload_bytes_copied !== 0) fail('payload copy detected');
if (report.extension_owned_idle_bytes <= 0)
  fail('extension-owned idle state was not reported');
if (report.control_p99_ns > 1000)
  fail(`control p99 ${report.control_p99_ns}ns exceeds 1us gate`);
if (report.batch_4k_p99_ns > 5000)
  fail(`4KiB batch p99 ${report.batch_4k_p99_ns}ns exceeds 5us gate`);
console.log('shared embedding membrane: PASS');
