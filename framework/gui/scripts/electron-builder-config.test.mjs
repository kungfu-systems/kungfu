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
