// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exposeGateMeasurementPython,
  exposeGateMeasurementRunnerTemp,
  gateMeasurementToolPath,
  gateMeasurementUvCommand,
} from './gate-measurement-environment.mjs';

test('projects runner temp into every platform temporary-directory variable', () => {
  const env = {
    RUNNER_TEMP: '/fast/runner/temp',
    TEMP: '/slow/system/temp',
    TMP: '/slow/system/tmp',
    TMPDIR: '/slow/system/tmpdir',
  };
  assert.equal(exposeGateMeasurementRunnerTemp({ env }), '/fast/runner/temp');
  assert.equal(env.TEMP, '/fast/runner/temp');
  assert.equal(env.TMP, '/fast/runner/temp');
  assert.equal(env.TMPDIR, '/fast/runner/temp');
});

test('preserves host temp selection outside a runner', () => {
  const env = { TMPDIR: '/host/temp' };
  assert.equal(exposeGateMeasurementRunnerTemp({ env }), '');
  assert.deepEqual(env, { TMPDIR: '/host/temp' });
});

test('keeps the managed uv wrapper ahead of user tool directories', () => {
  const wrapper = path.join('cache', 'uv-wrapper');
  const cargo = path.join('home', '.cargo', 'bin');
  const local = path.join('home', '.local', 'bin');
  const system = path.join('usr', 'bin');
  assert.equal(
    gateMeasurementToolPath(
      [wrapper, system, cargo].join(path.delimiter),
      [cargo, local],
      { managedUv: true },
    ),
    [wrapper, cargo, local, system].join(path.delimiter),
  );
});

test('continues to expose user tools first without a managed uv wrapper', () => {
  const cargo = path.join('home', '.cargo', 'bin');
  const system = path.join('usr', 'bin');
  assert.equal(
    gateMeasurementToolPath(system, [cargo]),
    [cargo, system].join(path.delimiter),
  );
});

test('resolves the managed uv wrapper without relying on Windows PATH casing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-measurement-uv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'uv'), '');
  fs.writeFileSync(path.join(bin, 'uv.cmd'), '');
  const env = {
    SHIFU_CACHE_MANAGED_UV: '1',
    SHIFU_UV_ADAPTER_MANIFEST: manifestPath,
    Path: path.join(root, 'unmanaged'),
    PATH: bin,
  };
  assert.deepEqual(gateMeasurementUvCommand({ env, platform: 'linux' }), {
    command: path.join(bin, 'uv'),
    shell: false,
  });
  assert.deepEqual(gateMeasurementUvCommand({ env, platform: 'win32' }), {
    command: path.join(bin, 'uv.cmd'),
    shell: true,
  });
});

test('uses ordinary uv lookup without a managed cache projection', () => {
  assert.deepEqual(gateMeasurementUvCommand({ env: {}, platform: 'win32' }), {
    command: 'uv',
    shell: false,
  });
});

test('projects the materialized core environment from the strict uv manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-measurement-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = path.join(root, 'repo', 'framework', 'core');
  const environment = path.join(root, 'overlay', 'environment');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(core, { recursive: true });
  fs.mkdirSync(environment, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema: 'shifu.uv-cache-overlay/v1',
      projects: [
        { source: core, overlay: path.join(root, 'overlay'), environment },
      ],
    })}\n`,
  );
  const wrapper = path.join(root, 'uv-wrapper');
  const system = path.join(root, 'system-bin');
  const env = {
    PATH: [wrapper, system].join(path.delimiter),
    SHIFU_CACHE_MANAGED_UV: '1',
  };
  assert.equal(
    exposeGateMeasurementPython(core, { env, manifestPath }),
    environment,
  );
  assert.equal(env.UV_PROJECT_ENVIRONMENT, environment);
  assert.equal(
    env.PATH,
    [wrapper, path.join(environment, 'bin'), system].join(path.delimiter),
  );
});

test('projects Windows environment tools using the existing PATH casing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-measurement-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = path.join(root, 'repo', 'framework', 'core');
  const environment = path.join(root, 'overlay', 'environment');
  fs.mkdirSync(core, { recursive: true });
  fs.mkdirSync(environment, { recursive: true });
  const env = {
    Path: path.join(root, 'system-bin'),
    UV_PROJECT_ENVIRONMENT: environment,
  };
  assert.equal(
    exposeGateMeasurementPython(core, { env, platform: 'win32' }),
    environment,
  );
  assert.equal(
    env.Path,
    [path.join(environment, 'Scripts'), path.join(root, 'system-bin')].join(
      path.delimiter,
    ),
  );
});

test('fails closed when the selected environment was not materialized', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-measurement-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = path.join(root, 'repo', 'framework', 'core');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema: 'shifu.uv-cache-overlay/v1',
      projects: [
        {
          source: core,
          overlay: path.join(root, 'overlay'),
          environment: path.join(root, 'missing'),
        },
      ],
    })}\n`,
  );
  assert.throws(
    () => exposeGateMeasurementPython(core, { env: {}, manifestPath }),
    /not materialized/,
  );
});
