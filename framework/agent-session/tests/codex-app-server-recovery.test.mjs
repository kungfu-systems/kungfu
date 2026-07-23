// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexAppServerContractGate } from '../src/codex-app-server-contract.mjs';
import { CodexAppServerInteractionAdapter } from '../src/codex-app-server-interaction.mjs';
import {
  CodexAppServerRecoveryError,
  CodexAppServerRecoveryGuard,
} from '../src/codex-app-server-recovery.mjs';

class MemoryLedger {
  constructor({ maxFrames = 256 } = {}) {
    this.maxFrames = maxFrames;
    this.nextCursor = 1;
    this.frames = [];
  }

  append(frame) {
    const stored = { cursor: this.nextCursor++, ...structuredClone(frame) };
    this.frames.push(stored);
    while (this.frames.length > this.maxFrames) this.frames.shift();
    return structuredClone(stored);
  }

  read({ fromCursor = 0 }) {
    const earliestCursor = this.frames[0]?.cursor ?? this.nextCursor;
    return {
      earliestCursor,
      nextCursor: this.nextCursor - 1,
      gap:
        fromCursor + 1 < earliestCursor
          ? {
              fromCursor,
              toCursor: earliestCursor - 1,
              reason: 'bounded-journal-retention-overflow',
            }
          : null,
      frames: structuredClone(
        this.frames.filter((frame) => frame.cursor > fromCursor),
      ),
    };
  }
}

class FakeRuntime {
  constructor({ attemptId = 'attempt-1', generation = '1' } = {}) {
    this.runtimeIdentity = 'runtime-codex';
    this.fence = {
      sessionAttemptId: attemptId,
      runtimeGeneration: generation,
      processStartIdentity: `process:${attemptId}:${generation}`,
    };
    this.inputAdmission = 'open';
    this.failure = null;
    this.exit = null;
    this.requests = [];
    this.responses = [];
    this.requestResult = {
      requestId: 41,
      outcome: 'result',
      status: 'observed',
    };
  }

  status() {
    return {
      schema: 'kungfu.codex-app-server.runtime-host/v1',
      runtimeIdentity: this.runtimeIdentity,
      ...this.fence,
      inputAdmission: this.inputAdmission,
      failure: this.failure,
      exit: this.exit,
    };
  }

  currentFence() {
    return { ...this.fence };
  }

  async request(action) {
    this.requests.push(structuredClone(action));
    return await this.requestResult;
  }

  respond(action) {
    this.responses.push(structuredClone(action));
    return { status: 'written' };
  }
}

function harness({
  runtime = new FakeRuntime(),
  ledger = new MemoryLedger(),
} = {}) {
  const interaction = new CodexAppServerInteractionAdapter({ runtime });
  const guard = new CodexAppServerRecoveryGuard({
    runtime,
    interaction,
    ledger,
    now: () => 1000 + ledger.nextCursor,
  });
  const gate = createCodexAppServerContractGate({ cliVersion: '0.144.3' });
  let sequence = 0;
  return {
    runtime,
    ledger,
    interaction,
    guard,
    event(direction, message, requestMethod = null) {
      const plan = gate.classify({ direction, message, requestMethod });
      return {
        schema: 'kungfu.codex-app-server.runtime-event/v1',
        sequence: sequence++,
        receivedAt: 2000 + sequence,
        runtimeIdentity: runtime.runtimeIdentity,
        ...runtime.currentFence(),
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

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof CodexAppServerRecoveryError);
    assert.equal(error.code, code);
    return true;
  });
}

function startPlan(interaction, actionId = 'start-1') {
  return interaction.planRequest({
    actionId,
    operation: 'start',
    params: { model: 'redacted-model' },
  });
}

test('durable admission precedes provider write and exact duplicates reuse one receipt', async () => {
  const { guard, interaction, runtime, ledger } = harness();
  const plan = startPlan(interaction);
  const first = await guard.executeRequest({
    inputId: 'input-1',
    sideEffectId: 'effect-1',
    plan,
  });
  assert.equal(ledger.frames[0].kind, 'input-opened');
  assert.equal(ledger.frames[1].kind, 'input-completed');
  assert.equal(runtime.requests.length, 1);
  assert.equal(first.semanticOutcome, null);
  assert.equal(first.workState, null);
  assert.equal(
    first.proves,
    'provider-request-written-and-response-observed-only',
  );

  const duplicate = await guard.executeRequest({
    inputId: 'input-1',
    sideEffectId: 'effect-1',
    plan,
  });
  assert.equal(duplicate.receiptRoot, first.receiptRoot);
  assert.equal(runtime.requests.length, 1);

  await expectCode(
    () =>
      guard.executeRequest({
        inputId: 'input-1',
        sideEffectId: 'effect-1',
        plan: startPlan(interaction, 'changed-action'),
      }),
    'idempotency_conflict',
  );
  await expectCode(
    () =>
      guard.executeRequest({
        inputId: 'input-2',
        sideEffectId: 'effect-1',
        plan: startPlan(interaction, 'start-2'),
      }),
    'side_effect_conflict',
  );
});

test('a crash window rehydrates as duplicate unknown and never writes twice', async () => {
  const runtime = new FakeRuntime();
  const ledger = new MemoryLedger();
  let resolveRequest;
  runtime.requestResult = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const first = harness({ runtime, ledger });
  const plan = startPlan(first.interaction);
  const pending = first.guard.executeRequest({
    inputId: 'input-crash',
    sideEffectId: 'effect-crash',
    plan,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ledger.frames.at(-1).kind, 'input-opened');
  assert.equal(runtime.requests.length, 1);

  const recovered = harness({ runtime, ledger });
  await expectCode(
    () =>
      recovered.guard.executeRequest({
        inputId: 'input-crash',
        sideEffectId: 'effect-crash',
        plan: startPlan(recovered.interaction),
      }),
    'duplicate_unknown',
  );
  assert.equal(runtime.requests.length, 1);

  resolveRequest({ requestId: 7, outcome: 'result', status: 'observed' });
  await pending;
});

test('runtime exit and request rejection converge on one unknown receipt', async () => {
  const runtime = new FakeRuntime();
  let rejectRequest;
  runtime.requestResult = new Promise((_, reject) => {
    rejectRequest = reject;
  });
  const { guard, interaction, ledger } = harness({ runtime });
  const pending = guard.executeRequest({
    inputId: 'input-race',
    sideEffectId: 'effect-race',
    plan: startPlan(interaction),
  });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.inputAdmission = 'closed';
  runtime.failure = { code: 'stdout-ended' };
  runtime.exit = { expected: false, boundary: 'attempt-outcome-unknown' };
  guard.reconcileRuntimeExit();
  rejectRequest(
    Object.assign(new Error('pipe lost'), { code: 'stdout-ended' }),
  );
  await expectCode(() => pending, 'delivery_unknown');
  assert.equal(
    ledger.frames.filter((frame) => frame.kind === 'input-unknown').length,
    1,
  );
});

test('approval controls retain exact request identity, default deny and deduplicate', async () => {
  const { guard, interaction, runtime, event } = harness();
  const receipt = guard.recordEvent(
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
  assert.equal(receipt.providerRequestId, 'approval-1');
  assert.equal(guard.status().pendingControls, 1);
  const plan = interaction.planControlResponse({
    actionId: 'deny-1',
    requestId: 'approval-1',
    providerSessionId: 'thread-1',
    providerTurnId: 'turn-1',
    providerItemId: 'item-1',
  });
  const first = await guard.executeControl({
    inputId: 'control-1',
    sideEffectId: 'approval-effect-1',
    plan,
  });
  assert.equal(first.decision, 'deny');
  assert.equal(runtime.responses.length, 1);
  assert.equal(guard.status().pendingControls, 0);
  const duplicate = await guard.executeControl({
    inputId: 'control-1',
    sideEffectId: 'approval-effect-1',
    plan,
  });
  assert.equal(duplicate.receiptRoot, first.receiptRoot);
  assert.equal(runtime.responses.length, 1);
});

test('runtime loss marks unresolved input and controls unknown before closing attempt', async () => {
  const { guard, interaction, runtime, event } = harness();
  runtime.requestResult = Promise.reject(
    Object.assign(new Error('pipe lost'), { code: 'stdout-ended' }),
  );
  const plan = startPlan(interaction);
  await expectCode(
    () =>
      guard.executeRequest({
        inputId: 'input-lost',
        sideEffectId: 'effect-lost',
        plan,
      }),
    'delivery_unknown',
  );
  guard.recordEvent(
    event('server-request', {
      id: 'approval-lost',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 1,
      },
    }),
  );
  runtime.inputAdmission = 'closed';
  runtime.failure = {
    code: 'stdout-ended',
    boundary: 'attempt-outcome-unknown',
  };
  runtime.exit = {
    expected: false,
    boundary: 'attempt-outcome-unknown',
  };
  const boundary = guard.reconcileRuntimeExit();
  assert.equal(boundary.boundary, 'unknown');
  assert.equal(boundary.inputReplay, false);
  assert.equal(boundary.unresolvedAdmissions, 1);
  assert.equal(boundary.unresolvedControls, 1);
  assert.equal(guard.status().pendingControls, 0);
  assert.equal(guard.status().inputAdmission, 'closed');
  await expectCode(
    () =>
      guard.executeRequest({
        inputId: 'input-lost',
        sideEffectId: 'effect-lost',
        plan,
      }),
    'duplicate_unknown',
  );
  assert.equal(runtime.requests.length, 1);
});

test('resume and read bind an exact old boundary without replaying old input', async () => {
  const ledger = new MemoryLedger();
  const oldRuntime = new FakeRuntime({ attemptId: 'attempt-old' });
  const old = harness({ runtime: oldRuntime, ledger });
  oldRuntime.inputAdmission = 'closed';
  oldRuntime.failure = { code: 'pipe-lost' };
  oldRuntime.exit = { expected: false, boundary: 'attempt-outcome-unknown' };
  const boundary = old.guard.reconcileRuntimeExit();

  const newRuntime = new FakeRuntime({
    attemptId: 'attempt-new',
    generation: '2',
  });
  const current = harness({ runtime: newRuntime, ledger });
  const recoveryFrom = {
    sessionAttemptId: 'attempt-old',
    boundaryReceiptRoot: boundary.receiptRoot,
  };
  const resumePlan = current.interaction.planRequest({
    actionId: 'resume-1',
    operation: 'resume',
    params: { threadId: 'thread-1' },
  });
  const resumed = await current.guard.executeRequest({
    inputId: 'resume-input',
    sideEffectId: 'resume-effect',
    plan: resumePlan,
    recoveryFrom,
  });
  assert.equal(resumed.recoveryMode, 'new-attempt-only');
  assert.equal(resumed.semanticOutcome, null);

  const readPlan = current.interaction.planRequest({
    actionId: 'read-1',
    operation: 'read',
    params: { threadId: 'thread-1' },
  });
  const observed = await current.guard.executeRequest({
    inputId: 'read-input',
    plan: readPlan,
    recoveryFrom,
  });
  assert.equal(observed.recoveryMode, 'observation-not-replay');
  assert.equal(newRuntime.requests.length, 2);
  assert.equal(
    ledger.frames.some((frame) =>
      JSON.stringify(frame.payload).includes('redacted-model'),
    ),
    false,
  );
});

test('backpressure, fence drift and ledger corruption fail before provider write', async () => {
  const runtime = new FakeRuntime();
  runtime.inputAdmission = 'frozen';
  const frozen = harness({ runtime });
  await expectCode(
    () =>
      frozen.guard.executeRequest({
        inputId: 'input-frozen',
        sideEffectId: 'effect-frozen',
        plan: startPlan(frozen.interaction),
      }),
    'runtime_admission_closed',
  );
  assert.equal(runtime.requests.length, 0);
  assert.equal(frozen.ledger.frames.length, 0);

  const drifted = harness();
  drifted.runtime.fence.runtimeGeneration = '2';
  await expectCode(
    () =>
      drifted.guard.executeRequest({
        inputId: 'input-stale-runtime',
        sideEffectId: 'effect-stale-runtime',
        plan: startPlan(drifted.interaction),
      }),
    'stale_runtime',
  );
  assert.equal(drifted.runtime.requests.length, 0);
  assert.equal(drifted.ledger.frames.length, 0);

  const ledger = new MemoryLedger({ maxFrames: 1 });
  const seed = harness({ ledger });
  await seed.guard.executeRequest({
    inputId: 'input-seed',
    sideEffectId: 'effect-seed',
    plan: startPlan(seed.interaction),
  });
  const recovered = harness({ runtime: seed.runtime, ledger });
  assert.equal(recovered.guard.status().durableLedger, 'incomplete');
  await expectCode(
    () =>
      recovered.guard.executeRequest({
        inputId: 'input-after-gap',
        sideEffectId: 'effect-after-gap',
        plan: startPlan(recovered.interaction, 'start-after-gap'),
      }),
    'ledger_incomplete',
  );
  assert.equal(seed.runtime.requests.length, 1);

  const corruptedLedger = new MemoryLedger();
  const durable = harness({ ledger: corruptedLedger });
  await durable.guard.executeRequest({
    inputId: 'input-corrupt',
    sideEffectId: 'effect-corrupt',
    plan: startPlan(durable.interaction),
  });
  corruptedLedger.frames[0].payload.receiptRoot = 'sha256:corrupted';
  const corrupted = harness({
    runtime: durable.runtime,
    ledger: corruptedLedger,
  });
  assert.equal(corrupted.guard.status().durableLedger, 'incomplete');
  await expectCode(
    () =>
      corrupted.guard.executeRequest({
        inputId: 'input-after-corruption',
        sideEffectId: 'effect-after-corruption',
        plan: startPlan(corrupted.interaction, 'start-after-corruption'),
      }),
    'ledger_incomplete',
  );
  assert.equal(durable.runtime.requests.length, 1);
});

test('PTY fallback preserves the old structured receipts and requires a new attempt', () => {
  const runtime = new FakeRuntime({ attemptId: 'attempt-old' });
  const { guard } = harness({ runtime });
  runtime.inputAdmission = 'closed';
  runtime.exit = { expected: true, boundary: 'attempt-interrupted' };
  const boundary = guard.reconcileRuntimeExit();
  assert.equal(boundary.boundary, 'interrupted');
  const fallback = guard.planPtyFallback({
    actionId: 'fallback-1',
    newSessionAttemptId: 'attempt-pty-new',
    boundaryReceiptRoot: boundary.receiptRoot,
  });
  assert.equal(fallback.transport, 'pty');
  assert.equal(fallback.hotSwitch, false);
  assert.equal(fallback.preservesStructuredReceipts, true);
  assert.throws(
    () =>
      guard.planPtyFallback({
        actionId: 'fallback-same',
        newSessionAttemptId: 'attempt-old',
        boundaryReceiptRoot: boundary.receiptRoot,
      }),
    (error) => {
      assert.equal(error.code, 'hot_switch_forbidden');
      return true;
    },
  );
});
