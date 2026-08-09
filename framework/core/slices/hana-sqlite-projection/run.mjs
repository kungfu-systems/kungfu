// SPDX-License-Identifier: Apache-2.0

import { fail, findBin, locate, run } from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);
const host = findBin(
  buildDir,
  'hana_sqlite_projection_host',
  'slices/hana-sqlite-projection',
);
if (!host) fail('hana_sqlite_projection_host not found');

const result = run(host);
process.stdout.write(result.stdout);
const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
if (
  !report.ok ||
  !report.enum ||
  !report.fixed_blob ||
  !report.vector_blob ||
  !report.malformed_rejected
)
  fail('Hana SQLite roundtrip invariant failed');

console.log('hana sqlite projection: PASS');
