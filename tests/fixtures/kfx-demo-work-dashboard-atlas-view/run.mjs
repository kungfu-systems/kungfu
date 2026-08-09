// SPDX-License-Identifier: Apache-2.0
//
// Render-smoke the current read-only Portfolio view without opening Electron.
// The kfx bundle is loaded the same CommonJS-wrapped way the GUI loader consumes
// it, while this fixture injects React and the Electron IPC boundary.
//
// Usage: node tests/fixtures/kfx-demo-work-dashboard-atlas-view/run.mjs

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
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

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(bundlePath)) {
  fail('work-dashboard is not built (run kungfu sdk kfx build first)');
}

const React = require('react');
const ReactDomServer = require('react-dom/server');
globalThis.window = {
  require: (id) => {
    if (id !== 'electron') throw new Error(`unexpected host module: ${id}`);
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
  profile: {
    runtimeDir: '/tmp/kungfu-runtime',
    discover: () => ({ source: '/profiles/work-control' }),
    memberCall: () => ({
      result: {
      schema: 'kungfu.work-control.dashboard-snapshot/v1',
      cut: { kind: 'system_time', system_time: '2026-07-12T12:00:00Z' },
      freshness: { status: 'fresh', basis: 'request-cut' },
      import_info: {
        import_id: 'fixture-import',
        repo_root: '/tmp/atlas',
        missions: 1,
        goals: 2,
        markers: 3,
      },
      missions: [
        {
          mission_id: 'mission-fixture',
          title: 'Fixture Mission',
          stage_name: 'dogfood',
        },
      ],
      goals: [
        {
          goal_id: 'goal-fixture-active',
          status: 'active',
          title: 'Active fixture goal',
          mission_id: 'mission-fixture',
          next_action: 'verify atlas tab',
        },
        {
          goal_id: 'goal-fixture-ready',
          status: 'ready',
          title: 'Ready fixture goal',
          mission_id: 'mission-fixture',
        },
      ],
      },
    }),
  },
  storage: {
    savedQueries: () => ({ entries: [] }),
  },
  projects: {
    list: async () => ({ schema: 'kungfu.projects.catalog/v1', projects: [] }),
    runs: () => [],
    subscribeRuns: () => () => undefined,
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
  if (!html.includes(needle)) fail(`rendered All Work view missing ${needle}`);
}

console.log('[kfx-demo-work-dashboard-atlas-view] All Work render ok');
