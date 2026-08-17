import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOCK_AGENT_SCENARIOS,
  MOCK_AGENT_VERSION,
  MOCK_RECOVERY_STORY_DELIVERABLE_PATH,
  createMockAgentInputFramer,
  createMockAgentMachine,
  mockRecoveryStoryDeliverable,
} from '../src/mock-provider.mjs';
import { createProviderAdapter } from '../src/provider-adapters.mjs';

function inspect(lines) {
  return createProviderAdapter({
    provider: 'synthetic',
    version: MOCK_AGENT_VERSION,
  }).inspect({
    lines,
    volatileTail: lines.join('\n'),
    lifecycleState: 'ready',
    inputAdmission: 'open',
    foreground: { provider: 'synthetic' },
  });
}

test('current Mock Agent version is admitted by its bundled interaction adapter', () => {
  const adapter = createProviderAdapter({
    provider: 'synthetic',
    version: MOCK_AGENT_VERSION,
  });
  assert.equal(adapter.compatible, true);
  assert.equal(adapter.tested, true);
});

test('Mock Agent exposes the complete deterministic scenario catalog', () => {
  assert.deepEqual(MOCK_AGENT_SCENARIOS, [
    'complete',
    'deliverable',
    'question',
    'approval',
    'blocked',
    'crash',
    'disconnect',
    'multi-step',
    'recovery-delivery',
    'recovery-story',
    'review-fit',
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
  assert.match(review.lines.join('\n'), /MOCK VALIDATION/u);
  assert.match(review.lines.join('\n'), /MOCK UNRESOLVED RISKS/u);
  assert.match(review.lines.join('\n'), /READY FOR REVIEW/u);
});

test('Mock Agent frames split bracketed paste and raw key input at terminal submission boundaries', () => {
  const frames = [];
  const input = createMockAgentInputFramer((frame) => frames.push(frame));
  const escapeCode = String.fromCharCode(27);

  input.push(`${escapeCode}[200~first line\n`);
  input.push(`second line${escapeCode}[201~`);
  assert.deepEqual(frames, []);
  input.push('\r');
  input.push('y');
  assert.equal(frames.length, 1);
  input.push('\r');

  assert.deepEqual(frames, [
    `${escapeCode}[200~first line\nsecond line${escapeCode}[201~`,
    'y',
  ]);
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

test('disconnect and deliverable scenarios expose truthful deterministic effects', () => {
  const disconnect = createMockAgentMachine({ scenario: 'disconnect' }).input(
    'go',
  );
  assert.equal(disconnect.exitCode, 75);
  assert.match(disconnect.lines.join('\n'), /transport closed/u);

  const writes = [];
  const deliverable = createMockAgentMachine({
    scenario: 'deliverable',
    effects: {
      writeDeliverable: () => {
        writes.push('deliverables/mock-agent-recovery-report.md');
        return { path: writes[0] };
      },
    },
  }).input('finish the recovery report');
  assert.deepEqual(writes, ['deliverables/mock-agent-recovery-report.md']);
  assert.match(deliverable.lines.join('\n'), /MOCK FILE WRITTEN/u);
});

test('review-fit covers exact criteria only when retained evidence is readable', () => {
  const prompt = [
    'Primary evidence: deliverables/report.md (sha256:abc)',
    'Supporting evidence:',
    '- none',
    '',
    'Acceptance criteria:',
    '- first exact criterion',
    '- second exact criterion',
    '',
    'Read the primary and supporting evidence.',
  ].join('\n');
  const transition = createMockAgentMachine({
    scenario: 'review-fit',
    effects: { inspectEvidence: () => ({ ok: true, bytes: 42 }) },
  }).input(prompt);
  const marker = transition.lines.find((line) =>
    line.startsWith('KUNGFU_REVIEW_RESULT '),
  );
  const result = JSON.parse(marker.slice('KUNGFU_REVIEW_RESULT '.length));
  assert.equal(result.verdict, 'fit');
  assert.deepEqual(
    result.criteria.map((row) => row.criterion),
    ['first exact criterion', 'second exact criterion'],
  );
});

test('recovery-story keeps one profile while advancing disconnect, crash, and delivery', () => {
  const steps = ['disconnect', 'crash', 'deliverable'];
  const writes = [];
  const run = () =>
    createMockAgentMachine({
      scenario: 'recovery-story',
      effects: {
        nextRecoveryStep: () => steps.shift(),
        writeDeliverable: (relativePath) => {
          writes.push(relativePath);
          return { path: relativePath };
        },
      },
    }).input('continue the same retained Work');

  assert.equal(run().exitCode, 75);
  assert.equal(run().exitCode, 23);
  assert.equal(run().exitCode, 0);
  assert.deepEqual(writes, [MOCK_RECOVERY_STORY_DELIVERABLE_PATH]);
});

test('recovery-story keeps the original business objective in natural Agent language', () => {
  const steps = ['disconnect', 'crash', 'deliverable'];
  const run = () =>
    createMockAgentMachine({
      scenario: 'recovery-story',
      effects: {
        nextRecoveryStep: () => steps.shift(),
        writeDeliverable: (relativePath) => ({ path: relativePath }),
      },
    }).input('complete the retained launch brief');

  const disconnect = run().lines.join('\n');
  const crash = run().lines.join('\n');
  const completed = run().lines.join('\n');
  assert.match(disconnect, /three source notes/u);
  assert.match(disconnect, /confirmed facts from open questions/u);
  assert.match(crash, /without relying on prior chat/u);
  assert.match(completed, /deliverables\/launch-brief\.md/u);
  assert.match(completed, /does not approve its own Work/u);
  const deliverable = mockRecoveryStoryDeliverable();
  assert.match(
    deliverable,
    /developers coordinating long-running coding-agent work/u,
  );
  assert.doesNotMatch(deliverable, /Northstar Notes|small product teams/u);
  assert.match(deliverable, /## Validation evidence/u);
  assert.match(deliverable, /inputs\/product-notes\.md/u);
  assert.match(deliverable, /## Unresolved risks/u);
});

test('recovery-delivery isolates the reviewable launch brief without inventing failed Attempts', () => {
  const writes = [];
  const completed = createMockAgentMachine({
    scenario: 'recovery-delivery',
    effects: {
      writeDeliverable: (relativePath) => {
        writes.push(relativePath);
        return { path: relativePath };
      },
    },
  }).input('complete the launch brief for independent review');

  assert.equal(completed.exitCode, 0);
  assert.deepEqual(writes, [MOCK_RECOVERY_STORY_DELIVERABLE_PATH]);
  assert.match(completed.lines.join('\n'), /does not approve its own Work/u);
  assert.equal(inspect(completed.lines).state, 'busy');
  assert.doesNotMatch(completed.lines.join('\n'), /^\s*mock›(?:\s|$)/mu);
});

test('every Mock Agent scenario reaches its declared deterministic boundary', () => {
  const expected = {
    complete: 'ready-for-review',
    deliverable: 'ended',
    question: 'needs-answer',
    approval: 'needs-approval',
    blocked: 'blocked',
    crash: 'ended',
    disconnect: 'ended',
    'multi-step': 'needs-answer',
    'recovery-delivery': 'ended',
    'recovery-story': 'ended',
    'review-fit': 'ended',
  };
  for (const scenario of MOCK_AGENT_SCENARIOS) {
    const machine = createMockAgentMachine({ scenario });
    machine.start();
    machine.input('start Work');
    assert.equal(machine.state(), expected[scenario], scenario);
  }
});
