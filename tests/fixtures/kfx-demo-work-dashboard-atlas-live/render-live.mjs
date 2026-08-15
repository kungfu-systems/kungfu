// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { openProfile } from '../../../framework/api/src/capability/profile.ts';
import { openWorkControlProfile } from '../../../extensions/work-dashboard/src/view/work-control-profile.ts';
import {
  corePython,
  ensureHomeWorkspace,
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
const home = path.join(tmpDir('atlas-view-live-'), '.kungfu');
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
const bundlePath = path.join(
  repoDir,
  'extensions',
  'work-dashboard',
  'dist',
  'view',
  'index.js',
);
const require = createRequire(
  path.join(repoDir, 'framework', 'gui', 'package.json'),
);

if (!fs.existsSync(assembledBin)) {
  fail('kungfu CLI is not assembled (run ./shifu freeze first)');
}
if (!fs.existsSync(bundlePath)) {
  fail('work-dashboard is not built (run kungfu sdk kfx build first)');
}

ensureHomeWorkspace(coreDir, home, 'kfx-work-dashboard-atlas-fixture');
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
if (imported.missions !== 1 || imported.goals !== 2 || imported.markers !== 1) {
  fail(`unexpected import counts: ${JSON.stringify(imported)}`);
}
await atlas.dashboard();

const React = require('react');
const ReactDomServer = require('react-dom/server');
globalThis.window = {
  require: (id) => {
    if (id !== 'electron') fail(`unexpected host module: ${id}`);
    return { ipcRenderer: {} };
  },
};
const fakeCaps = {
  work: {
    refresh: () => undefined,
    items: () => [],
  },
  ledger: {
    formatNanos: () => '',
  },
  profile,
  storage: {
    savedQueries: () => ({ entries: [] }),
  },
  projects: {
    list: async () => ({ schema: 'kungfu.projects.catalog/v1', projects: [] }),
    runs: () => [],
    subscribeRuns: () => () => undefined,
  },
  assignmentRuntime: {
    discover: async () => ({ status: 'ok' }),
    snapshot: async () => ({ status: 'ok', revision: { value: 'fixture' } }),
    watch: async () => ({ status: 'ok' }),
  },
};
const fakeShell = {
  params: {},
  open: () => undefined,
  notify: () => undefined,
  onRefresh: () => ({ stop: () => undefined }),
};
const capabilityModule = {
  WORK_STATUS_NAMES: ['active', 'blocked', 'waiting', 'ready', 'done'],
  DEFAULT_GOAL_CARD_QUERY: {
    schema: 'kungfu.work-control.goal-card-query/v1',
    text: '',
    sections: [],
    statuses: [],
    trust: [],
    actors: [],
    tracks: [],
    roles: [],
    importance: [],
    stages: [],
    updatedWithinDays: null,
    hasChildren: 'all',
    closed: 'include',
    hideClosedChildren: false,
    sort: { field: 'decision-priority', direction: 'desc' },
  },
  emptyQueryChangelogState: () => ({
    rows: {},
    evidence: {},
    changes: {},
    appliedMessageIds: [],
    resultSchema: null,
    frontier: { kind: 'empty', record_count: '0' },
    resultHash: '',
    gap: null,
  }),
  applyQueryChangelogPage: (state) => state,
  parseGoalCardQuerySpec: (value) => value,
};
const module = { exports: {} };
const code = fs.readFileSync(bundlePath, 'utf8');
const requireShim = (id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
  if (id === '@kungfu-tech/api/capability') return capabilityModule;
  return require(id);
};
new Function('require', 'module', 'exports', code)(
  requireShim,
  module,
  module.exports,
);

const { View } = module.exports;
if (typeof View !== 'function') fail('bundle does not export View');

const html = ReactDomServer.renderToStaticMarkup(
  React.createElement(View, { caps: fakeCaps, shell: fakeShell }),
);

for (const needle of [
  'All Work',
  'Connecting All Work…',
  'active local project workspace',
  'Loading retained Project Work…',
  'All Work remains open while Kungfu restores its Work graph.',
]) {
  if (!html.includes(needle)) fail(`live All Work view missing ${needle}`);
}

console.log('[kfx-demo-work-dashboard-atlas-live] profile + All Work render ok');
