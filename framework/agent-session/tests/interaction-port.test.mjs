import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentSessionCapsuleHost } from '../src/capsule-host.mjs';
import { AgentSessionInteractionPort } from '../src/interaction-port.mjs';
import {
  AgentSessionCapsulePeerTransport,
  InMemoryJournalNoticePort,
} from '../src/peer-transport.mjs';
import { createProviderAdapter } from '../src/provider-adapters.mjs';

const PROFILE_ROOT = `sha256:${'c'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 9191;
    this.writes = [];
    this.signals = [];
  }

  onData(listener) {
    this.on('data', listener);
  }

  onExit(listener) {
    this.on('exit', listener);
  }

  write(data) {
    this.writes.push(data);
  }

  resize() {}

  kill(signal) {
    this.signals.push(signal);
  }
}

function fixture({
  provider = 'codex',
  version = '0.144.3',
  queueLimit = 4,
  pause,
} = {}) {
  const child = new FakePtyProcess();
  const host = new AgentSessionCapsuleHost({
    pty: { spawn: () => child },
    capsuleId: 'capsule-interaction-1',
    runtimeIdentity: 'runtime-interaction-1',
    maxOutputBytes: 4096,
    now: () => 1000,
  });
  const started = host.start({
    workConsoleId: 'console-1',
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '11',
    provider,
    profileRoot: PROFILE_ROOT,
    executable: '/usr/bin/provider',
    argv: ['--tui'],
    cwd: '/tmp',
  });
  const transport = new AgentSessionCapsulePeerTransport({
    host,
    port: new InMemoryJournalNoticePort(),
    now: () => 1000,
  });
  transport.register({ coordinatorEpoch: '3', supervisorGeneration: '5' });
  transport.acquireControl({
    leaseId: 'lease-1',
    holderId: 'controller-1',
    planRoot: 'plan-1',
  });
  const adapter = createProviderAdapter({
    provider: provider === 'custom' ? 'codex' : provider,
    version,
  });
  const port = new AgentSessionInteractionPort({
    host,
    transport,
    adapter,
    queueLimit,
    now: () => 1001,
    ...(pause ? { pause } : {}),
  });
  const authority = {
    leaseId: 'lease-1',
    holderId: 'controller-1',
    coordinatorEpoch: '3',
    expectedForeground: started.foreground,
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '11',
    processStartIdentity: started.foreground.processStartIdentity,
  };
  return {
    authority,
    child,
    host,
    port,
    screen(value) {
      child.emit('data', `\u001b[2J\u001b[H${value}`);
    },
  };
}

function instruction(authority, id, overrides = {}) {
  return {
    ...authority,
    actionId: `action-${id}`,
    inputId: `input-${id}`,
    text: `instruction ${id}`,
    mode: 'when-ready',
    automatic: true,
    ...overrides,
  };
}

test('ready instruction is one idempotent atomic paste and proves no outcome', () => {
  const { authority, child, port, screen } = fixture();
  screen('› Ask about this workspace');
  const request = instruction(authority, 'ready');
  const first = port.instruct(request);
  const duplicate = port.instruct(request);
  assert.equal(first.status, 'written');
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(child.writes, ['\u001b[200~instruction ready\u001b[201~\r']);
  assert.equal(
    first.deliveryReceipt.proves,
    'validated-input-written-to-pty-only',
  );
  assert.equal(first.semanticOutcome, null);
  assert.equal(first.workState, null);
  assert.doesNotMatch(JSON.stringify(first), /instruction ready/u);
  assert.throws(
    () =>
      port.instruct(instruction(authority, 'newline', { text: 'unsafe\n' })),
    /cannot end with Enter/u,
  );
});

test('Claude instruction submits paste and Enter as separately idempotent writes', () => {
  const pauses = [];
  const { authority, child, port, screen } = fixture({
    provider: 'claude',
    version: '2.1.209',
    pause: (milliseconds) => pauses.push(milliseconds),
  });
  screen('❯ Ask about this workspace');
  const request = instruction(authority, 'claude-ready');
  const first = port.instruct(request);
  const duplicate = port.instruct(request);
  assert.equal(first.status, 'written');
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(child.writes, [
    '\u001b[200~instruction claude-ready\u001b[201~',
    '\r',
  ]);
  assert.deepEqual(pauses, [50, 50]);
  assert.equal(
    first.deliveryReceipt.proves,
    'validated-input-written-to-pty-only',
  );
});

test('busy queue flushes only after a supported ready signature', () => {
  const { authority, child, port, screen } = fixture();
  screen('Working (1s • esc to interrupt)');
  const held = port.instruct(
    instruction(authority, 'queued', { mode: 'queue' }),
  );
  assert.equal(held.status, 'held');
  assert.equal(held.queued, true);
  assert.deepEqual(child.writes, []);
  assert.equal(port.flushQueued().status, 'held');
  screen('› Ready');
  assert.equal(port.flushQueued().status, 'written');
  assert.equal(port.status().queuedInstructions, 0);
});

test('approval and unknown modal states never auto-deliver or auto-queue', () => {
  const { authority, child, port, screen } = fixture();
  screen('Would you like to run this command?');
  const approval = port.instruct(
    instruction(authority, 'approval', { mode: 'queue' }),
  );
  assert.equal(approval.status, 'held');
  assert.equal(approval.queued, false);
  assert.equal(approval.requiresHuman, true);
  screen('A changed layout says permission required');
  const unknown = port.instruct(
    instruction(authority, 'unknown', { mode: 'interrupt' }),
  );
  assert.equal(unknown.status, 'held');
  assert.equal(unknown.queued, false);
  assert.deepEqual(child.writes, []);
  assert.deepEqual(child.signals, []);
});

test('interrupt mode sends one fenced signal then waits for ready before text', () => {
  const { authority, child, port, screen } = fixture();
  screen('Working (3s • esc to interrupt)');
  const held = port.instruct(
    instruction(authority, 'interrupt', { mode: 'interrupt' }),
  );
  assert.equal(held.status, 'held');
  assert.equal(held.controlReceipt.operation, 'interrupt');
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.deepEqual(child.writes, []);
  screen('› Ready');
  assert.equal(port.flushQueued().status, 'written');
  assert.equal(held.controlReceipt.semanticOutcome, null);
});

test('sendKey is manual-only, deduplicated, and never implies approval outcome', () => {
  const { authority, child, port, screen } = fixture();
  screen('Would you like to run this command?');
  const request = {
    ...authority,
    actionId: 'action-key',
    inputId: 'input-key',
    key: 'y',
    automatic: false,
  };
  assert.equal(port.sendKey(request).status, 'written');
  assert.equal(port.sendKey(request).status, 'duplicate');
  assert.deepEqual(child.writes, ['y']);
  assert.throws(
    () => port.sendKey({ ...request, inputId: 'input-auto', automatic: true }),
    (error) => error.code === 'manual_key_required',
  );
});

test('provider exit and opaque shell fallback fail closed', () => {
  const ended = fixture();
  ended.screen('› Ready');
  ended.child.emit('exit', { exitCode: 0, signal: 0 });
  const afterExit = ended.port.instruct(instruction(ended.authority, 'late'));
  assert.equal(afterExit.status, 'held');
  assert.equal(afterExit.reason, 'provider-ended');
  assert.deepEqual(ended.child.writes, []);

  const custom = fixture({ provider: 'custom' });
  custom.screen('› Looks ready but belongs to an opaque shell');
  const shell = custom.port.instruct(instruction(custom.authority, 'shell'));
  assert.equal(shell.status, 'held');
  assert.equal(shell.reason, 'foreground-provider-mismatch');
  assert.equal(shell.requiresHuman, true);
  assert.deepEqual(custom.child.writes, []);
});

test('adapter version drift is visible and cannot write through a ready-looking screen', () => {
  const { authority, child, port, screen } = fixture({ version: '0.145.0' });
  screen('› Ready-looking prompt');
  const receipt = port.instruct(instruction(authority, 'drift'));
  assert.equal(receipt.status, 'held');
  assert.equal(receipt.reason, 'adapter-version-drift');
  assert.equal(receipt.requiresHuman, true);
  assert.equal(port.status().providerAdapter.rawHumanFallback, true);
  assert.deepEqual(child.writes, []);
});

test('bounded queue rejects overflow without dropping or writing hidden input', () => {
  const { authority, child, port, screen } = fixture({ queueLimit: 1 });
  screen('Working (1s • esc to interrupt)');
  assert.equal(
    port.instruct(instruction(authority, 'one', { mode: 'queue' })).status,
    'held',
  );
  const overflow = port.instruct(
    instruction(authority, 'two', { mode: 'queue' }),
  );
  assert.equal(overflow.status, 'rejected');
  assert.equal(overflow.reason, 'instruction-queue-full');
  assert.equal(overflow.queueDepth, 1);
  assert.deepEqual(child.writes, []);
});
