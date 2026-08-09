import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AssignmentRuntimeHostReady,
  type AssignmentRuntimeRequest,
  type AssignmentRuntimeResponse,
  openAssignmentRuntime,
} from '../src/capability/runtime.ts';

const ROOT = `sha256:${'a'.repeat(64)}`;
const REALM = {
  realmId: 'project:test',
  realmKind: 'local' as const,
  generation: ROOT,
};
const CURSOR = {
  streamId: 'assignment-events',
  generation: ROOT,
  sequence: '0',
  eventRoot: ROOT,
};
const READY: AssignmentRuntimeHostReady = {
  schema: 'kungfu.gui.assignment-runtime-host/v1',
  status: 'ready',
  protocol: 'kungfu.assignment-runtime/v1',
  profile: { id: 'kungfu.assignment-runtime.local', version: '1' },
  realm: REALM,
  genesisCursor: CURSOR,
  error: null,
};

function response(
  request: AssignmentRuntimeRequest,
): AssignmentRuntimeResponse {
  return {
    schema: 'kungfu.assignment-runtime.response/v1',
    requestId: request.requestId,
    realm: request.realm,
    revision: { value: 'revision-a', root: ROOT, parentRoot: null },
    capabilities: {
      supported: request.client.requestedCapabilities,
      selected: request.client.requestedCapabilities,
      unsupported: [],
    },
    status: 'ok',
    result: {},
    attempt: null,
    lease: null,
    warrant: null,
    factRefs: [],
    episodeRefs: [],
    receipts: [],
    diagnostics: [],
    cursor: request.cursor ?? null,
    error: null,
  };
}

test('GUI Runtime client maps every R1 operation to the versioned envelope', async () => {
  const requests: AssignmentRuntimeRequest[] = [];
  const runtime = openAssignmentRuntime({
    transport: {
      connect: async () => READY,
      invoke: async (request) => {
        requests.push(request);
        return response(request);
      },
    },
  });

  await runtime.discover();
  await runtime.snapshot();
  await runtime.list({ phase: 'executing' });
  await runtime.get('initiative-a', 'assignment-a');
  await runtime.query({ text: 'assignment-a' });
  await runtime.watch();
  await runtime.submit({
    schema: 'kungfu.assignment-runtime.command/v1',
    commandId: 'command-a',
    type: 'assignment.stage',
    target: { initiativeId: 'initiative-a', assignmentId: 'assignment-a' },
    expectedRevision: { value: 'revision-a', root: ROOT, parentRoot: null },
    idempotencyKey: 'idempotency-a',
  });
  await runtime.inspectCommand({ commandId: 'command-a' });
  await runtime.diagnostics();
  await runtime.recoveryPlan();
  await runtime.recoveryExecute({
    expectedRevision: { value: 'revision-a', root: ROOT, parentRoot: null },
    idempotencyKey: 'idempotency-a',
  });

  assert.deepEqual(
    requests.map((request) => request.operation),
    [
      'capabilities.discover',
      'assignment.snapshot',
      'assignment.list',
      'assignment.get',
      'assignment.query',
      'events.watch',
      'command.submit',
      'command.get',
      'diagnostics.get',
      'recovery.plan',
      'recovery.execute',
    ],
  );
  assert.deepEqual(requests[5]?.cursor, CURSOR);
  assert.equal(requests[6]?.payload.idempotencyKey, 'idempotency-a');
});

test('GUI Runtime reconnect replays the exact request after a lost response', async () => {
  let connects = 0;
  let attempts = 0;
  const requests: AssignmentRuntimeRequest[] = [];
  const runtime = openAssignmentRuntime({
    transport: {
      connect: async () => {
        connects += 1;
        return READY;
      },
      invoke: async (request) => {
        requests.push(structuredClone(request));
        attempts += 1;
        if (attempts === 1)
          throw new Error('transport lost after durable write');
        return response(request);
      },
    },
  });

  const result = await runtime.submit({
    schema: 'kungfu.assignment-runtime.command/v1',
    commandId: 'command-reconnect',
    type: 'assignment.create',
    target: { initiativeId: 'initiative-a', assignmentId: 'assignment-a' },
    expectedRevision: { value: 'revision-a', root: ROOT, parentRoot: null },
    idempotencyKey: 'idempotency-reconnect',
  });

  assert.equal(result.status, 'ok');
  assert.equal(connects, 2);
  assert.deepEqual(requests[1], requests[0]);
});

test('GUI Runtime preserves generation fences across reconnect and watch resume', async () => {
  const nextRoot = `sha256:${'b'.repeat(64)}`;
  const nextReady: AssignmentRuntimeHostReady = {
    ...READY,
    realm: { ...REALM, generation: nextRoot },
    genesisCursor: { ...CURSOR, generation: nextRoot, eventRoot: nextRoot },
  };
  let connects = 0;
  let attempts = 0;
  const requests: AssignmentRuntimeRequest[] = [];
  const runtime = openAssignmentRuntime({
    transport: {
      connect: async () => (++connects === 1 ? READY : nextReady),
      invoke: async (request) => {
        requests.push(structuredClone(request));
        attempts += 1;
        if (attempts === 1) throw new Error('connection replaced');
        if (attempts === 2) {
          return {
            ...response(request),
            realm: nextReady.realm,
            status: 'error',
            result: null,
            error: {
              code: 'generation-fenced',
              message: 'Request belongs to a stale realm generation',
              retryable: true,
              details: {},
            },
          };
        }
        if (
          request.cursor &&
          request.cursor.generation !== request.realm.generation
        ) {
          return {
            ...response(request),
            status: 'error',
            result: null,
            error: {
              code: 'generation-fenced',
              message: 'Event cursor belongs to a stale generation',
              retryable: true,
              details: {},
            },
          };
        }
        return response(request);
      },
    },
  });

  const fenced = await runtime.snapshot();
  await runtime.watch();
  const reconnected = await runtime.connect();
  await runtime.watch(reconnected.genesisCursor);

  assert.equal(fenced.error?.code, 'generation-fenced');
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1]?.realm.generation, ROOT);
  assert.equal(requests[2]?.realm.generation, nextRoot);
  assert.equal(requests[2]?.cursor?.generation, ROOT);
  assert.equal(requests[3]?.realm.generation, nextRoot);
  assert.equal(requests[3]?.cursor?.generation, nextRoot);
});

test('GUI Runtime rejects a successful response from another realm', async () => {
  const runtime = openAssignmentRuntime({
    transport: {
      connect: async () => READY,
      invoke: async (request) => ({
        ...response(request),
        realm: { ...REALM, realmId: 'project:other' },
      }),
    },
  });

  await assert.rejects(runtime.snapshot(), /mismatched realm/);
});
