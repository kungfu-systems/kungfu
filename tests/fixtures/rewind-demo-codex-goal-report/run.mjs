// SPDX-License-Identifier: Apache-2.0
// Codex native-goal receipt fixture. The retired `codex report-goal` command
// no longer creates a second Work authority. This proves a provider can report
// facts through the generic report surface and verify a receipt that references
// an externally authoritative Work identity.

import fs from 'node:fs';
import path from 'node:path';
import { assertFileContains, json, kfc, locate, tmpDir } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const home = tmpDir('kf-codex-goal-report-');

const workId = 'assignment-codex-native-goal-1';
const runId = 'codex-native-goal-run-1';
const begin = json(
  kfc(coreDir, home, [
    'report',
    'run',
    'begin',
    '--work',
    workId,
    '--provider',
    'codex',
    '--run-id',
    runId,
    '--command',
    'codex native goal codex-native-goal-1',
    '--json',
  ]),
);

kfc(coreDir, home, [
  'report',
  'event',
  '--run',
  runId,
  '--type',
  'codex_goal_usage_observed',
  '--message',
  JSON.stringify({
    schema: 'kungfu.codex-goal-usage/v1',
    goal_id: 'codex-native-goal-1',
    objective: 'Prove native Codex goal report receipts',
    status: 'succeeded',
    tokens_used: 1234,
    time_used_seconds: 56,
  }),
  '--json',
]);
kfc(coreDir, home, [
  'report',
  'run',
  'end',
  '--run',
  runId,
  '--status',
  'succeeded',
  '--json',
]);

const bundleDir = path.dirname(begin.manifest);
const runtimeDir = path.resolve(bundleDir, '..', '..', '..');
const receipt = path.join(bundleDir, 'codex-goal-receipt.json');
fs.writeFileSync(
  receipt,
  `${JSON.stringify(
    {
      schema: 'kungfu.codex-goal-report/v1',
      work_id: workId,
      run_id: runId,
      goal_id: 'codex-native-goal-1',
      runtime_dir: runtimeDir,
      manifest: begin.manifest,
    },
    null,
    2,
  )}\n`,
);

const verify = json(
  kfc(coreDir, home, [
    'codex',
    'verify-goal-report',
    '--receipt',
    receipt,
    '--json',
  ]),
);
if (!verify.ok) throw new Error(`receipt did not verify: ${JSON.stringify(verify)}`);
const eventFile = path.join(bundleDir, 'report-events.jsonl');
assertFileContains(eventFile, 'codex-native-goal-1', 'goal usage event');
assertFileContains(eventFile, 'tokens_used', 'goal usage event');
if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) {
  throw new Error('missing report manifest');
}

console.log('ok codex goal report');
