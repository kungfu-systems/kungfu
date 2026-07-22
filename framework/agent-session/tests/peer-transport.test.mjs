import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { AgentSessionCapsuleHost } from '../src/capsule-host.mjs';
import {
  AgentSessionCapsulePeerTransport,
  InMemoryJournalNoticePort,
} from '../src/peer-transport.mjs';
import {
  AGENT_SESSION_PEER_RECOVERY,
  admitCoordinator,
  coordinatorAuthority,
  peerContinuityObservation,
} from '../src/runtime-continuity.mjs';

const PROFILE_ROOT = `sha256:${'b'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 8118;
    this.writes = [];
    this.resizes = [];
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

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  kill(signal) {
    this.signals.push(signal);
  }
}

function fixture({ maxFrames = 256, maxOutputBytes = 1024 } = {}) {
  let clock = 1000;
  const child = new FakePtyProcess();
  const host = new AgentSessionCapsuleHost({
    pty: { spawn: () => child },
    capsuleId: 'capsule-peer-1',
    runtimeIdentity: 'workspace-runtime-1',
    maxOutputBytes,
    now: () => clock,
  });
  const started = host.start({
    workConsoleId: 'console-1',
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '11',
    provider: 'synthetic',
    profileRoot: PROFILE_ROOT,
    executable: '/usr/bin/node',
    argv: ['synthetic-provider.mjs'],
    cwd: '/tmp',
  });
  const port = new InMemoryJournalNoticePort({ maxFrames });
  const transport = new AgentSessionCapsulePeerTransport({
    host,
    port,
    now: () => clock,
    leaseTtlMs: 50,
  });
  transport.register({ coordinatorEpoch: '3', supervisorGeneration: '5' });
  const current = {
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '11',
    processStartIdentity: started.foreground.processStartIdentity,
  };
  return {
    child,
    current,
    foreground: started.foreground,
    host,
    port,
    transport,
    tick: (amount = 1) => {
      clock += amount;
    },
  };
}

test('multiple readers recover by journal cursor even when notices are lost', () => {
  const { child, port, transport } = fixture();
  transport.attach({ attachmentId: 'gui', actorId: 'gui', fromSequence: 0 });
  transport.attach({ attachmentId: 'cli', actorId: 'cli', fromSequence: 0 });
  port.dropNotices = true;
  child.emit('data', 'first\r\n');
  const gui = transport.read('gui');
  child.emit('data', 'second\r\n');
  const cli = transport.read('cli');
  assert.equal(gui.frames.at(-1).payload.data, 'first\r\n');
  assert.match(
    cli.frames.map((frame) => frame.payload.data).join(''),
    /second/u,
  );
  assert.equal(transport.status().attachments, 2);
  assert.equal(
    port.notices.some((notice) => notice.kind === 'output-bytes'),
    false,
  );
});

test('AgentSession declares process loss as lost-control instead of fake PTY recovery', () => {
  const { port, transport } = fixture();
  const registration = port.frames.find(
    (frame) => frame.kind === 'peer-registration',
  );
  assert.deepEqual(registration.payload.recovery, AGENT_SESSION_PEER_RECOVERY);
  assert.deepEqual(transport.status().recovery, AGENT_SESSION_PEER_RECOVERY);
});

test('one controller wins, duplicate input is idempotent, and stale authority fails closed', () => {
  const { child, current, foreground, transport } = fixture();
  const granted = transport.acquireControl({
    leaseId: 'lease-gui',
    holderId: 'gui',
    planRoot: 'plan-gui',
  });
  const denied = transport.acquireControl({
    leaseId: 'lease-cli',
    holderId: 'cli',
    planRoot: 'plan-cli',
  });
  assert.equal(granted.status, 'granted');
  assert.equal(denied.status, 'denied');
  const action = {
    ...current,
    actionId: 'action-1',
    inputId: 'input-1',
    data: 'hello',
    leaseId: 'lease-gui',
    holderId: 'gui',
    coordinatorEpoch: '3',
    expectedForeground: foreground,
  };
  assert.equal(transport.submitInput(action).status, 'written');
  assert.equal(transport.submitInput(action).status, 'duplicate');
  assert.deepEqual(child.writes, ['hello']);
  assert.throws(
    () =>
      transport.submitInput({
        ...action,
        inputId: 'input-2',
        leaseId: 'lease-cli',
      }),
    (error) => error.code === 'stale_controller_lease',
  );
  assert.throws(
    () =>
      transport.submitInput({
        ...action,
        inputId: 'input-3',
        expectedForeground: { ...foreground, provider: 'codex' },
      }),
    (error) => error.code === 'foreground_mismatch',
  );
  assert.throws(
    () =>
      transport.submitInput({
        ...action,
        inputId: 'input-4',
        coordinatorEpoch: '2',
      }),
    (error) => error.code === 'stale_coordinator',
  );
});

test('interrupt signal is idempotent and uses the same controller and foreground fencing', () => {
  const { child, current, foreground, transport } = fixture();
  transport.acquireControl({
    leaseId: 'lease-gui',
    holderId: 'gui',
    planRoot: 'plan-gui',
  });
  const action = {
    ...current,
    actionId: 'interrupt-1',
    inputId: 'interrupt-input-1',
    signal: 'SIGINT',
    leaseId: 'lease-gui',
    holderId: 'gui',
    coordinatorEpoch: '3',
    expectedForeground: foreground,
  };
  assert.equal(transport.submitSignal(action).status, 'applied');
  assert.equal(transport.submitSignal(action).status, 'duplicate');
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.throws(
    () =>
      transport.submitSignal({
        ...action,
        inputId: 'interrupt-input-2',
        leaseId: 'stale-lease',
      }),
    (error) => error.code === 'stale_controller_lease',
  );
  assert.throws(
    () =>
      transport.submitSignal({
        ...action,
        inputId: 'interrupt-input-3',
        expectedForeground: { ...foreground, processStartIdentity: 'stale' },
      }),
    (error) => error.code === 'foreground_mismatch',
  );
});

test('explicit takeover and resize coalescing retain one auditable winner', () => {
  const { child, current, transport } = fixture();
  transport.acquireControl({
    leaseId: 'lease-gui',
    holderId: 'gui',
    planRoot: 'plan-gui',
  });
  assert.throws(
    () =>
      transport.takeoverControl({
        expectedLeaseId: 'lease-gui',
        leaseId: 'lease-cli',
        holderId: 'cli',
        planRoot: 'plan-takeover',
        approved: false,
      }),
    (error) => error.code === 'takeover_precondition_failed',
  );
  const takeover = transport.takeoverControl({
    expectedLeaseId: 'lease-gui',
    leaseId: 'lease-cli',
    holderId: 'cli',
    planRoot: 'plan-takeover',
    approved: true,
  });
  assert.equal(takeover.takeover, true);
  transport.queueResize({
    ...current,
    leaseId: 'lease-cli',
    holderId: 'cli',
    actionId: 'resize-1',
    cols: 100,
    rows: 30,
  });
  transport.queueResize({
    ...current,
    leaseId: 'lease-cli',
    holderId: 'cli',
    actionId: 'resize-2',
    cols: 120,
    rows: 40,
  });
  transport.flushResize();
  assert.deepEqual(child.resizes, [[120, 40]]);
});

test('Coordinator re-registration preserves stream epoch and controller lease', () => {
  const { transport } = fixture();
  transport.acquireControl({
    leaseId: 'lease-1',
    holderId: 'gui',
    planRoot: 'plan-1',
  });
  const before = transport.status();
  transport.reregister({ coordinatorEpoch: '4' });
  const after = transport.status();
  assert.equal(after.coordinatorEpoch, '4');
  assert.equal(after.sessionStreamEpoch, before.sessionStreamEpoch);
  assert.equal(after.controllerLease.leaseId, before.controllerLease.leaseId);
  assert.throws(
    () => transport.reregister({ coordinatorEpoch: '4' }),
    (error) => error.code === 'stale_coordinator',
  );
  transport.reregister({ runtimeGeneration: '2', coordinatorEpoch: '1' });
  assert.deepEqual(transport.status().runtimeContinuity, {
    schema: 'kungfu.runtime.peer-continuity/v1',
    runtime_generation: '2',
    coordinator_epoch: '1',
  });
});

test('Capsule continuity consumes the Core runtime authority schema and fences regressions', () => {
  const current = coordinatorAuthority({
    runtimeGeneration: '7',
    coordinatorEpoch: '12',
  });
  assert.equal(
    admitCoordinator(
      current,
      coordinatorAuthority({
        runtimeGeneration: '8',
        coordinatorEpoch: '1',
      }),
    ).accepted,
    true,
  );
  assert.equal(
    admitCoordinator(
      current,
      coordinatorAuthority({
        runtimeGeneration: '7',
        coordinatorEpoch: '11',
      }),
    ).admission,
    'stale_coordinator',
  );
  assert.deepEqual(
    peerContinuityObservation({
      lastAuthority: current,
      reconnectAttempt: '3',
    }),
    {
      schema: 'kungfu.runtime.peer-continuity/v1',
      reconnect_attempt: '3',
      last_authority: current,
    },
  );
});

test('Supervisor adoption requires exact runtime, generation and process identity', () => {
  const { current, transport } = fixture();
  assert.throws(
    () =>
      transport.adopt({
        runtimeIdentity: 'workspace-runtime-1',
        capsuleGeneration: '7',
        processStartIdentity: 'stale-process',
        previousSupervisorGeneration: '5',
        supervisorGeneration: '6',
      }),
    (error) => error.code === 'stale_process',
  );
  const adopted = transport.adopt({
    runtimeIdentity: 'workspace-runtime-1',
    capsuleGeneration: '7',
    processStartIdentity: current.processStartIdentity,
    previousSupervisorGeneration: '5',
    supervisorGeneration: '6',
  });
  assert.equal(adopted.status, 'adopted');
  assert.equal(transport.status().supervisorGeneration, '6');
  assert.equal(transport.status().sessionStreamEpoch, '11');
});

test('slow reader gets an explicit gap and VT snapshot without blocking output', () => {
  const { child, transport } = fixture({ maxFrames: 4, maxOutputBytes: 64 });
  transport.attach({ attachmentId: 'slow', actorId: 'slow', fromSequence: 0 });
  for (let index = 0; index < 12; index += 1) {
    child.emit('data', `frame-${index}-${'x'.repeat(16)}\r\n`);
    transport.publishOutput();
  }
  const recovered = transport.read('slow');
  assert.equal(recovered.gap.reason, 'bounded-journal-retention-overflow');
  assert.equal(
    recovered.snapshot.schema,
    'kungfu.agent-session.vt-text-grid/v1',
  );
  assert.ok(recovered.frames.length <= 4);
});

test('bounded journal transport has no per-reader output fanout in the writer path', () => {
  const { child, port, transport } = fixture({
    maxFrames: 128,
    maxOutputBytes: 20_000,
  });
  for (let index = 0; index < 64; index += 1) {
    transport.attach({
      attachmentId: `reader-${index}`,
      actorId: `reader-${index}`,
    });
  }
  const beforeFrames = port.nextCursor;
  const started = performance.now();
  for (let index = 0; index < 10_000; index += 1) child.emit('data', 'x');
  transport.publishOutput();
  const elapsedMs = performance.now() - started;
  assert.equal(port.nextCursor - beforeFrames, 1);
  assert.ok(elapsedMs < 2_000, `10k-frame publish took ${elapsedMs}ms`);
});
