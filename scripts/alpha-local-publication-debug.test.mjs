#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCleanCheckout,
  parseArguments,
  validateCoordinates,
} from '../framework/release/alpha-local-publication-debug/index.mjs';

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
