// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import {
  cliArchiveBase,
  desktopUpdaterArtifact,
  esbuildPlatformBinaryPath,
  kfxBundleExternalModules,
  verifyProductObservabilityEvents,
} from './dist.mjs';

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

test('product kfx gate sees bundle externals but ignores window.require', () => {
  const code = [
    'var query = require("@kungfu-tech/api/query");',
    'var react = require("react");',
    'window.require("node:fs");',
    'win.require("node:path");',
  ].join('\n');
  assert.deepEqual(kfxBundleExternalModules(code), [
    '@kungfu-tech/api/query',
    'react',
  ]);
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

test('desktop product carries the externalized Agent Session runtime', () => {
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  assert.match(config, /from: \.\.\/agent-session/);
  assert.match(config, /to: app\/node_modules\/@kungfu-tech\/agent-session/);
});

test('desktop product declares prerelease update metadata without implicit publishing', () => {
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  assert.match(config, /publish:\n\s+- provider: github/);
  assert.match(config, /owner: kungfu-systems/);
  assert.match(config, /repo: kungfu/);
  assert.match(config, /channel: alpha/);
  assert.match(config, /releaseType: prerelease/);
  assert.match(config, /generateUpdatesFilesForAllChannels: true/);
  const launcher = fs.readFileSync(
    new URL(
      '../../framework/gui/scripts/run-electron-builder.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(launcher, /--publish=never/);
  assert.match(
    config,
    /dist\/update\/kungfu-release-manifest\.json\n\s+to: upgrade\/kungfu-release-manifest\.json/,
  );
});

test('desktop updater artifact selection is exact per platform', () => {
  assert.equal(
    desktopUpdaterArtifact(
      [
        'latest-mac.yml',
        'Kungfu Episodes-4.0.0-arm64.zip.blockmap',
        'Kungfu Episodes-4.0.0-arm64.zip',
      ],
      'darwin',
    ),
    'Kungfu Episodes-4.0.0-arm64.zip',
  );
  assert.equal(
    desktopUpdaterArtifact(
      ['latest.yml', 'Kungfu Episodes Setup.exe'],
      'win32',
    ),
    'Kungfu Episodes Setup.exe',
  );
  assert.throws(
    () => desktopUpdaterArtifact(['one.zip', 'two.zip'], 'darwin'),
    /expected one/,
  );
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
  assert.match(dist, /'esbuild',\s+esbuildRuntime\.resolvePaths/);
  assert.match(dist, /function esbuildPlatformPackageName\(\)/);
  assert.match(dist, /function ensureEsbuildRuntime\(\{ slot, paths \}\)/);
  assert.match(
    dist,
    /process\.env\.ESBUILD_BINARY_PATH = esbuildRuntime\.binaryPath/,
  );
  assert.match(
    dist,
    /Reflect\.deleteProperty\(process\.env, 'ESBUILD_BINARY_PATH'\)/,
  );
});

test('Buildchain stages exact esbuild binaries per product surface', () => {
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
  for (const slot of ['sdk', 'tui', 'gui']) {
    assert.match(dist, new RegExp(`slot: '${slot}'`));
  }
  assert.match(dist, /esbuild-platform',\s+slot/);
  assert.match(dist, /installedVersion !== version/);
  assert.match(dist, /buildKfx\(kfxPackages, sdkBuildEnv\)/);
  assert.match(dist, /'bundle tui',[\s\S]+?env: tuiBuildEnv/);
  assert.match(dist, /'build gui',[\s\S]+?env: guiBuildEnv/);
  assert.match(
    dist,
    /electron-builder desktop product[\s\S]+?\.\.\.sdkBuildEnv/,
  );
  assert.doesNotMatch(
    dist,
    /process\.env\.ESBUILD_BINARY_PATH = buildEnv\.ESBUILD_BINARY_PATH/,
  );
});

test('esbuild platform binary follows the native package layout', () => {
  assert.equal(
    esbuildPlatformBinaryPath('C:\\pkg', 'win32'),
    path.join('C:\\pkg', 'esbuild.exe'),
  );
  assert.equal(
    esbuildPlatformBinaryPath('/pkg', 'linux'),
    path.join('/pkg', 'bin', 'esbuild'),
  );
  assert.equal(
    esbuildPlatformBinaryPath('/pkg', 'darwin'),
    path.join('/pkg', 'bin', 'esbuild'),
  );
});
