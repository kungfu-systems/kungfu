// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fail, findBin, locate, run, tmpDir } from '../_harness.mjs';

function assertNoCoreDylibs(library) {
  let output = '';
  if (process.platform === 'darwin') {
    output = run('otool', ['-L', library]).stdout;
  } else if (process.platform === 'linux') {
    output = run('ldd', [library], { allowFail: true }).stdout;
  } else if (process.platform === 'win32') {
    const hasDumpbin = run('where.exe', ['dumpbin.exe'], { allowFail: true });
    const hasLdd = run('where.exe', ['ldd.exe'], { allowFail: true });
    if (hasDumpbin.status !== 0 && hasLdd.status !== 0) {
      console.log(`  ${path.basename(library)}: dependency cut-proof skipped`);
      return;
    }
    const result =
      hasDumpbin.status === 0
        ? run('dumpbin', ['/DEPENDENTS', library], { allowFail: true })
        : run('ldd', [library], { allowFail: true });
    output = `${result.stdout || ''}${result.stderr || ''}`;
  }
  if (/libkungfu|yijinjing|rocksdb|sqlite|\bnng\b/i.test(output))
    fail(`engine adapter links core-owned state:\n${output}`);
  console.log(`  ${path.basename(library)}: no core-owned dynamic state`);
}

const { buildDir } = locate(import.meta.url);
const host = findBin(
  buildDir,
  'libwasm_shared_membrane_host',
  'slices/libwasm-shared-membrane',
);
if (!host) fail('libwasm_shared_membrane_host not found');

const suffix =
  process.platform === 'win32'
    ? '.dll'
    : process.platform === 'darwin'
      ? '.dylib'
      : '.so';
const prefix = process.platform === 'win32' ? '' : 'lib';
const adapter = (engine) =>
  path.join(
    buildDir,
    'slices',
    'libwasm-shared-membrane',
    'cargo-stage',
    `${prefix}kf_libwasm_${engine}_spike${suffix}`,
  );
const wasmtime = adapter('wasmtime');
const wasmer = adapter('wasmer');
for (const library of [wasmtime, wasmer]) {
  if (!fs.existsSync(library)) fail(`libwasm adapter not found: ${library}`);
  assertNoCoreDylibs(library);
}

const reports = [];
for (let trial = 0; trial < 3; trial += 1) {
  const work = tmpDir(`libwasm-shared-membrane-${trial}-`);
  const result = run(host, [work, wasmtime, wasmer]);
  process.stdout.write(result.stdout);
  for (const line of result.stdout.trim().split('\n')) {
    if (!line.startsWith('{')) continue;
    reports.push({ trial, ...JSON.parse(line) });
  }
}

for (const engine of ['wasmtime', 'wasmer']) {
  const rows = reports.filter((report) => report.engine === engine);
  if (rows.length !== 3) fail(`${engine}: expected three trials`);
  const median = (field) =>
    rows.map((row) => row[field]).sort((a, b) => a - b)[1];
  const aggregate = {
    consumer: 'libwasm-aggregate',
    engine,
    trials: rows.length,
    control_p50_ns: median('control_p50_ns'),
    control_p99_ns: median('control_p99_ns'),
    batch_4k_p50_ns: median('batch_4k_p50_ns'),
    batch_4k_p99_ns: median('batch_4k_p99_ns'),
    cold_compile_ns: median('cold_compile_ns'),
    cold_instantiate_ns: median('cold_instantiate_ns'),
    one_mib_copy_bytes_per_second: median('one_mib_copy_bytes_per_second'),
    instance_idle_delta_bytes: median('instance_idle_delta_bytes'),
    adapter_file_bytes: fs.statSync(adapter(engine)).size,
  };
  console.log(JSON.stringify(aggregate));
  if (aggregate.control_p99_ns > 10_000)
    fail(`${engine}: control p99 exceeds 10us gate`);
  if (aggregate.batch_4k_p99_ns > 50_000)
    fail(`${engine}: 4KiB batch p99 exceeds 50us gate`);
  if (aggregate.one_mib_copy_bytes_per_second < 1024 ** 3)
    fail(`${engine}: 1MiB effective copy throughput is below 1GiB/s`);
  if (aggregate.instance_idle_delta_bytes > 16 * 1024 ** 2)
    fail(`${engine}: idle instance delta exceeds 16MiB`);
}

console.log('libwasm shared embedding membrane: PASS');
