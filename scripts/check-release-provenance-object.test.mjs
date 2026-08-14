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

test('candidate and promotion workflows pass one topology-neutral rooted object', () => {
  const candidate = read('.github/workflows/dev-alpha-candidate-patrol.yml');
  const promotion = read('.github/workflows/release-new-version.yml');

  assert.match(candidate, /release-provenance-object\.py candidate-v2/);
  assert.match(candidate, /release-provenance-object\.py source-content/);
  assert.match(candidate, /release-provenance-object\.py verify/);
  assert.match(
    candidate,
    /release-provenance-candidate-\$\{\{ steps\.provenance\.outputs\.candidate-commit \}\}/,
  );
  assert.match(candidate, /priorStateRoot/);
  assert.match(
    candidate,
    /--candidate-id "release-candidate:\$RELEASE_ID:\$QUALIFICATION_STATE_ROOT"/,
  );
  assert.match(
    candidate,
    /--dev-cut-id "release-cut:\$RELEASE_ID:development:\$QUALIFICATION_STATE_ROOT"/,
  );
  assert.match(
    candidate,
    /--previous-alpha-id "release-cut:\$RELEASE_ID:previous-alpha:\$QUALIFICATION_STATE_ROOT"/,
  );
  assert.match(candidate, /--approval-id "protected-review-policy:/);
  assert.match(candidate, /observed_parent_args=\(\)/);

  assert.match(promotion, /release-provenance-object\.py promotion/);
  assert.match(promotion, /release-provenance-object\.py verify/);
  assert.match(promotion, /actions\/download-artifact@/);
  assert.match(promotion, /candidate-provenance-run-id/);
  assert.match(promotion, /\.head_branch == \$defaultBranch/);
  assert.match(
    promotion,
    /--candidate-envelope "\$output_dir\/candidate\.json"/,
  );
  assert.match(promotion, /candidate-provenance-root/);
  assert.match(promotion, /candidate-content-root/);
  assert.match(promotion, /candidate-dev-cut-root/);
  assert.match(promotion, /candidate-previous-alpha-root/);
  assert.match(promotion, /candidate-qualification-root/);
  assert.match(promotion, /candidate-approval-root/);
  assert.match(promotion, /candidate-authority-root/);
  assert.match(promotion, /promotion-provenance-root/);
  assert.match(promotion, /release-provenance-promotion-/);
  assert.match(promotion, /candidate_ancestry_observed=false/);
  assert.match(
    promotion,
    /--promotion-id "release-promotion:\$\{\{ inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref \}\}:\$PREFLIGHT_RECEIPT_ROOT"/,
  );
  assert.doesNotMatch(
    promotion,
    /candidate_parents|candidate_parents\[[01]\]/u,
  );
  assert.doesNotMatch(promotion, /git show -s --format=%P/u);

  for (const workflow of [candidate, promotion]) {
    assert.doesNotMatch(workflow, /release-provenance-object\.py publication/);
    assert.doesNotMatch(
      workflow,
      /--candidate-id "\$(?:candidate_sha|CANDIDATE_SHA)"/,
    );
    assert.doesNotMatch(
      workflow,
      /--dev-cut-id [^\n]*(?:SELECTED_SHA|dev_cut_sha)/,
    );
    assert.doesNotMatch(
      workflow,
      /--previous-alpha-id [^\n]*(?:previous_alpha_sha|PREVIOUS_ALPHA_SHA)/,
    );
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
