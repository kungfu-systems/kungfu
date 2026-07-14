import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentSessionProductDetail,
  agentSessionProductLabel,
  resolveAgentSessionProduct,
} from '../src/view/agent-session-presentation.ts';

test('normal Agent Session presentation uses product states and one recovery action', () => {
  assert.equal(
    agentSessionProductLabel({
      state: 'recovering',
      reason: 'reattaching-session',
      recommendedAction: null,
    }),
    'Recovering',
  );
  const actionRequired = {
    state: 'action-required' as const,
    reason: 'prior-attempt-cannot-be-reattached',
    recommendedAction: 'start-new-attempt-or-provider-resume',
  };
  assert.equal(agentSessionProductLabel(actionRequired), 'Action required');
  assert.equal(
    agentSessionProductDetail(actionRequired),
    'Start a new attempt or use provider-supported resume.',
  );
  assert.doesNotMatch(
    `${agentSessionProductLabel(actionRequired)} ${agentSessionProductDetail(actionRequired)}`,
    /capsule|worker|pid|supervisor|coordinator/i,
  );
  assert.deepEqual(
    resolveAgentSessionProduct({
      live: true,
      lifecycleState: 'ready',
      interactionState: 'ready',
    }),
    {
      state: 'available',
      reason: 'ready-for-input',
      recommendedAction: null,
    },
  );
});
