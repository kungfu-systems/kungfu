// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function readProjection(relative) {
  return JSON.parse(
    fs
      .readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n'),
  );
}

test('electron-builder projections are deterministic and current', () => {
  const result = spawnSync(
    process.execPath,
    [
      'developer/maintainability/semantic-amplification.mjs',
      '--electron-builder-config-check',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('product overlay preserves common policy and owns only product resources', () => {
  const framework = readProjection('framework/gui/electron-builder.yml');
  const product = readProjection('product/electron-builder.yml');
  for (const key of [
    'appId',
    'productName',
    'asar',
    'npmRebuild',
    'beforePack',
    'afterPack',
    'publish',
    'files',
    'mac',
    'linux',
    'nsis',
    'win',
  ]) {
    assert.deepEqual(product[key], framework[key], key);
  }
  assert.equal(product.directories.output, '../../product/dist/desktop');
  assert.deepEqual(
    product.extraResources.map((resource) => resource.to),
    [
      'app/node_modules/@kungfu-tech/agent-session',
      'kungfu',
      'upgrade/kungfu-release-manifest.json',
      'cli',
      'tui',
      'extensions',
      'sdk',
      'action',
      'kfd',
      'templates',
      'node_modules',
    ],
  );
  assert.deepEqual(product.extraResources[0].filter, [
    'package.json',
    'src/**/*',
    'kungfu-agent-session.contract.json',
    'kungfu-codex-app-server.contract.json',
    'schemas/**/*',
  ]);
});

test('desktop product identity converges on Kungfu without changing upgrade identity', () => {
  const framework = readProjection('framework/gui/electron-builder.yml');
  const product = readProjection('product/electron-builder.yml');
  const productPackage = JSON.parse(
    fs.readFileSync(
      new URL(import.meta.resolve('@kungfu-tech/product-kungfu/package.json')),
    ),
  );
  assert.equal(framework.appId, 'com.kungfu.app');
  assert.equal(product.appId, 'com.kungfu.app');
  assert.equal(framework.productName, 'Kungfu');
  assert.equal(product.productName, 'Kungfu');
  assert.equal(productPackage.kungfuProduct.displayName, 'Kungfu');

  const sourceContracts = [
    'framework/gui/src/main/product-identity.ts',
    'framework/gui/src/renderer/index.html',
    '.buildchain/buildchain.toml',
    'scripts/publish-alpha-run.mjs',
  ].map((file) =>
    fs.readFileSync(new URL(`../../../${file}`, import.meta.url)),
  );
  for (const source of sourceContracts) {
    assert.doesNotMatch(source.toString(), /Kungfu Episodes|Kungfu-Episodes/u);
  }
  assert.match(sourceContracts[0].toString(), /PRODUCT_NAME = 'Kungfu'/u);
  assert.match(sourceContracts[1].toString(), /<title>Kungfu<\/title>/u);
  assert.match(
    sourceContracts[2].toString(),
    /product\/dist\/desktop\/mac-arm64\/Kungfu\.app/u,
  );
  assert.match(sourceContracts[3].toString(), /Kungfu-\\d\+.*\\\.AppImage/u);
  assert.match(sourceContracts[3].toString(), /Kungfu Setup \\d\+.*\\\.exe/u);
  assert.match(sourceContracts[3].toString(), /-macos-arm64/u);
  assert.match(sourceContracts[3].toString(), /Kungfu\.Setup\./u);
});

test('Windows uninstall retries the owned native runtime subtree', () => {
  const framework = readProjection('framework/gui/electron-builder.yml');
  assert.equal(framework.nsis.include, 'resources/installer.nsh');

  const include = fs.readFileSync(
    new URL('../resources/installer.nsh', import.meta.url),
    'utf8',
  );
  assert.match(include, /!macro customUnInstall/);
  assert.match(include, /RMDir \/r "\$INSTDIR\\resources\\kungfu"/);
  assert.match(include, /StrCpy \$R8 60/);
  assert.doesNotMatch(include, /RMDir \/r "?\$INSTDIR"?\s*$/m);
});
