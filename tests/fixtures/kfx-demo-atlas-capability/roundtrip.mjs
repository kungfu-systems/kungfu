// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openProfile } from '../../../framework/api/src/capability/profile.ts';
import { openWorkControlProfile } from '../../../extensions/work-dashboard/src/view/work-control-profile.ts';
import {
  corePython,
  fail,
  json,
  kfc,
  locate,
  tmpDir,
  uvPython,
} from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const repoDir = path.resolve(fixtureDir, '..', '..', '..');
const sampleRoot = path.resolve(
  fixtureDir,
  '..',
  'atlas-demo-import',
  'sample-root',
);
const home = tmpDir('atlas-capability-');
const runtimeDir = path.join(home, 'runtime');
const assembledBin = path.join(
  repoDir,
  'framework',
  'core',
  'dist',
  'kungfu',
  'kungfu',
);
const python = corePython(coreDir);
const devCli = path.join(coreDir, '.devtools', 'kungfu_cli.py');

if (!fs.existsSync(assembledBin)) {
  fail('kungfu CLI is not assembled (run ./shifu freeze first)');
}

uvPython(coreDir, [
  path.join(fixtureDir, '..', '_activate_work_control_profile.py'),
  runtimeDir,
  path.join(repoDir, 'extensions', 'work-control'),
]);
const imported = json(
  kfc(coreDir, home, ['atlas', 'import', '--repo', sampleRoot, '--json']),
);

const profile = openProfile({
  runtimeDir,
  execFileSync: (_file, args, options) =>
    execFileSync(python, [devCli, '-H', home, ...args], options),
  env: { ...process.env, KUNGFU_ATLAS_REPO: sampleRoot },
  bin: python,
});
const atlas = openWorkControlProfile(profile, sampleRoot);

function ck(label, ok) {
  if (!ok) fail(label);
}

ck('default repo root is exposed', atlas.defaultRepoRoot === sampleRoot);

ck('import counted one mission', imported.missions === 1);
ck('import counted two goals', imported.goals === 2);
ck('import counted one marker', imported.markers === 1);
ck(
  'import surfaced broken-json warning',
  imported.warnings.some((warning) => warning.includes('broken.json')),
);

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

const dashboard = await atlas.dashboard();
ck('dashboard snapshot has one request cut', dashboard.cut.kind === 'system_time');
ck('dashboard snapshot includes import info', dashboard.import_info?.missions === 1);
ck('dashboard snapshot includes missions', dashboard.missions.length === 1);
ck('dashboard snapshot includes goals', dashboard.goals.length === 2);
ck('dashboard snapshot is cached', atlas.currentDashboard() === dashboard);

console.log('[kfx-demo-atlas-capability] roundtrip ok');
