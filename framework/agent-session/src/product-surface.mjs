import { createHash, randomUUID } from 'node:crypto';
import {
  WORK_CONSOLE_REGISTRY_SCHEMA,
  WorkConsoleRegistry,
} from './work-console-registry.mjs';

const CONTROL_OPERATIONS = new Set([
  'acquire-control',
  'release-control',
  'instruct',
  'send-key',
  'interrupt',
  'respond-control',
  'end',
]);
const READ_OPERATIONS = new Set([
  'capabilities',
  'list',
  'show',
  'status',
  'snapshot',
]);

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      `${label} is required`,
    );
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

export function agentSessionSurfaceRoot(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function planRoot(plan) {
  const { root: _root, ...body } = plan;
  return agentSessionSurfaceRoot(body);
}

function sessionRef(value) {
  if (!value || typeof value !== 'object') {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      'session reference is required',
    );
  }
  return {
    workConsoleId: required(value.workConsoleId, 'workConsoleId'),
    sessionAttemptId: required(value.sessionAttemptId, 'sessionAttemptId'),
  };
}

function sessionKey(workConsoleId, sessionAttemptId) {
  return `${workConsoleId}\u0000${sessionAttemptId}`;
}

export function agentSessionProductState({
  live = false,
  lifecycleState = '',
  interactionState = '',
  attemptStatus = '',
  providerCompatible = null,
} = {}) {
  const state = live ? lifecycleState : attemptStatus || lifecycleState;
  let productState = 'recovering';
  let reason = 'reattaching-session';
  let recommendedAction = null;

  if (state === 'ended' || state === 'exited') {
    productState = 'ended';
    reason = 'attempt-ended';
  } else if (state === 'unrecoverable' || state === 'lost-control') {
    productState = 'action-required';
    reason = 'prior-attempt-cannot-be-reattached';
    recommendedAction = 'start-new-attempt-or-provider-resume';
  } else if (live && interactionState === 'approval-needed') {
    productState = 'action-required';
    reason = 'provider-request-needs-review';
    recommendedAction = 'review-provider-request';
  } else if (
    live &&
    interactionState === 'unknown' &&
    providerCompatible === false
  ) {
    productState = 'action-required';
    reason = 'interaction-state-needs-review';
    recommendedAction = 'inspect-session-and-choose-resume-or-new-attempt';
  } else if (state === 'degraded') {
    productState = 'action-required';
    reason = 'automatic-recovery-cannot-continue';
    recommendedAction = 'inspect-session-and-choose-resume-or-new-attempt';
  } else if (state === 'starting' || state === 'planned') {
    productState = 'starting';
    reason = 'attempt-starting';
  } else if (live && interactionState === 'busy') {
    productState = 'working';
    reason = 'provider-working';
  } else if (
    live &&
    lifecycleState === 'ready' &&
    interactionState === 'ready'
  ) {
    productState = 'available';
    reason = 'ready-for-input';
  }

  return {
    schema: 'kungfu.agent-session.product-state/v1',
    state: productState,
    reason,
    recommendedAction,
  };
}

function publicStatus(session) {
  const status = session.port.status();
  const controller = status.controllerLease;
  return {
    schema: 'kungfu.agent-session.surface-status/v1',
    live: true,
    workConsoleId: status.workConsoleId,
    sessionAttemptId: status.sessionAttemptId,
    capsuleId: status.capsuleId,
    capsuleGeneration: status.capsuleGeneration,
    coordinatorEpoch: status.coordinatorEpoch,
    sessionStreamEpoch: status.sessionStreamEpoch,
    lifecycleState: status.lifecycleState,
    interactionState: status.interactionState,
    inputAdmission: status.inputAdmission,
    foreground: status.foreground,
    output: status.output,
    exit: status.exit,
    providerAdapter: status.providerAdapter,
    queuedInstructions: status.queuedInstructions,
    binding: session.binding,
    attachments: [...session.attachments.values()].map((attachment) => ({
      attachmentId: attachment.attachmentId,
      surface: attachment.surface,
      presentation: attachment.presentation,
      controller: controller?.holderId === attachment.actorId,
      attachedAt: attachment.attachedAt,
    })),
    controller: controller
      ? {
          holderId: controller.holderId,
          leaseId: controller.leaseId,
          expiresAt: controller.expiresAt,
        }
      : null,
    workOutcome: null,
    proof: null,
    product: agentSessionProductState({
      live: true,
      lifecycleState: status.lifecycleState,
      interactionState: status.interactionState,
      providerCompatible: status.providerAdapter?.compatible ?? null,
    }),
    ...(status.transportRoute
      ? {
          transportRoute: status.transportRoute,
          structuredControl: status.structuredControl,
          attemptBoundary: status.attemptBoundary,
        }
      : {}),
  };
}

function receipt(operation, actorId, details, now) {
  const body = {
    schema: 'kungfu.agent-session.surface-receipt/v1',
    operation,
    actorId,
    recordedAt: now(),
    ...details,
    semanticOutcome: null,
    workState: null,
    proof: null,
  };
  return { ...body, receiptRoot: agentSessionSurfaceRoot(body) };
}

export class AgentSessionSurfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentSessionSurfaceError';
    this.code = code;
  }
}

/**
 * One self-describing action surface shared by GUI, CLI and KFD-3 clients.
 *
 * The injected runtime owns Capsule/InteractionPort instances. This class owns
 * plans, optimistic root checks and product projections only; it never spawns a
 * provider or writes a PTY through a private presentation path.
 */
export class AgentSessionProductSurface {
  constructor({
    runtime,
    registry = new WorkConsoleRegistry(),
    now = () => Date.now(),
    makeId = () => randomUUID(),
  }) {
    if (
      !runtime ||
      typeof runtime.list !== 'function' ||
      typeof runtime.get !== 'function' ||
      typeof runtime.start !== 'function'
    ) {
      throw new AgentSessionSurfaceError(
        'invalid_runtime',
        'product surface requires list/get/start Capsule runtime methods',
      );
    }
    this.runtime = runtime;
    this.registry = registry;
    this.now = now;
    this.makeId = makeId;
  }

  capabilities() {
    const productRoutes = this.runtime.capabilities?.();
    return {
      schema: 'kungfu.agent-session.surface-capabilities/v1',
      actions: [
        'capabilities',
        'resolve-console',
        'list',
        'show',
        'plan-start',
        'start',
        'attach',
        'detach',
        'status',
        'snapshot',
        'plan-control',
        'acquire-control',
        'release-control',
        'instruct',
        'send-key',
        'interrupt',
        ...(productRoutes ? ['respond-control'] : []),
        'end',
      ],
      clients: ['gui', 'cli', 'kfd3-agent'],
      projections: [
        'go-card',
        'assistant-console',
        'console-hub',
        'presentation',
      ],
      authority: 'agent-session-capsule-interaction-port',
      registryAuthority: WORK_CONSOLE_REGISTRY_SCHEMA,
      workMutationAuthority: 'profile-kfd3-actions-only',
      rawHumanFallback: 'current-controller-only',
      receipts: {
        delivery: 'validated-input-written-to-pty-only',
        semanticOutcome: null,
        workState: null,
      },
      knownLimits: [
        'terminal-status-does-not-update-cost-state-or-proof',
        'presentation-close-does-not-end-provider',
        'unknown-or-approval-state-never-auto-delivers',
        'capsule-worker-loss-ends-the-old-attempt-and-cannot-fake-continuity',
        'machine-reboot-requires-a-new-attempt-or-provider-resume',
      ],
      ...(productRoutes ? { providerRoutes: productRoutes } : {}),
    };
  }

  list() {
    const runtimeSessions = this.runtime.list();
    this.registry.observe(runtimeSessions);
    const sessions = runtimeSessions.map((session) => publicStatus(session));
    const consoles = this.registry.snapshot().consoles;
    const liveByAttempt = new Map(
      sessions.map((session) => [
        sessionKey(session.workConsoleId, session.sessionAttemptId),
        session,
      ]),
    );
    const attempts = consoles.flatMap((console) =>
      console.attempts.map((attempt) => {
        const live = liveByAttempt.get(
          sessionKey(console.consoleId, attempt.sessionAttemptId),
        );
        return {
          schema: 'kungfu.agent-session.attempt-presentation/v1',
          workConsoleId: console.consoleId,
          sessionAttemptId: attempt.sessionAttemptId,
          provider: attempt.provider,
          live: Boolean(live),
          lifecycleState: live?.lifecycleState ?? attempt.status,
          interactionState: live?.interactionState ?? 'unavailable',
          inputAdmission: live?.inputAdmission ?? 'closed',
          queuedInstructions: live?.queuedInstructions ?? 0,
          providerAdapter: live?.providerAdapter ?? {
            provider: attempt.provider,
            providerVersion: attempt.providerVersion,
            compatible: false,
            reason: 'attempt-not-live',
          },
          product:
            live?.product ??
            agentSessionProductState({ attemptStatus: attempt.status }),
        };
      }),
    );
    return {
      schema: 'kungfu.agent-session.surface-list/v1',
      sessions,
      consoles,
      attempts,
      listRoot: agentSessionSurfaceRoot({ sessions, consoles, attempts }),
    };
  }

  show(ref) {
    const normalized = sessionRef(ref);
    const session = this.runtime.get(normalized);
    if (!session) {
      const projection = this.registry.projection(normalized);
      if (!projection) {
        throw new AgentSessionSurfaceError(
          'session_not_found',
          `session '${normalized.sessionAttemptId}' is unavailable`,
        );
      }
      return {
        schema: 'kungfu.agent-session.surface-status/v1',
        workConsoleId: normalized.workConsoleId,
        sessionAttemptId: normalized.sessionAttemptId,
        live: false,
        lifecycleState: projection.attempt.status,
        interactionState: 'unavailable',
        inputAdmission: 'closed',
        foreground: null,
        output: null,
        providerAdapter: {
          provider: projection.attempt.provider,
          providerVersion: projection.attempt.providerVersion,
          compatible: false,
          reason: 'worker-runtime-continuity-lost',
        },
        queuedInstructions: [],
        binding: projection.console.binding,
        attachments: [],
        controller: null,
        workOutcome: null,
        proof: null,
        product: agentSessionProductState({
          attemptStatus: projection.attempt.status,
        }),
        console: projection.console,
        attempt: projection.attempt,
      };
    }
    this.registry.observe([session]);
    const status = publicStatus(session);
    const projection = this.registry.projection(ref);
    return {
      ...status,
      console: projection?.console ?? null,
      attempt: projection?.attempt ?? null,
    };
  }

  resolveConsole(input) {
    return this.registry.resolve(input);
  }

  planStart(input) {
    const binding = input.binding ?? {
      kind: 'workspace-assistant',
      workRef: null,
    };
    if (!['work', 'workspace-assistant'].includes(binding.kind)) {
      throw new AgentSessionSurfaceError(
        'invalid_argument',
        `unsupported binding kind '${String(binding.kind)}'`,
      );
    }
    if (
      binding.kind === 'work' &&
      (!binding.workRef || typeof binding.workRef !== 'object')
    ) {
      throw new AgentSessionSurfaceError(
        'invalid_argument',
        'work binding requires a WorkRef',
      );
    }
    const resolution = this.registry.resolve({
      workspaceId: input.workspaceId,
      workConsoleId: input.workConsoleId,
      binding,
    });
    const consoleId = resolution.workConsoleId;
    const existing = this.runtime
      .list()
      .find(
        (session) =>
          session.workConsoleId === consoleId &&
          publicStatus(session).lifecycleState !== 'ended',
      );
    const existingStatus = existing ? publicStatus(existing) : null;
    let fallback = null;
    let fallbackSession = null;
    let fallbackStatus = null;
    if (input.fallbackFrom) {
      const previous = this.#session(input.fallbackFrom);
      const previousStatus = publicStatus(previous);
      if (
        previousStatus.transportRoute?.kind !== 'structured' ||
        previousStatus.lifecycleState !== 'ended' ||
        !['unknown', 'interrupted'].includes(previousStatus.attemptBoundary)
      ) {
        throw new AgentSessionSurfaceError(
          'fallback_not_ready',
          'fallback requires an ended structured attempt boundary',
        );
      }
      if (previous.sessionAttemptId === input.sessionAttemptId) {
        throw new AgentSessionSurfaceError(
          'hot_switch_forbidden',
          'fallback must create a new session attempt',
        );
      }
      if (previous.workConsoleId !== consoleId) {
        throw new AgentSessionSurfaceError(
          'fallback_console_mismatch',
          'fallback must preserve the original WorkConsole identity',
        );
      }
      if (input.provider !== previousStatus.foreground.provider) {
        throw new AgentSessionSurfaceError(
          'fallback_provider_mismatch',
          'fallback must preserve the original provider identity',
        );
      }
      fallbackSession = previous;
      fallbackStatus = previousStatus;
      fallback = {
        workConsoleId: previous.workConsoleId,
        sessionAttemptId: previous.sessionAttemptId,
        boundary: previousStatus.attemptBoundary,
      };
    }
    const transportRoute =
      existingStatus?.transportRoute ?? this.runtime.planRoute?.(input) ?? null;
    const structured = transportRoute
      ? {
          initializeParams: input.structured?.initializeParams ?? {
            clientInfo: {
              name: 'kungfu-agent-session',
              version: '4.0.0-alpha.0',
            },
          },
          threadStartParams: input.structured?.threadStartParams ?? {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            approvalPolicy: 'untrusted',
            approvalsReviewer: 'user',
            sandbox: 'read-only',
          },
        }
      : null;
    const registeredConsole = this.registry.console(consoleId);
    const body = {
      schema: 'kungfu.agent-session.start-plan/v1',
      operation: existing ? 'attach-existing' : 'start',
      workspaceId: resolution.workspaceId,
      workConsoleId: consoleId,
      sessionAttemptId: existing
        ? existing.sessionAttemptId
        : required(input.sessionAttemptId, 'sessionAttemptId'),
      provider:
        existingStatus?.foreground.provider ??
        fallbackStatus?.foreground.provider ??
        required(input.provider, 'provider'),
      providerVersion:
        existingStatus?.providerAdapter.providerVersion ??
        fallbackStatus?.providerAdapter.providerVersion ??
        required(input.providerVersion, 'providerVersion'),
      profileRoot:
        existingStatus?.foreground.profileRoot ??
        fallbackStatus?.foreground.profileRoot ??
        required(input.profileRoot, 'profileRoot'),
      executable:
        existingStatus?.foreground.executable ??
        fallbackStatus?.foreground.executable ??
        required(input.executable, 'executable'),
      argv:
        existingStatus?.foreground.argv ??
        transportRoute?.argv ??
        (Array.isArray(input.argv) ? [...input.argv] : []),
      cwd: existing ? null : (input.cwd ?? null),
      environmentNames: existing ? [] : Object.keys(input.env ?? {}).sort(),
      binding: existing?.binding ?? fallbackSession?.binding ?? binding,
      runtimeProfileId:
        registeredConsole?.runtimeProfileId ??
        input.runtimeProfileId ??
        existingStatus?.providerAdapter.provider ??
        'unknown',
      backend: transportRoute?.kind === 'structured' ? 'structured' : 'capsule',
      effects: existing
        ? ['attach-presentation-to-existing-capsule']
        : transportRoute
          ? [
              'spawn-codex-app-server-direct-stdio',
              'start-one-provider-thread',
              'register-session',
              'attach-presentation',
            ]
          : fallback
            ? [
                'create-new-pty-attempt-only',
                'preserve-old-structured-receipts',
                'attach-presentation',
              ]
            : [
                'spawn-provider-in-capsule',
                'register-session',
                'attach-presentation',
              ],
      workEffects: [],
      rollback: existing ? 'detach-presentation' : 'end-new-session-attempt',
      ...(transportRoute ? { transportRoute, structured } : {}),
      ...(fallback ? { fallbackFrom: fallback } : {}),
    };
    const plan = { ...body, root: agentSessionSurfaceRoot(body) };
    this.registry.recordPlan(plan);
    return plan;
  }

  start({ actorId, client, plan, expectedPlanRoot, attachment, execution }) {
    required(actorId, 'actorId');
    required(client, 'client');
    this.#verifyPlan(plan, expectedPlanRoot, 'start');
    let session = this.runtime.get({
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
    });
    let reused = true;
    if (!session) {
      if (plan.operation !== 'start') {
        throw new AgentSessionSurfaceError(
          'stale_plan',
          'planned existing session is no longer available',
        );
      }
      const started = this.runtime.start(plan, execution);
      if (started && typeof started.then === 'function') {
        return started.then((resolved) =>
          this.#finishStart({
            actorId,
            client,
            plan,
            attachment,
            session: resolved,
            reused: false,
          }),
        );
      }
      session = started;
      reused = false;
    } else if (plan.operation !== 'attach-existing') {
      throw new AgentSessionSurfaceError(
        'stale_plan',
        'start plan would duplicate an existing live WorkConsole',
      );
    }
    return this.#finishStart({
      actorId,
      client,
      plan,
      attachment,
      session,
      reused,
    });
  }

  attach({
    actorId,
    client,
    session: ref,
    attachment = {},
    acquireControl = false,
  }) {
    return this.#attach(this.#session(ref), {
      actorId,
      client,
      attachment,
      acquireControl,
    });
  }

  detach({ actorId, session: ref, attachmentId }) {
    const session = this.#session(ref);
    const current = session.attachments.get(
      required(attachmentId, 'attachmentId'),
    );
    if (!current) {
      throw new AgentSessionSurfaceError(
        'attachment_not_found',
        `attachment '${attachmentId}' is not active`,
      );
    }
    if (current.actorId !== required(actorId, 'actorId')) {
      throw new AgentSessionSurfaceError(
        'attachment_owner_mismatch',
        'only the attachment owner may detach it',
      );
    }
    session.transport.detach({ attachmentId, actorId });
    session.attachments.delete(attachmentId);
    const result = receipt(
      'detach',
      actorId,
      {
        status: 'detached',
        workConsoleId: session.workConsoleId,
        sessionAttemptId: session.sessionAttemptId,
        attachmentId,
        providerEnded: false,
      },
      this.now,
    );
    this.registry.recordReceipt(ref, result);
    return result;
  }

  planControl({ operation, session: ref, payload = {} }) {
    if (!CONTROL_OPERATIONS.has(operation)) {
      throw new AgentSessionSurfaceError(
        'invalid_argument',
        `unsupported control operation '${String(operation)}'`,
      );
    }
    const session = this.#session(ref);
    const status = publicStatus(session);
    if (
      operation === 'respond-control' &&
      status.transportRoute?.kind !== 'structured'
    ) {
      throw new AgentSessionSurfaceError(
        'unsupported_operation',
        'provider control responses require a structured route',
      );
    }
    const body = {
      schema: 'kungfu.agent-session.control-plan/v1',
      operation,
      workConsoleId: session.workConsoleId,
      sessionAttemptId: session.sessionAttemptId,
      capsuleGeneration: status.capsuleGeneration,
      coordinatorEpoch: status.coordinatorEpoch,
      sessionStreamEpoch: status.sessionStreamEpoch,
      foregroundRoot: agentSessionSurfaceRoot(status.foreground),
      controllerRoot: agentSessionSurfaceRoot(status.controller),
      payloadRoot: agentSessionSurfaceRoot(payload),
      effects:
        operation === 'acquire-control'
          ? ['request-controller-lease']
          : operation === 'release-control'
            ? ['release-exact-controller-lease']
            : operation === 'end'
              ? ['end-exact-provider-attempt']
              : operation === 'interrupt'
                ? ['signal-exact-provider-attempt']
                : operation === 'respond-control'
                  ? ['respond-to-exact-provider-control-request']
                  : ['deliver-to-exact-provider-pty'],
      workEffects: [],
      proves:
        operation === 'acquire-control' || operation === 'release-control'
          ? 'controller-lease-decision-only'
          : operation === 'end'
            ? 'control-request-delivery-only'
            : operation === 'respond-control'
              ? 'provider-control-response-written-only'
              : 'validated-input-written-to-pty-only',
      ...(status.transportRoute
        ? { transportRoute: status.transportRoute }
        : {}),
    };
    return { ...body, root: agentSessionSurfaceRoot(body) };
  }

  control({ actorId, plan, expectedPlanRoot, payload = {}, automatic = true }) {
    required(actorId, 'actorId');
    this.#verifyPlan(plan, expectedPlanRoot, plan.operation);
    if (agentSessionSurfaceRoot(payload) !== plan.payloadRoot) {
      throw new AgentSessionSurfaceError(
        'payload_root_mismatch',
        'control payload changed after plan review',
      );
    }
    const session = this.#session(plan);
    const status = session.port.status();
    const controllerRoot = agentSessionSurfaceRoot(
      publicStatus(session).controller,
    );
    if (
      String(status.capsuleGeneration) !== String(plan.capsuleGeneration) ||
      String(status.coordinatorEpoch) !== String(plan.coordinatorEpoch) ||
      String(status.sessionStreamEpoch) !== String(plan.sessionStreamEpoch) ||
      agentSessionSurfaceRoot(status.foreground) !== plan.foregroundRoot ||
      controllerRoot !== plan.controllerRoot
    ) {
      throw new AgentSessionSurfaceError(
        'stale_plan',
        'session authority changed after plan review',
      );
    }
    let result;
    if (plan.operation === 'acquire-control') {
      result = session.transport.acquireControl({
        leaseId: payload.leaseId ?? `lease:${this.makeId()}`,
        holderId: actorId,
        planRoot: plan.root,
        ttlMs: payload.ttlMs,
      });
    } else if (plan.operation === 'release-control') {
      const controller = session.transport.status().controllerLease;
      result = session.transport.releaseControl({
        leaseId: controller?.leaseId,
        holderId: actorId,
        planRoot: plan.root,
      });
    } else {
      const request = {
        ...session.authority(actorId),
        actionId: `surface-action:${this.makeId()}`,
        inputId: `surface-input:${this.makeId()}`,
        automatic,
        ...payload,
      };
      if (plan.operation === 'instruct')
        result = session.port.instruct(request);
      else if (plan.operation === 'send-key')
        result = session.port.sendKey(request);
      else if (plan.operation === 'interrupt')
        result = session.port.interrupt(request);
      else if (plan.operation === 'respond-control')
        result = session.port.respondControl(request);
      else result = session.end(request);
    }
    const finish = (resolved) => {
      const receiptValue = receipt(
        plan.operation,
        actorId,
        {
          status: resolved.status,
          reason: resolved.reason ?? null,
          planRoot: plan.root,
          workConsoleId: session.workConsoleId,
          sessionAttemptId: session.sessionAttemptId,
          deliveryReceipt: resolved.deliveryReceipt ?? null,
          controlReceipt: resolved.controlReceipt ?? resolved,
          ...(publicStatus(session).transportRoute
            ? { transportRoute: publicStatus(session).transportRoute }
            : {}),
        },
        this.now,
      );
      this.registry.recordReceipt(plan, receiptValue);
      this.registry.observe([session]);
      return receiptValue;
    };
    if (result && typeof result.then === 'function') return result.then(finish);
    return finish(result);
  }

  invoke(request) {
    const operation = required(request.operation, 'operation');
    if (operation === 'resolve-console') {
      return this.resolveConsole(request.input ?? request);
    }
    if (READ_OPERATIONS.has(operation)) {
      if (operation === 'capabilities') return this.capabilities();
      if (operation === 'list') return this.list();
      if (operation === 'show' || operation === 'status')
        return this.show(request.session);
      return this.#session(request.session).port.snapshot({
        requestedSequence: request.requestedSequence ?? 0,
      });
    }
    if (operation === 'plan-start') return this.planStart(request.input ?? {});
    if (operation === 'start') return this.start(request);
    if (operation === 'attach') return this.attach(request);
    if (operation === 'detach') return this.detach(request);
    if (operation === 'plan-control') {
      return this.planControl({
        ...request,
        operation: request.controlOperation,
      });
    }
    if (CONTROL_OPERATIONS.has(operation)) return this.control(request);
    throw new AgentSessionSurfaceError(
      'unknown_operation',
      `unknown Agent Session operation '${operation}'`,
    );
  }

  #attach(session, { actorId, client, attachment, acquireControl }) {
    required(actorId, 'actorId');
    required(client, 'client');
    const attachmentId =
      attachment.attachmentId ?? `attachment:${this.makeId()}`;
    const existing = session.attachments.get(attachmentId);
    if (!existing) {
      session.transport.attach({ attachmentId, actorId, fromSequence: 0 });
    }
    let controller = false;
    const activeController = session.transport.status().controllerLease;
    if (acquireControl && !activeController) {
      const leaseId = `lease:${this.makeId()}`;
      const lease = session.transport.acquireControl({
        leaseId,
        holderId: actorId,
        planRoot: `surface-attach:${attachmentId}`,
      });
      controller = lease.status === 'granted' || lease.status === 'duplicate';
    } else if (activeController?.holderId === actorId) {
      controller = true;
    }
    session.attachments.set(attachmentId, {
      attachmentId,
      actorId,
      surface: client,
      presentation: attachment.presentation ?? 'headless',
      attachedAt: this.now(),
    });
    const result = receipt(
      'attach',
      actorId,
      {
        status: existing ? 'already-attached' : 'attached',
        workConsoleId: session.workConsoleId,
        sessionAttemptId: session.sessionAttemptId,
        attachmentId,
        controller,
        providerStarted: false,
      },
      this.now,
    );
    this.registry.recordReceipt(session, result);
    return result;
  }

  #finishStart({ actorId, client, plan, attachment, session, reused }) {
    const attachReceipt = this.#attach(session, {
      actorId,
      client,
      attachment: attachment ?? {},
      acquireControl: !session.controller,
    });
    const status = publicStatus(session);
    const result = receipt(
      'start',
      actorId,
      {
        status: reused ? 'reused' : 'started',
        planRoot: plan.root,
        workConsoleId: session.workConsoleId,
        sessionAttemptId: session.sessionAttemptId,
        capsuleId: session.port.status().capsuleId,
        autoAttached: true,
        attachReceipt,
        ...(status.transportRoute
          ? { transportRoute: status.transportRoute }
          : {}),
      },
      this.now,
    );
    this.registry.recordStarted(plan, result);
    return result;
  }

  #session(ref) {
    const normalized = sessionRef(ref);
    const session = this.runtime.get(normalized);
    if (!session) {
      throw new AgentSessionSurfaceError(
        'session_not_found',
        `session '${normalized.sessionAttemptId}' is unavailable`,
      );
    }
    return session;
  }

  #verifyPlan(plan, expectedPlanRoot, operation) {
    if (!plan || typeof plan !== 'object') {
      throw new AgentSessionSurfaceError('invalid_plan', 'plan is required');
    }
    required(expectedPlanRoot, 'expectedPlanRoot');
    if (plan.root !== expectedPlanRoot || planRoot(plan) !== expectedPlanRoot) {
      throw new AgentSessionSurfaceError(
        'plan_root_mismatch',
        `${operation} plan changed after review`,
      );
    }
  }
}

export function createAgentSessionSurfaceClient({ invoke, client, actorId }) {
  if (typeof invoke !== 'function') {
    throw new AgentSessionSurfaceError(
      'invalid_transport',
      'surface client requires invoke()',
    );
  }
  required(client, 'client');
  required(actorId, 'actorId');
  return Object.freeze({
    capabilities: () => invoke({ operation: 'capabilities', client, actorId }),
    resolveConsole: (input) =>
      invoke({ operation: 'resolve-console', client, actorId, input }),
    list: () => invoke({ operation: 'list', client, actorId }),
    show: (session) => invoke({ operation: 'show', client, actorId, session }),
    planStart: (input) =>
      invoke({ operation: 'plan-start', client, actorId, input }),
    start: (plan, attachment, execution) =>
      invoke({
        operation: 'start',
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
        attachment,
        execution,
      }),
    attach: (session, attachment, acquireControl = false) =>
      invoke({
        operation: 'attach',
        client,
        actorId,
        session,
        attachment,
        acquireControl,
      }),
    detach: (session, attachmentId) =>
      invoke({ operation: 'detach', actorId, session, attachmentId }),
    acquireControl: (session, payload = {}) => {
      const plan = invoke({
        operation: 'plan-control',
        controlOperation: 'acquire-control',
        client,
        actorId,
        session,
        payload,
      });
      return invoke({
        operation: 'acquire-control',
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
        payload,
      });
    },
    releaseControl: (session, payload = {}) => {
      const plan = invoke({
        operation: 'plan-control',
        controlOperation: 'release-control',
        client,
        actorId,
        session,
        payload,
      });
      return invoke({
        operation: 'release-control',
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
        payload,
      });
    },
    planControl: (operation, session, payload) =>
      invoke({
        operation: 'plan-control',
        controlOperation: operation,
        client,
        actorId,
        session,
        payload,
      }),
    control: (plan, payload, automatic = true) =>
      invoke({
        operation: plan.operation,
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
        payload,
        automatic,
      }),
  });
}
