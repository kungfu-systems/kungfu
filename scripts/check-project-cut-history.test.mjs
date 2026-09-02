// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildProjectCut,
  canonicalJson,
  semanticRoot,
} from '../framework/project-cut/index.mjs';
import {
  observeHistory,
  reconcileHistory,
  verifyHistoryObservation,
} from '../framework/project-cut/src/history.mjs';
import { checkProjectCutHistoryContract } from './project-cut-history-contract.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      'framework/project-cut/fixtures/golden/project-cut-v1.json',
    ),
    'utf8',
  ),
);
const CLI = path.join(REPO_ROOT, 'framework/project-cut/bin/project-cut.mjs');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`);
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-cut-history-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'History Test');
  git(root, 'config', 'user.email', 'history@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'history fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'test: initialize history fixture');
  return root;
}

function cut(seed, parentCutRoots = []) {
  const input = structuredClone(FIXTURE.projectCutInput);
  input.parentCutRoots = sorted(parentCutRoots);
  input.sourceProjection.root = semanticRoot({ source: seed });
  input.atlas.root = semanticRoot({ atlas: seed });
  input.episodeDelta.nativeRoots = [
    { provider: 'yijinjing/v1', root: semanticRoot({ episode: seed }) },
  ];
  return buildProjectCut(input, { availableParentRoots: input.parentCutRoots });
}

function addCut(root, value, legacy = false) {
  const relative = legacy
    ? `.kungfu/project-cuts/${value.cutRoot}/cut.json`
    : `.kungfu/project-cuts/sha256/${value.cutRoot.slice(7, 9)}/${value.cutRoot.slice(7)}/manifest.json`;
  writeJson(path.join(root, relative), value);
  return relative;
}

function commitCut(root, value, message) {
  const relative = addCut(root, value);
  git(root, 'add', relative);
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function request(operation, commit, cutRoots, overrides = {}) {
  return {
    schema: 'project.cut.history-request/v1',
    operation,
    commit,
    cutRoots: sorted(cutRoots),
    episodeRoots: [],
    integrationEpisodeRoot: null,
    semanticRelation:
      operation === 'publish' || operation === 'empty' ? 'new' : 'same',
    priorBindings: [],
    ref: null,
    ...overrides,
  };
}

function qualified(root, value) {
  const result = observeHistory(root, value);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(verifyHistoryObservation(result.observation).ok, true);
  return result.observation;
}

test('history schemas and operation matrix are rooted', () => {
  const result = checkProjectCutHistoryContract();
  assert.equal(result.schemaFiles, 2);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/);
});

test('history inventory retains legacy cut.json compatibility', (t) => {
  const root = workspace(t);
  const value = cut('legacy');
  const relative = addCut(root, value, true);
  git(root, 'add', relative);
  git(root, 'commit', '-qm', 'test: publish legacy Cut');
  const observation = qualified(
    root,
    request('publish', 'HEAD', [value.cutRoot]),
  );
  assert.deepEqual(observation.semantics.cutRoots, [value.cutRoot]);
});

test('history CLI emits stable JSON envelopes for observe and reconcile', (t) => {
  const root = workspace(t);
  const value = cut('cli');
  const commit = commitCut(root, value, 'test: publish CLI cut');
  const requestPath = path.join(root, 'history-request.json');
  writeJson(requestPath, request('publish', commit, [value.cutRoot]));
  const observed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        CLI,
        'history-observe',
        '--request',
        requestPath,
        '--root',
        root,
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(observed.schema, 'project.cut.history-response/v1');
  assert.equal(observed.ok, true);

  const observationsPath = path.join(root, 'history-observations.json');
  writeJson(observationsPath, [observed.observation]);
  const reconciled = JSON.parse(
    execFileSync(
      process.execPath,
      [
        CLI,
        'history-reconcile',
        '--observations',
        observationsPath,
        '--root',
        root,
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(reconciled.schema, 'project.cut.history-response/v1');
  assert.equal(reconciled.ok, true);
});

test('rewrite operations preserve sealed roots and unqualified rewrites fail visibly', (t) => {
  const root = workspace(t);
  const firstCut = cut('first');
  const firstCommit = commitCut(root, firstCut, 'test: publish first cut');
  let prior = qualified(
    root,
    request('publish', firstCommit, [firstCut.cutRoot]),
  );
  const observations = [prior];

  for (const operation of ['amend', 'rebase', 'squash', 'cherry-pick']) {
    fs.writeFileSync(path.join(root, `${operation}.txt`), `${operation}\n`);
    git(root, 'add', `${operation}.txt`);
    git(root, 'commit', '-qm', `test: model ${operation}`);
    const commit = git(root, 'rev-parse', 'HEAD');
    const next = qualified(
      root,
      request(operation, commit, [firstCut.cutRoot], {
        priorBindings: [prior],
      }),
    );
    assert.deepEqual(next.semantics.cutRoots, prior.semantics.cutRoots);
    prior = next;
    observations.push(prior);
  }

  const unqualified = observeHistory(
    root,
    request('rebase', 'HEAD', [firstCut.cutRoot]),
  );
  assert.equal(unqualified.ok, false);
  assert.ok(
    unqualified.diagnostics.some(
      (entry) => entry.code === 'unqualified-rewrite',
    ),
  );

  const publications = reconcileHistory(root, observations);
  assert.equal(publications.ok, true);
  assert.equal(publications.publications[0].commitOids.length, 5);

  const duplicateInitial = qualified(
    root,
    request('publish', 'HEAD', [firstCut.cutRoot]),
  );
  const duplicate = reconcileHistory(root, [observations[0], duplicateInitial]);
  assert.equal(duplicate.ok, false);
  assert.ok(
    duplicate.diagnostics.some(
      (entry) => entry.code === 'duplicate-initial-publication',
    ),
  );

  const forged = structuredClone(observations[0]);
  forged.operation = 'merge';
  forged.relation.kind = 'successor';
  const { observationRoot: _root, ...forgedPreimage } = forged;
  forged.observationRoot = semanticRoot(forgedPreimage);
  const forgedResult = verifyHistoryObservation(forged);
  assert.equal(forgedResult.ok, false);
  assert.ok(
    forgedResult.diagnostics.some((entry) => entry.code === 'not-a-merge'),
  );

  const invalidOid = structuredClone(observations[0]);
  invalidOid.publication.commitOid = 'a'.repeat(41);
  const { observationRoot: _invalidRoot, ...invalidPreimage } = invalidOid;
  invalidOid.observationRoot = semanticRoot(invalidPreimage);
  assert.equal(verifyHistoryObservation(invalidOid).ok, false);
});

test('merge, revert, recovery, empty, and ref contention have explicit semantics', (t) => {
  const root = workspace(t);
  const initial = git(root, 'rev-parse', 'HEAD');

  git(root, 'checkout', '-qb', 'left');
  const leftCut = cut('left');
  const leftCommit = commitCut(root, leftCut, 'test: publish left cut');
  const left = qualified(
    root,
    request('publish', leftCommit, [leftCut.cutRoot]),
  );

  git(root, 'checkout', '-qb', 'right', initial);
  const rightCut = cut('right');
  const rightCommit = commitCut(root, rightCut, 'test: publish right cut');
  const right = qualified(
    root,
    request('publish', rightCommit, [rightCut.cutRoot]),
  );

  git(root, 'checkout', '-q', 'left');
  git(root, 'merge', '--no-ff', '--no-commit', 'right');
  const mergedCut = cut('merged', [leftCut.cutRoot, rightCut.cutRoot]);
  addCut(root, mergedCut);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: publish merged cut');
  const mergeCommit = git(root, 'rev-parse', 'HEAD');
  const integrationEpisode = semanticRoot({ episode: 'integration' });
  const merge = qualified(
    root,
    request('merge', mergeCommit, [mergedCut.cutRoot], {
      episodeRoots: [integrationEpisode],
      integrationEpisodeRoot: integrationEpisode,
      semanticRelation: 'successor',
      priorBindings: [left, right],
    }),
  );
  assert.deepEqual(
    merge.semantics.parentCutRoots,
    sorted([leftCut.cutRoot, rightCut.cutRoot]),
  );

  const resolutionEpisode = semanticRoot({ episode: 'resolution' });
  const revertedCut = cut('reverted', [mergedCut.cutRoot]);
  const revertCommit = commitCut(root, revertedCut, 'test: publish revert cut');
  const revert = qualified(
    root,
    request('revert', revertCommit, [revertedCut.cutRoot], {
      episodeRoots: [resolutionEpisode],
      integrationEpisodeRoot: resolutionEpisode,
      semanticRelation: 'successor',
      priorBindings: [merge],
    }),
  );

  const recoveredCut = cut('recovered', [revertedCut.cutRoot]);
  const recoveryCommit = commitCut(
    root,
    recoveredCut,
    'test: publish recovery cut',
  );
  const recovery = qualified(
    root,
    request('recovery', recoveryCommit, [recoveredCut.cutRoot], {
      episodeRoots: [resolutionEpisode],
      integrationEpisodeRoot: resolutionEpisode,
      semanticRelation: 'successor',
      priorBindings: [revert],
    }),
  );
  const episodeMap = reconcileHistory(root, [
    left,
    right,
    merge,
    revert,
    recovery,
  ]);
  assert.equal(episodeMap.ok, true);
  assert.equal(
    episodeMap.episodes.find((entry) => entry.episodeRoot === resolutionEpisode)
      .commitOids.length,
    2,
  );

  git(root, 'commit', '--allow-empty', '-qm', 'test: empty publication commit');
  const emptyCommit = git(root, 'rev-parse', 'HEAD');
  qualified(root, request('empty', emptyCommit, []));

  git(root, 'branch', 'publication-ref', mergeCommit);
  const branchRequest = request('branch', mergeCommit, [mergedCut.cutRoot], {
    priorBindings: [merge],
    ref: { name: 'refs/heads/publication-ref', expectedOid: mergeCommit },
  });
  qualified(root, branchRequest);
  git(root, 'branch', '-f', 'publication-ref', emptyCommit);
  const lost = observeHistory(root, branchRequest);
  assert.equal(lost.ok, false);
  assert.ok(lost.diagnostics.some((entry) => entry.code === 'ref-cas-lost'));
});

test('orphan and archive reconciliation are visible and concurrent worktrees need no global lock', (t) => {
  const root = workspace(t);
  const initial = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'orphan-candidate');
  const orphanCut = cut('orphan');
  const orphanCommit = commitCut(root, orphanCut, 'test: publish orphan cut');
  const orphan = qualified(
    root,
    request('publish', orphanCommit, [orphanCut.cutRoot]),
  );
  git(root, 'checkout', '-q', 'main');
  git(root, 'branch', '-D', 'orphan-candidate');
  const unreconciled = reconcileHistory(root, [orphan]);
  assert.equal(unreconciled.ok, false);
  assert.equal(unreconciled.bindings[0].disposition, 'orphaned');
  const archived = reconcileHistory(root, [orphan], {
    archivedRoots: [orphan.observationRoot],
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.bindings[0].disposition, 'archived');

  const worktreeRoot = `${root}-peer`;
  t.after(() => {
    try {
      git(root, 'worktree', 'remove', '--force', worktreeRoot);
    } catch {}
  });
  git(root, 'worktree', 'add', '-qb', 'peer', worktreeRoot, initial);
  const mainCut = cut('main-independent');
  const mainCutTwo = cut('main-independent-two');
  addCut(root, mainCut);
  addCut(root, mainCutTwo);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: publish two main worktree cuts');
  const mainCommit = git(root, 'rev-parse', 'HEAD');
  const peerCut = cut('peer-independent');
  const peerCommit = commitCut(
    worktreeRoot,
    peerCut,
    'test: publish peer worktree cut',
  );
  const mainObservation = qualified(
    root,
    request('publish', mainCommit, [mainCut.cutRoot, mainCutTwo.cutRoot], {
      ref: { name: 'refs/heads/main', expectedOid: mainCommit },
    }),
  );
  const peerObservation = qualified(
    worktreeRoot,
    request('publish', peerCommit, [peerCut.cutRoot], {
      ref: { name: 'refs/heads/peer', expectedOid: peerCommit },
    }),
  );
  assert.notEqual(
    mainObservation.publication.commitOid,
    peerObservation.publication.commitOid,
  );
  const concurrent = reconcileHistory(root, [mainObservation, peerObservation]);
  assert.equal(concurrent.ok, true);
  assert.equal(concurrent.publications.length, 3);
});
