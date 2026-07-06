// SPDX-License-Identifier: Apache-2.0
// Codex native-goal report fixture. Proves an agent can close a native Codex
// goal through one adapter command and one receipt verification command.

import fs from 'node:fs';
import path from 'node:path';
import { assertFileContains, json, kfc, locate, tmpDir } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const home = tmpDir('kf-codex-goal-report-');

const report = json(
  kfc(coreDir, home, [
    'codex',
    'report-goal',
    '--goal-id',
    'codex-native-goal-1',
    '--objective',
    'Prove native Codex goal report receipts',
    '--status',
    'succeeded',
    '--tokens-used',
    '1234',
    '--time-used-seconds',
    '56',
    '--title',
    'Native Codex goal receipt',
    '--json',
  ]),
);

if (report.schema !== 'kungfu.codex-goal-report/v1') {
  throw new Error(`unexpected receipt schema: ${report.schema}`);
}
if (!report.created_work || !report.work_id || !report.run_id || !report.receipt) {
  throw new Error(`incomplete report payload: ${JSON.stringify(report)}`);
}

const verify = json(
  kfc(coreDir, home, [
    'codex',
    'verify-goal-report',
    '--receipt',
    report.receipt,
    '--json',
  ]),
);
if (!verify.ok) throw new Error(`receipt did not verify: ${JSON.stringify(verify)}`);

const shown = json(kfc(coreDir, home, ['work', 'show', report.work_id, '--json']));
if (!shown.runs.some((row) => row.run_id === report.run_id)) {
  throw new Error(`work item did not link run: ${JSON.stringify(shown.runs)}`);
}

const bundleDir = path.dirname(report.receipt);
const eventFile = path.join(bundleDir, 'report-events.jsonl');
assertFileContains(eventFile, 'codex-native-goal-1', 'goal usage event');
assertFileContains(eventFile, 'tokens_used', 'goal usage event');
if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) {
  throw new Error('missing report manifest');
}

console.log('ok codex goal report');
