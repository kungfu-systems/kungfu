// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
const runtimeDir = path.join(tmpDir('atlas-view-live-'), 'runtime');
const bin = path.join(repoDir, 'framework', 'core', 'dist', 'kungfu', 'kungfu');
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

if (!fs.existsSync(bin)) {
  fail('kungfu CLI is not frozen (run ./shifu freeze first)');
}
if (!fs.existsSync(bundlePath)) {
  fail('work-dashboard is not built (run kungfu sdk kfx build first)');
}

const atlas = openAtlas({
  runtimeDir,
  execFileSync,
  env: { KUNGFU_ATLAS_REPO: sampleRoot },
  bin,
});
const imported = atlas.importRepo(sampleRoot);
if (imported.missions !== 1 || imported.goals !== 2 || imported.markers !== 1) {
  fail(`unexpected import counts: ${JSON.stringify(imported)}`);
}

const React = require('react');
const ReactDomServer = require('react-dom/server');
const fakeCaps = {
  work: {
    refresh: () => undefined,
    items: () => [],
  },
  ledger: {
    formatNanos: () => '',
  },
  atlas,
};
const fakeShell = {
  params: { view: 'atlas' },
  open: () => undefined,
  onRefresh: () => ({ stop: () => undefined }),
};
const capabilityModule = {
  WORK_STATUS_NAMES: ['active', 'blocked', 'waiting', 'ready', 'done'],
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
  'Atlas projection',
  'Demo platform stewardship',
  '2026-01-02-demo-importer',
  'Demo importer goal',
  '1 missions',
  '2 goals',
  '1 markers',
]) {
  if (!html.includes(needle)) fail(`live Atlas tab missing ${needle}`);
}

console.log('[kfx-demo-work-dashboard-atlas-live] render ok');
