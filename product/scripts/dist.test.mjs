// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { cliArchiveBase, verifyProductObservabilityEvents } from './dist.mjs';

const require = createRequire(import.meta.url);
const workDashboardPackage = require('../../extensions/work-dashboard/package.json');
const {
  esmEntrypointArgs,
  toEsmEntrypointSpecifier,
} = require('../../framework/gui/scripts/before-pack.cjs');

test('CLI product archive name uses the Kungfu Episodes product prefix', () => {
  assert.equal(
    cliArchiveBase('darwin-arm64'),
    'kungfu-episodes-cli-darwin-arm64',
  );
  assert.equal(cliArchiveBase('linux-x64'), 'kungfu-episodes-cli-linux-x64');
  assert.equal(cliArchiveBase('win32-x64'), 'kungfu-episodes-cli-win32-x64');
});

test('product observability ignores errors from sibling components', () => {
  const names = [
    ['product.dist.start', 'prepare'],
    ['product.kfx.dependencies.declared', 'dependencies'],
    ['product.dependencies.sync.start', 'dependencies'],
    ['product.core.rebuild.start', 'core'],
    ['product.core.freeze.start', 'core'],
    ['product.extensions.build.start', 'extensions'],
    ['product.ui.bundle.start', 'ui'],
    ['product.desktop.electron-builder.start', 'package'],
    ['product.cli.archive.start', 'package'],
    ['product.cli.smoke.start', 'package'],
    ['product.cli.smoke.end', 'package'],
    ['product.dist.end', 'package'],
  ];
  const events = names.map(([event, phase]) => ({
    contract: 'kungfu-buildchain-log-event',
    timestamp: '2026-07-12T00:00:00.000Z',
    level: 'info',
    source: 'user',
    component: 'kungfu-product',
    event,
    phase,
  }));
  events.push({
    ...events[0],
    level: 'error',
    component: 'buildchain-lifecycle',
    event: 'unrelated.error',
  });

  const report = verifyProductObservabilityEvents(events);
  assert.equal(report.ok, true);
  assert.equal(report.summary.errorCount, 0);
  assert.equal(report.summary.eventCount, names.length);
});

test('product observability ignores same-component errors from prior runs', () => {
  const events = [
    {
      contract: 'kungfu-buildchain-log-event',
      timestamp: '2026-07-12T00:00:00.000Z',
      level: 'error',
      source: 'user',
      component: 'kungfu-product',
      event: 'product.dist.error',
      phase: 'package',
    },
    ...[
      ['product.dist.start', 'prepare'],
      ['product.kfx.dependencies.declared', 'dependencies'],
      ['product.dependencies.sync.start', 'dependencies'],
      ['product.core.rebuild.start', 'core'],
      ['product.core.freeze.start', 'core'],
      ['product.extensions.build.start', 'extensions'],
      ['product.ui.bundle.start', 'ui'],
      ['product.desktop.electron-builder.start', 'package'],
      ['product.cli.archive.start', 'package'],
      ['product.cli.smoke.start', 'package'],
      ['product.cli.smoke.end', 'package'],
      ['product.dist.end', 'package'],
    ].map(([event, phase]) => ({
      contract: 'kungfu-buildchain-log-event',
      timestamp: '2026-07-12T00:01:00.000Z',
      level: 'info',
      source: 'user',
      component: 'kungfu-product',
      event,
      phase,
    })),
  ];

  const report = verifyProductObservabilityEvents(events, 'all', 1);
  assert.equal(report.ok, true);
  assert.equal(report.summary.errorCount, 0);
  assert.equal(report.summary.eventCount, 12);
});

test('electron before-pack uses a file URL only on Windows', () => {
  const entryPath = new URL(
    '../../framework/gui/scripts/gen-first-party-manifest.mjs',
    import.meta.url,
  ).pathname;
  assert.equal(toEsmEntrypointSpecifier(entryPath, 'linux'), entryPath);
  assert.equal(toEsmEntrypointSpecifier(entryPath, 'darwin'), entryPath);
  assert.equal(
    new URL(toEsmEntrypointSpecifier('C:\\kungfu\\manifest.mjs', 'win32'))
      .protocol,
    'file:',
  );
});

test('electron before-pack imports its ESM entrypoint through eval', () => {
  const entryPath = new URL(
    '../../framework/gui/scripts/gen-first-party-manifest.mjs',
    import.meta.url,
  ).pathname;
  const specifier = toEsmEntrypointSpecifier(entryPath);
  assert.deepEqual(esmEntrypointArgs(entryPath), [
    '--eval',
    `import(${JSON.stringify(specifier)})`,
  ]);
});

test('work dashboard declares the storage handle used by its query stream', () => {
  assert.ok(
    workDashboardPackage.kungfuConfig.config.view.capabilities.includes(
      'storage',
    ),
  );
});

test('desktop product carries the installed Agent authoring runtime', () => {
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  for (const target of ['sdk', 'kfd', 'templates', 'node_modules']) {
    assert.match(
      config,
      new RegExp(`desktop-authoring/${target}\\n\\s+to: ${target}`),
    );
  }
});

test('installed SDK resolves the packaged KFX contract beside its resources', () => {
  const sdk = fs.readFileSync(
    new URL('../../developer/sdk/src/sdk.js', import.meta.url),
    'utf8',
  );
  assert.match(
    sdk,
    /path\.join\(SDK_ROOT, 'kungfu', 'config', KFX_CONTRACT_FILE\)/,
  );
});

test('installed SDK keeps esbuild external and carries its native runtime', () => {
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
  assert.match(dist, /external: \['esbuild'\]/);
  assert.match(
    dist,
    /copySdkRuntimePackageForCli\(stageRoot, 'esbuild', esbuildResolvePaths\)/,
  );
  assert.match(dist, /`@esbuild\/\$\{process\.platform\}-\$\{process\.arch\}`/);
});
