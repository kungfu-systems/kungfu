import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESTORING_RETAINED_AGENT_RESULT,
  assignmentSelector,
  preferredProjectReviewRun,
  resolveWorkProject,
  settleRetainedProjectRunBusy,
  shouldRestoreRetainedProjectRun,
} from '../src/view/project-work-run.ts';

test('a Work card binds its exact Assignment and owning Project', () => {
  const projects = [
    { id: 'project:a', path: '/projects/a' },
    { id: 'project:b', path: '/projects/b' },
  ];

  assert.equal(
    assignmentSelector('initiative-a:create-launch-brief'),
    'create-launch-brief',
  );
  assert.deepEqual(
    resolveWorkProject([{ workspace_id: 'project:b' }], projects),
    projects[1],
  );
  assert.deepEqual(
    resolveWorkProject([{ workspace_id: '/projects/a' }], projects),
    projects[0],
  );
});

test('Project Work restores a retained run from inventory or global authority', () => {
  const captured = {
    requestRoot: `sha256:${'1'.repeat(64)}`,
  };
  const retainedState = {
    canonical_root: `sha256:${'2'.repeat(64)}`,
  };

  assert.equal(
    shouldRestoreRetainedProjectRun(
      { ...captured, phase: 'executing' },
      { canonical_root: captured.requestRoot },
    ),
    true,
  );
  assert.equal(shouldRestoreRetainedProjectRun(captured, retainedState), true);
  assert.equal(
    shouldRestoreRetainedProjectRun(captured, {
      canonical_root: captured.requestRoot,
    }),
    false,
  );
});

test('retained run restoration releases only its own busy state', () => {
  assert.equal(
    settleRetainedProjectRunBusy(RESTORING_RETAINED_AGENT_RESULT),
    '',
  );
  assert.equal(
    settleRetainedProjectRunBusy('Preparing a fresh independent review…'),
    'Preparing a fresh independent review…',
  );
});

test('Project Work keeps the active or passed independent review visible', () => {
  const passed = {
    id: 'review-passed',
    kind: 'review',
    sourceRunId: 'source-1',
    running: false,
    reviewReceipt: { status: 'review-passed' },
  };
  const failed = {
    id: 'review-failed',
    kind: 'review',
    sourceRunId: 'source-1',
    running: false,
    reviewReceipt: { status: 'settlement-interrupted' },
  };
  const running = {
    id: 'review-running',
    kind: 'review',
    sourceRunId: 'source-1',
    running: true,
  };

  assert.equal(
    preferredProjectReviewRun([failed, passed], 'source-1')?.id,
    'review-passed',
  );
  assert.equal(
    preferredProjectReviewRun([passed, running], 'source-1')?.id,
    'review-running',
  );
  assert.equal(
    preferredProjectReviewRun(
      [{ ...running, sourceRunId: 'source-2' }],
      'source-1',
    ),
    undefined,
  );
});
