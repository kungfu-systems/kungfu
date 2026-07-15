// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  loadExecutionProfile,
  parseExecutionProfile,
  releaseQualificationEnvironment,
  releaseQualificationStages,
} from './run-release-qualification.mjs';

test('qualification temp state is repository scoped on every platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-release-env-'));
  try {
    const env = releaseQualificationEnvironment(root, {
      TMPDIR: '/host/tmpdir',
      TEMP: '/host/temp',
      TMP: '/host/tmp',
    });
    const expected = path.join(root, '.buildchain', 'tmp');
    assert.equal(env.TMPDIR, expected);
    assert.equal(env.TEMP, expected);
    assert.equal(env.TMP, expected);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const names = (platform) =>
  releaseQualificationStages(platform).map(([name]) => name);

test('canonical Episode release evidence runs once on the Linux release leg', () => {
  assert.ok(names('linux').includes('episode:qualify:release'));
  assert.ok(!names('darwin').includes('episode:qualify:release'));
  assert.ok(!names('win32').includes('episode:qualify:release'));
});

test('ADR admission follows Episode evidence only on the Linux release leg', () => {
  const linux = names('linux');
  assert.equal(
    linux.indexOf('adr:release:gate'),
    linux.indexOf('episode:qualify:release') + 1,
  );
  assert.ok(!names('darwin').includes('adr:release:gate'));
  assert.ok(!names('win32').includes('adr:release:gate'));
});

test('every platform runs the complete qualification stage sequence', () => {
  const required = [
    'verify',
    'live-peer:qualify',
    'runtime:qualify',
    'test:upgrade-qualification',
    'zero-burden:qualify',
    'gate',
    'upgrade:qualify:native',
  ];
  for (const platform of ['linux', 'darwin', 'win32'])
    assert.deepEqual(
      names(platform).filter(
        (name) =>
          name !== 'episode:qualify:release' && name !== 'adr:release:gate',
      ),
      required,
    );
});

test('cryptographic upgrade qualification runs before artifact layer admission', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const stages = names(platform);
    assert.ok(
      stages.indexOf('test:upgrade-qualification') < stages.indexOf('gate'),
    );
  }
});

test('alpha and release qualification retain the live Peer report and raw bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const continuity = releaseQualificationStages(platform).find(
      ([name]) => name === 'live-peer:qualify',
    );
    assert.deepEqual(continuity, [
      'live-peer:qualify',
      '--',
      '--retain',
      'product/release/qualification/live-peer-continuity',
    ]);
  }
});

test('alpha and release qualification retain the complete runtime report and log bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const runtime = releaseQualificationStages(platform).find(
      ([name]) => name === 'runtime:qualify',
    );
    assert.deepEqual(runtime, [
      'runtime:qualify',
      '--',
      '--mode',
      'execute',
      '--with-product',
      '--retain',
      'product/release/qualification/runtime-activation',
    ]);
  }
});

test('alpha and release qualification retain the cross-layer desktop report and raw bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const aggregate = releaseQualificationStages(platform).find(
      ([name]) => name === 'zero-burden:qualify',
    );
    assert.deepEqual(aggregate, [
      'zero-burden:qualify',
      '--',
      '--retain',
      'product/release/qualification/zero-burden-desktop',
    ]);
  }
});

test('the Gate stage emits one source-bound receipt for all artifact layers', () => {
  const gateStage = releaseQualificationStages('darwin').find(
    ([name]) => name === 'gate',
  );
  assert.deepEqual(gateStage.slice(0, 5), [
    'gate',
    'run',
    'layers.format',
    'layers.sdk',
    'layers.surfaces',
  ]);
  assert.ok(gateStage.includes('--receipt'));
  assert.ok(gateStage.includes('--overwrite'));
  assert.ok(!gateStage.includes('pack:spec'));
  assert.ok(!gateStage.includes('layers:qualify:format'));
});

test('execution profiles propagate bounded Episode and receipt parameters', () => {
  const release = loadExecutionProfile('release-candidate');
  const stages = releaseQualificationStages('linux', release);
  const episode = stages.find(([name]) => name === 'episode:qualify:release');
  assert.deepEqual(episode.slice(1, 4), [
    '--',
    '--profile',
    'mvp-candidate-v1',
  ]);
  const gate = stages.find(([name]) => name === 'gate');
  const context = JSON.parse(gate[gate.indexOf('--execution-context') + 1]);
  assert.equal(context.executionProfile, 'release-candidate');
  assert.equal(context.effectiveParameters.episodeTimeoutSeconds, 1200);
  assert.match(context.policyDigest, /^sha256:[0-9a-f]{64}$/);
});

test('native upgrade evidence is retained only after exact artifact gates pass', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const stages = names(platform);
    assert.equal(
      stages.indexOf('upgrade:qualify:native'),
      stages.indexOf('gate') + 1,
    );
  }
});

test('execution profile parsing fails closed on missing, duplicate, and unknown values', () => {
  assert.equal(
    parseExecutionProfile(['--execution-profile', 'alpha']),
    'alpha',
  );
  assert.throws(() => parseExecutionProfile([]), /is required/);
  assert.throws(
    () =>
      parseExecutionProfile([
        '--execution-profile',
        'alpha',
        '--execution-profile',
        'release-candidate',
      ]),
    /specified once/,
  );
  assert.throws(() => loadExecutionProfile('missing'), /unknown/);
});

test('execution profile numeric constraints reject zero and negative values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-profile-'));
  try {
    const valid = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'docs/qualification/gates/execution-profiles.json',
        ),
        'utf8',
      ),
    );
    valid.profiles.alpha.budgetSeconds = 0;
    const file = path.join(root, 'profiles.json');
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.throws(
      () => loadExecutionProfile('alpha', file),
      /positive integer/,
    );
    valid.profiles.alpha.budgetSeconds = 1800;
    valid.profiles.alpha.reserveSeconds = -1;
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.throws(
      () => loadExecutionProfile('alpha', file),
      /positive integer/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
