// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

const LEDGER_SCHEMA = 'kungfu.codex-app-server.recovery-receipt/v1';
const FALLBACK_SCHEMA = 'kungfu.codex-app-server.fallback-plan/v1';
const FRAME_CLASS = 'provider-private-control';
const MUTATING_OPERATIONS = new Set([
  'start',
  'resume',
  'instruct',
  'steer',
  'interrupt',
  'control',
]);

export class CodexAppServerRecoveryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CodexAppServerRecoveryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CodexAppServerRecoveryError(code, message, details);
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_argument', `${label} is required`);
  }
  return value;
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

function requireRuntime(runtime) {
  for (const method of ['status', 'currentFence']) {
    if (typeof runtime?.[method] !== 'function') {
      fail('invalid_runtime', `recovery guard requires runtime.${method}()`);
    }
  }
  return runtime;
}

function requireInteraction(interaction) {
  for (const method of [
    'status',
    'ingest',
    'executeRequest',
    'executeControlResponse',
  ]) {
    if (typeof interaction?.[method] !== 'function') {
      fail(
        'invalid_interaction',
        `recovery guard requires interaction.${method}()`,
      );
    }
  }
  return interaction;
}

function requireLedger(ledger) {
  for (const method of ['append', 'read']) {
    if (typeof ledger?.[method] !== 'function') {
      fail('invalid_ledger', `recovery guard requires ledger.${method}()`);
    }
  }
  return ledger;
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

function safeInteractionReceipt(receipt) {
  return {
    interactionReceiptRoot: receipt.receiptRoot,
    receiptKind: receipt.receiptKind,
    providerMethod: receipt.providerMethod,
    providerReceiveSequence: receipt.providerReceiveSequence,
    providerRequestId: receipt.providerRequestId,
    providerSessionId: receipt.providerSessionId,
    providerTurnId: receipt.providerTurnId,
    providerItemId: receipt.providerItemId,
    providerTerminal: receipt.providerTerminal,
    defaultDecision: receipt.defaultDecision,
  };
}

export class CodexAppServerRecoveryGuard {
  constructor({ runtime, interaction, ledger, now = () => Date.now() }) {
    this.runtime = requireRuntime(runtime);
    this.interaction = requireInteraction(interaction);
    this.ledger = requireLedger(ledger);
    this.now = now;
    const status = this.runtime.status();
    this.runtimeIdentity = required(status.runtimeIdentity, 'runtimeIdentity');
    this.fence = Object.freeze({ ...this.runtime.currentFence() });
    this.inputs = new Map();
    this.sideEffects = new Map();
    this.pendingControls = new Map();
    this.providerTerminalReceipts = 0;
    this.boundariesByRoot = new Map();
    this.boundary = null;
    this.ledgerFailure = null;
    this.#rehydrate();
    this.boundaryPromise =
      typeof this.runtime.waitForExit === 'function'
        ? this.runtime
            .waitForExit()
            .then((exitStatus) => this.reconcileRuntimeExit(exitStatus))
            .catch((error) => {
              this.ledgerFailure = {
                reason: 'runtime-exit-observation-failed',
                errorCode: error?.code ?? null,
              };
              return null;
            })
        : null;
  }

  status() {
    const runtime = this.runtime.status();
    const inputAdmission =
      this.ledgerFailure || this.boundary || runtime.inputAdmission !== 'open'
        ? 'closed'
        : 'open';
    return Object.freeze({
      schema: 'kungfu.codex-app-server.recovery-status/v1',
      provider: 'codex',
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      state: this.boundary?.boundary ?? 'active',
      inputAdmission,
      durableLedger: this.ledgerFailure ? 'incomplete' : 'current',
      ledgerFailure: this.ledgerFailure
        ? structuredClone(this.ledgerFailure)
        : null,
      admissions: {
        total: this.inputs.size,
        unresolved: [...this.inputs.values()].filter(
          (entry) => entry.state === 'opened' || entry.state === 'unknown',
        ).length,
      },
      pendingControls: this.pendingControls.size,
      providerTerminalReceipts: this.providerTerminalReceipts,
      hotSwitch: false,
      semanticOutcome: null,
      workState: null,
    });
  }

  recordEvent(event) {
    this.#requireLedgerCurrent();
    const receipt = this.interaction.ingest(event);
    const stored = this.#append('interaction-receipt', {
      ...safeInteractionReceipt(receipt),
      retention: 'provider-private-durable-metadata',
    });
    this.#apply(stored);
    return receipt;
  }

  async executeRequest({ inputId, sideEffectId = null, plan, recoveryFrom }) {
    const operation = required(plan?.operation, 'plan.operation');
    const duplicate = this.#lookupInput(inputId, sideEffectId, plan);
    if (duplicate) return duplicate;
    this.#requireAdmission();
    this.#requireRecovery(operation, recoveryFrom);
    const opened = this.#openInput({
      inputId,
      sideEffectId,
      plan,
      operation,
      providerRequestId: null,
      recoveryFrom,
    });
    if (opened.duplicate) return opened.receipt;
    try {
      const delivery = await this.interaction.executeRequest(plan);
      const completed = this.#append('input-completed', {
        inputId,
        sideEffectId,
        openedReceiptRoot: opened.receipt.receiptRoot,
        planRoot: plan.root,
        actionId: plan.actionId,
        operation,
        providerMethod: plan.providerMethod,
        providerRequestId: delivery.requestId,
        deliveryStatus: delivery.status,
        responseOutcome: delivery.responseOutcome,
        proves: delivery.proves,
        recoveryMode:
          operation === 'read'
            ? 'observation-not-replay'
            : operation === 'resume'
              ? 'new-attempt-only'
              : null,
        semanticOutcome: null,
        workState: null,
        proof: null,
      });
      this.#apply(completed);
      return completed;
    } catch (error) {
      const unknown = this.#recordInputUnknown({
        inputId,
        reason: 'provider-delivery-or-response-not-provable',
        errorCode: error?.code ?? null,
      });
      fail(
        'delivery_unknown',
        'provider delivery or response is not provable; blind replay is forbidden',
        { receiptRoot: unknown.receiptRoot },
      );
    }
  }

  async executeControl({ inputId, sideEffectId, plan }) {
    const duplicate = this.#lookupInput(inputId, sideEffectId, plan);
    if (duplicate) return duplicate;
    this.#requireAdmission();
    const key = requestKey(plan?.requestId);
    const pendingControl = this.pendingControls.get(key);
    if (
      !pendingControl ||
      pendingControl.sessionAttemptId !== this.fence.sessionAttemptId
    ) {
      fail('unknown_control', 'control request has no durable pending receipt');
    }
    const opened = this.#openInput({
      inputId,
      sideEffectId,
      plan,
      operation: 'control',
      providerRequestId: plan.requestId,
      recoveryFrom: null,
    });
    if (opened.duplicate) return opened.receipt;
    try {
      const delivery = await this.interaction.executeControlResponse(plan);
      const completed = this.#append('input-completed', {
        inputId,
        sideEffectId,
        openedReceiptRoot: opened.receipt.receiptRoot,
        planRoot: plan.root,
        actionId: plan.actionId,
        operation: 'control',
        providerMethod: plan.providerMethod,
        providerRequestId: plan.requestId,
        deliveryStatus: delivery.deliveryStatus,
        decision: plan.decision,
        proves: delivery.proves,
        semanticOutcome: null,
        workState: null,
        proof: null,
      });
      this.#apply(completed);
      this.pendingControls.delete(key);
      return completed;
    } catch (error) {
      const unknown = this.#recordInputUnknown({
        inputId,
        reason: 'control-delivery-not-provable',
        errorCode: error?.code ?? null,
      });
      fail(
        'control_unknown',
        'control delivery is not provable; the request cannot be replayed',
        { receiptRoot: unknown.receiptRoot },
      );
    }
  }

  reconcileRuntimeExit(exitStatus = this.runtime.status()) {
    this.#requireLedgerCurrent();
    if (this.boundary) return this.boundary;
    if (
      exitStatus.inputAdmission === 'open' &&
      !exitStatus.failure &&
      !exitStatus.exit
    ) {
      fail('runtime_still_active', 'runtime has no recovery boundary');
    }
    for (const entry of this.inputs.values()) {
      if (entry.attemptId !== this.fence.sessionAttemptId) continue;
      if (entry.state !== 'opened') continue;
      this.#recordInputUnknown({
        inputId: entry.inputId,
        reason: 'runtime-ended-before-durable-completion',
        errorCode: exitStatus.failure?.code ?? null,
      });
    }
    const pending = [...this.pendingControls.values()].filter(
      (control) => control.sessionAttemptId === this.fence.sessionAttemptId,
    );
    for (const control of pending) {
      const unknown = this.#append('control-unknown', {
        providerRequestId: control.providerRequestId,
        providerMethod: control.providerMethod,
        providerSessionId: control.providerSessionId,
        providerTurnId: control.providerTurnId,
        providerItemId: control.providerItemId,
        interactionReceiptRoot: control.interactionReceiptRoot,
        reason: 'runtime-ended-with-control-outstanding',
        defaultDecision: 'deny-unavailable-after-pipe-loss',
        semanticOutcome: null,
        workState: null,
        proof: null,
      });
      this.#apply(unknown);
    }
    const boundary =
      exitStatus.exit?.expected === true ? 'interrupted' : 'unknown';
    const receipt = this.#append('attempt-boundary', {
      boundary,
      reason:
        exitStatus.failure?.code ??
        exitStatus.exit?.boundary ??
        'runtime-admission-closed',
      unresolvedAdmissions: [...this.inputs.values()].filter(
        (entry) =>
          entry.attemptId === this.fence.sessionAttemptId &&
          entry.state === 'unknown',
      ).length,
      unresolvedControls: pending.length,
      inputReplay: false,
      eventReplay: false,
      oldReceiptsImmutable: true,
      semanticOutcome: null,
      workState: null,
      proof: null,
    });
    this.#apply(receipt);
    return receipt;
  }

  waitForBoundary() {
    if (!this.boundaryPromise) {
      fail('runtime_not_observable', 'runtime has no waitForExit boundary');
    }
    return this.boundaryPromise;
  }

  planPtyFallback({ actionId, newSessionAttemptId, boundaryReceiptRoot }) {
    required(actionId, 'actionId');
    required(newSessionAttemptId, 'newSessionAttemptId');
    const boundary = this.boundariesByRoot.get(
      required(boundaryReceiptRoot, 'boundaryReceiptRoot'),
    );
    if (!boundary) fail('unknown_boundary', 'fallback boundary is not durable');
    if (!['unknown', 'interrupted'].includes(boundary.boundary)) {
      fail(
        'invalid_boundary',
        'fallback requires unknown or interrupted boundary',
      );
    }
    if (newSessionAttemptId === boundary.sessionAttemptId) {
      fail(
        'hot_switch_forbidden',
        'fallback must create a new session attempt',
      );
    }
    const body = {
      schema: FALLBACK_SCHEMA,
      actionId,
      provider: 'codex',
      transport: 'pty',
      previousSessionAttemptId: boundary.sessionAttemptId,
      newSessionAttemptId,
      boundaryReceiptRoot,
      hotSwitch: false,
      preservesStructuredReceipts: true,
      effects: ['create-new-pty-attempt-only'],
      semanticOutcome: null,
      workState: null,
    };
    return Object.freeze({ ...body, root: root(body) });
  }

  #requireAdmission() {
    this.#requireLedgerCurrent();
    if (this.boundary)
      fail('attempt_closed', 'old attempt admission is closed');
    const runtime = this.runtime.status();
    if (runtime.inputAdmission !== 'open') {
      fail('runtime_admission_closed', 'runtime input admission is not open');
    }
    const currentFence = this.runtime.currentFence();
    for (const field of [
      'sessionAttemptId',
      'runtimeGeneration',
      'processStartIdentity',
    ]) {
      if (currentFence[field] !== this.fence[field]) {
        fail('stale_runtime', `runtime ${field} changed`);
      }
    }
  }

  #requireLedgerCurrent() {
    if (this.ledgerFailure) {
      fail('ledger_incomplete', 'durable recovery ledger is incomplete', {
        ...this.ledgerFailure,
      });
    }
  }

  #requireRecovery(operation, recoveryFrom) {
    if (operation !== 'resume' && !recoveryFrom) return;
    if (!recoveryFrom) {
      fail(
        'recovery_boundary_required',
        'resume requires an old attempt boundary',
      );
    }
    const boundary = this.boundariesByRoot.get(
      required(recoveryFrom.boundaryReceiptRoot, 'boundaryReceiptRoot'),
    );
    if (!boundary) fail('unknown_boundary', 'recovery boundary is not durable');
    if (boundary.sessionAttemptId !== recoveryFrom.sessionAttemptId) {
      fail('stale_recovery', 'recovery attempt id does not match its boundary');
    }
    if (boundary.sessionAttemptId === this.fence.sessionAttemptId) {
      fail('same_attempt_recovery', 'recovery must use a new session attempt');
    }
    if (!['unknown', 'interrupted'].includes(boundary.boundary)) {
      fail('invalid_boundary', 'recovery boundary is not resumable');
    }
  }

  #openInput({
    inputId,
    sideEffectId,
    plan,
    operation,
    providerRequestId,
    recoveryFrom,
  }) {
    required(inputId, 'inputId');
    required(plan?.root, 'plan.root');
    required(plan?.actionId, 'plan.actionId');
    required(plan?.providerMethod, 'plan.providerMethod');
    if (MUTATING_OPERATIONS.has(operation)) {
      required(sideEffectId, 'sideEffectId');
    }
    const existing = this.#lookupInput(inputId, sideEffectId, plan);
    if (existing) return { duplicate: true, receipt: existing };
    if (sideEffectId) {
      const owner = this.sideEffects.get(sideEffectId);
      if (owner && owner !== inputId) {
        fail('side_effect_conflict', 'side effect id belongs to another input');
      }
    }
    const receipt = this.#append('input-opened', {
      inputId,
      sideEffectId,
      planRoot: plan.root,
      actionId: plan.actionId,
      operation,
      providerMethod: plan.providerMethod,
      providerRequestId,
      recoveryFrom: recoveryFrom
        ? {
            sessionAttemptId: recoveryFrom.sessionAttemptId,
            boundaryReceiptRoot: recoveryFrom.boundaryReceiptRoot,
          }
        : null,
      retention: 'provider-private-durable-metadata',
      semanticOutcome: null,
      workState: null,
      proof: null,
    });
    this.#apply(receipt);
    return { duplicate: false, receipt };
  }

  #lookupInput(inputId, sideEffectId, plan) {
    required(inputId, 'inputId');
    const existing = this.inputs.get(inputId);
    if (!existing) return null;
    if (
      existing.planRoot !== plan?.root ||
      existing.sideEffectId !== sideEffectId
    ) {
      fail('idempotency_conflict', 'input id was used for another exact plan');
    }
    if (existing.state === 'completed') return existing.receipt;
    fail(
      'duplicate_unknown',
      'input is unresolved; query its receipt and never replay blindly',
      {
        receiptRoot:
          existing.receipt?.receiptRoot ?? existing.opened.receiptRoot,
      },
    );
  }

  #append(kind, detail) {
    const body = {
      schema: LEDGER_SCHEMA,
      kind,
      provider: 'codex',
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      recordedAt: this.now(),
      ...structuredClone(detail),
    };
    const payload = Object.freeze({ ...body, receiptRoot: root(body) });
    let stored;
    try {
      stored = this.ledger.append({
        frameClass: FRAME_CLASS,
        kind,
        payload,
      });
    } catch (error) {
      this.ledgerFailure = {
        reason: 'ledger-append-failed',
        errorCode: error?.code ?? null,
      };
      fail('ledger_append_failed', 'durable ledger append failed');
    }
    if (!stored || !Number.isSafeInteger(stored.cursor) || stored.cursor < 1) {
      this.ledgerFailure = { reason: 'invalid-ledger-cursor' };
      fail('ledger_append_failed', 'ledger append returned no durable cursor');
    }
    return Object.freeze({ ...payload, journalCursor: stored.cursor });
  }

  #rehydrate() {
    const journal = this.ledger.read({ fromCursor: 0 });
    if (journal?.gap) {
      this.ledgerFailure = {
        reason: journal.gap.reason ?? 'ledger-gap',
        fromCursor: journal.gap.fromCursor ?? 0,
        toCursor: journal.gap.toCursor ?? null,
      };
      return;
    }
    for (const frame of journal?.frames ?? []) {
      if (frame.frameClass !== FRAME_CLASS) continue;
      const payload = frame.payload;
      if (!payload || payload.schema !== LEDGER_SCHEMA) {
        this.ledgerFailure = {
          reason: 'invalid-ledger-receipt',
          cursor: frame.cursor ?? null,
        };
        return;
      }
      const { receiptRoot, ...body } = payload;
      if (receiptRoot !== root(body)) {
        this.ledgerFailure = {
          reason: 'ledger-receipt-root-mismatch',
          cursor: frame.cursor ?? null,
        };
        return;
      }
      this.#apply({ ...payload, journalCursor: frame.cursor });
    }
  }

  #recordInputUnknown({ inputId, reason, errorCode }) {
    const entry = this.inputs.get(inputId);
    if (!entry) fail('unknown_input', 'input has no durable admission receipt');
    if (entry.state === 'unknown') return entry.receipt;
    if (entry.state === 'completed') return entry.receipt;
    const unknown = this.#append('input-unknown', {
      inputId: entry.inputId,
      sideEffectId: entry.sideEffectId,
      openedReceiptRoot: entry.opened.receiptRoot,
      planRoot: entry.planRoot,
      actionId: entry.actionId,
      operation: entry.operation,
      providerMethod: entry.providerMethod,
      providerRequestId: entry.providerRequestId,
      reason,
      errorCode,
      semanticOutcome: null,
      workState: null,
      proof: null,
    });
    this.#apply(unknown);
    return unknown;
  }

  #apply(receipt) {
    if (receipt.kind === 'input-opened') {
      this.inputs.set(receipt.inputId, {
        inputId: receipt.inputId,
        sideEffectId: receipt.sideEffectId,
        planRoot: receipt.planRoot,
        actionId: receipt.actionId,
        operation: receipt.operation,
        providerMethod: receipt.providerMethod,
        providerRequestId: receipt.providerRequestId,
        attemptId: receipt.sessionAttemptId,
        state: 'opened',
        opened: receipt,
        receipt,
      });
      if (receipt.sideEffectId) {
        this.sideEffects.set(receipt.sideEffectId, receipt.inputId);
      }
    }
    if (
      receipt.kind === 'input-completed' ||
      receipt.kind === 'input-unknown'
    ) {
      const entry = this.inputs.get(receipt.inputId);
      if (entry) {
        entry.state =
          receipt.kind === 'input-completed' ? 'completed' : 'unknown';
        entry.receipt = receipt;
      }
    }
    if (receipt.kind === 'interaction-receipt') {
      if (receipt.providerTerminal) this.providerTerminalReceipts += 1;
      if (receipt.receiptKind === 'control-request') {
        this.pendingControls.set(
          requestKey(receipt.providerRequestId),
          receipt,
        );
      }
      if (receipt.receiptKind === 'control-resolution') {
        this.pendingControls.delete(requestKey(receipt.providerRequestId));
      }
    }
    if (receipt.kind === 'control-unknown') {
      this.pendingControls.delete(requestKey(receipt.providerRequestId));
    }
    if (receipt.kind === 'attempt-boundary') {
      this.boundariesByRoot.set(receipt.receiptRoot, receipt);
      if (receipt.sessionAttemptId === this.fence.sessionAttemptId) {
        this.boundary = receipt;
      }
    }
  }
}
