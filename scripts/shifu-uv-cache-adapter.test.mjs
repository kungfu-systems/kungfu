// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  prepareUvCacheOverlay,
  publicUvLockViolations,
  runUvCacheAdapter,
  uvLockSemanticDigest,
} from './shifu-uv-cache-adapter.mjs';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function lock(
  registry = 'https://pypi.org/simple',
  artifacts = 'https://files.pythonhosted.org',
) {
  return `version = 1
revision = 3
requires-python = ">=3.12"

[[package]]
name = "demo"
version = "1.0.0"
source = { registry = "${registry}" }
sdist = { url = "${artifacts}/packages/demo-1.0.0.tar.gz", hash = "${HASH_A}", size = 1 }
wheels = [
    { url = "${artifacts}/packages/demo-1.0.0.whl", hash = "${HASH_B}", size = 1 },
]
`;
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function fakeUv(bin) {
  const module = path.join(bin, 'fake-uv.mjs');
  fs.writeFileSync(
    module,
    `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const projectAt = args.indexOf('--project');
const project = projectAt >= 0 ? args[projectAt + 1] : process.cwd();
if (args.includes('lock')) {
  const lock = path.join(project, 'uv.lock');
  const endpoint = args[args.indexOf('--default-index') + 1];
  const origin = new URL(endpoint).origin;
  const rebound = fs.readFileSync(lock, 'utf8')
    .replaceAll('https://pypi.org/simple', endpoint)
    .replaceAll('https://files.pythonhosted.org', origin);
  fs.writeFileSync(lock, rebound);
} else if (process.env.FAKE_UV_OUTPUT) {
  fs.writeFileSync(process.env.FAKE_UV_OUTPUT, JSON.stringify({
    args,
    projectEnvironment: process.env.UV_PROJECT_ENVIRONMENT,
    frozen: process.env.UV_FROZEN,
  }));
}
`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(bin, 'uv.cmd'),
      '@node "%~dp0fake-uv.mjs" %*\r\n',
    );
  } else {
    fs.writeFileSync(
      path.join(bin, 'uv'),
      '#!/bin/sh\nexec node "$(dirname "$0")/fake-uv.mjs" "$@"\n',
      { mode: 0o700 },
    );
  }
}

test('official PyPI lock policy rejects private and alternate hosts', () => {
  assert.deepEqual(publicUvLockViolations(lock()), []);
  const violations = publicUvLockViolations(
    lock(
      'http://package-cache.local/pypi/simple/',
      'http://artifact-cache.local',
    ),
  );
  assert.ok(violations.some((item) => item.includes('private registry host')));
  assert.ok(violations.some((item) => item.includes('private artifact host')));
  assert.ok(violations.some((item) => item.includes('not official PyPI')));
  assert.ok(
    publicUvLockViolations(
      `${lock()}\nsource = { url = "http://10.0.0.8/private.whl" }\n`,
    ).some((item) => item.includes('not an official PyPI transport')),
  );
});

test('transport URL rebinding preserves the uv lock semantic digest', () => {
  assert.equal(
    uvLockSemanticDigest(lock()),
    uvLockSemanticDigest(
      lock(
        'http://cache.example.invalid/simple/',
        'http://cache.example.invalid',
      ),
    ),
  );
});

test('effective lock and environment stay outside the canonical checkout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-uv-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const project = path.join(repo, 'framework', 'core');
  const bin = path.join(root, 'bin');
  const inheritedWrapperBin = path.join(root, 'inherited-wrapper-bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(inheritedWrapperBin);
  fs.writeFileSync(
    path.join(project, 'pyproject.toml'),
    '[project]\nname="demo"\nversion="1.0.0"\n',
  );
  fs.writeFileSync(path.join(project, 'uv.lock'), lock());
  checked('git', ['init', '-q'], { cwd: repo });
  checked(
    'git',
    ['add', 'framework/core/pyproject.toml', 'framework/core/uv.lock'],
    { cwd: repo },
  );
  fakeUv(bin);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(inheritedWrapperBin, 'uv.cmd'),
      '@exit /b 99\r\n',
    );
  } else {
    fs.writeFileSync(
      path.join(inheritedWrapperBin, 'uv'),
      '#!/bin/sh\nexit 99\n',
      { mode: 0o700 },
    );
  }

  const output = path.join(root, 'uv-run.json');
  const original = fs.readFileSync(path.join(project, 'uv.lock'), 'utf8');
  const statusBefore = checked('git', ['status', '--short'], {
    cwd: repo,
  }).stdout;
  const overlay = prepareUvCacheOverlay({
    cwd: repo,
    endpoint: 'http://cache.example.invalid/simple/',
    env: {
      ...process.env,
      PATH: `${inheritedWrapperBin}${path.delimiter}${bin}${path.delimiter}${process.env.PATH || ''}`,
      SHIFU_UV_ORIGINAL_PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_UV_OUTPUT: output,
    },
  });
  t.after(() => overlay.cleanup());

  assert.equal(overlay.evidence.enforcement, 'project-overlay');
  assert.equal(overlay.evidence.projectCount, 1);
  assert.equal(
    overlay.env.SHIFU_UV_ORIGINAL_PATH,
    `${bin}${path.delimiter}${process.env.PATH || ''}`,
  );
  assert.equal(
    fs.readFileSync(path.join(project, 'uv.lock'), 'utf8'),
    original,
  );
  assert.equal(
    checked('git', ['status', '--short'], { cwd: repo }).stdout,
    statusBefore,
  );

  const status = runUvCacheAdapter(['sync'], {
    cwd: project,
    env: {
      ...process.env,
      ...overlay.env,
      UV_DEFAULT_INDEX: 'http://cache.example.invalid/simple/',
      FAKE_UV_OUTPUT: output,
    },
  });
  assert.equal(status, 0);
  const invocation = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(invocation.args[0], '--project');
  assert.match(invocation.args[1], /shifu-uv-overlay-/);
  assert.equal(invocation.args.at(-1), 'sync');
  assert.match(invocation.projectEnvironment, /shifu-uv-overlay-/);
  assert.equal(invocation.frozen, '1');
  assert.throws(
    () =>
      runUvCacheAdapter(['add', 'another-package'], {
        cwd: project,
        env: overlay.env,
      }),
    /not allowed/,
  );

  const overlayRoot = overlay.root;
  overlay.cleanup();
  assert.equal(fs.existsSync(overlayRoot), false);
});
