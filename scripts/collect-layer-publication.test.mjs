// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-layer-publication.mjs',
);

function write(root, platform, name, body = name) {
  const directory = path.join(root, platform);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), body);
}

function completeFixture(root) {
  write(root, 'darwin', 'kungfu-tech-spec-4.0.0-alpha.1.tgz');
  write(root, 'darwin', 'kungfu-tech-storage-4.0.0-alpha.1.tgz');
  write(root, 'linux', 'kungfu-tech-core-4.0.0-alpha.1.tgz');
  for (const packageName of [
    'agent-session',
    'api',
    'gui',
    'kfx',
    'kfx-github-dogfood-bridge',
    'kfx-github-webhook-ingress',
    'kfx-suite-github-webhook-reference',
    'kfx-suite-system',
    'kfx-view-config-manager',
    'kfx-view-fact-manager',
    'kfx-view-github-events',
    'kfx-view-journal-manager',
    'kfx-view-kfx-manager',
    'kfx-view-rewind-inspector',
    'kfx-view-settings',
    'kfx-view-skill-manager',
    'kfx-view-status',
    'kfx-view-terminal',
    'kfx-view-work-dashboard',
    'sdk',
    'site',
    'skill',
    'tui',
  ])
    write(root, 'linux', `kungfu-tech-${packageName}-4.0.0-alpha.1.tgz`);
  for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
    write(root, platform, `kungfu-tech-storage-${platform}-4.0.0-alpha.1.tgz`);
    write(root, platform, `kungfu-tech-core-${platform}-4.0.0-alpha.1.tgz`);
    write(root, platform, `kungfu_storage-4.0.0a1-cp313-${platform}.whl`);
    write(root, platform, 'kungfu-sdk-4.0.0-alpha.1.crate', 'same-crate');
  }
  write(root, 'linux-arm64', 'kungfu-tech-core-linux-arm64-4.0.0-alpha.1.tgz');
  write(root, 'darwin', 'kungfu-cli-darwin-arm64.tar.gz');
  write(root, 'linux', 'kungfu-cli-linux-x64.tar.gz');
  write(root, 'win32', 'kungfu-cli-windows-x64.zip');
  write(root, 'darwin', 'Kungfu-4.0.0-alpha.1-arm64.dmg');
  write(root, 'linux', 'Kungfu-4.0.0-alpha.1-x86_64.AppImage');
  write(root, 'win32', 'Kungfu Setup 4.0.0-alpha.1.exe');
}

test('collects the exact 43-file cross-platform publication set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-publish-test-'));
  try {
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    completeFixture(input);
    const result = spawnSync(
      process.execPath,
      [RUNNER, '--input', input, '--output', output],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.artifacts.length, 43);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a platform package basename with divergent bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-publish-test-'));
  try {
    const input = path.join(root, 'input');
    completeFixture(input);
    write(root, 'input/other', 'kungfu-sdk-4.0.0-alpha.1.crate', 'other');
    const result = spawnSync(
      process.execPath,
      [RUNNER, '--input', input, '--output', path.join(root, 'output')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /divergent content/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects retired Kungfu Episodes desktop artifact names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-publish-test-'));
  try {
    const input = path.join(root, 'input');
    completeFixture(input);
    write(input, 'darwin', 'Kungfu Episodes-4.0.0-alpha.1-arm64.dmg');
    const result = spawnSync(
      process.execPath,
      [RUNNER, '--input', input, '--output', path.join(root, 'output')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retired desktop product artifact name/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
