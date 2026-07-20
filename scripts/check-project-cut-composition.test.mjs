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
  episodeProviderPaths,
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
  sha256Bytes,
} from '../framework/project-cut/src/project-cut.mjs';
import {
  sourceProjectionAtCommit,
  sourceProjectionAtTree,
} from '../framework/project-cut/src/settlement.mjs';
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

function cutTemplate(parentCutRoots = [], episodeRoot = null, project = null) {
  const value = structuredClone(FIXTURE.projectCutInput);
  value.project.id = 'composition/fixture';
  if (project) value.project = project;
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

function publishCut(
  root,
  parentCutRoots = [],
  episodeRoot = null,
  project = null,
  sourceRoot = null,
) {
  const input = cutTemplate(parentCutRoots, episodeRoot, project);
  const semanticCommit = git(root, 'rev-parse', 'HEAD');
  input.sourceProjection.root =
    sourceRoot ?? sourceProjectionAtCommit(root, semanticCommit, input).root;
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

function stageCut(root, parentCutRoots = []) {
  const input = cutTemplate(parentCutRoots);
  input.sourceProjection.root = sourceProjectionAtTree(
    root,
    git(root, 'write-tree'),
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
  return cut;
}

function baseline(t) {
  const root = workspace(t);
  const parent = publishCut(root);
  return { root, parent, base: parent.commit };
}

function feature(
  root,
  branch,
  parent,
  file,
  content,
  episodeRoot = null,
  project = null,
) {
  git(root, 'checkout', '-qb', branch, parent.commit);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  git(root, 'commit', '-qm', `feat: ${branch}`);
  return publishCut(root, [parent.cut.cutRoot], episodeRoot, project);
}

function sealEpisode(root) {
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
  return segment;
}

function admittedEpisode(root) {
  return sealEpisode(root).providerRoot;
}

function forgedEpisode(root) {
  const segment = sealEpisode(root);
  const directory = episodeProviderPaths(root, segment.semanticRoot).segment;
  const claimsPath = path.join(directory, 'claims.jsonl');
  const claims = fs
    .readFileSync(claimsPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((row) => ({ ...JSON.parse(row), schema: 'evil.segment/v9' }));
  const claimsBytes = Buffer.from(
    `${claims.map((row) => canonicalJson(row)).join('\n')}\n`,
  );
  const qualification = {
    ...segment.qualification,
    schema: 'evil.qualification/v9',
    policy_source: 'self-asserted',
    episode_id: 999,
  };
  const { providerRoot: _providerRoot, ...manifestPreimage } = {
    ...segment.manifest,
    schema: 'evil.provider/v9',
    qualificationRoot: semanticRoot(qualification),
    claims: {
      ...segment.manifest.claims,
      digest: sha256Bytes(claimsBytes),
      count: claims.length,
    },
  };
  const manifest = {
    ...manifestPreimage,
    providerRoot: semanticRoot(manifestPreimage),
  };
  fs.writeFileSync(claimsPath, claimsBytes);
  writeJson(path.join(directory, 'qualification.json'), qualification);
  writeJson(path.join(directory, 'manifest.json'), manifest);
  return manifest.providerRoot;
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

test('a Cut first published by a merge commit has a deterministic publication', (t) => {
  const { root, parent, base } = baseline(t);
  git(root, 'checkout', '-qb', 'upstream', base);
  fs.writeFileSync(path.join(root, 'upstream.txt'), 'upstream\n');
  git(root, 'add', 'upstream.txt');
  git(root, 'commit', '-qm', 'test: upstream');

  git(root, 'checkout', '-qb', 'merge-publication', base);
  git(root, 'merge', '--no-ff', '--no-commit', 'upstream');
  fs.writeFileSync(path.join(root, 'task.txt'), 'task\n');
  git(root, 'add', 'task.txt');
  const cut = stageCut(root, [parent.cut.cutRoot]);
  git(root, 'commit', '-qm', 'test: publish Cut in merge commit');

  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(receipt.scope.changedCutRoots.includes(cut.cutRoot), true);
  assert.equal(
    receipt.diagnostics.some((entry) => entry.code === 'missing-publication'),
    false,
  );
});

test('a merge preview reuses the publication from its identical side parent', (t) => {
  const { root, parent, base } = baseline(t);
  git(root, 'checkout', '-qb', 'upstream', base);
  fs.writeFileSync(path.join(root, 'upstream.txt'), 'upstream\n');
  git(root, 'add', 'upstream.txt');
  git(root, 'commit', '-qm', 'test: upstream');

  git(root, 'checkout', '-qb', 'merge-publication', base);
  git(root, 'merge', '--no-ff', '--no-commit', 'upstream');
  fs.writeFileSync(path.join(root, 'task.txt'), 'task\n');
  git(root, 'add', 'task.txt');
  const cut = stageCut(root, [parent.cut.cutRoot]);
  git(root, 'commit', '-qm', 'test: publish Cut in merge commit');
  const publication = git(root, 'rev-parse', 'HEAD');

  git(root, 'checkout', '-B', 'preview', base);
  git(root, 'merge', '--no-ff', '-qm', 'test: merge preview', publication);
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(
    receipt.inputs.find((input) => input.cutRoot === cut.cutRoot)?.publication
      .commitOid,
    publication,
  );
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
  let candidate = movingBase;
  for (const branch of ['feature-a', 'feature-b', 'feature-c']) {
    git(root, 'checkout', branch);
    git(root, 'rebase', '--onto', candidate, base, branch);
    candidate = git(root, 'rev-parse', 'HEAD');
  }
  const receipt = observeComposition(root, movingBase, candidate);
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(receipt.inputs.length, 3);
  assert.ok(
    receipt.inputs.every((input) => input.publicationMode === 'rebased-replay'),
  );

  const clone = fs.mkdtempSync(
    path.join(os.tmpdir(), 'project-cut-clean-clone-'),
  );
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', root, clone]);
  assert.equal(verifyComposition(clone, receipt).ok, true);
});

test('a self-consistent Cut with the wrong source root still fails closed', (t) => {
  const { root, parent, base } = baseline(t);
  git(root, 'checkout', '-qb', 'source-drift', parent.commit);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/drift.txt'), 'drift\n');
  git(root, 'add', 'src/drift.txt');
  git(root, 'commit', '-qm', 'feat: source drift');
  publishCut(
    root,
    [parent.cut.cutRoot],
    null,
    null,
    semanticRoot({ forged: 'source-projection' }),
  );
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(receipt.status, 'incomplete');
  assert.ok(receipt.diagnostics.some((entry) => entry.code === 'source-drift'));
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
  const left = feature(root, 'feature-a', parent, 'shared.txt', 'a\n');
  const right = feature(root, 'feature-b', parent, 'shared.txt', 'b\n');
  git(root, 'checkout', '-B', 'candidate', base);
  git(root, 'merge', '--no-ff', '-qm', 'merge a', 'feature-a');
  try {
    git(root, 'merge', '--no-ff', '-m', 'merge b', 'feature-b');
  } catch {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-qm', 'test: resolve overlap');
  }
  const providerRoot = admittedEpisode(root);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: seal integration evidence');
  publishCut(root, [left.cut.cutRoot, right.cut.cutRoot], providerRoot);
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
});

test('a qualified Integration Cut remains valid after forward evolution', (t) => {
  const { root, parent, base } = baseline(t);
  const left = feature(root, 'feature-a', parent, 'shared.txt', 'a\n');
  const right = feature(root, 'feature-b', parent, 'shared.txt', 'b\n');
  git(root, 'checkout', '-B', 'candidate', base);
  git(root, 'merge', '--no-ff', '-qm', 'merge a', 'feature-a');
  try {
    git(root, 'merge', '--no-ff', '-m', 'merge b', 'feature-b');
  } catch {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-qm', 'test: resolve overlap');
  }
  const providerRoot = admittedEpisode(root);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: seal integration evidence');
  const integration = publishCut(
    root,
    [left.cut.cutRoot, right.cut.cutRoot],
    providerRoot,
  );
  fs.writeFileSync(path.join(root, 'future.txt'), 'future\n');
  git(root, 'add', 'future.txt');
  git(root, 'commit', '-qm', 'feat: continue after integration');
  publishCut(root, [integration.cut.cutRoot]);

  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(verifyComposition(root, receipt).ok, true);
});

test('self-consistent forged Episode evidence cannot admit an overlap', (t) => {
  const { root, parent, base } = baseline(t);
  const left = feature(root, 'feature-a', parent, 'shared.txt', 'a\n');
  const right = feature(root, 'feature-b', parent, 'shared.txt', 'b\n');
  git(root, 'checkout', '-B', 'candidate', base);
  git(root, 'merge', '--no-ff', '-qm', 'merge a', 'feature-a');
  try {
    git(root, 'merge', '--no-ff', '-m', 'merge b', 'feature-b');
  } catch {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-qm', 'test: resolve overlap');
  }
  const providerRoot = forgedEpisode(root);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: seal forged integration evidence');
  publishCut(root, [left.cut.cutRoot, right.cut.cutRoot], providerRoot);
  const receipt = observeComposition(root, base, 'HEAD');
  assert.equal(receipt.status, 'incomplete');
  assert.ok(
    receipt.diagnostics.some(
      (entry) => entry.code === 'unadmitted-integration-episode',
    ),
  );
});

test('receipt-only and Episode-only evidence deletion enter the scoped gate', (t) => {
  const { root, parent } = baseline(t);
  git(root, 'checkout', '-qb', 'evidence', parent.commit);
  fs.writeFileSync(path.join(root, 'episode.txt'), 'episode\n');
  const providerRoot = admittedEpisode(root);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'feat: evidence source');
  const child = publishCut(root, [parent.cut.cutRoot], providerRoot);
  const base = child.commit;
  const cutDir = `.kungfu/project-cuts/sha256/${child.cut.cutRoot.slice(7, 9)}/${child.cut.cutRoot.slice(7)}`;
  git(root, 'rm', `${cutDir}/receipt.json`);
  git(root, 'commit', '-qm', 'test: remove only Cut receipt');
  const receiptOnly = observeComposition(root, base, 'HEAD');
  assert.equal(receiptOnly.status, 'incomplete');
  assert.ok(
    receiptOnly.diagnostics.some(
      (entry) => entry.code === 'missing-cut-receipt',
    ),
  );

  git(root, 'reset', '--hard', base);
  const providerManifest = git(
    root,
    'ls-files',
    '*episodes/sealed/*/manifest.json',
  );
  git(root, 'rm', providerManifest);
  git(root, 'commit', '-qm', 'test: remove only Episode manifest');
  const episodeOnly = observeComposition(root, base, 'HEAD');
  assert.equal(episodeOnly.status, 'incomplete');
  assert.ok(
    episodeOnly.diagnostics.some(
      (entry) => entry.code === 'unadmitted-integration-episode',
    ),
  );
});

test('multiple project identities receive separate candidate projections', (t) => {
  const { root, parent, base } = baseline(t);
  feature(root, 'project-a', parent, 'src/a.txt', 'a\n', null, {
    id: 'project/a',
    identityRoot: semanticRoot({ project: 'a' }),
  });
  feature(root, 'project-b', parent, 'src/b.txt', 'b\n', null, {
    id: 'project/b',
    identityRoot: semanticRoot({ project: 'b' }),
  });
  const candidate = mergeBranches(root, base, ['project-a', 'project-b']);
  const receipt = observeComposition(root, base, candidate);
  assert.equal(
    receipt.status,
    'qualified',
    JSON.stringify(receipt.diagnostics),
  );
  assert.equal(receipt.output.projects.length, 2);
  assert.notEqual(
    receipt.output.projects[0].sourceProjectionRoot,
    receipt.output.projects[1].sourceProjectionRoot,
  );
  assert.deepEqual(receipt.mappings.map((entry) => entry.project.id).sort(), [
    'project/a',
    'project/b',
  ]);
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
