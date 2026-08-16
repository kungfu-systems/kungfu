// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CODEX_APP_SERVER_FEATURE_FLAG,
  CodexAppServerProductRuntime,
  codexAppServerProductEnabled,
} from '../src/codex-app-server-product.mjs';
import { InProcessAgentSessionProductRuntime } from '../src/product-runtime.mjs';
import { AgentSessionProductSurface } from '../src/product-surface.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const provider = path.join(
  here,
  'fixtures',
  'codex-app-server-runtime-provider.mjs',
);
const PROFILE_ROOT = `sha256:${'e'.repeat(64)}`;

class FakePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 9001;
  }

  onData(listener) {
    this.on('data', listener);
  }

  onExit(listener) {
    this.on('exit', listener);
  }

  write() {}
  resize() {}
  kill() {}
}

function input(overrides = {}) {
  return {
    workConsoleId: 'console-product',
    sessionAttemptId: 'attempt-structured',
    provider: 'codex',
    providerVersion: '0.146.0',
    profileRoot: PROFILE_ROOT,
    executable: process.execPath,
    argv: [provider, 'product-route'],
    cwd: here,
    env: {},
    ...overrides,
  };
}

function runtime({ structured = true, structuredMode = 'product-route' } = {}) {
  return new InProcessAgentSessionProductRuntime({
    pty: { spawn: () => new FakePtyProcess() },
    structuredRuntime: structured
      ? new CodexAppServerProductRuntime({
          appServerArgv: [provider, structuredMode],
        })
      : null,
  });
}

function surface(options = {}) {
  let id = 0;
  return new AgentSessionProductSurface({
    runtime: runtime(options),
    now: () => 10_000 + id,
    makeId: () => `product-id-${++id}`,
  });
}

test('structured instruction waits for a response-first turn boundary', async (t) => {
  const product = surface({ structuredMode: 'response-first-product-route' });
  const startPlan = product.invoke({
    operation: 'plan-start',
    input: input({ argv: [provider, 'response-first-product-route'] }),
  });
  let started = false;
  let ended = false;
  t.after(async () => {
    if (!started || ended) return;
    const cleanupPlan = product.invoke({
      operation: 'plan-control',
      controlOperation: 'end',
      actorId: 'actor-agent',
      session: {
        workConsoleId: startPlan.workConsoleId,
        sessionAttemptId: startPlan.sessionAttemptId,
      },
      payload: {},
    });
    await product.invoke({
      operation: 'end',
      actorId: 'actor-agent',
      plan: cleanupPlan,
      expectedPlanRoot: cleanupPlan.root,
      payload: {},
    });
  });
  await product.invoke({
    operation: 'start',
    client: 'cli',
    actorId: 'actor-agent',
    plan: startPlan,
    expectedPlanRoot: startPlan.root,
    execution: { env: {} },
  });
  started = true;
  const ref = {
    workConsoleId: startPlan.workConsoleId,
    sessionAttemptId: startPlan.sessionAttemptId,
  };
  const payload = { text: 'response-first instruction' };
  const instructionPlan = product.invoke({
    operation: 'plan-control',
    controlOperation: 'instruct',
    actorId: 'actor-agent',
    session: ref,
    payload,
  });
  const startedAt = Date.now();
  const receipt = await product.invoke({
    operation: 'instruct',
    actorId: 'actor-agent',
    plan: instructionPlan,
    expectedPlanRoot: instructionPlan.root,
    payload,
  });
  assert.equal(receipt.status, 'delivered');
  assert.ok(Date.now() - startedAt >= 20);
  await waitFor(
    () =>
      product.invoke({ operation: 'status', session: ref }).interactionState ===
      'ready',
    'response-first structured turn did not reach its terminal boundary',
  );
  const snapshot = product.invoke({ operation: 'snapshot', session: ref });
  assert.equal(snapshot.agentText, 'Structured answer retained.');
  assert.equal(snapshot.retainedAgentResponse, true);
  assert.equal(snapshot.retainedTranscript, false);
  const endPlan = product.invoke({
    operation: 'plan-control',
    controlOperation: 'end',
    actorId: 'actor-agent',
    session: ref,
    payload: {},
  });
  await product.invoke({
    operation: 'end',
    actorId: 'actor-agent',
    plan: endPlan,
    expectedPlanRoot: endPlan.root,
    payload: {},
  });
  ended = true;
});

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

test('production route freezes Codex app-server stdio without version admission', () => {
  const structured = new CodexAppServerProductRuntime();
  const route = structured.planRoute(input());
  assert.deepEqual(route.argv, ['app-server', '--stdio']);
  assert.deepEqual(
    structured.planRoute(
      input({ providerVersion: 'future-channel-without-semver' }),
    ),
    route,
  );
  assert.equal(
    structured.capabilities().routes[0].versionAdmission,
    'diagnostic-only',
  );
  assert.equal(route.defaultPolicy, 'structured');
  assert.equal(route.rollback, `${CODEX_APP_SERVER_FEATURE_FLAG}=0`);
});

test('arbitrary Codex version metadata uses structured capability negotiation', () => {
  const product = surface();
  const plan = product.invoke({
    operation: 'plan-start',
    input: input({ providerVersion: 'opaque-nightly' }),
  });
  assert.equal(plan.transportRoute.kind, 'structured');
  assert.deepEqual(plan.effects, [
    'spawn-codex-app-server-direct-stdio',
    'start-one-provider-thread',
    'register-session',
    'attach-presentation',
  ]);
});

test('product policy defaults Codex to structured with an explicit PTY rollback', () => {
  assert.equal(codexAppServerProductEnabled({}), true);
  assert.equal(
    codexAppServerProductEnabled({ [CODEX_APP_SERVER_FEATURE_FLAG]: '1' }),
    true,
  );
  assert.equal(
    codexAppServerProductEnabled({ [CODEX_APP_SERVER_FEATURE_FLAG]: '0' }),
    false,
  );
  assert.throws(
    () =>
      codexAppServerProductEnabled({
        [CODEX_APP_SERVER_FEATURE_FLAG]: 'unexpected',
      }),
    (error) => error.code === 'invalid_route_policy',
  );
});

test('feature flag off and non-Codex providers retain the PTY plan', () => {
  const disabled = surface({ structured: false });
  const plan = disabled.invoke({ operation: 'plan-start', input: input() });
  assert.equal(Object.hasOwn(plan, 'transportRoute'), false);
  assert.deepEqual(plan.effects, [
    'spawn-provider-in-capsule',
    'register-session',
    'attach-presentation',
  ]);
  assert.equal(
    Object.hasOwn(
      disabled.invoke({ operation: 'capabilities' }),
      'providerRoutes',
    ),
    false,
  );
  disabled.invoke({
    operation: 'start',
    client: 'cli',
    actorId: 'actor-pty',
    plan,
    expectedPlanRoot: plan.root,
    execution: { env: {} },
  });
  assert.throws(
    () =>
      disabled.invoke({
        operation: 'plan-control',
        controlOperation: 'respond-control',
        session: {
          workConsoleId: plan.workConsoleId,
          sessionAttemptId: plan.sessionAttemptId,
        },
      }),
    (error) => error.code === 'unsupported_operation',
  );

  const enabled = surface();
  const claude = enabled.invoke({
    operation: 'plan-start',
    input: input({
      provider: 'claude',
      providerVersion: '2.1.209',
      sessionAttemptId: 'attempt-claude',
      argv: [],
    }),
  });
  assert.equal(Object.hasOwn(claude, 'transportRoute'), false);
});

test('GUI CLI and Agent share one frozen structured route and exact controls', async () => {
  const product = surface();
  const guiPlan = product.invoke({
    operation: 'plan-start',
    client: 'gui',
    actorId: 'actor-gui',
    input: input(),
  });
  const cliPlan = product.invoke({
    operation: 'plan-start',
    client: 'cli',
    actorId: 'actor-cli',
    input: input(),
  });
  assert.deepEqual(guiPlan, cliPlan);
  assert.equal(guiPlan.transportRoute.kind, 'structured');
  assert.equal(guiPlan.transportRoute.frozenPerAttempt, true);
  assert.deepEqual(guiPlan.argv, [provider, 'product-route']);
  assert.deepEqual(guiPlan.structured.threadStartParams, {
    cwd: here,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  });

  const started = await product.invoke({
    operation: 'start',
    client: 'kfd3-agent',
    actorId: 'actor-agent',
    plan: guiPlan,
    expectedPlanRoot: guiPlan.root,
    attachment: { presentation: 'assistant-console' },
    execution: { env: {} },
  });
  assert.equal(started.transportRoute.kind, 'structured');
  const duplicateAttemptPlan = product.invoke({
    operation: 'plan-start',
    input: input({ workConsoleId: 'other-console' }),
  });
  await assert.rejects(
    async () =>
      product.invoke({
        operation: 'start',
        client: 'gui',
        actorId: 'actor-gui',
        plan: duplicateAttemptPlan,
        expectedPlanRoot: duplicateAttemptPlan.root,
        execution: { env: {} },
      }),
    /already exists/,
  );
  const ref = {
    workConsoleId: guiPlan.workConsoleId,
    sessionAttemptId: guiPlan.sessionAttemptId,
  };
  let status = product.invoke({ operation: 'status', session: ref });
  assert.equal(status.foreground.providerSessionId, 'thread-product');
  assert.equal(status.transportRoute.hotSwitch, false);
  assert.equal(status.workOutcome, null);
  const snapshot = product.invoke({ operation: 'snapshot', session: ref });
  assert.equal(snapshot.status.sessionAttemptId, ref.sessionAttemptId);
  assert.equal(snapshot.status.output.kind, 'structured-events');
  assert.equal(snapshot.retainedTranscript, false);
  assert.equal(Object.hasOwn(snapshot, 'terminal'), false);

  const instruction = { text: 'redacted product instruction' };
  const instructionPlan = product.invoke({
    operation: 'plan-control',
    controlOperation: 'instruct',
    client: 'gui',
    actorId: 'actor-agent',
    session: ref,
    payload: instruction,
  });
  const instructed = await product.invoke({
    operation: 'instruct',
    client: 'cli',
    actorId: 'actor-agent',
    plan: instructionPlan,
    expectedPlanRoot: instructionPlan.root,
    payload: instruction,
  });
  assert.equal(instructed.deliveryReceipt.deliveryStatus, 'observed');
  assert.equal(instructed.semanticOutcome, null);

  status = await waitFor(() => {
    const current = product.invoke({ operation: 'status', session: ref });
    return current.structuredControl.pending.length > 0 ? current : null;
  }, 'structured approval was not projected');
  assert.equal(status.interactionState, 'approval-needed');
  assert.equal(
    status.structuredControl.pending[0].requestId,
    'approval-product',
  );

  const denial = { requestId: 'approval-product', decision: 'deny' };
  const denialPlan = product.invoke({
    operation: 'plan-control',
    controlOperation: 'respond-control',
    client: 'gui',
    actorId: 'actor-agent',
    session: ref,
    payload: denial,
  });
  const denied = await product.invoke({
    operation: 'respond-control',
    client: 'kfd3-agent',
    actorId: 'actor-agent',
    plan: denialPlan,
    expectedPlanRoot: denialPlan.root,
    payload: denial,
  });
  assert.equal(denied.controlReceipt.decision, 'deny');
  assert.equal(denied.workState, null);
  await waitFor(
    () =>
      product.invoke({ operation: 'status', session: ref }).interactionState ===
      'ready',
    'structured turn did not return to ready',
  );
  const completedSnapshot = product.invoke({
    operation: 'snapshot',
    session: ref,
  });
  assert.equal(
    completedSnapshot.agentText,
    'Approved structured answer retained.',
  );
  assert.equal(completedSnapshot.retainedAgentResponse, true);
  assert.equal(completedSnapshot.retainedTranscript, false);

  assert.throws(
    () =>
      product.invoke({
        operation: 'plan-start',
        input: input({
          sessionAttemptId: 'attempt-hot-switch',
          fallbackFrom: ref,
        }),
      }),
    (error) => error.code === 'fallback_not_ready',
  );

  const endPlan = product.invoke({
    operation: 'plan-control',
    controlOperation: 'end',
    actorId: 'actor-agent',
    session: ref,
    payload: {},
  });
  await product.invoke({
    operation: 'end',
    actorId: 'actor-agent',
    plan: endPlan,
    expectedPlanRoot: endPlan.root,
    payload: {},
  });
  status = product.invoke({ operation: 'status', session: ref });
  assert.equal(status.attemptBoundary, 'interrupted');

  assert.throws(
    () =>
      product.invoke({
        operation: 'plan-start',
        input: input({
          workConsoleId: 'other-console',
          sessionAttemptId: 'attempt-wrong-console',
          fallbackFrom: ref,
        }),
      }),
    (error) => error.code === 'fallback_console_mismatch',
  );
  assert.throws(
    () =>
      product.invoke({
        operation: 'plan-start',
        input: input({
          provider: 'claude',
          providerVersion: '2.1.209',
          sessionAttemptId: 'attempt-wrong-provider',
          fallbackFrom: ref,
        }),
      }),
    (error) => error.code === 'fallback_provider_mismatch',
  );

  const fallback = product.invoke({
    operation: 'plan-start',
    input: input({
      sessionAttemptId: 'attempt-pty-fallback',
      fallbackFrom: ref,
      argv: [],
    }),
  });
  assert.equal(Object.hasOwn(fallback, 'transportRoute'), false);
  assert.deepEqual(fallback.effects, [
    'create-new-pty-attempt-only',
    'preserve-old-structured-receipts',
    'attach-presentation',
  ]);
  assert.equal(fallback.provider, 'codex');
  assert.equal(fallback.providerVersion, '0.146.0');
  assert.equal(fallback.profileRoot, PROFILE_ROOT);
  const fallbackReceipt = await product.invoke({
    operation: 'start',
    client: 'gui',
    actorId: 'actor-agent',
    plan: fallback,
    expectedPlanRoot: fallback.root,
    attachment: { presentation: 'console-hub' },
    execution: { env: {} },
  });
  assert.equal(fallbackReceipt.sessionAttemptId, 'attempt-pty-fallback');
  assert.notEqual(fallbackReceipt.sessionAttemptId, ref.sessionAttemptId);
});
