// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  compositionChanged,
  observeComposition,
  verifyComposition,
} from '../framework/project-cut/src/composition.mjs';

export const MERGE_QUEUE_ADMISSION_SCHEMA =
  'project.cut.merge-queue-admission/v1';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
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
    return {
      ...replay,
      schema: MERGE_QUEUE_ADMISSION_SCHEMA,
      ok: true,
      decision: 'qualified',
      retryable: false,
      compositionChanged: false,
      reasonCodes: [],
    };
  }

  const receipt = observeComposition(
    rootInput,
    replay.baseCommitOid,
    replay.candidateCommitOid,
  );
  const verified = verifyComposition(rootInput, receipt);
  const diagnostics = [...receipt.diagnostics, ...verified.diagnostics];
  const ok = receipt.status === 'qualified' && verified.ok;
  return {
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
}
