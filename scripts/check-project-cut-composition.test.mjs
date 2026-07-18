// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGitEpisodeSegment,
  sealGitEpisode,
} from '../framework/episode-provider/src/git-workspace-episode-provider.mjs';

import {
  observeComposition,
  verifyComposition,
} from '../framework/project-cut/src/composition.mjs';
import {
  buildProjectCut,
  canonicalJson,
  createProjectCutReceipt,
  semanticRoot,
} from '../framework/project-cut/src/project-cut.mjs';
import { sourceProjectionAtCommit } from '../framework/project-cut/src/settlement.mjs';
import { checkProjectCutCompositionContract } from './project-cut-composition-contract.mjs';

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`);
}

function workspace(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'project-cut-composition-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Composition Test');
  git(root, 'config', 'user.email', 'composition@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'composition fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'test: initialize composition fixture');
  return root;
}

function cutTemplate(parentCutRoots = [], episodeRoot = null) {
  const value = structuredClone(FIXTURE.projectCutInput);
  value.project.id = 'composition/fixture';
  value.parentCutRoots = [...parentCutRoots].sort();
  value.visibility = 'public';
  value.omissions = [];
  value.conflicts = [];
  value.unknowns = [];
  value.atlas.root = semanticRoot({ atlas: gitSeed++ });
  value.episodeDelta = {
    schema: 'kungfu.episode-delta-ref/v1',
    empty: episodeRoot === null,
    nativeRoots: episodeRoot
      ? [{ provider: 'git-workspace-jsonl/v1', root: episodeRoot }]
      : [],
    semanticRoot: null,
    equivalenceProfileRoot: null,
  };
  return value;
}

let gitSeed = 1;

function publishCut(root, parentCutRoots = [], episodeRoot = null) {
  const input = cutTemplate(parentCutRoots, episodeRoot);
  const semanticCommit = git(root, 'rev-parse', 'HEAD');
  input.sourceProjection.root = sourceProjectionAtCommit(
    root,
    semanticCommit,
    input,
  ).root;
  const cut = buildProjectCut(input, { availableParentRoots: parentCutRoots });
  const relative = `.kungfu/project-cuts/sha256/${cut.cutRoot.slice(7, 9)}/${cut.cutRoot.slice(7)}`;
  const manifest = path.join(root, relative, 'manifest.json');
  writeJson(manifest, cut);
  const bytes = fs.readFileSync(manifest);
  writeJson(
    path.join(root, relative, 'receipt.json'),
    createProjectCutReceipt(cut, bytes, {
      availableParentRoots: parentCutRoots,
    }),
  );
  git(root, 'add', relative);
  git(root, 'commit', '-qm', `test: publish ${cut.cutRoot.slice(7, 15)}`);
  return { cut, commit: git(root, 'rev-parse', 'HEAD') };
}

function baseline(t) {
  const root = workspace(t);
  const parent = publishCut(root);
  return { root, parent, base: parent.commit };
}

function feature(root, branch, parent, file, content, episodeRoot = null) {
  git(root, 'checkout', '-qb', branch, parent.commit);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  git(root, 'commit', '-qm', `feat: ${branch}`);
  return publishCut(root, [parent.cut.cutRoot], episodeRoot);
}

function admittedEpisode(root) {
  const semantic = semanticRoot({ episode: gitSeed++ });
  const bundle = {
    schema: 'kungfu.storage.episode-bundle/v1',
    bundle_id: `episode:${gitSeed}`,
    scope: 'episode',
    episode_id: gitSeed,
    authority: 'yijinjing-journal',
    manifest: {
      schema: 'kungfu.episode.manifest/v1',
      episode_id: gitSeed,
      opened: true,
      closed: true,
      status: 'ended',
      content_root_algorithm: 'sha256',
      content_root: semantic.slice(7),
    },
    records: [
      {
        manifest_frame_uid: 1,
        carrier_type: 10801,
        record: { episode_id: gitSeed },
      },
      {
        manifest_frame_uid: 2,
        carrier_type: 10805,
        record: { episode_id: gitSeed },
      },
      {
        manifest_frame_uid: 3,
        carrier_type: 10806,
        record: { root_value: semantic.slice(7) },
      },
    ],
    refs: [],
    dependencies: [],
  };
  const qualification = {
    schema: 'kungfu.episode.qualification/v1',
    policy_source: 'cpp-typed-fold-fsck',
    episode_id: gitSeed,
    lifecycle: 'ended',
    status: 'ok',
    evidence: { manifest_integrity: { state: 'verified', issue_codes: [] } },
    issues: [],
    capabilities: [
      { name: 'export_evidence', safe: true, requires: [], blocked_by: [] },
    ],
    safe_capabilities: ['export_evidence'],
    contractions: [],
    repair_prerequisites: [],
  };
  const segment = buildGitEpisodeSegment(bundle, qualification);
  sealGitEpisode(root, segment, { writerId: 'composition-test' });
  return segment.providerRoot;
}

function mergeBranches(root, base, branches) {
  git(root, 'checkout', '-B', 'candidate', base);
  for (const branch of branches)
    git(root, 'merge', '--no-ff', '-qm', `merge ${branch}`, branch);
  return git(root, 'rev-parse', 'HEAD');
}

test('composition contract is rooted without changing Project Cut v1', () => {
  const result = checkProjectCutCompositionContract();
  assert.equal(result.schemaFiles, 1);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('two concurrent disjoint Cuts compose into one qualified N:M receipt', (t) => {
  const { root, parent, base } = baseline(t);
  feature(root, 'feature-a', parent, 'src/a.txt', 'a\n');
  feature(root, 'feature-b', parent, 'src/b.txt', 'b\n');
  const candidate = mergeBranches(root, base, ['feature-a', 'feature-b']);
  const receipt = observeComposition(root, base, candidate);
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(receipt.inputs.length, 2);
  assert.deepEqual(receipt.scope.changedPaths, ['src/a.txt', 'src/b.txt']);
  assert.equal(receipt.mappings.length, 2);
  assert.equal(verifyComposition(root, receipt).ok, true);
});

test('three concurrent Cuts survive a moving-main merge and clean-clone rebuild', (t) => {
  const { root, parent, base } = baseline(t);
  feature(root, 'feature-a', parent, 'src/a.txt', 'a\n');
  feature(root, 'feature-b', parent, 'src/b.txt', 'b\n');
  feature(root, 'feature-c', parent, 'src/c.txt', 'c\n');
  git(root, 'checkout', '-B', 'moving-main', base);
  fs.writeFileSync(path.join(root, 'moving.txt'), 'moving\n');
  git(root, 'add', 'moving.txt');
  git(root, 'commit', '-qm', 'test: move main');
  const movingBase = git(root, 'rev-parse', 'HEAD');
  const candidate = mergeBranches(root, movingBase, [
    'feature-a',
    'feature-b',
    'feature-c',
  ]);
  const receipt = observeComposition(root, base, candidate);
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(receipt.inputs.length, 3);

  const clone = fs.mkdtempSync(
    path.join(os.tmpdir(), 'project-cut-clean-clone-'),
  );
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', root, clone]);
  assert.equal(verifyComposition(clone, receipt).ok, true);
});

test('resolved overlap stays incomplete until integration evidence is admitted', (t) => {
  const { root, parent, base } = baseline(t);
  feature(root, 'feature-a', parent, 'shared.txt', 'a\n');
  feature(root, 'feature-b', parent, 'shared.txt', 'b\n');
  git(root, 'checkout', '-B', 'candidate', base);
  git(root, 'merge', '--no-ff', '-qm', 'merge a', 'feature-a');
  try {
    git(root, 'merge', '--no-ff', '-m', 'merge b', 'feature-b');
  } catch {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-qm', 'test: resolve overlap');
  }
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(receipt.status, 'incomplete');
  assert.ok(
    receipt.diagnostics.some(
      (entry) => entry.code === 'unadmitted-integration-episode',
    ),
  );
});

test('resolved overlap qualifies with a tracked admitted Integration Episode', (t) => {
  const { root, parent, base } = baseline(t);
  feature(root, 'feature-a', parent, 'shared.txt', 'a\n');
  git(root, 'checkout', '-qb', 'feature-b', parent.commit);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'b\n');
  const providerRoot = admittedEpisode(root);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'feat: feature-b with integration evidence');
  publishCut(root, [parent.cut.cutRoot], providerRoot);
  git(root, 'checkout', '-B', 'candidate', base);
  git(root, 'merge', '--no-ff', '-qm', 'merge a', 'feature-a');
  try {
    git(root, 'merge', '--no-ff', '-m', 'merge b', 'feature-b');
  } catch {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-qm', 'test: resolve overlap with evidence');
  }
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
});

test('missing parent manifest and missing receipt fail closed', (t) => {
  const { root, parent, base } = baseline(t);
  const child = feature(root, 'feature-a', parent, 'src/a.txt', 'a\n');
  git(
    root,
    'rm',
    `.kungfu/project-cuts/sha256/${parent.cut.cutRoot.slice(7, 9)}/${parent.cut.cutRoot.slice(7)}/manifest.json`,
  );
  git(
    root,
    'rm',
    `.kungfu/project-cuts/sha256/${child.cut.cutRoot.slice(7, 9)}/${child.cut.cutRoot.slice(7)}/receipt.json`,
  );
  git(root, 'commit', '-qm', 'test: inject missing evidence');
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(receipt.status, 'incomplete');
  assert.ok(
    receipt.diagnostics.some((entry) => entry.code === 'missing-parent-cut'),
  );
  assert.ok(
    receipt.diagnostics.some((entry) => entry.code === 'missing-cut-receipt'),
  );
});

test('tampering is rejected and empty scopes remain distinct from global audit', (t) => {
  const { root, base } = baseline(t);
  const empty = observeComposition(root, base, base);
  assert.equal(empty.status, 'qualified');
  assert.equal(empty.inputs.length, 0);
  const tampered = structuredClone(empty);
  tampered.operation = 'publish';
  assert.equal(verifyComposition(root, tampered).ok, false);
});
