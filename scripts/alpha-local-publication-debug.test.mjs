#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCleanCheckout,
  completeRegularFileInventory,
  parseArguments,
  parsePortableArguments,
  parseReplayArguments,
  replayScenarioObservations,
  validateCoordinates,
} from '../framework/release/alpha-local-publication-debug/index.mjs';

function root(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function git(repo, ...args) {
  const result = childProcess.spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('explicit coordinates must be pairwise disjoint', (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-debug-coordinates-'),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'candidate');
  const scratchRoot = path.join(root, 'scratch');
  const buildchainRoot = path.join(root, 'buildchain');
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(buildchainRoot);
  const realRoot = fs.realpathSync(root);

  assert.deepEqual(
    validateCoordinates({ artifactRoot, scratchRoot, buildchainRoot }),
    {
      artifactRoot: path.join(realRoot, 'candidate'),
      scratchRoot: path.join(realRoot, 'scratch'),
      buildchainRoot: path.join(realRoot, 'buildchain'),
    },
  );
  assert.throws(
    () =>
      validateCoordinates({
        artifactRoot,
        scratchRoot: path.join(artifactRoot, 'output'),
        buildchainRoot,
      }),
    /must be disjoint/u,
  );
  assert.throws(
    () =>
      validateCoordinates({
        artifactRoot,
        scratchRoot,
        buildchainRoot: artifactRoot,
      }),
    /must be disjoint/u,
  );
});

test('the Buildchain runtime checkout must remain clean', (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-debug-buildchain-'),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  fs.writeFileSync(
    path.join(root, 'runtime.js'),
    'export const version = 1;\n',
  );
  git(root, 'add', 'runtime.js');
  git(
    root,
    '-c',
    'user.name=Kungfu Test',
    '-c',
    'user.email=kungfu-test@example.invalid',
    'commit',
    '-q',
    '-m',
    'test: seed runtime',
  );

  assert.doesNotThrow(() => assertCleanCheckout(root, '--buildchain-root'));
  fs.writeFileSync(
    path.join(root, 'runtime.js'),
    'export const version = 2;\n',
  );
  assert.throws(
    () => assertCleanCheckout(root, '--buildchain-root'),
    /must be clean/u,
  );
});

test('the one-command interface is explicit and closed to unknown options', () => {
  const expected = {
    'artifact-root': '/candidate',
    'scratch-root': '/scratch',
    'buildchain-root': '/buildchain',
  };
  assert.deepEqual(
    parseArguments([
      '--artifact-root',
      '/candidate',
      '--scratch-root',
      '/scratch',
      '--buildchain-root',
      '/buildchain',
    ]),
    expected,
  );
  assert.deepEqual(
    parseArguments([
      '--',
      '--artifact-root',
      '/candidate',
      '--scratch-root',
      '/scratch',
      '--buildchain-root',
      '/buildchain',
    ]),
    expected,
  );
  assert.throws(
    () => parseArguments(['--artifact-root', '/candidate']),
    /--scratch-root is required/u,
  );
  assert.throws(
    () =>
      parseArguments([
        '--artifact-root',
        '/candidate',
        '--artifact-root',
        '/other',
        '--scratch-root',
        '/scratch',
        '--buildchain-root',
        '/buildchain',
      ]),
    /duplicate option/u,
  );
  assert.throws(
    () =>
      parseArguments([
        '--artifact-root',
        '/candidate',
        '--scratch-root',
        '/scratch',
        '--buildchain-root',
        '/buildchain',
        '--publish',
        'true',
      ]),
    /unknown option/u,
  );
});

test('the exact candidate inventory covers every regular file and rejects drift', (context) => {
  const candidate = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-debug-inventory-'),
  );
  context.after(() => fs.rmSync(candidate, { recursive: true, force: true }));
  fs.mkdirSync(path.join(candidate, 'bindings'));
  const bytes = Buffer.from('exact candidate bytes\n');
  fs.writeFileSync(path.join(candidate, 'bindings/source.json'), bytes);
  const declared = [
    {
      role: 'candidate-source-binding',
      path: 'bindings/source.json',
      size: bytes.length,
      root: root(bytes),
    },
  ];

  const inventory = completeRegularFileInventory(candidate, declared);
  assert.equal(inventory.fileCount, 1);
  assert.match(inventory.inventoryRoot, /^sha256:[0-9a-f]{64}$/u);

  fs.writeFileSync(path.join(candidate, 'unexpected.txt'), 'drift\n');
  assert.throws(
    () => completeRegularFileInventory(candidate, declared),
    /regular-file inventory differs/u,
  );
  fs.rmSync(path.join(candidate, 'unexpected.txt'));
  fs.writeFileSync(path.join(candidate, 'bindings/source.json'), 'tampered\n');
  assert.throws(
    () => completeRegularFileInventory(candidate, declared),
    /file binding drift/u,
  );
});

test('the portable smoke requires an exact capsule and admitted roots', () => {
  assert.deepEqual(
    parsePortableArguments([
      '--',
      '--capsule',
      '/data/rehearsal-capsule.json',
      '--capsule-root',
      '/data/candidate',
      '--buildchain-root',
      '/data/buildchain',
      '--expected-binding-root',
      `sha256:${'a'.repeat(64)}`,
      '--expected-transaction-root',
      `sha256:${'b'.repeat(64)}`,
    ]),
    {
      capsule: '/data/rehearsal-capsule.json',
      'capsule-root': '/data/candidate',
      'buildchain-root': '/data/buildchain',
      'expected-binding-root': `sha256:${'a'.repeat(64)}`,
      'expected-transaction-root': `sha256:${'b'.repeat(64)}`,
    },
  );
  assert.throws(
    () => parsePortableArguments(['--capsule', '/data/capsule.json']),
    /--capsule-root is required/u,
  );
});

test('replay qualification accepts only explicit immutable and scratch coordinates', () => {
  assert.deepEqual(
    parseReplayArguments([
      '--',
      '--capsule',
      '/data/rehearsal-capsule.json',
      '--capsule-root',
      '/data/candidate',
      '--scratch-root',
      '/data/replay-output',
      '--buildchain-root',
      '/data/buildchain',
    ]),
    {
      capsule: '/data/rehearsal-capsule.json',
      'capsule-root': '/data/candidate',
      'scratch-root': '/data/replay-output',
      'buildchain-root': '/data/buildchain',
    },
  );
  assert.throws(
    () =>
      parseReplayArguments([
        '--capsule',
        '/data/rehearsal-capsule.json',
        '--capsule-root',
        '/data/candidate',
      ]),
    /--scratch-root is required/u,
  );
});

test('replay scenarios encode readback-first bounded fault transcripts', () => {
  const operation = (id) => ({
    operationId: root(id),
    effect: {
      subjectRoot: root(`${id}-subject`),
      targetRoot: root(`${id}-target`),
    },
  });
  const capsule = {
    transaction: { operations: [operation('first'), operation('second')] },
  };
  const bounded = replayScenarioObservations(capsule, 'bounded-transient');
  assert.deepEqual(
    bounded[0].readbacks.map((entry) => entry.outcome),
    ['transient', 'absent', 'observed'],
  );
  const duplicate = replayScenarioObservations(capsule, 'duplicate-observed');
  assert.deepEqual(
    duplicate.map((entry) => entry.readbacks[0].outcome),
    ['observed', 'observed'],
  );
  const conflict = replayScenarioObservations(capsule, 'immutable-collision');
  assert.equal(conflict[0].readbacks[0].outcome, 'conflict');
  const missing = replayScenarioObservations(capsule, 'missing-observation');
  assert.deepEqual(
    missing[0].readbacks.map((entry) => entry.outcome),
    ['absent'],
  );
  assert.throws(
    () => replayScenarioObservations(capsule, 'unknown'),
    /unknown replay scenario/u,
  );
});
