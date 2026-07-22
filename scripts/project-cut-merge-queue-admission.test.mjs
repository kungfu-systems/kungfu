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
  createProjectCutReceipt,
  semanticRoot,
} from '../framework/project-cut/src/project-cut.mjs';
import { sourceProjectionAtCommit } from '../framework/project-cut/src/settlement.mjs';
import {
  inspectProjectCutMergeQueueAdmission,
  replayFirstParentOntoBase,
} from './project-cut-merge-queue-admission.mjs';

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

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function workspace(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'project-cut-queue-admission-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Queue Admission Test');
  git(root, 'config', 'user.email', 'queue-admission@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'queue admission fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'test: initialize queue admission fixture');
  return root;
}

function commitFile(root, relative, content, message) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
  git(root, 'add', relative);
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`);
}

let cutSeed = 1;
function publishCut(root, parentCutRoots = [], sourceRoot = null) {
  const input = structuredClone(FIXTURE.projectCutInput);
  input.project.id = 'queue-admission/fixture';
  input.parentCutRoots = [...parentCutRoots];
  input.visibility = 'public';
  input.omissions = [];
  input.conflicts = [];
  input.unknowns = [];
  input.atlas.root = semanticRoot({ queueAdmission: cutSeed++ });
  input.episodeDelta = {
    schema: 'kungfu.episode-delta-ref/v1',
    empty: true,
    nativeRoots: [],
    semanticRoot: null,
    equivalenceProfileRoot: null,
  };
  input.sourceProjection.root =
    sourceRoot ?? sourceProjectionAtCommit(root, 'HEAD', input).root;
  const cut = buildProjectCut(input, { availableParentRoots: parentCutRoots });
  const relative = `.kungfu/project-cuts/sha256/${cut.cutRoot.slice(7, 9)}/${cut.cutRoot.slice(7)}`;
  const manifest = path.join(root, relative, 'manifest.json');
  writeJson(manifest, cut);
  writeJson(
    path.join(root, relative, 'receipt.json'),
    createProjectCutReceipt(cut, fs.readFileSync(manifest), {
      availableParentRoots: parentCutRoots,
    }),
  );
  git(root, 'add', relative);
  git(root, 'commit', '-qm', `test: publish ${cut.cutRoot.slice(7, 15)}`);
  return { cut, commit: git(root, 'rev-parse', 'HEAD') };
}

test('synthetic replay matches the tree produced by a real rebase', (t) => {
  const root = workspace(t);
  const fork = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'feature');
  commitFile(root, 'feature-a.txt', 'a\n', 'feat: add a');
  commitFile(root, 'feature-b.txt', 'b\n', 'feat: add b');
  const head = git(root, 'rev-parse', 'HEAD');

  git(root, 'switch', '-q', 'main');
  commitFile(root, 'base.txt', 'base\n', 'feat: advance base');
  const base = git(root, 'rev-parse', 'HEAD');

  const replay = replayFirstParentOntoBase(root, base, head);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayedCommitCount, 2);

  git(root, 'branch', 'real-rebase', head);
  git(root, 'switch', '-q', 'real-rebase');
  git(root, 'rebase', '--quiet', '--onto', base, fork);
  assert.equal(replay.candidateTreeOid, git(root, 'rev-parse', 'HEAD^{tree}'));
});

test('merge conflicts are deterministic repair-required admissions', (t) => {
  const root = workspace(t);
  const fork = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'feature');
  commitFile(root, 'shared.txt', 'feature\n', 'feat: feature side');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-q', 'main');
  commitFile(root, 'shared.txt', 'base\n', 'feat: base side');
  const base = git(root, 'rev-parse', 'HEAD');

  const admission = inspectProjectCutMergeQueueAdmission(root, base, head);
  assert.equal(admission.ok, false, JSON.stringify(admission));
  assert.equal(admission.decision, 'repair-required');
  assert.equal(admission.retryable, false);
  assert.deepEqual(admission.reasonCodes, ['merge-conflict']);
});

test('source drift is rejected before merge queue entry', (t) => {
  const root = workspace(t);
  const parent = publishCut(root);

  git(root, 'switch', '-qc', 'feature');
  commitFile(root, 'feature.txt', 'feature\n', 'feat: change feature source');
  const child = publishCut(
    root,
    [parent.cut.cutRoot],
    semanticRoot({ forgedSourceProjection: true }),
  );

  const admission = inspectProjectCutMergeQueueAdmission(
    root,
    parent.commit,
    child.commit,
  );
  assert.equal(admission.ok, false, JSON.stringify(admission));
  assert.equal(admission.decision, 'repair-required');
  assert.equal(admission.retryable, false);
  assert.ok(admission.reasonCodes.includes('source-drift'));
});

test('a source-only candidate with no Cut delta is qualified', (t) => {
  const root = workspace(t);
  const fork = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'feature');
  const head = commitFile(
    root,
    'feature.txt',
    'feature\n',
    'feat: source only',
  );
  git(root, 'switch', '-q', 'main');
  commitFile(root, 'base.txt', 'base\n', 'feat: advance base');
  const base = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(base, fork);

  const admission = inspectProjectCutMergeQueueAdmission(root, base, head);
  assert.equal(admission.ok, true);
  assert.equal(admission.decision, 'qualified');
  assert.equal(admission.compositionChanged, false);
});
