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
} from '@kungfu-tech/work/project-cut';
import { sourceProjectionAtCommit } from '@kungfu-tech/work/project-cut/settlement';
import {
  admitFamilyQueueLease,
  createFamilyQueueLease,
  inspectProjectCutMergeQueueAdmission,
  parseFamilyQueueLeaseMarker,
  releaseFamilyQueueLease,
  replayFirstParentOntoBase,
  verifyFamilyQueueLeaseAtMergeGroup,
} from './project-cut-merge-queue-admission.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      'framework/work/project-cut/fixtures/golden/project-cut-v1.json',
    ),
    'utf8',
  ),
);

test('merge-group native proof consumes the admitted replayed tree', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /source_tree="\$\(git rev-parse "\$\{pr_head\}\^\{tree\}"\)"[\s\S]*GITHUB_EVENT_NAME" = "merge_group"[\s\S]*source\.replayedTree[\s\S]*source-tree=\$\{source_tree\}/u,
  );

  const revalidation = workflow.slice(
    workflow.indexOf(
      '      - name: Revalidate exact affected-native source binding',
    ),
    workflow.indexOf('      - name: Download admitted producer proof'),
  );
  assert.match(
    revalidation,
    /binding_state="\$\(jq -er '\.state'[\s\S]*bound\)[\s\S]*source\.replayedTree[\s\S]*HEAD\^\{tree\}[\s\S]*unbound\)[\s\S]*source\.pullRequestHead[\s\S]*source_head\}\^\{tree\}/u,
  );
});

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

test('family lease binds exact replay identity and blocks a second child', (t) => {
  const root = workspace(t);
  git(root, 'switch', '-qc', 'feature');
  const head = commitFile(
    root,
    'family.txt',
    'family\n',
    'feat: add family candidate',
  );
  git(root, 'switch', '-q', 'main');
  const base = commitFile(root, 'base.txt', 'base\n', 'feat: advance dev');
  const workDefinitionRoot = semanticRoot({ work: 'family-queue' });
  const admission = inspectProjectCutMergeQueueAdmission(root, base, head, {
    initiativeId: 'initiative-one',
    assignmentId: 'child-one',
    deliveryClass: 'non-native-fast',
    queueAttempt: 'attempt-one',
    admissionProofRoots: [workDefinitionRoot],
  });
  assert.equal(admission.ok, true);
  const lease = admission.familyLease;
  assert.equal(lease.devHead, base);
  assert.equal(lease.pullRequestHead, head);
  assert.equal(lease.replayedCandidate, admission.candidateCommitOid);
  assert.ok(lease.admissionProofRoots.includes(workDefinitionRoot));
  const { marker, ...leaseWithoutMarker } = lease;
  assert.ok(marker.includes('kungfu-family-queue-lease:v1'));
  assert.deepEqual(parseFamilyQueueLeaseMarker(marker), leaseWithoutMarker);

  const second = createFamilyQueueLease(admission, {
    initiativeId: 'initiative-one',
    assignmentId: 'child-two',
    deliveryClass: 'native-proof-required',
    queueAttempt: 'attempt-two',
  });
  assert.deepEqual(admitFamilyQueueLease([lease], second), {
    ok: false,
    decision: 'blocked',
    reasonCodes: ['family-lease-contention'],
    conflictingLeaseRoot: lease.leaseRoot,
  });
  assert.deepEqual(admitFamilyQueueLease([lease], lease), {
    ok: true,
    decision: 'admitted',
    reused: true,
    leaseRoot: lease.leaseRoot,
  });
});

test('family merge-group verification rejects replay drift and inactive status', (t) => {
  const root = workspace(t);
  git(root, 'switch', '-qc', 'feature');
  const head = commitFile(root, 'family.txt', 'family\n', 'feat: family');
  git(root, 'switch', '-q', 'main');
  const base = commitFile(root, 'base.txt', 'base\n', 'feat: base');
  const admission = inspectProjectCutMergeQueueAdmission(root, base, head, {
    initiativeId: 'initiative-one',
    assignmentId: 'child-one',
    deliveryClass: 'non-native-fast',
    queueAttempt: 'attempt-one',
  });
  const lease = admission.familyLease;
  const verified = verifyFamilyQueueLeaseAtMergeGroup({
    lease,
    pullRequestHead: head,
    devHead: base,
    candidateTree: lease.replayedTree,
    combinedStatus: {
      statuses: [{ context: lease.statusContext, state: 'pending' }],
    },
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const drifted = verifyFamilyQueueLeaseAtMergeGroup({
    lease,
    pullRequestHead: 'a'.repeat(40),
    devHead: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    combinedStatus: {
      statuses: [{ context: lease.statusContext, state: 'success' }],
    },
  });
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.reasonCodes, [
    'family-pr-head-drift',
    'family-dev-head-drift',
    'family-replay-tree-drift',
    'family-lease-inactive',
  ]);
  assert.equal(
    verifyFamilyQueueLeaseAtMergeGroup({
      lease: null,
      pullRequestHead: head,
      devHead: base,
      candidateTree: lease.replayedTree,
      combinedStatus: {},
    }).applicable,
    false,
  );
});

test('family release is exact-root, exact-head, and idempotent', () => {
  const admission = {
    schema: 'project.cut.merge-queue-admission/v1',
    ok: true,
    decision: 'qualified',
    baseCommitOid: 'a'.repeat(40),
    headCommitOid: 'b'.repeat(40),
    candidateCommitOid: 'c'.repeat(40),
    candidateTreeOid: 'd'.repeat(40),
    replayedCommitCount: 1,
    compositionChanged: false,
    reasonCodes: [],
  };
  const lease = createFamilyQueueLease(admission, {
    initiativeId: 'initiative-one',
    assignmentId: 'child-one',
    deliveryClass: 'non-native-fast',
    queueAttempt: 'attempt-one',
  });
  assert.throws(
    () =>
      releaseFamilyQueueLease(lease, {
        expectedLeaseRoot: `sha256:${'0'.repeat(64)}`,
        observedHead: lease.pullRequestHead,
        terminalReason: 'dequeue-manual',
      }),
    /stale family queue release evidence/u,
  );
  assert.throws(
    () =>
      releaseFamilyQueueLease(lease, {
        expectedLeaseRoot: lease.leaseRoot,
        observedHead: 'e'.repeat(40),
        terminalReason: 'dequeue-manual',
      }),
    /stale family queue release head/u,
  );
  const released = releaseFamilyQueueLease(lease, {
    expectedLeaseRoot: lease.leaseRoot,
    observedHead: lease.pullRequestHead,
    terminalReason: 'dequeue-manual',
    evidenceRoots: [semanticRoot({ dequeue: 'manual' })],
  });
  assert.equal(released.state, 'released');
  assert.equal(released.idempotent, false);
  assert.equal(
    releaseFamilyQueueLease(released, {
      expectedLeaseRoot: lease.leaseRoot,
      terminalReason: 'dequeue-manual',
    }).idempotent,
    true,
  );
  const cliRelease = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(
          REPO_ROOT,
          'scripts/check-project-cut-merge-queue-admission.mjs',
        ),
        '--release-family-marker',
        '-',
        '--expected-pr-head',
        lease.pullRequestHead,
        '--terminal-reason',
        'merged',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: `${lease.marker}\n`,
      },
    ),
  );
  assert.equal(cliRelease.state, 'released');
  assert.equal(cliRelease.predecessorLeaseRoot, lease.leaseRoot);
});
