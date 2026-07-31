import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOCK_AGENT_SCENARIOS,
  createMockAgentMachine,
} from '../src/mock-provider.mjs';
import { createProviderAdapter } from '../src/provider-adapters.mjs';

function inspect(lines) {
  return createProviderAdapter({
    provider: 'synthetic',
    version: '1.0.0',
  }).inspect({
    lines,
    volatileTail: lines.join('\n'),
    lifecycleState: 'ready',
    inputAdmission: 'open',
    foreground: { provider: 'synthetic' },
  });
}

test('Mock Agent exposes the complete deterministic scenario catalog', () => {
  assert.deepEqual(MOCK_AGENT_SCENARIOS, [
    'complete',
    'question',
    'approval',
    'blocked',
    'crash',
    'multi-step',
  ]);
});

test('multi-step scenario deterministically crosses answer, approval, and review boundaries', () => {
  const machine = createMockAgentMachine({ scenario: 'multi-step' });
  assert.equal(inspect(machine.start().lines).state, 'ready');

  const question = machine.input('implement the bounded Work');
  assert.equal(machine.state(), 'needs-answer');
  assert.equal(inspect(question.lines).state, 'ready');
  assert.match(question.lines.join('\n'), /MOCK NEEDS ANSWER/u);

  const approval = machine.input('alpha');
  assert.equal(machine.state(), 'needs-approval');
  assert.equal(inspect(approval.lines).state, 'approval-needed');

  const review = machine.input('y');
  assert.equal(machine.state(), 'ready-for-review');
  assert.equal(inspect(review.lines).state, 'ready');
  assert.match(review.lines.join('\n'), /READY FOR REVIEW/u);
});

test('blocked and crash scenarios are explicit and stable', () => {
  const blocked = createMockAgentMachine({ scenario: 'blocked' }).input('go');
  const blockedState = inspect(blocked.lines);
  assert.equal(blockedState.state, 'unknown');
  assert.equal(blockedState.reason, 'provider-reported-blocked');

  const crash = createMockAgentMachine({ scenario: 'crash' }).input('go');
  assert.equal(crash.exitCode, 23);
  assert.match(crash.lines.join('\n'), /MOCK CRASH/u);
});

test('every Mock Agent scenario reaches its declared deterministic boundary', () => {
  const expected = {
    complete: 'ready-for-review',
    question: 'needs-answer',
    approval: 'needs-approval',
    blocked: 'blocked',
    crash: 'ended',
    'multi-step': 'needs-answer',
  };
  for (const scenario of MOCK_AGENT_SCENARIOS) {
    const machine = createMockAgentMachine({ scenario });
    machine.start();
    machine.input('start Work');
    assert.equal(machine.state(), expected[scenario], scenario);
  }
});
