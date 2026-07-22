// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

const EVENT_SCHEMA = 'kungfu.codex-app-server.runtime-event/v1';
const PLAN_SCHEMA = 'kungfu.codex-app-server.interaction-plan/v1';
const RECEIPT_SCHEMA = 'kungfu.agent-session.structured-receipt/v1';
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const REQUEST_METHODS = {
  start: 'thread/start',
  read: 'thread/read',
  resume: 'thread/resume',
  instruct: 'turn/start',
  steer: 'turn/steer',
  interrupt: 'turn/interrupt',
};

export class CodexAppServerInteractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexAppServerInteractionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexAppServerInteractionError(code, message);
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_argument', `${label} is required`);
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function root(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function freezeReceipt(body) {
  return Object.freeze({ ...body, receiptRoot: root(body) });
}

function requestKey(id) {
  if (
    !(
      typeof id === 'string' ||
      (Number.isSafeInteger(id) && Number.isFinite(id))
    ) ||
    String(id).length === 0
  ) {
    fail('invalid_request_id', 'provider request id is invalid');
  }
  return `${typeof id}:${String(id)}`;
}

function identities(message) {
  const params = message.params ?? {};
  return {
    providerSessionId:
      params.threadId ??
      params.thread?.id ??
      message.result?.thread?.id ??
      null,
    providerTurnId:
      params.turnId ?? params.turn?.id ?? message.result?.turn?.id ?? null,
    providerItemId: params.itemId ?? params.item?.id ?? params.callId ?? null,
  };
}

function receiptBody(event, kind, details = {}) {
  const body = {
    schema: RECEIPT_SCHEMA,
    receiptKind: kind,
    provider: 'codex',
    providerMethod: event.providerMethod,
    runtimeIdentity: event.runtimeIdentity,
    sessionAttemptId: event.sessionAttemptId,
    runtimeGeneration: event.runtimeGeneration,
    processStartIdentity: event.processStartIdentity,
    providerReceiveSequence: event.sequence,
    providerRequestId:
      event.requestId ?? event.message.params?.requestId ?? null,
    recordedAt: event.receivedAt,
    evidencePointer: {
      kind: 'runtime-event',
      runtimeIdentity: event.runtimeIdentity,
      sequence: event.sequence,
    },
    authority: event.authority,
    ...identities(event.message),
    ...details,
    semanticOutcome: null,
    workState: null,
    proof: null,
  };
  return freezeReceipt(body);
}

function eventKind(event) {
  if (event.normalizedSemantic === 'typed-provider-error')
    return 'provider-error';
  if (event.direction === 'server-response') return 'delivery';
  if (event.direction === 'server-request') return 'control-request';
  if (event.normalizedSemantic === 'usage-updated') return 'usage';
  if (/^item-/u.test(event.normalizedSemantic)) return 'item-lifecycle';
  if (/delta|presentation/u.test(event.normalizedSemantic))
    return 'presentation';
  if (/tool-/u.test(event.normalizedSemantic)) return 'tool-control';
  if (event.normalizedSemantic === 'control-request-resolved')
    return 'control-resolution';
  return 'lifecycle';
}

export class CodexAppServerInteractionAdapter {
  constructor({ runtime }) {
    if (
      !runtime ||
      typeof runtime.status !== 'function' ||
      typeof runtime.currentFence !== 'function' ||
      typeof runtime.request !== 'function' ||
      typeof runtime.respond !== 'function'
    ) {
      fail('invalid_runtime', 'structured interaction requires a runtime host');
    }
    const status = runtime.status();
    this.runtime = runtime;
    this.runtimeIdentity = required(status.runtimeIdentity, 'runtimeIdentity');
    this.fence = Object.freeze({ ...runtime.currentFence() });
    this.nextSequence = 0;
    this.threads = new Set();
    this.turns = new Map();
    this.terminalTurns = new Set();
    this.pendingControls = new Map();
  }

  status() {
    return freezeReceipt({
      schema: 'kungfu.codex-app-server.interaction-status/v1',
      provider: 'codex',
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      providerSessions: this.threads.size,
      activeTurns: [...this.turns.values()].filter(
        (turn) => turn.state === 'active',
      ).length,
      terminalTurns: this.terminalTurns.size,
      pendingControls: this.pendingControls.size,
      structuredAuthority: true,
      ptyHotSwitch: false,
      semanticOutcome: null,
      workState: null,
    });
  }

  ingest(event) {
    this.#verifyEvent(event);
    const ids = identities(event.message);
    const turnKey =
      ids.providerSessionId && ids.providerTurnId
        ? `${ids.providerSessionId}\0${ids.providerTurnId}`
        : null;
    const details = {
      normalizedSemantic: event.normalizedSemantic,
      providerTerminal: null,
      retry: null,
      usage: null,
      defaultDecision: null,
    };

    if (event.providerMethod === 'thread/started' && ids.providerSessionId) {
      this.threads.add(ids.providerSessionId);
    }
    if (event.providerMethod === 'turn/started') {
      if (!turnKey)
        fail('missing_identity', 'turn/started has no exact identity');
      if (this.terminalTurns.has(turnKey))
        fail('terminal_turn_reopened', 'terminal provider turn cannot restart');
      this.threads.add(ids.providerSessionId);
      this.turns.set(turnKey, { ...ids, state: 'active' });
    }
    if (event.providerMethod === 'turn/completed') {
      if (!turnKey)
        fail('missing_identity', 'turn/completed has no exact identity');
      if (this.terminalTurns.has(turnKey))
        fail(
          'duplicate_terminal',
          'provider turn has more than one terminal boundary',
        );
      this.terminalTurns.add(turnKey);
      this.turns.set(turnKey, { ...ids, state: 'terminal' });
      details.providerTerminal = event.message.params.turn.status;
    }
    if (event.providerMethod === 'thread/tokenUsage/updated') {
      details.usage = structuredClone(event.message.params.tokenUsage);
    }
    if (event.providerMethod === 'error') {
      details.retry = event.message.params.willRetry === true;
      details.providerError = {
        code: event.message.params.error?.code ?? null,
        messageRetained: false,
      };
    }
    if (event.direction === 'server-request') {
      const key = requestKey(event.message.id);
      if (this.pendingControls.has(key))
        fail(
          'duplicate_control',
          'provider control request is already pending',
        );
      this.pendingControls.set(key, {
        requestId: event.message.id,
        providerMethod: event.providerMethod,
        ...ids,
        evidenceSequence: event.sequence,
      });
      details.defaultDecision = 'deny';
    }
    if (event.providerMethod === 'serverRequest/resolved') {
      this.pendingControls.delete(requestKey(event.message.params.requestId));
    }

    const receipt = receiptBody(event, eventKind(event), details);
    this.nextSequence += 1;
    return receipt;
  }

  planRequest(action) {
    required(action.actionId, 'actionId');
    const providerMethod = REQUEST_METHODS[action.operation];
    if (!providerMethod) fail('invalid_operation', 'unsupported operation');
    const params = structuredClone(action.params ?? {});
    if (
      ['read', 'resume', 'instruct', 'steer', 'interrupt'].includes(
        action.operation,
      )
    ) {
      required(params.threadId, 'threadId');
    }
    if (action.operation === 'steer') {
      required(params.expectedTurnId, 'expectedTurnId');
      this.#requireActiveTurn(params.threadId, params.expectedTurnId);
    }
    if (action.operation === 'interrupt') {
      required(params.turnId, 'turnId');
      this.#requireActiveTurn(params.threadId, params.turnId);
    }
    const body = {
      schema: PLAN_SCHEMA,
      planKind: 'provider-request',
      actionId: action.actionId,
      operation: action.operation,
      providerMethod,
      params,
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      effects: ['write-one-correlated-provider-request'],
      proves: 'provider-request-written-and-response-observed-only',
      semanticOutcome: null,
      workState: null,
    };
    return Object.freeze({ ...body, root: root(body) });
  }

  async executeRequest(plan) {
    this.#verifyPlan(plan, 'provider-request');
    const response = await this.runtime.request({
      ...this.fence,
      actionId: plan.actionId,
      method: plan.providerMethod,
      params: structuredClone(plan.params),
    });
    return freezeReceipt({
      schema: RECEIPT_SCHEMA,
      receiptKind: 'request-admission',
      actionId: plan.actionId,
      operation: plan.operation,
      providerMethod: plan.providerMethod,
      requestId: response.requestId,
      responseOutcome: response.outcome,
      planRoot: plan.root,
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      status: response.status,
      proves: 'provider-request-written-and-response-observed-only',
      semanticOutcome: null,
      workState: null,
      proof: null,
    });
  }

  planControlResponse(action) {
    required(action.actionId, 'actionId');
    const key = requestKey(action.requestId);
    const pending = this.pendingControls.get(key);
    if (!pending) fail('unknown_control', 'control request is not pending');
    for (const field of [
      'providerSessionId',
      'providerTurnId',
      'providerItemId',
    ]) {
      if ((action[field] ?? null) !== (pending[field] ?? null)) {
        fail('stale_control_target', `control ${field} does not match`);
      }
    }
    const decision = action.decision ?? 'deny';
    if (!['allow', 'deny'].includes(decision))
      fail('invalid_decision', 'control decision must be allow or deny');
    let response;
    if (APPROVAL_METHODS.has(pending.providerMethod)) {
      response = {
        result: { decision: decision === 'allow' ? 'accept' : 'decline' },
      };
    } else if (decision === 'allow') {
      if (!hasOwn(action, 'result'))
        fail(
          'explicit_result_required',
          'non-approval allow requires a result',
        );
      response = { result: structuredClone(action.result) };
    } else {
      response = {
        error: {
          code: -32001,
          message: 'Denied by Kungfu default control policy',
        },
      };
    }
    const body = {
      schema: PLAN_SCHEMA,
      planKind: 'control-response',
      actionId: action.actionId,
      decision,
      requestId: pending.requestId,
      providerMethod: pending.providerMethod,
      providerSessionId: pending.providerSessionId,
      providerTurnId: pending.providerTurnId,
      providerItemId: pending.providerItemId,
      evidenceSequence: pending.evidenceSequence,
      response,
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      semanticOutcome: null,
      workState: null,
    };
    return Object.freeze({ ...body, root: root(body) });
  }

  executeControlResponse(plan) {
    this.#verifyPlan(plan, 'control-response');
    const key = requestKey(plan.requestId);
    const pending = this.pendingControls.get(key);
    if (!pending || pending.evidenceSequence !== plan.evidenceSequence)
      fail('stale_control_plan', 'control request changed after planning');
    const wire = hasOwn(plan.response, 'result')
      ? { result: structuredClone(plan.response.result) }
      : { error: structuredClone(plan.response.error) };
    const delivery = this.runtime.respond({
      ...this.fence,
      actionId: plan.actionId,
      requestId: plan.requestId,
      ...wire,
    });
    this.pendingControls.delete(key);
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      receiptKind: 'control-admission',
      actionId: plan.actionId,
      decision: plan.decision,
      requestId: plan.requestId,
      providerMethod: plan.providerMethod,
      providerSessionId: plan.providerSessionId,
      providerTurnId: plan.providerTurnId,
      providerItemId: plan.providerItemId,
      planRoot: plan.root,
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      deliveryStatus: delivery.status,
      proves: 'provider-control-response-written-only',
      semanticOutcome: null,
      workState: null,
      proof: null,
    });
  }

  #verifyEvent(event) {
    if (!event || event.schema !== EVENT_SCHEMA)
      fail('invalid_event', 'runtime event schema is unsupported');
    if (event.runtimeIdentity !== this.runtimeIdentity)
      fail('stale_runtime', 'runtime identity does not match');
    for (const field of [
      'sessionAttemptId',
      'runtimeGeneration',
      'processStartIdentity',
    ]) {
      if (event[field] !== this.fence[field])
        fail('stale_event', `event ${field} does not match`);
    }
    if (event.sequence !== this.nextSequence)
      fail('event_gap', 'runtime event sequence is not contiguous');
  }

  #verifyPlan(plan, kind) {
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.planKind !== kind)
      fail('invalid_plan', 'interaction plan is invalid');
    const { root: claimedRoot, ...body } = plan;
    if (claimedRoot !== root(body)) fail('stale_plan', 'plan root changed');
    if (plan.runtimeIdentity !== this.runtimeIdentity)
      fail('stale_runtime', 'plan runtime identity does not match');
    for (const field of [
      'sessionAttemptId',
      'runtimeGeneration',
      'processStartIdentity',
    ]) {
      if (plan[field] !== this.fence[field])
        fail('stale_plan', `plan ${field} does not match`);
    }
  }

  #requireActiveTurn(threadId, turnId) {
    const turn = this.turns.get(`${threadId}\0${turnId}`);
    if (!turn || turn.state !== 'active')
      fail('stale_turn', 'provider turn is not active');
  }
}
