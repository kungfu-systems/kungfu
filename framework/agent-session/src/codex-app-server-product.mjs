// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { CodexAppServerInteractionAdapter } from './codex-app-server-interaction.mjs';
import { CodexAppServerRecoveryGuard } from './codex-app-server-recovery.mjs';
import { CodexAppServerRuntimeHost } from './codex-app-server-runtime.mjs';
import { InMemoryJournalNoticePort } from './peer-transport.mjs';

export const CODEX_APP_SERVER_FEATURE_FLAG =
  'KUNGFU_AGENT_SESSION_CODEX_APP_SERVER';

const MAX_RETAINED_AGENT_TEXT = 128_000;

/**
 * Codex app-server is the product default for any installed Codex CLI that
 * completes the structured protocol handshake.
 * Setting the retained feature flag to `0` is the bounded rollback to PTY for
 * newly-created attempts; an existing attempt never changes transport.
 */
export function codexAppServerProductEnabled(env = {}) {
  const value = env[CODEX_APP_SERVER_FEATURE_FLAG];
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw Object.assign(
    new Error(`${CODEX_APP_SERVER_FEATURE_FLAG} must be 0 or 1`),
    { code: 'invalid_route_policy' },
  );
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`${label} is required`), {
      code: 'invalid_argument',
    });
  }
  return value;
}

function sameKeys(left, right) {
  return (
    JSON.stringify(Object.keys(left ?? {}).sort()) ===
    JSON.stringify([...right].sort())
  );
}

class StructuredAuthorityTransport {
  constructor({ ledger, now }) {
    this.ledger = ledger;
    this.now = now;
    this.attachments = new Map();
    this.controllerLease = null;
  }

  status() {
    return { controllerLease: this.controllerLease };
  }

  attach({ attachmentId, actorId }) {
    this.attachments.set(attachmentId, actorId);
  }

  detach({ attachmentId, actorId }) {
    if (this.attachments.get(attachmentId) === actorId) {
      this.attachments.delete(attachmentId);
    }
  }

  acquireControl({ leaseId, holderId, planRoot }) {
    if (this.controllerLease) {
      return {
        status:
          this.controllerLease.holderId === holderId ? 'duplicate' : 'denied',
        ...this.controllerLease,
      };
    }
    this.controllerLease = {
      leaseId,
      holderId,
      planRoot,
      expiresAt: null,
    };
    this.#append('controller-granted', this.controllerLease);
    return { status: 'granted', ...this.controllerLease };
  }

  releaseControl({ leaseId, holderId, planRoot }) {
    if (
      !this.controllerLease ||
      this.controllerLease.leaseId !== leaseId ||
      this.controllerLease.holderId !== holderId
    ) {
      return { status: 'denied', reason: 'stale-controller-lease' };
    }
    const released = { ...this.controllerLease };
    this.controllerLease = null;
    this.#append('controller-released', { ...released, planRoot });
    return { status: 'released', ...released };
  }

  #append(kind, payload) {
    this.ledger.append({
      frameClass: 'auditable-control',
      kind,
      payload: {
        schema: 'kungfu.agent-session.structured-controller-receipt/v1',
        ...payload,
        recordedAt: this.now(),
      },
    });
  }
}

function routeStatus(argv) {
  return {
    kind: 'structured',
    provider: 'codex',
    transport: 'codex-app-server-direct-stdio',
    argv: [...argv],
    featureFlag: CODEX_APP_SERVER_FEATURE_FLAG,
    defaultPolicy: 'structured',
    rollback: `${CODEX_APP_SERVER_FEATURE_FLAG}=0`,
    frozenPerAttempt: true,
    hotSwitch: false,
  };
}

/** Product runtime for one direct-stdio Codex route behind the shared surface. */
export class CodexAppServerProductRuntime {
  constructor({
    spawnProcess = spawn,
    journalFactory = () => new InMemoryJournalNoticePort({ maxFrames: 4096 }),
    baseEnv = {},
    now = () => Date.now(),
    appServerArgv = ['app-server', '--stdio'],
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.journalFactory = journalFactory;
    this.baseEnv = baseEnv;
    this.now = now;
    this.appServerArgv = Object.freeze([...appServerArgv]);
    this.sessions = new Map();
    this.generation = 0;
  }

  capabilities() {
    return {
      featureFlag: CODEX_APP_SERVER_FEATURE_FLAG,
      enabled: true,
      routes: [
        {
          ...routeStatus(this.appServerArgv),
          versionAdmission: 'diagnostic-only',
          capabilities: [
            'structured-provider-events',
            'exact-provider-controls',
            'provider-resume-new-attempt-only',
          ],
        },
      ],
    };
  }

  planRoute(input) {
    if (input.provider !== 'codex' || input.fallbackFrom) return null;
    return routeStatus(this.appServerArgv);
  }

  list() {
    return [...this.sessions.values()];
  }

  get(ref) {
    const session = this.sessions.get(ref.sessionAttemptId) ?? null;
    return session?.workConsoleId === ref.workConsoleId ? session : null;
  }

  async start(plan, execution = {}) {
    if (this.sessions.has(plan.sessionAttemptId)) {
      throw new Error(`session '${plan.sessionAttemptId}' already exists`);
    }
    if (!sameKeys(execution.env, plan.environmentNames)) {
      throw new Error(
        'execution environment names do not match the reviewed plan',
      );
    }
    if (
      JSON.stringify(plan.argv) !== JSON.stringify(this.appServerArgv) ||
      JSON.stringify(plan.transportRoute?.argv) !==
        JSON.stringify(this.appServerArgv)
    ) {
      throw Object.assign(
        new Error('structured Codex route launch arguments drifted'),
        { code: 'provider_launch_drift' },
      );
    }
    this.generation += 1;
    const generation = String(this.generation);
    const ledger = this.journalFactory(plan);
    const runtime = new CodexAppServerRuntimeHost({
      spawn: this.spawnProcess,
      runtimeIdentity: `product-codex-runtime:${plan.sessionAttemptId}:${generation}`,
      now: this.now,
    });
    const env = {};
    for (const name of plan.environmentNames) {
      const value = execution.env?.[name] ?? this.baseEnv[name];
      if (typeof value === 'string') env[name] = value;
    }
    await runtime.start({
      sessionAttemptId: plan.sessionAttemptId,
      runtimeGeneration: generation,
      executable: plan.executable,
      argv: plan.argv,
      cwd: plan.cwd ?? undefined,
      env,
      cliVersion: plan.providerVersion,
      initializeParams: plan.structured.initializeParams,
    });
    const interaction = new CodexAppServerInteractionAdapter({ runtime });
    const recovery = new CodexAppServerRecoveryGuard({
      runtime,
      interaction,
      ledger,
      now: this.now,
    });
    const state = {
      providerSessionId: null,
      providerTurnId: null,
      turnLifecycleSequence: 0,
      lastReceiptRoot: null,
      pendingControls: new Map(),
      agentMessages: new Map(),
      eventFailure: null,
      draining: false,
    };
    const retainAgentMessage = (event) => {
      const params = event.message?.params ?? {};
      const item = params.item ?? {};
      const itemId = String(params.itemId ?? item.id ?? 'agent-message');
      const prior = state.agentMessages.get(itemId) ?? '';
      let text = null;
      if (
        event.providerMethod === 'item/agentMessage/delta' &&
        typeof params.delta === 'string'
      ) {
        text = `${prior}${params.delta}`;
      } else if (
        event.providerMethod === 'item/completed' &&
        ['agentMessage', 'agent_message'].includes(item.type) &&
        typeof item.text === 'string'
      ) {
        text = item.text;
      }
      if (text !== null) {
        state.agentMessages.set(itemId, text.slice(0, MAX_RETAINED_AGENT_TEXT));
      }
    };
    const applyReceipt = (receipt) => {
      state.lastReceiptRoot = receipt.receiptRoot;
      if (receipt.providerSessionId)
        state.providerSessionId = receipt.providerSessionId;
      if (receipt.providerMethod === 'turn/started')
        state.providerTurnId = receipt.providerTurnId;
      if (receipt.providerTerminal) state.providerTurnId = null;
      if (
        receipt.providerMethod === 'turn/started' ||
        receipt.providerMethod === 'turn/completed'
      ) {
        state.turnLifecycleSequence += 1;
      }
      if (receipt.receiptKind === 'control-request') {
        state.pendingControls.set(String(receipt.providerRequestId), receipt);
      }
      if (receipt.receiptKind === 'control-resolution') {
        state.pendingControls.delete(String(receipt.providerRequestId));
      }
    };
    const drain = () => {
      if (state.draining || state.eventFailure) return;
      state.draining = true;
      try {
        for (const event of runtime.takeEvents()) {
          applyReceipt(recovery.recordEvent(event));
          retainAgentMessage(event);
        }
      } catch (error) {
        state.eventFailure = error;
        if (!runtime.status().exit) {
          runtime.shutdown({
            ...runtime.currentFence(),
            actionId: `event-consumer-failed:${plan.sessionAttemptId}`,
          });
        }
      } finally {
        state.draining = false;
      }
    };
    const unsubscribe = runtime.subscribe(drain);
    drain();
    const startRequest = interaction.planRequest({
      actionId: `product-thread-start:${plan.sessionAttemptId}`,
      operation: 'start',
      params: plan.structured.threadStartParams,
    });
    await recovery.executeRequest({
      inputId: `product-thread-start:${plan.root}`,
      sideEffectId: `provider-thread:${plan.sessionAttemptId}`,
      plan: startRequest,
    });
    drain();
    if (!state.providerSessionId || state.eventFailure) {
      runtime.shutdown({
        ...runtime.currentFence(),
        actionId: `missing-thread-identity:${plan.sessionAttemptId}`,
      });
      throw Object.assign(
        new Error('Codex thread/start returned no durable provider identity'),
        { code: 'missing_provider_identity' },
      );
    }
    const transport = new StructuredAuthorityTransport({
      ledger,
      now: this.now,
    });
    const session = this.#session({
      plan,
      runtime,
      interaction,
      recovery,
      ledger,
      state,
      drain,
      unsubscribe,
      transport,
      generation,
    });
    this.sessions.set(plan.sessionAttemptId, session);
    return session;
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      if (session.runtime.status().exit) continue;
      void session
        .end({ actionId: 'product-worker-shutdown' })
        .catch(() => undefined);
    }
  }

  #session(context) {
    const { plan, runtime, interaction, recovery, state, drain, transport } =
      context;
    const retainedAgentText = () =>
      [...state.agentMessages.values()]
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_RETAINED_AGENT_TEXT);
    const interactionState = () => {
      if (state.eventFailure || recovery.status().inputAdmission !== 'open')
        return runtime.status().exit ? 'ended' : 'unknown';
      if (state.pendingControls.size > 0) return 'approval-needed';
      if (state.providerTurnId) return 'busy';
      return state.providerSessionId ? 'ready' : 'unknown';
    };
    const pendingControls = () =>
      [...state.pendingControls.values()].map((receipt) => ({
        requestId: receipt.providerRequestId,
        providerMethod: receipt.providerMethod,
        providerSessionId: receipt.providerSessionId,
        providerTurnId: receipt.providerTurnId,
        providerItemId: receipt.providerItemId,
        defaultDecision: receipt.defaultDecision,
      }));
    const status = () => {
      const current = runtime.status();
      const boundary = recovery.status().state;
      return {
        workConsoleId: plan.workConsoleId,
        sessionAttemptId: plan.sessionAttemptId,
        capsuleId: null,
        capsuleGeneration: current.runtimeGeneration,
        coordinatorEpoch: '1',
        sessionStreamEpoch: '1',
        lifecycleState: current.exit
          ? 'ended'
          : current.failure
            ? 'failed'
            : 'ready',
        interactionState: interactionState(),
        inputAdmission: recovery.status().inputAdmission,
        foreground: {
          provider: 'codex',
          profileRoot: plan.profileRoot,
          executable: plan.executable,
          argv: [...plan.argv],
          processStartIdentity: current.processStartIdentity,
          providerSessionId: state.providerSessionId,
          providerTurnId: state.providerTurnId,
          backend: current.backend,
        },
        output: {
          kind: 'structured-events',
          nextSequence: current.queue.nextSequence,
          retainedTranscript: false,
        },
        providerAdapter: {
          schema: 'kungfu.agent-session.provider-adapter/v1',
          provider: 'codex',
          providerVersion: plan.providerVersion,
          adapterVersion: 'codex-app-server-structured/v1',
          compatible: true,
          tested: true,
          failureCode:
            state.eventFailure?.code ?? current.failure?.code ?? null,
          failureDetail:
            state.eventFailure?.message ?? current.failure?.message ?? null,
          exit: current.exit
            ? {
                code: current.exit.code,
                signal: current.exit.signal,
                expected: current.exit.expected,
              }
            : null,
          stderrBytesObserved: current.stderr.observedBytes,
          stderrRetained: false,
        },
        queuedInstructions: 0,
        transportRoute: plan.transportRoute,
        structuredControl: { pending: pendingControls() },
        attemptBoundary: ['unknown', 'interrupted'].includes(boundary)
          ? boundary
          : null,
      };
    };
    const execute = async (request, operation, params) => {
      if (state.eventFailure) throw state.eventFailure;
      const priorTurnLifecycleSequence = state.turnLifecycleSequence;
      const providerPlan = interaction.planRequest({
        actionId: request.actionId,
        operation,
        params,
      });
      const deliveryReceipt = await recovery.executeRequest({
        inputId: request.inputId,
        sideEffectId: `structured:${request.inputId}`,
        plan: providerPlan,
      });
      drain();
      if (operation === 'instruct') {
        const deadline = Date.now() + 10_000;
        while (
          state.turnLifecycleSequence === priorTurnLifecycleSequence &&
          state.pendingControls.size === 0 &&
          !state.eventFailure &&
          !runtime.status().exit &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          drain();
        }
        if (state.eventFailure) throw state.eventFailure;
        if (
          state.turnLifecycleSequence === priorTurnLifecycleSequence &&
          state.pendingControls.size === 0
        ) {
          throw Object.assign(
            new Error(
              'Codex turn/start returned before a turn lifecycle or control boundary was observed',
            ),
            { code: 'missing_turn_boundary' },
          );
        }
      }
      return { status: 'delivered', deliveryReceipt };
    };
    const port = {
      status,
      snapshot: () => ({
        schema: 'kungfu.agent-session.structured-snapshot/v1',
        status: status(),
        sessionAttemptId: plan.sessionAttemptId,
        providerSessionId: state.providerSessionId,
        providerTurnId: state.providerTurnId,
        pendingControls: pendingControls(),
        lastReceiptRoot: state.lastReceiptRoot,
        agentText: retainedAgentText() || null,
        retainedAgentResponse: retainedAgentText().length > 0,
        retainedTranscript: false,
        semanticOutcome: null,
        workState: null,
        proof: null,
      }),
      instruct: (request) => {
        if (interactionState() !== 'ready') {
          return { status: 'held', reason: 'structured-provider-not-ready' };
        }
        return execute(request, 'instruct', {
          threadId: state.providerSessionId,
          input: [{ type: 'text', text: required(request.text, 'text') }],
        });
      },
      sendKey: () => ({
        status: 'rejected',
        reason: 'structured-route-has-no-semantic-key-path',
      }),
      interrupt: (request) => {
        if (!state.providerTurnId) {
          return { status: 'held', reason: 'no-active-provider-turn' };
        }
        return execute(request, 'interrupt', {
          threadId: state.providerSessionId,
          turnId: state.providerTurnId,
        });
      },
      respondControl: async (request) => {
        const pending = state.pendingControls.get(String(request.requestId));
        if (!pending) {
          throw Object.assign(new Error('structured control is not pending'), {
            code: 'unknown_control',
          });
        }
        const controlPlan = interaction.planControlResponse({
          actionId: request.actionId,
          requestId: request.requestId,
          providerSessionId: pending.providerSessionId,
          providerTurnId: pending.providerTurnId,
          providerItemId: pending.providerItemId,
          decision: request.decision,
          result: request.result,
        });
        const controlReceipt = await recovery.executeControl({
          inputId: request.inputId,
          sideEffectId: `structured-control:${request.inputId}`,
          plan: controlPlan,
        });
        state.pendingControls.delete(String(request.requestId));
        drain();
        return { status: 'delivered', controlReceipt };
      },
    };
    const session = {
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
      binding: plan.binding,
      runtime,
      recovery,
      transport,
      port,
      attachments: new Map(),
      authority(actorId) {
        return {
          holderId: actorId,
          ...runtime.currentFence(),
        };
      },
      async end(request) {
        const controlReceipt = runtime.shutdown({
          ...runtime.currentFence(),
          actionId: request.actionId,
        });
        await runtime.waitForExit();
        const boundaryReceipt = await recovery.waitForBoundary();
        drain();
        return {
          status: controlReceipt.status,
          controlReceipt,
          boundaryReceipt,
        };
      },
    };
    return session;
  }
}
