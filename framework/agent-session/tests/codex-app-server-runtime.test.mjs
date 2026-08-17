// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerRuntimeError,
  CodexAppServerRuntimeHost,
} from '../src/codex-app-server-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const provider = path.join(
  here,
  'fixtures',
  'codex-app-server-runtime-provider.mjs',
);

function createHost(overrides = {}) {
  return new CodexAppServerRuntimeHost({
    runtimeIdentity: 'runtime-test-1',
    initializeTimeoutMs: 2_000,
    ...overrides,
  });
}

function stdoutEndingChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let pending = '';
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString();
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      const message = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (message.method === 'initialize') {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { userAgent: 'synthetic-redacted' } })}\n`,
        );
      } else if (message.method === 'initialized') {
        child.stdout.end();
      }
    }
  });
  child.kill = (signal) => {
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function start(mode, overrides = {}) {
  const host = createHost(overrides);
  await host.start({
    sessionAttemptId: 'attempt-1',
    runtimeGeneration: '7',
    executable: process.execPath,
    argv: [provider, mode],
    cliVersion: '0.146.0',
    initializeParams: {
      clientInfo: { name: 'kungfu-test', version: '4.0.0-alpha.1' },
    },
  });
  return host;
}

async function waitUntil(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function stop(host, actionId = 'shutdown-test') {
  if (!host.status().exit) {
    host.shutdown({ ...host.currentFence(), actionId });
    const waitForExit = host.waitForExit();
    const exited = await Promise.race([
      waitForExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (exited) return;
    if (process.platform !== 'win32')
      throw new Error('test-owned Codex App Server did not exit after SIGTERM');
    const pid = host.status().pid;
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(pid), '/t', '/f'],
      { encoding: 'utf8', windowsHide: true },
    );
    const terminated = await Promise.race([
      waitForExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!terminated) {
      const diagnostic = [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(
        `test-owned Codex App Server process tree ${pid} did not exit: ${diagnostic || 'no termination diagnostic'}`,
      );
    }
  }
}

function expectRuntimeCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CodexAppServerRuntimeError);
    assert.equal(error.code, code);
    return true;
  });
}

test('continuous reader exposes turn identity before a late turn/start response', async (t) => {
  const host = await start('late-turn-response');
  t.after(() => stop(host));
  const response = await host.request({
    ...host.currentFence(),
    actionId: 'turn-start-1',
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'redacted synthetic input' }],
    },
  });
  const events = host.takeEvents();
  const started = events.findIndex(
    (event) => event.normalizedSemantic === 'turn-started',
  );
  const completed = events.findIndex(
    (event) => event.normalizedSemantic === 'turn-terminal',
  );
  const correlated = events.findIndex(
    (event) =>
      event.direction === 'server-response' &&
      event.requestId === response.requestId,
  );
  assert.ok(started >= 0);
  assert.ok(completed > started);
  assert.ok(correlated > completed);
  assert.equal(events[started].message.params.turn.id, 'turn-authority');
  assert.deepEqual(
    {
      sessionAttemptId: events[started].sessionAttemptId,
      runtimeGeneration: events[started].runtimeGeneration,
      processStartIdentity: events[started].processStartIdentity,
    },
    host.currentFence(),
  );
  assert.equal(response.providerMethod, 'turn/start');
  assert.equal(response.status, 'observed');
});

test('Windows command wrappers use an explicit shell without version coupling', async (t) => {
  const child = stdoutEndingChild();
  let invocation = null;
  const host = createHost({
    platform: 'win32',
    spawn: (executable, argv, options) => {
      invocation = { executable, argv, options };
      return child;
    },
  });
  await host.start({
    sessionAttemptId: 'attempt-wrapper',
    runtimeGeneration: '8',
    executable: '/agent/bin/codex.CMD',
    argv: ['app-server', '--stdio'],
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    cliVersion: 'opaque-future-build',
    initializeParams: {
      clientInfo: { name: 'kungfu-test', version: '4.0.0-alpha.1' },
    },
  });
  t.after(() => stop(host));
  assert.equal(invocation.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.argv, [
    '/d',
    '/s',
    '/v:off',
    '/c',
    'call "/agent/bin/codex.CMD" "app-server" "--stdio"',
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
});

test('unknown provider notifications remain diagnostic and keep admission open', async (t) => {
  const host = await start('unknown-method');
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().queue.depth >= 2,
    'unknown provider notification was not retained as a diagnostic event',
  );
  const event = host
    .takeEvents()
    .find((candidate) => candidate.providerMethod === 'provider/unknown');
  assert.equal(event.providerMethod, 'provider/unknown');
  assert.equal(event.normalizedSemantic, 'provider-notification-unclassified');
  assert.equal(event.authority, 'provider-diagnostic-not-work-fact');
  assert.equal(host.status().failure, null);
  assert.equal(host.status().inputAdmission, 'open');
});

test('malformed frames and unknown requests fail closed and freeze admission', async (t) => {
  for (const [mode, code] of [
    ['malformed', 'malformed-jsonl'],
    ['unknown-request', 'unknown-method'],
  ]) {
    const host = await start(mode);
    t.after(() => stop(host, `shutdown-${mode}`));
    await waitUntil(
      () => host.status().failure !== null,
      `${mode} did not fail visibly`,
    );
    assert.equal(host.status().failure.code, code);
    assert.notEqual(host.status().inputAdmission, 'open');
    expectRuntimeCode(
      () =>
        host.request({
          ...host.currentFence(),
          actionId: `late-${mode}`,
          method: 'thread/read',
          params: { threadId: 'thread-1' },
        }),
      'input-admission-closed',
    );
  }
});

test('bounded queue freezes before the hard bound and reports overflow without growth', async (t) => {
  const host = await start('burst', {
    maxQueueEvents: 5,
    admissionStopThreshold: 3,
  });
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().failure?.code === 'consumer-queue-hard-bound',
    'burst did not reach the hard bound',
  );
  const status = host.status();
  assert.equal(status.queue.depth, 5);
  assert.equal(status.queue.maxEvents, 5);
  assert.equal(status.failure.code, 'consumer-queue-hard-bound');
  assert.equal(status.failure.boundary, 'attempt-outcome-unknown');
  assert.notEqual(status.inputAdmission, 'open');
});

test('thread and turn identities remain isolated across concurrent notifications', async (t) => {
  const host = await start('multi-identity');
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().queue.depth >= 3,
    'identity notifications were not drained',
  );
  const identities = host
    .takeEvents()
    .filter((event) => event.normalizedSemantic === 'turn-started')
    .map((event) => [
      event.message.params.threadId,
      event.message.params.turn.id,
    ]);
  assert.deepEqual(identities, [
    ['thread-a', 'turn-a'],
    ['thread-b', 'turn-b'],
  ]);
});

test('server requests correlate exactly and stale writers are rejected', async (t) => {
  const host = await start('server-request');
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().correlation.outstandingServerRequests === 1,
    'server request was not correlated',
  );
  const fence = host.currentFence();
  expectRuntimeCode(
    () =>
      host.respond({
        ...fence,
        runtimeGeneration: '6',
        actionId: 'stale-response',
        requestId: 'approval-1',
        result: { decision: 'decline' },
      }),
    'stale-generation',
  );
  const receipt = host.respond({
    ...fence,
    actionId: 'deny-response',
    requestId: 'approval-1',
    result: { decision: 'decline' },
  });
  assert.equal(receipt.status, 'written');
  assert.equal(host.status().correlation.outstandingServerRequests, 0);
  expectRuntimeCode(
    () =>
      host.respond({
        ...fence,
        actionId: 'duplicate-response',
        requestId: 'approval-1',
        result: { decision: 'decline' },
      }),
    'unknown-server-request',
  );
  expectRuntimeCode(
    () =>
      host.request({
        ...fence,
        processStartIdentity: 'stale-process',
        actionId: 'stale-request',
        method: 'thread/read',
        params: { threadId: 'thread-1' },
      }),
    'stale-process',
  );
});

test('slow or failing consumers cannot block stdout draining', async (t) => {
  const host = createHost();
  host.subscribe(() => {
    throw new Error('synthetic consumer failure');
  });
  await host.start({
    sessionAttemptId: 'attempt-1',
    runtimeGeneration: '7',
    executable: process.execPath,
    argv: [provider, 'multi-identity'],
    cliVersion: '0.146.0',
    initializeParams: {
      clientInfo: { name: 'kungfu-test', version: '4.0.0-alpha.1' },
    },
  });
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().consumerFailures >= 3,
    'consumer failure was not isolated',
  );
  assert.ok(host.status().queue.depth >= 3);
  assert.equal(host.status().lifecycleState, 'ready');
});

test('stderr content is never retained or surfaced', async (t) => {
  const host = await start('stderr-redaction');
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().stderr.observedBytes > 0,
    'stderr bytes were not observed',
  );
  const visible = JSON.stringify({
    status: host.status(),
    events: host.takeEvents(),
  });
  assert.equal(
    visible.includes('synthetic-secret-must-not-be-retained'),
    false,
  );
  assert.equal(host.status().stderr.retainedContent, false);
});

test('stdout pipe loss terminates the provider with an unknown attempt boundary', async (t) => {
  const child = stdoutEndingChild();
  const host = await start('stdout-end', { spawn: () => child });
  t.after(() => stop(host));
  await waitUntil(
    () => host.status().failure?.code === 'stdout-ended',
    'stdout loss did not fail visibly',
  );
  host.shutdown({ ...host.currentFence(), actionId: 'repeat-termination' });
  const status = await host.waitForExit();
  assert.equal(status.failure.code, 'stdout-ended');
  assert.equal(status.failure.boundary, 'attempt-outcome-unknown');
  assert.equal(status.exit.expected, false);
  assert.equal(status.exit.boundary, 'attempt-outcome-unknown');
});

test('unexpected provider exit is visible and never claims a terminal outcome', async () => {
  const host = await start('unexpected-exit');
  const status = await host.waitForExit();
  assert.equal(status.lifecycleState, 'failed');
  assert.equal(status.exit.code, 23);
  assert.equal(status.exit.expected, false);
  assert.equal(status.exit.boundary, 'attempt-outcome-unknown');
  assert.equal(status.failure.boundary, 'attempt-outcome-unknown');
  assert.notEqual(status.inputAdmission, 'open');
});

test('runtime version metadata never blocks a valid structured handshake', async (t) => {
  const host = createHost();
  t.after(() => stop(host));
  const status = await host.start({
    sessionAttemptId: 'attempt-version-neutral',
    runtimeGeneration: '1',
    executable: process.execPath,
    argv: [provider, 'stderr-redaction'],
    cliVersion: 'future-channel-without-semver',
    initializeParams: {
      clientInfo: { name: 'kungfu-test', version: '4.0.0-alpha.1' },
    },
  });
  assert.equal(status.provider.cliVersion, 'future-channel-without-semver');
  assert.equal(status.lifecycleState, 'ready');
});
