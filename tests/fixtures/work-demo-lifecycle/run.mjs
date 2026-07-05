// SPDX-License-Identifier: Apache-2.0
//
// Work profile lifecycle fixture (gates P1/P2 slice): one item walks the whole
// default-profile vocabulary — create, every lifecycle verb, next action,
// checkpoint, decision, validation, artifact, linked run — and the journal
// plus the folded projection carry every fact. Asserted by check_lifecycle.py.
// Requires the core dev environment (built dist/kungfu).
//
// Usage: node tests/fixtures/work-demo-lifecycle/run.mjs

import path from 'node:path';
import { locate, tmpDir, kfc, uvPython, json } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('work-demo-');
const k = (args) => kfc(coreDir, home, args);

const created = json(
  k([
    'work',
    'create',
    'Fixture lifecycle item',
    '--kind',
    'task',
    '--summary',
    'work profile lifecycle fixture',
    '--json',
  ]),
);
const workId = created.work_id;

k(['work', 'start', workId]);
k(['work', 'next', workId, 'wire the projection']);
k(['work', 'pause', workId, '--reason', 'waiting on review']);
k(['work', 'resume', workId]);
k(['work', 'block', workId, '--reason', 'blocked on schema decision']);
k(['work', 'decide', workId, 'keep five statuses', '--by', 'fixture']);
k(['work', 'resume', workId]);
k(['work', 'checkpoint', workId, 'projection folds correctly']);
k([
  'work',
  'validate',
  workId,
  '--result',
  'pass',
  '--command',
  'fixture smoke',
  '--note',
  'ran clean',
]);
k([
  'work',
  'artifact',
  workId,
  'framework/core/src/python/kungfu/work',
  '--kind',
  'path',
]);
k(['work', 'link-run', workId, 'runfixture01']);
k(['work', 'ready', workId]);
k(['work', 'done', workId, '--reason', 'delivered']);

uvPython(coreDir, [
  path.join(fixtureDir, 'check_lifecycle.py'),
  path.join(home, 'runtime'),
  workId,
]);
