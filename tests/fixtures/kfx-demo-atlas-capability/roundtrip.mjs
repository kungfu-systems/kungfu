// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openAtlas } from '../../../framework/api/src/capability/atlas.ts';
import { fail, locate, tmpDir } from '../_harness.mjs';

const { fixtureDir } = locate(import.meta.url);
const repoDir = path.resolve(fixtureDir, '..', '..', '..');
const sampleRoot = path.resolve(
  fixtureDir,
  '..',
  'atlas-demo-import',
  'sample-root',
);
const runtimeDir = path.join(tmpDir('atlas-capability-'), 'runtime');
const bin = path.join(repoDir, 'framework', 'core', 'dist', 'kungfu', 'kungfu');

if (!fs.existsSync(bin)) {
  fail('kungfu CLI is not frozen (run ./shifu freeze first)');
}

const atlas = openAtlas({
  runtimeDir,
  execFileSync,
  env: { KUNGFU_ATLAS_REPO: sampleRoot },
  bin,
});

function ck(label, ok) {
  if (!ok) fail(label);
}

ck('default repo root is exposed', atlas.defaultRepoRoot === sampleRoot);

const imported = atlas.importRepo(sampleRoot);
ck('import counted one mission', imported.missions === 1);
ck('import counted two goals', imported.goals === 2);
ck('import counted one marker', imported.markers === 1);
ck('import surfaced broken-json warning', imported.warnings.length === 1);

const info = atlas.importInfo();
ck('import info is readable', info?.import_id === imported.import_id);
ck('import info counts missions', info?.missions === 1);
ck('import info counts goals', info?.goals === 2);
ck('import info counts markers', info?.markers === 1);

const missions = atlas.missions();
ck('mission list folds latest import', missions.length === 1);
ck('mission id preserved', missions[0]?.mission_id === 'demo-platform');

const activeGoals = atlas.goals({ status: 'active' });
ck('active goal filter works', activeGoals.length === 1);
ck('active goal id preserved', activeGoals[0]?.goal_id === '2026-01-02-demo-importer');

const mission = atlas.mission('demo-platform');
ck('mission detail is readable', mission?.mission.mission_id === 'demo-platform');
ck('mission detail links active goal', mission?.goals.length === 1);

const goal = atlas.goal('2026-01-02-demo-importer');
ck('goal detail is readable', goal?.mission_id === 'demo-platform');

const markers = atlas.markers();
ck('marker list is readable', markers.length === 1);
ck('marker branch preserved', markers[0]?.branch === 'ai/demo/importer');

console.log('[kfx-demo-atlas-capability] roundtrip ok');
