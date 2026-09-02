// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { semanticRoot } from '../framework/project-cut/index.mjs';
import {
  compositionChanged,
  observeComposition,
  verifyComposition,
} from '../framework/project-cut/src/composition.mjs';

export const MERGE_QUEUE_ADMISSION_SCHEMA =
  'project.cut.merge-queue-admission/v1';
export const FAMILY_QUEUE_LEASE_SCHEMA = 'project.cut.family-queue-lease/v1';
export const FAMILY_QUEUE_RELEASE_SCHEMA =
  'project.cut.family-queue-release/v1';
export const FAMILY_QUEUE_MARKER = '<!-- kungfu-family-queue-lease:v1 ';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_OID = /^[0-9a-f]{40,64}$/u;
const FAMILY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const QUEUE_ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const REPLAY_IDENTITY = {
  GIT_AUTHOR_NAME: 'Project Cut Merge Queue Admission',
  GIT_AUTHOR_EMAIL: 'project-cut-merge-queue-admission@example.invalid',
  GIT_COMMITTER_NAME: 'Project Cut Merge Queue Admission',
  GIT_COMMITTER_EMAIL: 'project-cut-merge-queue-admission@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function gitResult(root, args, options = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    ...options,
  });
}

function git(root, args, options = {}) {
  const result = gitResult(root, args, options);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim();
    throw new Error(
      `git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return `${result.stdout || ''}`.trim();
}

function resolveCommit(root, ref) {
  return git(root, ['rev-parse', `${ref}^{commit}`]);
}

function diagnostic(code, detail) {
  return { code, path: '$', detail };
}

function requirePattern(value, label, pattern) {
  const normalized = String(value || '');
  if (!pattern.test(normalized)) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function uniqueRoots(values, label) {
  const roots = [...new Set((values || []).map(String))].sort();
  if (roots.some((root) => !SHA256_ROOT.test(root))) {
    throw new Error(`invalid ${label}`);
  }
  return roots;
}

function markerFor(value) {
  return `${FAMILY_QUEUE_MARKER}${Buffer.from(
    JSON.stringify(value),
    'utf8',
  ).toString('base64url')} -->`;
}

function leaseMaterial(lease) {
  const {
    marker: _marker,
    leaseRoot: _leaseRoot,
    idempotent: _idempotent,
    ...material
  } = lease;
  return material;
}

export function familyQueueStatusContext(initiativeId) {
  const normalized = requirePattern(
    initiativeId,
    'family initiative id',
    FAMILY_ID,
  );
  return `Queue family lease/${semanticRoot({
    initiativeId: normalized,
  }).slice(7, 23)}`;
}

export function parseFamilyQueueLeaseMarker(text) {
  const pattern = /<!-- kungfu-family-queue-lease:v1 ([A-Za-z0-9_-]+) -->/gu;
  let match = null;
  for (const candidate of String(text || '').matchAll(pattern)) {
    match = candidate;
  }
  if (match === null) return null;
  let lease;
  try {
    lease = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('family queue lease marker is not valid canonical JSON');
  }
  if (lease?.schema !== FAMILY_QUEUE_LEASE_SCHEMA) {
    throw new Error('unsupported family queue lease marker schema');
  }
  const expectedRoot = semanticRoot(leaseMaterial(lease));
  if (lease.leaseRoot !== expectedRoot) {
    throw new Error('family queue lease marker root mismatch');
  }
  if (lease.marker && lease.marker !== markerFor(leaseMaterial(lease))) {
    throw new Error('family queue lease marker self-reference is invalid');
  }
  return { ...leaseMaterial(lease), leaseRoot: expectedRoot };
}

export function createFamilyQueueLease(admission, values) {
  if (!admission?.ok || admission.decision !== 'qualified') {
    throw new Error('family queue lease requires qualified replay admission');
  }
  const initiativeId = requirePattern(
    values?.initiativeId,
    'family initiative id',
    FAMILY_ID,
  );
  const assignmentId = requirePattern(
    values?.assignmentId,
    'family assignment id',
    FAMILY_ID,
  );
  const deliveryClass = requirePattern(
    values?.deliveryClass,
    'family delivery class',
    FAMILY_ID,
  );
  const queueAttempt = requirePattern(
    values?.queueAttempt,
    'family queue attempt',
    QUEUE_ATTEMPT,
  );
  const devHead = requirePattern(
    admission.baseCommitOid,
    'family dev head',
    COMMIT_OID,
  );
  const pullRequestHead = requirePattern(
    admission.headCommitOid,
    'family pull request head',
    COMMIT_OID,
  );
  const replayedCandidate = requirePattern(
    admission.candidateCommitOid,
    'family replayed candidate',
    COMMIT_OID,
  );
  const replayedTree = requirePattern(
    admission.candidateTreeOid,
    'family replayed tree',
    COMMIT_OID,
  );
  const admissionProof = {
    schema: 'project.cut.family-queue-admission-proof/v1',
    admissionSchema: admission.schema,
    devHead,
    pullRequestHead,
    replayedCandidate,
    replayedTree,
    replayedCommitCount: admission.replayedCommitCount,
    compositionChanged: Boolean(admission.compositionChanged),
    compositionRoot: admission.compositionRoot || null,
    reasonCodes: [...(admission.reasonCodes || [])],
  };
  const admissionProofRoot = semanticRoot(admissionProof);
  const material = {
    schema: FAMILY_QUEUE_LEASE_SCHEMA,
    state: 'active',
    initiativeId,
    assignmentId,
    deliveryClass,
    devHead,
    pullRequestHead,
    replayedCandidate,
    replayedTree,
    queueAttempt,
    admissionProofRoot,
    admissionProofRoots: uniqueRoots(
      [admissionProofRoot, ...(values?.admissionProofRoots || [])],
      'family admission proof roots',
    ),
    statusContext: familyQueueStatusContext(initiativeId),
  };
  const leaseRoot = semanticRoot(material);
  return {
    ...material,
    leaseRoot,
    marker: markerFor({ ...material, leaseRoot }),
  };
}

export function admitFamilyQueueLease(activeLeases, candidate) {
  if (candidate?.schema !== FAMILY_QUEUE_LEASE_SCHEMA) {
    throw new Error('unsupported family queue lease candidate');
  }
  const parsed = parseFamilyQueueLeaseMarker(candidate.marker);
  if (parsed?.leaseRoot !== candidate.leaseRoot) {
    throw new Error('family queue lease candidate marker mismatch');
  }
  const conflict = (activeLeases || []).find(
    (lease) =>
      lease?.schema === FAMILY_QUEUE_LEASE_SCHEMA &&
      lease.state === 'active' &&
      lease.initiativeId === candidate.initiativeId &&
      lease.leaseRoot !== candidate.leaseRoot,
  );
  if (conflict) {
    return {
      ok: false,
      decision: 'blocked',
      reasonCodes: ['family-lease-contention'],
      conflictingLeaseRoot: conflict.leaseRoot,
    };
  }
  const reused = (activeLeases || []).some(
    (lease) =>
      lease?.state === 'active' && lease.leaseRoot === candidate.leaseRoot,
  );
  return {
    ok: true,
    decision: 'admitted',
    reused,
    leaseRoot: candidate.leaseRoot,
  };
}

export function releaseFamilyQueueLease(lease, values) {
  if (
    lease?.schema === FAMILY_QUEUE_RELEASE_SCHEMA &&
    lease.state === 'released'
  ) {
    if (
      lease.predecessorLeaseRoot !== values?.expectedLeaseRoot ||
      lease.terminalReason !== values?.terminalReason
    ) {
      throw new Error('stale family queue release evidence');
    }
    return { ...lease, idempotent: true };
  }
  if (lease?.schema !== FAMILY_QUEUE_LEASE_SCHEMA || lease.state !== 'active') {
    throw new Error('family queue release requires one active lease');
  }
  if (lease.leaseRoot !== values?.expectedLeaseRoot) {
    throw new Error('stale family queue release evidence');
  }
  const observedHead = requirePattern(
    values?.observedHead,
    'family release observed head',
    COMMIT_OID,
  );
  if (observedHead !== lease.pullRequestHead) {
    throw new Error('stale family queue release head');
  }
  const terminalReason = requirePattern(
    values?.terminalReason,
    'family release terminal reason',
    FAMILY_ID,
  );
  const material = {
    schema: FAMILY_QUEUE_RELEASE_SCHEMA,
    state: 'released',
    initiativeId: lease.initiativeId,
    assignmentId: lease.assignmentId,
    deliveryClass: lease.deliveryClass,
    devHead: lease.devHead,
    pullRequestHead: lease.pullRequestHead,
    queueAttempt: lease.queueAttempt,
    statusContext: lease.statusContext,
    predecessorLeaseRoot: lease.leaseRoot,
    terminalReason,
    evidenceRoots: uniqueRoots(
      values?.evidenceRoots || [],
      'family release evidence roots',
    ),
  };
  return {
    ...material,
    releaseRoot: semanticRoot(material),
    idempotent: false,
  };
}

export function verifyFamilyQueueLeaseAtMergeGroup({
  lease,
  pullRequestHead,
  devHead,
  candidateTree,
  combinedStatus,
}) {
  if (lease === null) {
    return {
      schema: 'project.cut.family-queue-lease-verification/v1',
      ok: true,
      applicable: false,
      reasonCodes: [],
    };
  }
  const diagnostics = [];
  const compare = (actual, expected, code) => {
    if (actual !== expected) {
      diagnostics.push(diagnostic(code, `${actual} != ${expected}`));
    }
  };
  compare(pullRequestHead, lease.pullRequestHead, 'family-pr-head-drift');
  compare(devHead, lease.devHead, 'family-dev-head-drift');
  compare(candidateTree, lease.replayedTree, 'family-replay-tree-drift');
  const latest = (combinedStatus?.statuses || []).find(
    (status) => status?.context === lease.statusContext,
  );
  if (latest?.state !== 'pending') {
    diagnostics.push(
      diagnostic(
        'family-lease-inactive',
        `expected pending ${lease.statusContext}, got ${latest?.state || 'missing'}`,
      ),
    );
  }
  return {
    schema: 'project.cut.family-queue-lease-verification/v1',
    ok: diagnostics.length === 0,
    applicable: true,
    leaseRoot: lease.leaseRoot,
    diagnostics,
    reasonCodes: diagnostics.map((entry) => entry.code),
  };
}

/**
 * Recreate the linear commit series that GitHub's rebase merge queue builds.
 * The temporary commits are unreachable Git objects: no refs, index, or worktree
 * are changed.
 */
export function replayFirstParentOntoBase(rootInput, baseInput, headInput) {
  const root = path.resolve(rootInput);
  const baseCommitOid = resolveCommit(root, baseInput);
  const headCommitOid = resolveCommit(root, headInput);
  const forkCommitOid = git(root, ['merge-base', baseCommitOid, headCommitOid]);
  const commits = git(root, [
    'rev-list',
    '--reverse',
    '--first-parent',
    `${forkCommitOid}..${headCommitOid}`,
  ])
    .split('\n')
    .filter(Boolean);

  let candidateCommitOid = baseCommitOid;
  for (const commitOid of commits) {
    const parentCommitOid = resolveCommit(root, `${commitOid}^1`);
    const merged = gitResult(root, [
      'merge-tree',
      '--write-tree',
      '--no-messages',
      `--merge-base=${parentCommitOid}`,
      candidateCommitOid,
      commitOid,
    ]);
    if (merged.status !== 0) {
      return {
        ok: false,
        baseCommitOid,
        headCommitOid,
        forkCommitOid,
        candidateCommitOid,
        replayedCommitCount: commits.indexOf(commitOid),
        diagnostics: [
          diagnostic(
            'merge-conflict',
            `cannot replay ${commitOid} onto ${candidateCommitOid}`,
          ),
        ],
      };
    }
    const treeOid = `${merged.stdout || ''}`.trim().split('\n')[0];
    if (!/^[0-9a-f]{40,64}$/u.test(treeOid)) {
      throw new Error(
        `git merge-tree returned an invalid tree oid: ${treeOid}`,
      );
    }
    const message = git(root, ['show', '-s', '--format=%B', commitOid]);
    candidateCommitOid = git(
      root,
      ['commit-tree', treeOid, '-p', candidateCommitOid],
      {
        input: `${message}\n`,
        env: { ...process.env, ...REPLAY_IDENTITY },
      },
    );
  }

  return {
    ok: true,
    baseCommitOid,
    headCommitOid,
    forkCommitOid,
    candidateCommitOid,
    candidateTreeOid: git(root, ['rev-parse', `${candidateCommitOid}^{tree}`]),
    replayedCommitCount: commits.length,
    diagnostics: [],
  };
}

export function inspectProjectCutMergeQueueAdmission(
  rootInput,
  baseInput,
  headInput,
  familyValues = null,
) {
  const replay = replayFirstParentOntoBase(rootInput, baseInput, headInput);
  if (!replay.ok) {
    return {
      ...replay,
      schema: MERGE_QUEUE_ADMISSION_SCHEMA,
      ok: false,
      decision: 'repair-required',
      retryable: false,
      reasonCodes: replay.diagnostics.map((entry) => entry.code),
    };
  }

  if (
    !compositionChanged(
      rootInput,
      replay.baseCommitOid,
      replay.candidateCommitOid,
    )
  ) {
    const result = {
      ...replay,
      schema: MERGE_QUEUE_ADMISSION_SCHEMA,
      ok: true,
      decision: 'qualified',
      retryable: false,
      compositionChanged: false,
      reasonCodes: [],
    };
    return familyValues
      ? { ...result, familyLease: createFamilyQueueLease(result, familyValues) }
      : result;
  }

  const receipt = observeComposition(
    rootInput,
    replay.baseCommitOid,
    replay.candidateCommitOid,
  );
  const verified = verifyComposition(rootInput, receipt);
  const diagnostics = [...receipt.diagnostics, ...verified.diagnostics];
  const ok = receipt.status === 'qualified' && verified.ok;
  const result = {
    ...replay,
    schema: MERGE_QUEUE_ADMISSION_SCHEMA,
    ok,
    decision: ok ? 'qualified' : 'repair-required',
    retryable: false,
    compositionChanged: true,
    compositionRoot: receipt.compositionRoot,
    changedCutRoots: receipt.scope.changedCutRoots,
    diagnostics,
    reasonCodes: [...new Set(diagnostics.map((entry) => entry.code))].sort(),
  };
  return familyValues && result.ok
    ? { ...result, familyLease: createFamilyQueueLease(result, familyValues) }
    : result;
}
