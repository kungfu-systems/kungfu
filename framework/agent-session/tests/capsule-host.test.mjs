import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentSessionCapsuleHost } from '../src/capsule-host.mjs';
import { VtTextGrid } from '../src/vt-snapshot.mjs';

const PROFILE_ROOT = `sha256:${'a'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.writes = [];
    this.resizes = [];
    this.signals = [];
  }

  onData(listener) {
    this.on('data', listener);
    return { dispose: () => this.off('data', listener) };
  }

  onExit(listener) {
    this.on('exit', listener);
    return { dispose: () => this.off('exit', listener) };
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

function fixture(maxOutputBytes = 64) {
  const child = new FakePtyProcess();
  let now = 1000;
  const host = new AgentSessionCapsuleHost({
    pty: { spawn: () => child },
    capsuleId: 'capsule-1',
    runtimeIdentity: 'runtime-test-1',
    maxOutputBytes,
    now: () => now++,
  });
  const status = host.start({
    workConsoleId: 'console-1',
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '9',
    provider: 'synthetic',
    profileRoot: PROFILE_ROOT,
    executable: '/usr/bin/node',
    argv: ['synthetic-provider.mjs'],
    cwd: '/tmp',
    cols: 20,
    rows: 4,
  });
  const current = {
    sessionAttemptId: 'attempt-1',
    capsuleGeneration: '7',
    sessionStreamEpoch: '9',
    processStartIdentity: status.foreground.processStartIdentity,
  };
  return { child, current, host, status };
}

test('VT snapshot preserves the active text grid without presenting escape bytes', () => {
  const vt = new VtTextGrid(20, 3);
  vt.write('\x1b[2J\x1b[Hprimary');
  vt.write('\x1b[?1049halternate\x1b[?1049l');
  const snapshot = vt.snapshot(17);
  assert.equal(snapshot.activeBuffer, 'primary');
  assert.equal(snapshot.lines[0], 'primary');
  assert.equal(snapshot.lines.join('').includes('alternate'), false);
  assert.equal(snapshot.lines.join('').includes('\x1b'), false);
  assert.equal(snapshot.fidelity, 'printable-text-grid');
});

test('VT snapshot reconstructs absolute columns, whole-line erase, and saved cursor', () => {
  const vt = new VtTextGrid(30, 4);
  vt.write('\x1b[2J\x1b[Hstale-line');
  vt.write('\x1b[2K\x1b[3GTry\x1b[8G"edit');
  vt.write('\x1b7\x1b[4;20Hstatus\x1b8 placeholder');
  const snapshot = vt.snapshot(29);
  assert.equal(snapshot.lines[0], '  Try  "edit placeholder');
  assert.equal(snapshot.lines[3], '                   status');
});

test('bounded output emits an explicit gap while the VT snapshot remains current', () => {
  const { child, host } = fixture(32);
  child.emit('data', `header\r\n${'x'.repeat(128)}tail`);
  const replay = host.snapshot(0);
  assert.deepEqual(replay.receipt.gap, {
    fromSequence: 0,
    toSequence: replay.receipt.earliestAvailableSequence,
    reason: 'bounded-retention-overflow',
  });
  assert.equal(
    replay.receipt.nextSequence,
    Buffer.byteLength(`header\r\n${'x'.repeat(128)}tail`),
  );
  assert.ok(
    replay.frames.reduce(
      (sum, frame) => sum + Buffer.byteLength(frame.data),
      0,
    ) <= 32,
  );
  assert.equal(replay.vt.sequence, replay.receipt.nextSequence);
});

test('input is idempotent and fenced by attempt, generation, epoch and process identity', () => {
  const { child, current, host } = fixture();
  const action = {
    ...current,
    actionId: 'action-1',
    inputId: 'input-1',
    data: 'hello',
  };
  const first = host.input(action);
  const duplicate = host.input(action);
  assert.equal(first.status, 'written');
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(child.writes, ['hello']);
  assert.throws(
    () => host.input({ ...action, inputId: 'input-2', capsuleGeneration: '6' }),
    /stale capsule generation/u,
  );
  assert.throws(
    () =>
      host.signal({
        ...current,
        actionId: 'signal-1',
        processStartIdentity: '4242:old',
      }),
    /stale provider process identity/u,
  );
});

test('provider exit closes input before any later write can reach a shell', () => {
  const { child, current, host } = fixture();
  child.emit('exit', { exitCode: 23, signal: 0 });
  assert.equal(host.status().inputAdmission, 'closed');
  assert.throws(
    () =>
      host.input({
        ...current,
        actionId: 'late',
        inputId: 'late',
        data: 'whoami\n',
      }),
    /input admission is closed/u,
  );
  assert.deepEqual(child.writes, []);
  assert.deepEqual(
    host.lifecycle().map((receipt) => receipt.event),
    ['started', 'ready', 'exit'],
  );
});

test('resize and signal target only the current process identity', () => {
  const { child, current, host } = fixture();
  assert.equal(
    host.resize({ ...current, actionId: 'resize-1', cols: 120, rows: 40 })
      .status,
    'applied',
  );
  assert.equal(
    host.signal({ ...current, actionId: 'interrupt-1', signal: 'SIGINT' })
      .status,
    'applied',
  );
  assert.deepEqual(child.resizes, [[120, 40]]);
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.throws(
    () =>
      host.signal({
        ...current,
        actionId: 'invalid-signal',
        signal: 'SIGKILL',
      }),
    /not allowed/u,
  );
});

test('PTY readiness failure is exposed before provider spawn', () => {
  const child = new FakePtyProcess();
  const host = new AgentSessionCapsuleHost({
    pty: { spawn: () => child },
    capsuleId: 'capsule-degraded',
    runtimeIdentity: 'runtime-degraded',
    ptyReadiness: {
      ready: false,
      diagnostic: 'node-pty spawn-helper is not executable',
    },
  });
  assert.equal(host.handshake().health, 'degraded');
  assert.throws(
    () =>
      host.start({
        workConsoleId: 'console-1',
        sessionAttemptId: 'attempt-1',
        capsuleGeneration: '1',
        sessionStreamEpoch: '1',
        provider: 'synthetic',
        profileRoot: PROFILE_ROOT,
        executable: '/usr/bin/node',
        argv: [],
      }),
    /spawn-helper is not executable/u,
  );
});
