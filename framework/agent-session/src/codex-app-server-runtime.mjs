// SPDX-License-Identifier: Apache-2.0

import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createCodexAppServerContractGate } from './codex-app-server-contract.mjs';

const RUNTIME_SCHEMA = 'kungfu.codex-app-server.runtime-host/v1';
const EVENT_SCHEMA = 'kungfu.codex-app-server.runtime-event/v1';
const RECEIPT_SCHEMA = 'kungfu.codex-app-server.runtime-write-receipt/v1';

export class CodexAppServerRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexAppServerRuntimeError';
    this.code = code;
  }
}

function runtimeError(code, message) {
  return new CodexAppServerRuntimeError(code, message);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw runtimeError('invalid-spec', `${label} must be a non-empty string`);
  }
  return value;
}

function requireGeneration(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw runtimeError(
      'invalid-spec',
      'runtimeGeneration must be a positive integer string',
    );
  }
  return value;
}

function requestKey(id) {
  if (
    !(
      typeof id === 'string' ||
      (Number.isSafeInteger(id) && Number.isFinite(id))
    ) ||
    String(id).length === 0
  ) {
    throw runtimeError(
      'invalid-request-id',
      'Codex App Server request id must be a non-empty string or safe integer',
    );
  }
  return `${typeof id}:${String(id)}`;
}

function validateQueueBounds(maxQueueEvents, admissionStopThreshold) {
  if (!Number.isSafeInteger(maxQueueEvents) || maxQueueEvents < 2) {
    throw runtimeError(
      'invalid-queue-bound',
      'maxQueueEvents must be a safe integer of at least 2',
    );
  }
  if (
    !Number.isSafeInteger(admissionStopThreshold) ||
    admissionStopThreshold < 1 ||
    admissionStopThreshold >= maxQueueEvents
  ) {
    throw runtimeError(
      'invalid-queue-bound',
      'admissionStopThreshold must be below maxQueueEvents',
    );
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * One direct-stdio Codex App Server process for one Kungfu SessionAttempt.
 *
 * The host intentionally owns only process, framing, correlation and bounded
 * in-memory delivery. Event normalization and product routing are later seams.
 */
export class CodexAppServerRuntimeHost extends EventEmitter {
  constructor({
    spawn = spawnProcess,
    runtimeIdentity,
    maxQueueEvents = 256,
    admissionStopThreshold = 192,
    maxLineBytes = 1024 * 1024,
    initializeTimeoutMs = 10_000,
    now = () => Date.now(),
    uuid = randomUUID,
  }) {
    super();
    if (typeof spawn !== 'function') {
      throw runtimeError('invalid-runtime', 'spawn must be a function');
    }
    validateQueueBounds(maxQueueEvents, admissionStopThreshold);
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 256) {
      throw runtimeError(
        'invalid-runtime',
        'maxLineBytes must be a safe integer of at least 256',
      );
    }
    if (!Number.isSafeInteger(initializeTimeoutMs) || initializeTimeoutMs < 1) {
      throw runtimeError(
        'invalid-runtime',
        'initializeTimeoutMs must be a positive safe integer',
      );
    }
    this.spawn = spawn;
    this.runtimeIdentity = requireString(runtimeIdentity, 'runtimeIdentity');
    this.maxQueueEvents = maxQueueEvents;
    this.admissionStopThreshold = admissionStopThreshold;
    this.maxLineBytes = maxLineBytes;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.now = now;
    this.uuid = uuid;
    this.state = null;
  }

  async start(spec) {
    if (this.state) {
      throw runtimeError(
        'runtime-already-started',
        'runtime host is already bound to a session attempt',
      );
    }
    const executable = requireString(spec.executable, 'executable');
    if (!path.isAbsolute(executable)) {
      throw runtimeError('invalid-spec', 'executable must be an absolute path');
    }
    if (
      !Array.isArray(spec.argv) ||
      !spec.argv.every((entry) => typeof entry === 'string')
    ) {
      throw runtimeError('invalid-spec', 'argv must be an array of strings');
    }
    if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) {
      throw runtimeError('invalid-spec', 'cwd must be an absolute path');
    }
    if (
      spec.env !== undefined &&
      (spec.env === null ||
        typeof spec.env !== 'object' ||
        Array.isArray(spec.env) ||
        !Object.values(spec.env).every((value) => typeof value === 'string'))
    ) {
      throw runtimeError('invalid-spec', 'env must contain only string values');
    }

    const sessionAttemptId = requireString(
      spec.sessionAttemptId,
      'sessionAttemptId',
    );
    const runtimeGeneration = requireGeneration(spec.runtimeGeneration);
    const initializeParams = clone(spec.initializeParams ?? {});
    if (
      initializeParams === null ||
      typeof initializeParams !== 'object' ||
      Array.isArray(initializeParams) ||
      initializeParams.clientInfo === null ||
      typeof initializeParams.clientInfo !== 'object'
    ) {
      throw runtimeError(
        'invalid-spec',
        'initializeParams.clientInfo is required',
      );
    }
    const gate = createCodexAppServerContractGate({
      cliVersion: requireString(spec.cliVersion, 'cliVersion'),
      initializeCapabilities: initializeParams,
    });

    const child = this.spawn(executable, [...spec.argv], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (
      !child ||
      !child.stdin ||
      typeof child.stdin.write !== 'function' ||
      !child.stdout ||
      typeof child.stdout.on !== 'function' ||
      !child.stderr ||
      typeof child.stderr.on !== 'function' ||
      typeof child.on !== 'function'
    ) {
      throw runtimeError(
        'invalid-child-process',
        'spawn did not return a direct stdio child process',
      );
    }

    const startedAt = this.now();
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.state = {
      sessionAttemptId,
      runtimeGeneration,
      cliVersion: spec.cliVersion,
      executable,
      argv: [...spec.argv],
      cwd: spec.cwd ?? null,
      gate,
      child,
      pid: child.pid ?? null,
      processStartIdentity: `${String(child.pid ?? 'unknown')}:${startedAt}:${this.uuid()}`,
      startedAt,
      lifecycleState: 'initializing',
      inputAdmission: 'handshake-only',
      expectedShutdown: false,
      stdoutBuffer: Buffer.alloc(0),
      stdoutEnded: false,
      stderrBytes: 0,
      queue: [],
      nextSequence: 0,
      nextRequestId: 1,
      clientRequests: new Map(),
      serverRequests: new Map(),
      failure: null,
      exit: null,
      consumerFailures: 0,
      exitPromise,
      resolveExit,
    };

    // Reader and process boundaries are installed before initialize is written.
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stdout.on('end', () => this.#onStdoutEnd());
    child.stdout.on('error', (error) =>
      this.#fail('stdout-error', 'Codex App Server stdout failed', error),
    );
    child.stderr.on('data', (chunk) => {
      if (!this.state) return;
      this.state.stderrBytes += Buffer.byteLength(chunk);
    });
    child.stderr.on('error', (error) =>
      this.#fail('stderr-error', 'Codex App Server stderr failed', error),
    );
    child.on('error', (error) =>
      this.#fail('process-error', 'Codex App Server process failed', error),
    );
    child.on('close', (code, signal) => this.#onClose(code, signal));

    const initialize = this.#sendRequest('initialize', initializeParams, {
      handshake: true,
    });
    let timer;
    try {
      await Promise.race([
        initialize,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                runtimeError(
                  'initialize-timeout',
                  'Codex App Server initialize response timed out',
                ),
              ),
            this.initializeTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (this.state.failure) throw this.#failureError();
      this.#writeNotification('initialized');
      if (this.state.inputAdmission !== 'handshake-only') {
        throw runtimeError(
          'initialize-admission-frozen',
          'runtime admission froze before initialize completed',
        );
      }
      this.state.lifecycleState = 'ready';
      this.state.inputAdmission = 'open';
      return this.status();
    } catch (error) {
      this.#fail(
        error.code ?? 'initialize-failed',
        error.message ?? 'Codex App Server initialize failed',
        error,
      );
      throw this.#failureError();
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    const state = this.#requireState();
    return {
      schema: RUNTIME_SCHEMA,
      runtimeIdentity: this.runtimeIdentity,
      sessionAttemptId: state.sessionAttemptId,
      runtimeGeneration: state.runtimeGeneration,
      lifecycleState: state.lifecycleState,
      inputAdmission: state.inputAdmission,
      backend: 'codex-app-server-direct-stdio',
      provider: {
        name: 'codex',
        cliVersion: state.cliVersion,
        schemaBundleSha256: state.gate.schemaBundleSha256,
        experimentalApi: false,
      },
      foreground: {
        executable: state.executable,
        argv: [...state.argv],
        cwd: state.cwd,
        pid: state.pid,
        processStartIdentity: state.processStartIdentity,
        state: state.exit ? 'ended' : 'running',
      },
      queue: {
        depth: state.queue.length,
        maxEvents: this.maxQueueEvents,
        admissionStopThreshold: this.admissionStopThreshold,
        nextSequence: state.nextSequence,
      },
      correlation: {
        outstandingClientRequests: state.clientRequests.size,
        outstandingServerRequests: state.serverRequests.size,
      },
      stderr: { observedBytes: state.stderrBytes, retainedContent: false },
      consumerFailures: state.consumerFailures,
      failure: state.failure ? { ...state.failure } : null,
      exit: state.exit ? { ...state.exit } : null,
    };
  }

  currentFence() {
    const state = this.#requireState();
    return Object.freeze({
      sessionAttemptId: state.sessionAttemptId,
      runtimeGeneration: state.runtimeGeneration,
      processStartIdentity: state.processStartIdentity,
    });
  }

  request(action) {
    this.#requireCurrent(action);
    requireString(action.actionId, 'actionId');
    if (this.state.inputAdmission !== 'open') {
      throw runtimeError(
        'input-admission-closed',
        'Codex App Server input admission is not open',
      );
    }
    return this.#sendRequest(
      requireString(action.method, 'method'),
      clone(action.params ?? {}),
      { actionId: action.actionId },
    );
  }

  respond(action) {
    this.#requireCurrent(action);
    const actionId = requireString(action.actionId, 'actionId');
    if (this.state.inputAdmission !== 'open') {
      throw runtimeError(
        'input-admission-closed',
        'Codex App Server input admission is not open',
      );
    }
    const key = requestKey(action.requestId);
    const pending = this.state.serverRequests.get(key);
    if (!pending) {
      throw runtimeError(
        'unknown-server-request',
        'server request is unknown, stale, or already resolved',
      );
    }
    const hasResult = hasOwn(action, 'result');
    const hasError = hasOwn(action, 'error');
    if (hasResult === hasError) {
      throw runtimeError(
        'invalid-response',
        'response must contain exactly one result or error',
      );
    }
    const message = {
      id: action.requestId,
      ...(hasResult
        ? { result: clone(action.result) }
        : { error: clone(action.error) }),
    };
    const plan = this.state.gate.classify({
      direction: 'client-response',
      message,
      requestMethod: pending.method,
    });
    this.#writeLine(message);
    this.state.serverRequests.delete(key);
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      operation: 'server-request-response',
      actionId,
      requestId: action.requestId,
      providerMethod: pending.method,
      normalizedSemantic: plan.normalizedSemantic,
      status: 'written',
      ...this.currentFence(),
    });
  }

  takeEvents(limit = this.maxQueueEvents) {
    const state = this.#requireState();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw runtimeError('invalid-limit', 'event limit must be positive');
    }
    return state.queue.splice(0, limit).map((event) => clone(event));
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw runtimeError('invalid-consumer', 'listener must be a function');
    }
    this.on('runtime-event', listener);
    return () => this.off('runtime-event', listener);
  }

  shutdown(action) {
    const state = this.#requireCurrent(action);
    const actionId = requireString(action.actionId, 'actionId');
    if (state.exit) {
      return Object.freeze({
        schema: RECEIPT_SCHEMA,
        operation: 'shutdown',
        actionId,
        status: 'already-ended',
        ...this.currentFence(),
      });
    }
    const alreadyFailing = state.failure !== null;
    if (!alreadyFailing) {
      state.expectedShutdown = true;
      state.lifecycleState = 'stopping';
      state.inputAdmission = 'closed';
    }
    state.child.kill('SIGTERM');
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      operation: 'shutdown',
      actionId,
      status: alreadyFailing ? 'failure-termination-signalled' : 'signalled',
      signal: 'SIGTERM',
      ...this.currentFence(),
    });
  }

  waitForExit() {
    return this.#requireState().exitPromise;
  }

  #sendRequest(method, params, { handshake = false, actionId = null } = {}) {
    const state = this.#requireState();
    if (!handshake && state.inputAdmission !== 'open') {
      throw runtimeError(
        'input-admission-closed',
        'Codex App Server input admission is not open',
      );
    }
    const id = state.nextRequestId++;
    const message = { id, method, params };
    const plan = state.gate.classify({
      direction: 'client-request',
      message,
    });
    const key = requestKey(id);
    let resolve;
    let reject;
    const response = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    state.clientRequests.set(key, {
      id,
      method,
      actionId,
      plan,
      resolve,
      reject,
    });
    try {
      this.#writeLine(message);
    } catch (error) {
      state.clientRequests.delete(key);
      reject(error);
      this.#fail(
        'stdin-write-error',
        'Codex App Server stdin write failed',
        error,
      );
    }
    return response;
  }

  #writeNotification(method) {
    const message = { method };
    this.state.gate.classify({
      direction: 'client-notification',
      message,
    });
    this.#writeLine(message);
  }

  #writeLine(message) {
    const state = this.#requireState();
    if (state.exit || state.failure) throw this.#failureError();
    state.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    const state = this.state;
    if (!state || state.failure || state.exit) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.stdoutBuffer = Buffer.concat([state.stdoutBuffer, incoming]);
    if (state.stdoutBuffer.length > this.maxLineBytes) {
      const newline = state.stdoutBuffer.indexOf(0x0a);
      if (newline < 0 || newline > this.maxLineBytes) {
        this.#fail(
          'stdout-frame-too-large',
          'Codex App Server emitted a JSONL frame above the byte limit',
        );
        return;
      }
    }
    while (!state.failure) {
      const newline = state.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = state.stdoutBuffer.subarray(0, newline);
      state.stdoutBuffer = state.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > this.maxLineBytes) {
        this.#fail(
          'stdout-frame-too-large',
          'Codex App Server emitted a JSONL frame above the byte limit',
        );
        return;
      }
      let message;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch (error) {
        this.#fail(
          'malformed-jsonl',
          'Codex App Server emitted malformed JSONL',
          error,
        );
        return;
      }
      this.#acceptServerMessage(message);
    }
  }

  #acceptServerMessage(message) {
    const state = this.#requireState();
    try {
      if (
        message === null ||
        typeof message !== 'object' ||
        Array.isArray(message)
      ) {
        throw runtimeError(
          'invalid-envelope',
          'Codex App Server message must be an object',
        );
      }
      if (hasOwn(message, 'method')) {
        const direction = hasOwn(message, 'id')
          ? 'server-request'
          : 'server-notification';
        const plan = state.gate.classify({ direction, message });
        if (direction === 'server-request') {
          const key = requestKey(message.id);
          if (state.serverRequests.has(key)) {
            throw runtimeError(
              'duplicate-server-request',
              'Codex App Server repeated an outstanding server request id',
            );
          }
          state.serverRequests.set(key, {
            id: message.id,
            method: message.method,
          });
        }
        this.#enqueue(direction, message, plan);
        return;
      }
      if (hasOwn(message, 'id')) {
        const key = requestKey(message.id);
        const pending = state.clientRequests.get(key);
        if (!pending) {
          throw runtimeError(
            'unknown-client-response',
            'Codex App Server response is unknown, stale, or duplicated',
          );
        }
        const plan = state.gate.classify({
          direction: 'server-response',
          message,
          requestMethod: pending.method,
        });
        state.clientRequests.delete(key);
        this.#enqueue('server-response', message, plan);
        pending.resolve(
          Object.freeze({
            schema: RECEIPT_SCHEMA,
            operation: 'client-request-response',
            actionId: pending.actionId,
            requestId: message.id,
            providerMethod: pending.method,
            normalizedSemantic: plan.normalizedSemantic,
            outcome: hasOwn(message, 'error') ? 'error' : 'result',
            response: clone(message),
            status: 'observed',
            ...this.currentFence(),
          }),
        );
        return;
      }
      throw runtimeError(
        'invalid-envelope',
        'Codex App Server frame is neither a method nor a response',
      );
    } catch (error) {
      this.#fail(
        error.code ?? 'protocol-frame-rejected',
        error.message ?? 'Codex App Server frame failed closed',
        error,
      );
    }
  }

  #enqueue(direction, message, plan) {
    const state = this.#requireState();
    if (state.queue.length >= this.maxQueueEvents) {
      this.#fail(
        'consumer-queue-hard-bound',
        'Codex App Server consumer queue reached its hard bound',
      );
      return;
    }
    const event = Object.freeze({
      schema: EVENT_SCHEMA,
      sequence: state.nextSequence++,
      receivedAt: this.now(),
      runtimeIdentity: this.runtimeIdentity,
      sessionAttemptId: state.sessionAttemptId,
      runtimeGeneration: state.runtimeGeneration,
      processStartIdentity: state.processStartIdentity,
      direction,
      requestId: hasOwn(message, 'id') ? message.id : null,
      providerMethod: plan.providerMethod,
      normalizedSemantic: plan.normalizedSemantic,
      authority: plan.authority,
      retention: 'private-in-memory-bounded',
      message: clone(message),
    });
    state.queue.push(event);
    if (
      state.queue.length >= this.admissionStopThreshold &&
      state.inputAdmission === 'open'
    ) {
      state.inputAdmission = 'frozen';
    } else if (
      state.queue.length >= this.admissionStopThreshold &&
      state.inputAdmission === 'handshake-only'
    ) {
      state.inputAdmission = 'frozen';
    }
    for (const listener of this.listeners('runtime-event')) {
      queueMicrotask(() => {
        try {
          Promise.resolve(listener(clone(event))).catch(() => {
            if (this.state) this.state.consumerFailures += 1;
          });
        } catch {
          if (this.state) this.state.consumerFailures += 1;
        }
      });
    }
  }

  #onStdoutEnd() {
    const state = this.state;
    if (!state || state.stdoutEnded) return;
    state.stdoutEnded = true;
    if (!state.exit) {
      state.inputAdmission = 'frozen';
      if (!state.expectedShutdown && !state.failure) {
        this.#fail(
          'stdout-ended',
          'Codex App Server stdout ended before process close',
        );
      }
    }
  }

  #onClose(code, signal) {
    const state = this.state;
    if (!state || state.exit) return;
    if (state.stdoutBuffer.length > 0 && !state.failure) {
      this.#fail(
        'truncated-jsonl',
        'Codex App Server closed with a partial JSONL frame',
      );
    }
    state.inputAdmission = 'closed';
    if (!state.failure && !state.expectedShutdown) {
      state.failure = {
        code: 'unexpected-process-exit',
        message: 'Codex App Server process exited without an explicit shutdown',
        boundary: 'attempt-outcome-unknown',
        recordedAt: this.now(),
      };
    }
    state.lifecycleState = state.failure ? 'failed' : 'ended';
    state.exit = {
      code,
      signal: signal ?? null,
      expected: state.expectedShutdown,
      endedAt: this.now(),
      boundary: state.expectedShutdown
        ? 'attempt-interrupted'
        : 'attempt-outcome-unknown',
    };
    this.#rejectPending(
      state.failure
        ? this.#failureError()
        : runtimeError('runtime-ended', 'Codex App Server runtime ended'),
    );
    state.resolveExit(this.status());
  }

  #fail(code, message, cause = null) {
    const state = this.state;
    if (!state || state.failure || state.exit) return;
    state.failure = {
      code,
      message,
      boundary: 'attempt-outcome-unknown',
      recordedAt: this.now(),
      cause: cause?.name ?? null,
    };
    state.lifecycleState = 'failed';
    state.inputAdmission = 'frozen';
    this.#rejectPending(this.#failureError());
    try {
      state.child.kill('SIGTERM');
    } catch {
      // Process failure is already recorded; shutdown errors cannot replace it.
    }
  }

  #rejectPending(error) {
    const state = this.state;
    if (!state) return;
    for (const pending of state.clientRequests.values()) pending.reject(error);
    state.clientRequests.clear();
  }

  #failureError() {
    const failure = this.state?.failure;
    return runtimeError(
      failure?.code ?? 'runtime-unavailable',
      failure?.message ?? 'Codex App Server runtime is unavailable',
    );
  }

  #requireState() {
    if (!this.state) {
      throw runtimeError(
        'runtime-not-started',
        'runtime host has no session attempt',
      );
    }
    return this.state;
  }

  #requireCurrent(action) {
    const state = this.#requireState();
    if (action.sessionAttemptId !== state.sessionAttemptId) {
      throw runtimeError('stale-attempt', 'stale session attempt');
    }
    if (action.runtimeGeneration !== state.runtimeGeneration) {
      throw runtimeError('stale-generation', 'stale runtime generation');
    }
    if (action.processStartIdentity !== state.processStartIdentity) {
      throw runtimeError('stale-process', 'stale provider process identity');
    }
    return state;
  }
}
