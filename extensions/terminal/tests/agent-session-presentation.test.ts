import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentSessionProductDetail,
  agentSessionProductLabel,
  instructionWasDelivered,
  resolveAgentSessionComposer,
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

test('composer makes the ready input path explicit only to the controller', () => {
  const product = {
    state: 'available' as const,
    reason: 'ready-for-input',
    recommendedAction: null,
  };
  assert.deepEqual(
    resolveAgentSessionComposer({
      product,
      inputAdmission: 'open',
      controllerHolderId: 'gui:home',
      actorId: 'gui:home',
      providerLabel: 'Codex',
    }),
    {
      state: 'ready',
      label: 'Ready to send',
      guidance: 'Press Enter to send · Shift+Enter for a new line.',
      canSend: true,
    },
  );
  assert.deepEqual(
    resolveAgentSessionComposer({
      product,
      inputAdmission: 'open',
      controllerHolderId: 'gui:other',
      actorId: 'gui:home',
      providerLabel: 'Codex',
    }),
    {
      state: 'blocked',
      label: 'Controlled elsewhere',
      guidance: 'Another attached client currently controls this session.',
      canSend: false,
    },
  );
});

test('composer preserves drafts while Codex is working or input is paused', () => {
  const working = resolveAgentSessionComposer({
    product: {
      state: 'working',
      reason: 'provider-working',
      recommendedAction: null,
    },
    inputAdmission: 'open',
    controllerHolderId: 'gui:home',
    actorId: 'gui:home',
    providerLabel: 'Codex',
  });
  assert.equal(working.label, 'Codex is working');
  assert.equal(working.canSend, false);
  assert.deepEqual(
    resolveAgentSessionComposer({
      product: {
        state: 'available',
        reason: 'ready-for-input',
        recommendedAction: null,
      },
      inputAdmission: 'closed',
      controllerHolderId: 'gui:home',
      actorId: 'gui:home',
    }),
    {
      state: 'blocked',
      label: 'Input paused',
      guidance: 'This session is not accepting new instructions right now.',
      canSend: false,
    },
  );
});

test('composer clears instructions for PTY writes and structured delivery', () => {
  assert.equal(instructionWasDelivered('written'), true);
  assert.equal(instructionWasDelivered('delivered'), true);
  assert.equal(instructionWasDelivered('held'), false);
  assert.equal(instructionWasDelivered('rejected'), false);
});
