// SPDX-License-Identifier: Apache-2.0
// Fact Bridge report-mode fixture. Proves a non-managed run can report
// lifecycle, cost, approval, and work linkage facts without changing the
// provider execution surface.

import fs from 'node:fs';
import path from 'node:path';
import { assertFileContains, json, kfc, locate, tmpDir, uvPython } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('kf-report-bridge-');

const work = json(
  kfc(coreDir, home, [
    'work',
    'create',
    'External Codex run',
    '--kind',
    'agent-run',
    '--json',
  ]),
);
const workId = work.work_id;
const begin = json(
  kfc(coreDir, home, [
    'report',
    'run',
    'begin',
    '--work',
    workId,
    '--provider',
    'codex',
    '--cwd',
    fixtureDir,
    '--run-id',
    'reported-run-1',
    '--json',
  ]),
);
const bundleDir = path.dirname(begin.manifest);
const runtimeDir = path.resolve(bundleDir, '..', '..', '..');

kfc(coreDir, home, [
  'report',
  'cost',
  '--run',
  begin.run_id,
  '--work',
  workId,
  '--provider',
  'codex',
  '--source',
  'manual_report',
  '--attribution',
  'manual_estimate',
  '--input-tokens',
  '123',
  '--output-tokens',
  '45',
  '--usd',
  '0.42',
  '--json',
]);
kfc(coreDir, home, [
  'report',
  'approval',
  '--run',
  begin.run_id,
  '--decision',
  'approve',
  '--request-id',
  'req-1',
  '--decided-by',
  'user',
  '--reason',
  'human approved',
  '--json',
]);
kfc(coreDir, home, [
  'report',
  'event',
  '--run',
  begin.run_id,
  '--type',
  'blocker',
  '--message',
  'waiting for PR review',
  '--severity',
  'warning',
  '--json',
]);
kfc(coreDir, home, [
  'report',
  'run',
  'end',
  '--run',
  begin.run_id,
  '--status',
  'blocked',
  '--exit-code',
  '1',
  '--json',
]);

const shown = json(kfc(coreDir, home, ['work', 'show', workId, '--json']));
if (!shown.runs.some((row) => row.run_id === begin.run_id)) {
  throw new Error(`work item did not link reported run: ${JSON.stringify(shown.runs)}`);
}

const eventFile = path.join(bundleDir, 'report-events.jsonl');
assertFileContains(eventFile, 'waiting for PR review', 'report event');
if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) {
  throw new Error('missing report manifest');
}

uvPython(coreDir, [
  path.join(fixtureDir, 'check_report.py'),
  runtimeDir,
  begin.run_id,
  workId,
], {
  env: {
    PYTHONPATH: [
      path.join(coreDir, 'src', 'python'),
      path.join(coreDir, 'dist', 'kungfu'),
    ].join(path.delimiter),
  },
});

console.log('ok report bridge');
