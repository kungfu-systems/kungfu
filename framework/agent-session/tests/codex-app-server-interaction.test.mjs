// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexAppServerContractGate } from '../src/codex-app-server-contract.mjs';
import {
  CodexAppServerInteractionAdapter,
  CodexAppServerInteractionError,
} from '../src/codex-app-server-interaction.mjs';

const FENCE = {
  sessionAttemptId: 'attempt-1',
  runtimeGeneration: '7',
  processStartIdentity: '4242:1000:runtime-test',
};

class FakeRuntime {
  constructor() {
    this.requests = [];
    this.responses = [];
  }

  status() {
    return { runtimeIdentity: 'runtime-1', ...FENCE };
  }

  currentFence() {
    return { ...FENCE };
  }

  async request(action) {
    this.requests.push(structuredClone(action));
    return {
      requestId: 41,
      outcome: 'result',
      status: 'observed',
    };
  }

  respond(action) {
    this.responses.push(structuredClone(action));
    return { status: 'written' };
  }
}

function harness() {
  const runtime = new FakeRuntime();
  const adapter = new CodexAppServerInteractionAdapter({ runtime });
  const gate = createCodexAppServerContractGate({ cliVersion: '0.144.3' });
  let sequence = 0;
  return {
    adapter,
    runtime,
    event(direction, message, requestMethod = null) {
      const plan = gate.classify({ direction, message, requestMethod });
      return {
        schema: 'kungfu.codex-app-server.runtime-event/v1',
        sequence: sequence++,
        receivedAt: 1000 + sequence,
        runtimeIdentity: 'runtime-1',
        ...FENCE,
        direction,
        requestId: Object.hasOwn(message, 'id') ? message.id : null,
        providerMethod: plan.providerMethod,
        normalizedSemantic: plan.normalizedSemantic,
        authority: plan.authority,
        retention: 'private-in-memory-bounded',
        message: structuredClone(message),
      };
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CodexAppServerInteractionError);
    assert.equal(error.code, code);
    return true;
  });
}

async function expectAsyncCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof CodexAppServerInteractionError);
    assert.equal(error.code, code);
    return true;
  });
}

function turnStarted(threadId = 'thread-1', turnId = 'turn-1') {
  return {
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, status: 'inProgress', items: [] },
    },
  };
}

test('turn identity comes from turn/started and has one terminal boundary', () => {
  const { adapter, event } = harness();
  const started = adapter.ingest(event('server-notification', turnStarted()));
  assert.equal(started.providerSessionId, 'thread-1');
  assert.equal(started.providerTurnId, 'turn-1');
  assert.equal(started.receiptKind, 'lifecycle');
  assert.equal(started.semanticOutcome, null);
  assert.equal(started.workState, null);
  assert.equal(Object.hasOwn(started, 'message'), false);

  const terminalMessage = {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    },
  };
  const terminal = adapter.ingest(
    event('server-notification', terminalMessage),
  );
  assert.equal(terminal.providerTerminal, 'completed');
  assert.equal(adapter.status().terminalTurns, 1);
  expectCode(
    () => adapter.ingest(event('server-notification', terminalMessage)),
    'duplicate_terminal',
  );
});

test('approval control is exact-targeted and defaults to deny', () => {
  const { adapter, event, runtime } = harness();
  const control = adapter.ingest(
    event('server-request', {
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 1,
      },
    }),
  );
  assert.equal(control.receiptKind, 'control-request');
  assert.equal(control.providerRequestId, 'approval-1');
  assert.equal(control.defaultDecision, 'deny');
  assert.equal(adapter.status().pendingControls, 1);
  expectCode(
    () =>
      adapter.planControlResponse({
        actionId: 'stale',
        requestId: 'approval-1',
        providerSessionId: 'thread-1',
        providerTurnId: 'wrong-turn',
        providerItemId: 'item-1',
      }),
    'stale_control_target',
  );
  const plan = adapter.planControlResponse({
    actionId: 'deny-1',
    requestId: 'approval-1',
    providerSessionId: 'thread-1',
    providerTurnId: 'turn-1',
    providerItemId: 'item-1',
  });
  assert.equal(plan.decision, 'deny');
  assert.deepEqual(plan.response, { result: { decision: 'decline' } });
  const receipt = adapter.executeControlResponse(plan);
  assert.equal(receipt.deliveryStatus, 'written');
  assert.equal(receipt.semanticOutcome, null);
  assert.equal(receipt.workState, null);
  assert.equal(adapter.status().pendingControls, 0);
  assert.equal(runtime.responses[0].requestId, 'approval-1');
  assert.deepEqual(runtime.responses[0].result, { decision: 'decline' });
  expectCode(() => adapter.executeControlResponse(plan), 'stale_control_plan');
});

test('non-approval controls deny by default and require explicit allow results', () => {
  const { adapter, event, runtime } = harness();
  adapter.ingest(
    event('server-request', {
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [],
      },
    }),
  );
  expectCode(
    () =>
      adapter.planControlResponse({
        actionId: 'allow-without-result',
        requestId: 'input-1',
        providerSessionId: 'thread-1',
        providerTurnId: 'turn-1',
        providerItemId: 'item-1',
        decision: 'allow',
      }),
    'explicit_result_required',
  );
  const deny = adapter.planControlResponse({
    actionId: 'deny-input',
    requestId: 'input-1',
    providerSessionId: 'thread-1',
    providerTurnId: 'turn-1',
    providerItemId: 'item-1',
  });
  adapter.executeControlResponse(deny);
  assert.equal(runtime.responses[0].error.code, -32001);
});

test('steer and interrupt plans require the exact active provider turn', async () => {
  const { adapter, event, runtime } = harness();
  expectCode(
    () =>
      adapter.planRequest({
        actionId: 'early-steer',
        operation: 'steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          input: [],
        },
      }),
    'stale_turn',
  );
  adapter.ingest(event('server-notification', turnStarted()));
  const steer = adapter.planRequest({
    actionId: 'steer-1',
    operation: 'steer',
    params: {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'redacted' }],
    },
  });
  const admission = await adapter.executeRequest(steer);
  assert.equal(
    admission.proves,
    'provider-request-written-and-response-observed-only',
  );
  assert.equal(admission.semanticOutcome, null);
  assert.match(admission.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(runtime.requests[0].method, 'turn/steer');
  const interrupt = adapter.planRequest({
    actionId: 'interrupt-1',
    operation: 'interrupt',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  assert.equal(interrupt.providerMethod, 'turn/interrupt');
});

test('usage, error and unknown item types stay typed without raw retention', () => {
  const { adapter, event } = harness();
  const usage = adapter.ingest(
    event('server-notification', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: { total: { totalTokens: 12 } },
      },
    }),
  );
  assert.equal(usage.receiptKind, 'usage');
  assert.deepEqual(usage.usage, { total: { totalTokens: 12 } });
  const error = adapter.ingest(
    event('server-notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        error: { message: 'must-not-retain' },
        willRetry: false,
      },
    }),
  );
  assert.equal(error.receiptKind, 'provider-error');
  assert.equal(error.providerError.messageRetained, false);
  assert.equal(JSON.stringify(error).includes('must-not-retain'), false);
  const responseError = adapter.ingest(
    event(
      'server-response',
      { id: 12, error: { code: -32600, message: 'must-not-retain' } },
      'thread/read',
    ),
  );
  assert.equal(responseError.receiptKind, 'provider-error');
  assert.equal(
    JSON.stringify(responseError).includes('must-not-retain'),
    false,
  );
  const item = adapter.ingest(
    event('server-notification', {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'item-unknown', type: 'futureKnownToSchema' },
      },
    }),
  );
  assert.equal(item.receiptKind, 'item-lifecycle');
  assert.equal(item.providerItemId, 'item-unknown');
  assert.equal(Object.hasOwn(item, 'itemType'), false);
});

test('event gaps, stale processes and plan mutation fail closed', async () => {
  const { adapter, event } = harness();
  const first = event('server-notification', turnStarted());
  expectCode(
    () => adapter.ingest({ ...first, processStartIdentity: 'stale' }),
    'stale_event',
  );
  adapter.ingest(first);
  const skipped = event('server-notification', {
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'idle' } },
  });
  skipped.sequence += 1;
  expectCode(() => adapter.ingest(skipped), 'event_gap');

  const plan = adapter.planRequest({
    actionId: 'read-1',
    operation: 'read',
    params: { threadId: 'thread-1' },
  });
  await expectAsyncCode(
    () => adapter.executeRequest({ ...plan, params: { threadId: 'other' } }),
    'stale_plan',
  );
});

test('CLI and Agent consumers produce the same deterministic plan root', () => {
  const left = harness().adapter.planRequest({
    actionId: 'start-1',
    operation: 'start',
    params: { model: 'redacted-model' },
  });
  const right = harness().adapter.planRequest({
    actionId: 'start-1',
    operation: 'start',
    params: { model: 'redacted-model' },
  });
  assert.equal(left.root, right.root);
});
