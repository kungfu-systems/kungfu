import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkAgentState } from '../src/work-attention.mjs';

test('Project Work separates attempt progress from user attention', () => {
  assert.deepEqual(
    projectWorkAgentState({
      live: true,
      lifecycleState: 'ready',
      interactionState: 'busy',
    }),
    {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'working',
      attention: null,
    },
  );

  const answer = projectWorkAgentState({
    live: true,
    lifecycleState: 'ready',
    interactionState: 'ready',
  });
  assert.equal(answer.attempt, 'waiting');
  assert.equal(answer.attention.kind, 'needs-answer');
  assert.deepEqual(answer.attention.nextActions, [
    'reply',
    'review-changes',
    'end-attempt',
  ]);

  const mockReview = projectWorkAgentState({
    live: true,
    lifecycleState: 'ready',
    interactionState: 'ready',
    providerAdapter: { signatureIds: ['synthetic.ready.review'] },
  });
  assert.equal(mockReview.attention.kind, 'ready-for-review');

  const approval = projectWorkAgentState({
    live: true,
    lifecycleState: 'ready',
    interactionState: 'approval-needed',
  });
  assert.equal(approval.attention.kind, 'needs-approval');

  const blocked = projectWorkAgentState({
    live: true,
    lifecycleState: 'ready',
    interactionState: 'unknown',
    interactionReason: 'provider-reported-blocked',
  });
  assert.equal(blocked.attention.kind, 'blocked');
  assert.equal(blocked.attention.reason, 'provider-reported-blocked');
});

test('ended and unrecoverable attempts lead to review or recovery without claiming completion', () => {
  const ended = projectWorkAgentState({
    live: false,
    lifecycleState: 'ended',
    attempt: { status: 'exited' },
    exit: { exitCode: 0 },
  });
  assert.equal(ended.attempt, 'ended');
  assert.equal(ended.attention.kind, 'ready-for-review');
  assert.doesNotMatch(JSON.stringify(ended), /completed/u);

  const endedRuntimeProjection = projectWorkAgentState({
    live: true,
    lifecycleState: 'ended',
    attempt: { status: 'exited' },
    exit: { exitCode: 0 },
  });
  assert.equal(endedRuntimeProjection.attempt, 'ended');
  assert.equal(endedRuntimeProjection.attention.kind, 'ready-for-review');

  const crashed = projectWorkAgentState({
    live: false,
    lifecycleState: 'ended',
    attempt: { status: 'exited' },
    exit: { exitCode: 23 },
  });
  assert.equal(crashed.attention.kind, 'blocked');

  const controlledWindowsExit = projectWorkAgentState({
    live: false,
    lifecycleState: 'ended',
    attempt: { status: 'exited' },
    exit: {
      exitCode: 1,
      signal: 0,
      controlRequest: { operation: 'end', signal: 'SIGTERM' },
    },
  });
  assert.equal(controlledWindowsExit.attention.kind, 'ready-for-review');
  assert.equal(
    controlledWindowsExit.attention.reason,
    'agent-attempt-ended-by-controller',
  );

  const lost = projectWorkAgentState({
    live: false,
    attempt: { status: 'unrecoverable' },
  });
  assert.equal(lost.attempt, 'unrecoverable');
  assert.equal(lost.attention.kind, 'blocked');
});
