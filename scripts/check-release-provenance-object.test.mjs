// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const read = (path) => fs.readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));

const contractPath =
  'framework/release/kungfu-release-provenance.contract.json';
const artifactPath = 'config/release/kungfu-release-provenance.contract.json';
const contract = readJson(contractPath);
const ROOT = process.cwd();

function git(repository, ...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

function sourceContent(repository, revision = 'HEAD') {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        'scripts/release-provenance-object.py',
        'source-content',
        '--repository',
        repository,
        '--revision',
        revision,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: path.join(ROOT, 'framework/core/src/python'),
        },
      },
    ),
  );
}

test('release provenance is a welded KFR2 semantic contract', () => {
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.rootProtocol, 'kungfu.fact-root.canonical/v2');
  assert.equal(contract.dualWrite.publicationAuthority, false);
  assert.deepEqual(
    new Set(contract.envelopes.requiredRelations),
    new Set([
      'derived-from',
      'acknowledges',
      'has-content',
      'qualified-by',
      'approved-by',
      'authorized-by',
      'implements-contract',
      'projected-as',
    ]),
  );
  assert.equal(read(contractPath), read(artifactPath));

  const sourceRegistry = readJson(
    'framework/contract/kungfu-contracts.registry.json',
  );
  const runtimeRegistry = readJson('config/kungfu-contracts.registry.json');
  assert.deepEqual(sourceRegistry, runtimeRegistry);
  const factContract = sourceRegistry.contracts.find(
    ({ id }) => id === 'kungfu-fact-cut-kernel',
  );
  assert.ok(
    factContract.extraArtifacts.some(
      ({ source, artifact }) =>
        source === contractPath && artifact === artifactPath,
    ),
  );
});

test('legacy provenance objects are retired from active release workflows', () => {
  const candidate = read('.github/workflows/dev-alpha-candidate-patrol.yml');
  const promotion = read('.github/workflows/release-new-version.yml');

  for (const workflow of [candidate, promotion]) {
    assert.match(workflow, /check:durable-provenance-authority/u);
    assert.doesNotMatch(workflow, /release-provenance-object\.py/u);
    assert.doesNotMatch(workflow, /candidate-provenance/u);
    assert.doesNotMatch(workflow, /promotion-provenance/u);
    assert.doesNotMatch(workflow, /git show -s --format=%P/u);
  }
});

test('canonical source content is stable across commit topology and changes on bytes', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-release-source-content-'),
  );
  try {
    git(repository, 'init', '-q');
    git(repository, 'config', 'user.name', 'Kungfu Test');
    git(repository, 'config', 'user.email', 'test@libkungfu.dev');
    fs.writeFileSync(path.join(repository, 'payload.txt'), 'same bytes\n');
    git(repository, 'add', 'payload.txt');
    git(repository, 'commit', '-q', '-m', 'initial');
    const initial = sourceContent(repository);
    git(
      repository,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'different topology',
    );
    const transported = sourceContent(repository);
    fs.writeFileSync(path.join(repository, 'payload.txt'), 'changed bytes\n');
    git(repository, 'add', 'payload.txt');
    git(repository, 'commit', '-q', '-m', 'change content');
    const changed = sourceContent(repository);

    assert.equal(initial.algorithm, 'sha256-canonical-file-set-v1');
    assert.equal(initial.digest, transported.digest);
    assert.equal(initial.contentRoot, transported.contentRoot);
    assert.notEqual(initial.digest, changed.digest);
  } finally {
    fs.rmSync(repository, { force: true, recursive: true });
  }
});

test('the package gate and source gate execute release provenance checks', () => {
  const scripts = readJson('package.json').scripts;
  assert.match(
    scripts['check:release-provenance-object'],
    /check-release-provenance-object\.test\.mjs/,
  );
  const sourceAcceptance = read('scripts/source-acceptance.mjs');
  assert.match(sourceAcceptance, /check-release-provenance-object\.test\.mjs/);
});
