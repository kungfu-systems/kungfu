// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bundleFetchUrl,
  prepareGateMeasurementHistory,
} from './prepare-gate-measurement-history.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepository(root) {
  const repository = path.join(root, 'origin');
  fs.mkdirSync(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Gate History Test');
  git(repository, 'config', 'user.email', 'gate-history@example.invalid');
  fs.writeFileSync(path.join(repository, 'fixture.txt'), 'one\n');
  git(repository, 'add', 'fixture.txt');
  git(repository, 'commit', '-m', 'first');
  fs.appendFileSync(path.join(repository, 'fixture.txt'), 'two\n');
  git(repository, 'commit', '-am', 'second');
  return repository;
}

test('normalizes a Windows bundle path to an unambiguous file URL', () => {
  assert.equal(
    bundleFetchUrl('C:\\runner\\cache\\kungfu.bundle', 'win32'),
    'file:///C:/runner/cache/kungfu.bundle',
  );
  assert.equal(
    bundleFetchUrl('/runner/cache/kungfu.bundle', 'linux'),
    '/runner/cache/kungfu.bundle',
  );
});

test('recovers a complete local object graph without fetching origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-local-'));
  try {
    const repository = makeRepository(root);
    const head = git(repository, 'rev-parse', 'HEAD');
    const shallowPath = path.resolve(
      repository,
      git(repository, 'rev-parse', '--git-path', 'shallow'),
    );
    fs.writeFileSync(shallowPath, `${head}\n`);
    assert.equal(
      git(repository, 'rev-parse', '--is-shallow-repository'),
      'true',
    );

    assert.equal(prepareGateMeasurementHistory(repository), 'recovered-local');
    assert.equal(
      git(repository, 'rev-parse', '--is-shallow-repository'),
      'false',
    );
    assert.equal(git(repository, 'rev-list', '--count', 'HEAD'), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to an unshallow fetch when objects are genuinely absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-fetch-'));
  try {
    const origin = makeRepository(root);
    const checkout = path.join(root, 'checkout');
    execFileSync('git', ['clone', '--depth=1', `file://${origin}`, checkout], {
      stdio: 'ignore',
    });
    assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');

    assert.equal(prepareGateMeasurementHistory(checkout), 'fetched-origin');
    assert.equal(
      git(checkout, 'rev-parse', '--is-shallow-repository'),
      'false',
    );
    assert.equal(git(checkout, 'rev-list', '--count', 'HEAD'), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restores the source-acceptance base ref after local history recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-base-'));
  try {
    const origin = makeRepository(root);
    git(origin, 'branch', 'dev/v4/v4.0', 'HEAD~1');
    const checkout = path.join(root, 'checkout');
    execFileSync('git', ['clone', `file://${origin}`, checkout], {
      stdio: 'ignore',
    });
    git(checkout, 'update-ref', '-d', 'refs/remotes/origin/dev/v4/v4.0');
    const head = git(checkout, 'rev-parse', 'HEAD');
    const shallowPath = path.resolve(
      checkout,
      git(checkout, 'rev-parse', '--git-path', 'shallow'),
    );
    fs.writeFileSync(shallowPath, `${head}\n`);

    assert.equal(
      prepareGateMeasurementHistory(checkout, {
        baseRef: 'dev/v4/v4.0',
      }),
      'recovered-local',
    );
    assert.equal(
      git(checkout, 'rev-parse', 'refs/remotes/origin/dev/v4/v4.0'),
      git(origin, 'rev-parse', 'dev/v4/v4.0'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
