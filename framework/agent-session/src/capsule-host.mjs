import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { commandLaunchSpec } from './command-launch.mjs';
import { VtTextGrid } from './vt-snapshot.mjs';

const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
const PROVIDERS = new Set(['codex', 'claude', 'synthetic', 'custom']);
const PROFILE_ROOT = /^sha256:[a-f0-9]{64}$/u;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireEpoch(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive integer string`);
  }
  return value;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

export class AgentSessionCapsuleHost {
  constructor({
    pty,
    capsuleId,
    runtimeIdentity,
    ptyReadiness = { ready: true, diagnostic: null },
    maxOutputBytes = 256 * 1024,
    now = () => Date.now(),
    platform = process.platform,
  }) {
    if (!pty || typeof pty.spawn !== 'function') {
      throw new Error(
        'AgentSessionCapsuleHost requires an injected PTY module',
      );
    }
    this.pty = pty;
    this.capsuleId = requireString(capsuleId, 'capsuleId');
    this.runtimeIdentity = requireString(runtimeIdentity, 'runtimeIdentity');
    this.ptyReadiness = ptyReadiness;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
      throw new Error('maxOutputBytes must be a non-negative safe integer');
    }
    this.maxOutputBytes = maxOutputBytes;
    this.now = now;
    this.platform = platform;
    this.session = null;
  }

  handshake() {
    return {
      schema: 'kungfu.agent-session.capsule-handshake/v1',
      capsuleId: this.capsuleId,
      runtimeIdentity: this.runtimeIdentity,
      processId: process.pid,
      capabilities: [
        'pty-owner',
        'ordered-io',
        'bounded-replay',
        'vt-text-grid-snapshot',
        'exact-generation-signal',
      ],
      transport: 'local-capsule-test-port',
      health: this.ptyReadiness.ready ? 'ready' : 'degraded',
      diagnostic: this.ptyReadiness.diagnostic,
    };
  }

  start(spec) {
    if (!this.ptyReadiness.ready) {
      throw new Error(this.ptyReadiness.diagnostic);
    }
    if (this.session) {
      throw new Error('capsule is already bound to a session attempt');
    }
    const executable = requireString(spec.executable, 'executable');
    if (!path.isAbsolute(executable)) {
      throw new Error('executable must be an absolute path');
    }
    if (
      !Array.isArray(spec.argv) ||
      !spec.argv.every((item) => typeof item === 'string')
    ) {
      throw new Error('argv must be an array of strings');
    }
    if (!PROFILE_ROOT.test(spec.profileRoot)) {
      throw new Error('profileRoot must be a sha256 identity');
    }
    if (!PROVIDERS.has(spec.provider)) {
      throw new Error('provider must be codex, claude, synthetic, or custom');
    }
    if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) {
      throw new Error('cwd must be an absolute path');
    }
    const cols = spec.cols ?? 80;
    const rows = spec.rows ?? 24;
    if (
      !Number.isInteger(cols) ||
      cols < 1 ||
      !Number.isInteger(rows) ||
      rows < 1
    ) {
      throw new Error('start requires positive integer cols and rows');
    }
    if (
      spec.env !== undefined &&
      (typeof spec.env !== 'object' ||
        spec.env === null ||
        Array.isArray(spec.env) ||
        !Object.values(spec.env).every((value) => typeof value === 'string'))
    ) {
      throw new Error('env must contain only string values');
    }
    const capsuleGeneration = requireEpoch(
      spec.capsuleGeneration,
      'capsuleGeneration',
    );
    const sessionStreamEpoch = requireEpoch(
      spec.sessionStreamEpoch,
      'sessionStreamEpoch',
    );
    const launch = commandLaunchSpec({
      executable,
      argv: spec.argv,
      env: spec.env,
      platform: this.platform,
    });
    const child = this.pty.spawn(launch.executable, launch.argv, {
      name: spec.terminalName ?? 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
    });
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const startedAt = this.now();
    const session = {
      workConsoleId: requireString(spec.workConsoleId, 'workConsoleId'),
      sessionAttemptId: requireString(
        spec.sessionAttemptId,
        'sessionAttemptId',
      ),
      capsuleGeneration,
      sessionStreamEpoch,
      provider: requireString(spec.provider, 'provider'),
      profileRoot: spec.profileRoot,
      executable,
      argv: [...spec.argv],
      cwd: spec.cwd ?? null,
      child,
      pid: child.pid,
      processStartIdentity: `${child.pid}:${startedAt}:${randomUUID()}`,
      startedAt,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      inputAdmission: 'open',
      lifecycleState: 'ready',
      interactionState: 'unknown',
      nextSequence: 0,
      earliestSequence: 0,
      retainedBytes: 0,
      output: [],
      vt: new VtTextGrid(cols, rows),
      inputReceipts: new Map(),
      inputOffset: 0,
      lifecycle: [],
      changeSequence: 0,
      changeWaiters: new Set(),
      exitPromise,
      resolveExit,
    };
    this.session = session;
    this.#recordLifecycle('started');
    this.#recordLifecycle('ready');
    child.onData((data) => this.#appendOutput(data));
    child.onExit(({ exitCode, signal }) => {
      if (session !== this.session || session.inputAdmission === 'closed')
        return;
      session.inputAdmission = 'closed';
      session.lifecycleState = 'ended';
      session.interactionState = 'ended';
      session.endedAt = this.now();
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      this.#recordLifecycle('exit', { exitCode, signal: signal ?? null });
      this.#notifyChange();
      session.resolveExit(this.status());
    });
    return this.status();
  }

  waitForExit() {
    const session = this.#requireSession();
    if (session.inputAdmission === 'closed') {
      return Promise.resolve(this.status());
    }
    return session.exitPromise;
  }

  waitForChange(afterChangeSequence) {
    const session = this.#requireSession();
    if (!Number.isSafeInteger(afterChangeSequence) || afterChangeSequence < 0) {
      throw new Error(
        'afterChangeSequence must be a non-negative safe integer',
      );
    }
    if (session.changeSequence !== afterChangeSequence) {
      return Promise.resolve(this.status());
    }
    return new Promise((resolve) => session.changeWaiters.add(resolve));
  }

  status() {
    const session = this.#requireSession();
    return {
      schema: 'kungfu.agent-session.capsule-host-status/v1',
      capsuleId: this.capsuleId,
      runtimeIdentity: this.runtimeIdentity,
      workConsoleId: session.workConsoleId,
      sessionAttemptId: session.sessionAttemptId,
      capsuleGeneration: session.capsuleGeneration,
      sessionStreamEpoch: session.sessionStreamEpoch,
      changeSequence: session.changeSequence,
      lifecycleState: session.lifecycleState,
      interactionState: session.interactionState,
      inputAdmission: session.inputAdmission,
      backend: 'capsule-native-pty',
      foreground: {
        provider: session.provider,
        profileRoot: session.profileRoot,
        executable: session.executable,
        argv: [...session.argv],
        pid: session.pid,
        processStartIdentity: session.processStartIdentity,
        state: session.inputAdmission === 'closed' ? 'ended' : 'running',
      },
      output: {
        earliestSequence: session.earliestSequence,
        nextSequence: session.nextSequence,
        latestSnapshotSequence: session.nextSequence,
        retainedBytes: session.retainedBytes,
      },
      exit: session.endedAt
        ? {
            endedAt: session.endedAt,
            exitCode: session.exitCode,
            signal: session.exitSignal,
          }
        : null,
    };
  }

  snapshot(requestedSequence = 0) {
    const session = this.#requireSession();
    if (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0) {
      throw new Error('requestedSequence must be a non-negative safe integer');
    }
    const gap =
      requestedSequence < session.earliestSequence
        ? {
            fromSequence: requestedSequence,
            toSequence: session.earliestSequence,
            reason: 'bounded-retention-overflow',
          }
        : null;
    return {
      receipt: {
        schema: 'kungfu.agent-session.output-read-receipt/v1',
        sessionAttemptId: session.sessionAttemptId,
        sessionStreamEpoch: String(session.sessionStreamEpoch),
        requestedSequence,
        earliestAvailableSequence: session.earliestSequence,
        nextSequence: session.nextSequence,
        gap,
        snapshotSequence: session.nextSequence,
      },
      vt: session.vt.snapshot(session.nextSequence),
      frames: session.output.filter(
        (frame) =>
          frame.endSequence >
          Math.max(requestedSequence, session.earliestSequence),
      ),
    };
  }

  input(action) {
    const session = this.#requireCurrent(action);
    const inputId = requireString(action.inputId, 'inputId');
    const actionId = requireString(action.actionId, 'actionId');
    const existing = session.inputReceipts.get(inputId);
    if (existing) return { ...existing, status: 'duplicate' };
    if (session.inputAdmission !== 'open') {
      throw new Error('provider input admission is closed');
    }
    if (typeof action.data !== 'string') {
      throw new Error('input data must be a string');
    }
    session.child.write(action.data);
    const writtenOffset = session.inputOffset;
    session.inputOffset += byteLength(action.data);
    const receipt = {
      schema: 'kungfu.agent-session.delivery-receipt/v1',
      inputId,
      actionId,
      sessionAttemptId: session.sessionAttemptId,
      capsuleGeneration: session.capsuleGeneration,
      sessionStreamEpoch: session.sessionStreamEpoch,
      status: 'written',
      writtenOffset,
      proves: 'validated-input-written-to-pty-only',
      semanticOutcome: null,
      workState: null,
    };
    session.inputReceipts.set(inputId, receipt);
    return receipt;
  }

  resize(action) {
    const session = this.#requireCurrent(action);
    if (
      !Number.isInteger(action.cols) ||
      action.cols < 1 ||
      !Number.isInteger(action.rows) ||
      action.rows < 1
    ) {
      throw new Error('resize requires positive integer cols and rows');
    }
    session.child.resize(action.cols, action.rows);
    session.vt.resize(action.cols, action.rows);
    return this.#controlReceipt('resize', action);
  }

  signal(action) {
    const session = this.#requireCurrent(action);
    const signal = action.signal ?? 'SIGINT';
    if (!ALLOWED_SIGNALS.has(signal)) {
      throw new Error(`signal '${signal}' is not allowed`);
    }
    if (session.inputAdmission !== 'open') {
      throw new Error('provider process has already ended');
    }
    if (this.platform === 'win32') {
      if (signal !== 'SIGTERM') {
        throw new Error(`signal '${signal}' is not supported on Windows`);
      }
      session.child.kill();
    } else {
      session.child.kill(signal);
    }
    return this.#controlReceipt('signal', action, { signal });
  }

  lifecycle() {
    return this.#requireSession().lifecycle.map((receipt) => ({ ...receipt }));
  }

  #requireSession() {
    if (!this.session) throw new Error('capsule has no session attempt');
    return this.session;
  }

  #requireCurrent(action) {
    const session = this.#requireSession();
    if (action.sessionAttemptId !== session.sessionAttemptId) {
      throw new Error('stale session attempt');
    }
    if (action.capsuleGeneration !== session.capsuleGeneration) {
      throw new Error('stale capsule generation');
    }
    if (action.sessionStreamEpoch !== session.sessionStreamEpoch) {
      throw new Error('stale session stream epoch');
    }
    if (action.processStartIdentity !== session.processStartIdentity) {
      throw new Error('stale provider process identity');
    }
    return session;
  }

  #appendOutput(data) {
    const session = this.#requireSession();
    const encoded = Buffer.from(data, 'utf8');
    const startSequence = session.nextSequence;
    session.nextSequence += encoded.length;
    session.vt.write(data);
    let retained = encoded;
    let retainedStart = startSequence;
    if (retained.length > this.maxOutputBytes) {
      let cut = retained.length - this.maxOutputBytes;
      while (cut < retained.length && (retained[cut] & 0xc0) === 0x80) cut += 1;
      retainedStart += cut;
      retained = retained.subarray(cut);
    }
    if (retained.length > 0 && this.maxOutputBytes > 0) {
      session.output.push({
        startSequence: retainedStart,
        endSequence: session.nextSequence,
        data: retained.toString('utf8'),
      });
      session.retainedBytes += retained.length;
    }
    while (
      session.retainedBytes > this.maxOutputBytes &&
      session.output.length > 0
    ) {
      const first = session.output.shift();
      session.retainedBytes -= first.endSequence - first.startSequence;
    }
    session.earliestSequence =
      session.output[0]?.startSequence ?? session.nextSequence;
    this.#notifyChange();
  }

  #notifyChange() {
    const session = this.#requireSession();
    session.changeSequence += 1;
    const status = this.status();
    for (const resolve of session.changeWaiters) resolve(status);
    session.changeWaiters.clear();
  }

  #recordLifecycle(event, detail = {}) {
    const session = this.#requireSession();
    session.lifecycle.push({
      schema: 'kungfu.agent-session.lifecycle-receipt/v1',
      event,
      capsuleId: this.capsuleId,
      sessionAttemptId: session.sessionAttemptId,
      capsuleGeneration: session.capsuleGeneration,
      sessionStreamEpoch: session.sessionStreamEpoch,
      processStartIdentity: session.processStartIdentity,
      recordedAt: this.now(),
      semanticOutcome: null,
      workState: null,
      ...detail,
    });
  }

  #controlReceipt(operation, action, detail = {}) {
    const session = this.#requireSession();
    return {
      schema: 'kungfu.agent-session.control-receipt/v1',
      operation,
      actionId: requireString(action.actionId, 'actionId'),
      sessionAttemptId: session.sessionAttemptId,
      capsuleGeneration: session.capsuleGeneration,
      sessionStreamEpoch: session.sessionStreamEpoch,
      processStartIdentity: session.processStartIdentity,
      status: 'applied',
      appliedAt: this.now(),
      ...detail,
    };
  }
}
