import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type {
  AssignmentRuntimeRequest,
  AssignmentRuntimeResponse,
} from '@kungfu-tech/api/capability';

import { createAssignmentRuntimeHost } from './runtime-recovery.ts';

const ROOT = `sha256:${'a'.repeat(64)}`;
const READY = {
  schema: 'kungfu.gui.assignment-runtime-host/v1',
  status: 'ready',
  protocol: 'kungfu.assignment-runtime/v1',
  profile: { id: 'kungfu.assignment-runtime.local', version: '1' },
  realm: { realmId: 'project:test', realmKind: 'local', generation: ROOT },
  genesisCursor: {
    streamId: 'assignment-events',
    generation: ROOT,
    sequence: '0',
    eventRoot: ROOT,
  },
  error: null,
} as const;

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function response(
  request: AssignmentRuntimeRequest,
): AssignmentRuntimeResponse {
  return {
    schema: 'kungfu.assignment-runtime.response/v1',
    requestId: request.requestId,
    realm: READY.realm,
    revision: { value: 'revision-a', root: ROOT, parentRoot: null },
    capabilities: { supported: [], selected: [], unsupported: [] },
    status: 'ok',
    result: {},
    attempt: null,
    lease: null,
    warrant: null,
    factRefs: [],
    episodeRefs: [],
    receipts: [],
    diagnostics: [],
    cursor: null,
    error: null,
  };
}

test('main host becomes ready only after the Python writer handshake', async () => {
  const child = childProcess();
  const launches: string[][] = [];
  const host = createAssignmentRuntimeHost({
    bin: '/product/kungfu',
    env: {},
    workspaceRoot: '/workspace',
    spawn: (_file, args) => {
      launches.push(args);
      return child as never;
    },
  });
  let settled = false;
  const connecting = host.connect().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.write(`${JSON.stringify(READY)}\n`);
  assert.equal((await connecting).status, 'ready');
  assert.deepEqual(launches[0], [
    'work',
    'runtime-host',
    '--workspace',
    '/workspace',
  ]);

  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk)) as AssignmentRuntimeRequest;
    child.stdout.write(`${JSON.stringify(response(request))}\n`);
  });
  const request: AssignmentRuntimeRequest = {
    schema: 'kungfu.assignment-runtime.request/v1',
    requestId: 'gui.work-dashboard:1',
    realm: READY.realm,
    operation: 'assignment.snapshot',
    client: {
      clientId: 'gui.work-dashboard',
      kind: 'gui',
      requestedCapabilities: ['assignment.snapshot.read'],
    },
    payload: {},
  };
  assert.equal((await host.invoke(request)).requestId, request.requestId);
  host.dispose();
});

test('main host fails closed when the writer cannot bind', async () => {
  const child = childProcess();
  const host = createAssignmentRuntimeHost({
    bin: '/product/kungfu',
    env: {},
    spawn: () => child as never,
  });
  const connecting = host.connect();
  child.stdout.write(
    `${JSON.stringify({
      ...READY,
      status: 'error',
      realm: null,
      genesisCursor: null,
      error: {
        code: 'ambiguous-identity',
        message: 'writer already active',
        retryable: false,
        details: {},
      },
    })}\n`,
  );
  await assert.rejects(connecting, (error: Error & { code?: string }) => {
    assert.equal(error.code, 'ambiguous-identity');
    return true;
  });
  host.dispose();
});

test('main host fails closed when writer readiness never arrives', async () => {
  const child = childProcess();
  let killedWith: string | undefined;
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };
  const host = createAssignmentRuntimeHost({
    bin: '/product/kungfu',
    env: {},
    handshakeTimeoutMs: 1,
    spawn: () => child as never,
  });

  await assert.rejects(host.connect(), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'assignment-runtime-host-startup-timeout');
    return true;
  });
  assert.equal(killedWith, 'SIGTERM');
  host.dispose();
});

test('main host fails closed on malformed writer output', async () => {
  const child = childProcess();
  let killedWith: string | undefined;
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };
  const host = createAssignmentRuntimeHost({
    bin: '/product/kungfu',
    env: {},
    spawn: () => child as never,
  });

  const connecting = host.connect();
  child.stdout.write('not-json\n');
  await assert.rejects(connecting, /emitted invalid JSON/);
  assert.equal(killedWith, 'SIGTERM');
  host.dispose();
});
