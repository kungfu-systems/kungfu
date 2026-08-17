import { createHash, randomUUID } from 'node:crypto';
import { projectWorkAgentState } from './work-attention.mjs';
import {
  WORK_CONSOLE_REGISTRY_SCHEMA,
  WorkConsoleRegistry,
  normalizeNativeBootstrap,
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
  'wait-status-change',
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

function nativeWorkObservation(value) {
  if (value == null) return null;
  const requiredFields = [
    'assignmentId',
    'continuation',
    'evidenceEpisodeRoots',
    'initiativeId',
    'nextAction',
    'nextActions',
    'phase',
    'queryProofRoot',
    'remainingObligation',
    'schema',
    'state',
  ];
  const optionalFields = ['acceptanceChecks', 'objective', 'title'];
  const fields = Object.keys(value);
  if (
    typeof value !== 'object' ||
    !requiredFields.every((field) => fields.includes(field)) ||
    fields.some(
      (field) =>
        !requiredFields.includes(field) && !optionalFields.includes(field),
    ) ||
    value.schema !== 'kungfu.native-work-observation/v1' ||
    !['none', 'ambiguous', 'available', 'degraded', 'unknown'].includes(
      value.state,
    ) ||
    typeof value.initiativeId !== 'string' ||
    typeof value.assignmentId !== 'string' ||
    ![value.phase, value.remainingObligation, value.nextAction].every(
      (candidate) => candidate === null || typeof candidate === 'string',
    ) ||
    !Array.isArray(value.nextActions) ||
    !value.nextActions.every((candidate) => typeof candidate === 'string') ||
    ![value.title, value.objective].every(
      (candidate) => candidate === undefined || typeof candidate === 'string',
    ) ||
    (value.acceptanceChecks !== undefined &&
      (!Array.isArray(value.acceptanceChecks) ||
        !value.acceptanceChecks.every(
          (candidate) => typeof candidate === 'string',
        ))) ||
    !Array.isArray(value.evidenceEpisodeRoots) ||
    !value.evidenceEpisodeRoots.every((root) =>
      /^sha256:[a-f0-9]{64}$/u.test(root),
    ) ||
    (value.queryProofRoot !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.queryProofRoot))
  ) {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      'native Work observation must use the exact public Core projection',
    );
  }
  const continuation = value.continuation;
  const continuationFields = [
    'completionClaimCount',
    'continuationDecisionCount',
    'independentReviewCount',
  ];
  if (
    !continuation ||
    typeof continuation !== 'object' ||
    Object.keys(continuation).sort().join('\u0000') !==
      continuationFields.sort().join('\u0000') ||
    !continuationFields.every(
      (field) =>
        Number.isInteger(continuation[field]) && continuation[field] >= 0,
    )
  ) {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      'native Work continuation counts must be non-negative integers',
    );
  }
  return structuredClone(value);
}

function nativeWorkProjection(value) {
  if (!value || typeof value !== 'object') {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      'native Work projection is required',
    );
  }
  const requiredFields = [
    'schema',
    'workRefRoot',
    'state',
    'observedAt',
    'source',
    'queryCount',
    'queryProofRoot',
    'work',
    'diagnostic',
  ];
  if (
    Object.keys(value).sort().join('\u0000') !==
      requiredFields.sort().join('\u0000') ||
    value.schema !== 'kungfu.native-work-projection/v1' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.workRefRoot) ||
    !['fresh', 'stale', 'degraded', 'unknown'].includes(value.state) ||
    typeof value.observedAt !== 'number' ||
    !['initial', 'invalidation', 'bounded-fallback'].includes(value.source) ||
    !Number.isInteger(value.queryCount) ||
    value.queryCount < 1 ||
    (value.queryProofRoot !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.queryProofRoot)) ||
    (value.diagnostic !== null && typeof value.diagnostic !== 'string')
  ) {
    throw new AgentSessionSurfaceError(
      'invalid_argument',
      'native Work projection must use the exact bounded projection contract',
    );
  }
  return {
    ...structuredClone(value),
    work: nativeWorkObservation(value.work),
  };
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
  const live =
    status.lifecycleState !== 'ended' && status.inputAdmission !== 'closed';
  const exit =
    status.exit && session.endControl
      ? { ...status.exit, controlRequest: { ...session.endControl } }
      : status.exit;
  const statusProjection = {
    schema: 'kungfu.agent-session.surface-status/v1',
    live,
    terminalObservable: true,
    controllable: live,
    workConsoleId: status.workConsoleId,
    sessionAttemptId: status.sessionAttemptId,
    capsuleId: status.capsuleId,
    capsuleGeneration: status.capsuleGeneration,
    coordinatorEpoch: status.coordinatorEpoch,
    sessionStreamEpoch: status.sessionStreamEpoch,
    changeSequence: status.changeSequence,
    lifecycleState: status.lifecycleState,
    interactionState: status.interactionState,
    inputAdmission: status.inputAdmission,
    foreground: status.foreground,
    output: status.output,
    exit,
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
    receiptRoots: [],
    product: agentSessionProductState({
      live,
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
  return {
    ...statusProjection,
    workAgent: projectWorkAgentState(statusProjection),
  };
}

function nativeAttemptStatus(projection, now) {
  const { console, attempt, activeWorkLease = null } = projection;
  const observer = attempt.observer ?? {
    state: 'unknown',
    observedAt: 0,
    staleAfterMs: 2000,
    processIdentityRoot: '',
    work: null,
    diagnostic: 'native-observer-metadata-unavailable',
  };
  const ageMs = Math.max(0, now - observer.observedAt);
  const ended = attempt.status === 'exited';
  const observerState = ended
    ? 'disconnected'
    : ageMs > Math.max(observer.staleAfterMs, 5000)
      ? 'stale'
      : observer.state;
  const processObserved =
    !ended && !['stale', 'disconnected'].includes(observerState);
  const coherentWork = attempt.workProjection?.work ?? null;
  const workBlocked = coherentWork?.phase === 'blocked';
  const attention = ended
    ? {
        kind: 'ready-for-review',
        reason: 'native-agent-attempt-ended',
        message:
          'The native Agent process ended. Review Core Work evidence before completion.',
        nextActions: ['inspect-work-status', 'review-project-changes'],
      }
    : workBlocked
      ? {
          kind: 'blocked',
          reason: 'work-control-reports-blocked',
          message:
            'Work Control reports that this Work is blocked. Inspect its current obligation and next action.',
          nextActions: ['inspect-work-status', 'resolve-work-blocker'],
        }
      : null;
  return {
    schema: 'kungfu.agent-session.surface-status/v1',
    live: processObserved,
    workspaceId: console.workspaceId,
    backend: 'native-interactive',
    terminalObservable: false,
    controllable: false,
    workConsoleId: console.consoleId,
    sessionAttemptId: attempt.sessionAttemptId,
    lifecycleState: ended ? 'ended' : processObserved ? 'running' : 'unknown',
    interactionState: 'external-native-ui',
    inputAdmission: 'closed',
    foreground: null,
    output: null,
    exit: attempt.exit ?? null,
    providerAdapter: {
      provider: attempt.provider,
      providerVersion: attempt.providerVersion,
      compatible: true,
      reason: 'native-ui-owned-by-provider-terminal',
    },
    queuedInstructions: [],
    binding: attempt.workBinding ?? console.binding,
    attachments: [],
    controller: null,
    workOutcome: null,
    proof: null,
    receiptRoots: attempt.receipts
      .map((receiptValue) => receiptValue.receiptRoot)
      .filter(Boolean),
    product: {
      schema: 'kungfu.agent-session.product-state/v1',
      state: ended
        ? 'ended'
        : observerState === 'fresh'
          ? 'working'
          : 'action-required',
      reason: ended
        ? 'attempt-ended'
        : observerState === 'fresh'
          ? 'native-provider-working'
          : `native-observer-${observerState}`,
      recommendedAction: ended
        ? 'review-work-evidence'
        : observerState === 'fresh'
          ? null
          : 'continue-in-native-ui-or-inspect-work-status',
    },
    workAgent: {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: ended
        ? 'ended'
        : observerState === 'fresh'
          ? 'working'
          : 'waiting',
      attention,
    },
    nativeObserver: {
      ...observer,
      state: observerState,
      ageMs,
      work: coherentWork,
      workProjection: attempt.workProjection ?? null,
    },
    bootstrap: attempt.bootstrap,
    activeWorkLease,
    console,
    attempt,
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
        'plan-native-start',
        'start-native',
        'plan-native-bind-work',
        'bind-native-work',
        'heartbeat-native',
        'project-native-work',
        'end-native',
        'attach',
        'detach',
        'status',
        'wait-status-change',
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
      terminalAuthorities: {
        capsule: 'agent-session-capsule',
        structured: 'provider-structured-transport',
        nativeInteractive: 'provider-native-terminal',
      },
      nativeObserverAuthority: 'core-work-status-plus-exact-launcher-heartbeat',
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
        'native-interactive-attempts-expose-no-terminal-bytes-or-tui-input-control',
      ],
      ...(productRoutes ? { providerRoutes: productRoutes } : {}),
    };
  }

  list() {
    const runtimeSessions = this.runtime.list();
    this.registry.observe(runtimeSessions);
    const sessions = runtimeSessions.map((session) => publicStatus(session));
    const registry = this.registry.snapshot();
    const consoles = registry.consoles;
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
        const nativeStatus =
          attempt.backend === 'native-interactive'
            ? nativeAttemptStatus({ console, attempt }, this.now())
            : null;
        return {
          schema: 'kungfu.agent-session.attempt-presentation/v1',
          workConsoleId: console.consoleId,
          sessionAttemptId: attempt.sessionAttemptId,
          provider: attempt.provider,
          runtimeProfileId: attempt.runtimeProfileId,
          workspaceId: console.workspaceId,
          binding: nativeStatus?.binding ?? console.binding,
          backend: attempt.backend,
          live: nativeStatus?.live ?? live?.live ?? false,
          terminalObservable:
            nativeStatus?.terminalObservable ??
            live?.terminalObservable ??
            false,
          controllable:
            nativeStatus?.controllable ?? live?.controllable ?? false,
          lifecycleState:
            nativeStatus?.lifecycleState ??
            live?.lifecycleState ??
            attempt.status,
          interactionState:
            nativeStatus?.interactionState ??
            live?.interactionState ??
            'unavailable',
          inputAdmission:
            nativeStatus?.inputAdmission ?? live?.inputAdmission ?? 'closed',
          queuedInstructions: live?.queuedInstructions ?? 0,
          providerAdapter: nativeStatus?.providerAdapter ??
            live?.providerAdapter ?? {
              provider: attempt.provider,
              providerVersion: attempt.providerVersion,
              compatible: false,
              reason: 'attempt-not-live',
            },
          product:
            nativeStatus?.product ??
            live?.product ??
            agentSessionProductState({ attemptStatus: attempt.status }),
          workAgent: nativeStatus?.workAgent ?? live?.workAgent ?? null,
          nativeObserver: nativeStatus?.nativeObserver ?? null,
          bootstrap: nativeStatus?.bootstrap ?? attempt.bootstrap,
          receiptRoots: nativeStatus?.receiptRoots ?? [],
        };
      }),
    );
    return {
      schema: 'kungfu.agent-session.surface-list/v1',
      sessions,
      consoles,
      activeWorkLeases: registry.activeWorkLeases,
      attempts,
      listRoot: agentSessionSurfaceRoot({
        sessions,
        consoles,
        activeWorkLeases: registry.activeWorkLeases,
        attempts,
      }),
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
      if (projection.attempt.backend === 'native-interactive') {
        return nativeAttemptStatus(projection, this.now());
      }
      return {
        schema: 'kungfu.agent-session.surface-status/v1',
        workConsoleId: normalized.workConsoleId,
        sessionAttemptId: normalized.sessionAttemptId,
        live: false,
        terminalObservable: false,
        controllable: false,
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

  async waitStatusChange({ session: ref, afterChangeSequence }) {
    const normalized = sessionRef(ref);
    const session = this.runtime.get(normalized);
    if (!session || typeof session.waitForStatusChange !== 'function') {
      throw new AgentSessionSurfaceError(
        'unsupported_operation',
        'event-driven status changes are unavailable for this Agent Session',
      );
    }
    await session.waitForStatusChange(afterChangeSequence);
    return this.show(normalized);
  }

  resolveConsole(input) {
    return this.registry.resolve(input);
  }

  planNativeStart(input) {
    const binding = input.binding ?? {
      kind: 'workspace-assistant',
      workRef: null,
    };
    const resolution = this.registry.resolve({
      workspaceId: input.workspaceId,
      workConsoleId: input.workConsoleId,
      binding,
    });
    const registered = this.registry.console(resolution.workConsoleId);
    const workConflict = this.registry.activeWorkConflict(resolution.binding, {
      workConsoleId: resolution.workConsoleId,
      sessionAttemptId: input.sessionAttemptId,
    });
    const active =
      workConflict?.attempt ??
      registered?.attempts.find((attempt) =>
        ['planned', 'running', 'detached'].includes(attempt.status),
      );
    if (active && active.sessionAttemptId !== input.sessionAttemptId) {
      const activeProvider = active.provider ?? 'unknown provider';
      const requestedProvider = input.provider ?? 'requested provider';
      throw new AgentSessionSurfaceError(
        'native_attempt_already_active',
        [
          'Another Agent is already active for this Work.',
          `WorkConsole: ${resolution.workConsoleId}`,
          `Active Agent: ${activeProvider} (attempt ${active.sessionAttemptId}, status ${active.status})`,
          `Requested Agent: ${requestedProvider}`,
          '',
          'Kungfu permits one active Agent per WorkConsole to protect single-writer continuity. This is expected behavior, not a system failure.',
          `Next: exit the active Agent normally, then retry \`kungfu run ${requestedProvider}\`.`,
          'For parallel Agents, use separate Work items so they resolve to separate WorkConsoles.',
        ].join('\n'),
      );
    }
    const sessionAttemptId = required(
      input.sessionAttemptId,
      'sessionAttemptId',
    );
    const body = {
      schema: 'kungfu.agent-session.native-start-plan/v1',
      operation: 'native-start',
      workspaceId: resolution.workspaceId,
      workConsoleId: resolution.workConsoleId,
      sessionAttemptId,
      provider: required(input.provider, 'provider'),
      providerVersion: required(input.providerVersion, 'providerVersion'),
      profileRoot: required(input.profileRoot, 'profileRoot'),
      runtimeProfileId:
        input.runtimeProfileId ?? registered?.runtimeProfileId ?? 'unknown',
      backend: 'native-interactive',
      bootstrap: normalizeNativeBootstrap(input.bootstrap, sessionAttemptId),
      binding: resolution.binding,
      effects: [
        'register-native-provider-attempt',
        'observe-metadata-without-terminal-capture',
      ],
      workEffects: [],
      rollback: 'end-native-attempt-record-only',
    };
    const plan = { ...body, root: agentSessionSurfaceRoot(body) };
    this.registry.recordPlan(plan);
    return plan;
  }

  planNativeBindWork({
    session: ref,
    workRef,
    bindingScope = 'same-project',
    sourceWorkspaceId = null,
  }) {
    const normalized = sessionRef(ref);
    const projection = this.registry.projection(normalized);
    if (!projection || projection.attempt.backend !== 'native-interactive') {
      throw new AgentSessionSurfaceError(
        'session_not_found',
        'native SessionAttempt is unavailable',
      );
    }
    const consoleWorkspaceId = projection.console.workspaceId;
    const declaredSourceWorkspaceId = sourceWorkspaceId ?? consoleWorkspaceId;
    if (declaredSourceWorkspaceId !== consoleWorkspaceId) {
      throw new AgentSessionSurfaceError(
        'work_binding_source_mismatch',
        'native Work binding source differs from the Agent Console workspace',
      );
    }
    const externalProject = workRef.workspaceId !== consoleWorkspaceId;
    if (
      (externalProject && bindingScope !== 'explicit-external-project') ||
      (!externalProject && bindingScope !== 'same-project')
    ) {
      throw new AgentSessionSurfaceError(
        'work_workspace_mismatch',
        'external Project Work requires an explicit cross-project binding scope',
      );
    }
    const binding = { kind: 'work', workRef };
    const conflict = this.registry.activeWorkConflict(binding, normalized);
    if (conflict) this.#throwNativeWorkConflict(conflict, workRef);
    const body = {
      schema: 'kungfu.agent-session.native-bind-work-plan/v1',
      operation: 'native-bind-work',
      workConsoleId: normalized.workConsoleId,
      sessionAttemptId: normalized.sessionAttemptId,
      workRef: structuredClone(workRef),
      bindingScope,
      sourceWorkspaceId: declaredSourceWorkspaceId,
      effects: ['replace-native-attempt-current-work-observation'],
      workEffects: [],
      rollback: 'bind-the-prior-work-again-or-end-native-attempt',
    };
    return { ...body, root: agentSessionSurfaceRoot(body) };
  }

  bindNativeWork({ actorId, plan, expectedPlanRoot }) {
    required(actorId, 'actorId');
    this.#verifyPlan(plan, expectedPlanRoot, 'native-bind-work');
    if (plan.operation !== 'native-bind-work') {
      throw new AgentSessionSurfaceError(
        'invalid_plan',
        'native Work binding requires a native-bind-work plan',
      );
    }
    const conflict = this.registry.activeWorkConflict(
      { kind: 'work', workRef: plan.workRef },
      plan,
    );
    if (conflict) this.#throwNativeWorkConflict(conflict, plan.workRef);
    const result = receipt(
      'bind-native-work',
      actorId,
      {
        status: 'bound',
        workConsoleId: plan.workConsoleId,
        sessionAttemptId: plan.sessionAttemptId,
        workRef: structuredClone(plan.workRef),
      },
      this.now,
    );
    try {
      this.registry.bindNativeWork(plan, plan.workRef, result);
    } catch (error) {
      if (error?.code === 'native_work_already_active') {
        this.#throwNativeWorkConflict(error.conflict, plan.workRef);
      }
      throw error;
    }
    return result;
  }

  startNative({ actorId, client, plan, expectedPlanRoot, processIdentity }) {
    required(actorId, 'actorId');
    required(client, 'client');
    this.#verifyPlan(plan, expectedPlanRoot, 'native-start');
    if (plan.operation !== 'native-start') {
      throw new AgentSessionSurfaceError(
        'invalid_plan',
        'native start requires a native-start plan',
      );
    }
    if (!processIdentity || typeof processIdentity !== 'object') {
      throw new AgentSessionSurfaceError(
        'invalid_argument',
        'native start requires exact launcher process identity',
      );
    }
    const recordedAt = this.now();
    const result = receipt(
      'start-native',
      actorId,
      {
        status: 'started',
        planRoot: plan.root,
        workConsoleId: plan.workConsoleId,
        sessionAttemptId: plan.sessionAttemptId,
        terminalOwnership: 'provider-native-ui',
        inputControl: 'external-to-kungfu-tui',
      },
      () => recordedAt,
    );
    this.registry.recordNativeStarted(plan, result, {
      schema: 'kungfu.attempt-heartbeat/v1',
      state: 'unknown',
      observedAt: recordedAt,
      staleAfterMs: 2000,
      processIdentityRoot: agentSessionSurfaceRoot(processIdentity),
      workRefRoot:
        plan.binding?.kind === 'work'
          ? agentSessionSurfaceRoot(plan.binding.workRef)
          : null,
      diagnostic: 'awaiting-first-native-heartbeat',
    });
    return result;
  }

  heartbeatNative({ session: ref, processIdentity, observation = {} }) {
    const projection = this.registry.projection(sessionRef(ref));
    if (!projection || projection.attempt.backend !== 'native-interactive') {
      throw new AgentSessionSurfaceError(
        'session_not_found',
        'native SessionAttempt is unavailable',
      );
    }
    const processIdentityRoot = agentSessionSurfaceRoot(
      processIdentity ?? null,
    );
    if (
      projection.attempt.observer?.processIdentityRoot !== processIdentityRoot
    ) {
      throw new AgentSessionSurfaceError(
        'stale_native_process',
        'native heartbeat process identity does not match the registered attempt',
      );
    }
    const state = ['fresh', 'degraded', 'unknown'].includes(observation.state)
      ? observation.state
      : 'unknown';
    const staleAfterMs = Math.min(
      10000,
      Math.max(500, Number(observation.staleAfterMs ?? 2000)),
    );
    const observedAt = this.now();
    if (
      observation.schema !== 'kungfu.attempt-heartbeat/v1' ||
      (observation.workRefRoot !== null &&
        !/^sha256:[a-f0-9]{64}$/u.test(observation.workRefRoot)) ||
      Object.hasOwn(observation, 'work')
    ) {
      throw new AgentSessionSurfaceError(
        'invalid_argument',
        'AttemptHeartbeat may contain liveness coordinates only',
      );
    }
    const activeWorkRef =
      projection.attempt.workBinding?.workRef ??
      (projection.console.binding.kind === 'work'
        ? projection.console.binding.workRef
        : null);
    const expectedWorkRefRoot = activeWorkRef
      ? agentSessionSurfaceRoot(activeWorkRef)
      : null;
    if ((observation.workRefRoot ?? null) !== expectedWorkRefRoot) {
      throw new AgentSessionSurfaceError(
        'attempt_heartbeat_binding_mismatch',
        'AttemptHeartbeat Work coordinate does not match the active binding',
      );
    }
    this.registry.recordNativeHeartbeat(ref, {
      schema: 'kungfu.attempt-heartbeat/v1',
      state,
      observedAt,
      staleAfterMs,
      processIdentityRoot,
      workRefRoot: observation.workRefRoot ?? null,
      diagnostic:
        typeof observation.diagnostic === 'string'
          ? observation.diagnostic
          : null,
    });
    return receipt(
      'heartbeat-native',
      'native-launcher',
      {
        status: state,
        workConsoleId: projection.console.consoleId,
        sessionAttemptId: projection.attempt.sessionAttemptId,
        observerState: state,
      },
      () => observedAt,
    );
  }

  projectNativeWork({ session: ref, processIdentity, projection }) {
    const normalized = sessionRef(ref);
    const current = this.registry.projection(normalized);
    if (!current || current.attempt.backend !== 'native-interactive') {
      throw new AgentSessionSurfaceError(
        'session_not_found',
        'native SessionAttempt is unavailable',
      );
    }
    if (
      current.attempt.observer?.processIdentityRoot !==
      agentSessionSurfaceRoot(processIdentity ?? null)
    ) {
      throw new AgentSessionSurfaceError(
        'stale_native_process',
        'native Work projection process identity does not match the registered attempt',
      );
    }
    const value = nativeWorkProjection(projection);
    if (
      current.attempt.workBinding &&
      value.workRefRoot !==
        agentSessionSurfaceRoot(current.attempt.workBinding.workRef)
    ) {
      throw new AgentSessionSurfaceError(
        'work_projection_binding_mismatch',
        'native Work projection does not match the active Work binding',
      );
    }
    const boundWorkRef = current.attempt.workBinding?.workRef;
    if (
      boundWorkRef &&
      value.work &&
      (value.work.initiativeId !== (boundWorkRef.initiativeId ?? '') ||
        value.work.assignmentId !== boundWorkRef.entityId)
    ) {
      throw new AgentSessionSurfaceError(
        'work_projection_identity_mismatch',
        'native Work projection identity does not match the active Work binding',
      );
    }
    if (value.work && value.queryProofRoot !== value.work.queryProofRoot) {
      throw new AgentSessionSurfaceError(
        'work_projection_proof_mismatch',
        'native Work projection proof does not match its coherent Work snapshot',
      );
    }
    const prior = current.attempt.workProjection;
    if (
      prior &&
      (value.observedAt < prior.observedAt ||
        value.queryCount <= prior.queryCount)
    ) {
      throw new AgentSessionSurfaceError(
        'stale_work_projection',
        'native Work projection must advance observation time and query count',
      );
    }
    this.registry.recordNativeWorkProjection(normalized, value);
    return {
      schema: 'kungfu.native-work-projection-receipt/v1',
      status: 'projected',
      workConsoleId: normalized.workConsoleId,
      sessionAttemptId: normalized.sessionAttemptId,
      queryProofRoot: value.queryProofRoot,
      observedAt: value.observedAt,
    };
  }

  endNative({ actorId, session: ref, processIdentity, exit = {} }) {
    required(actorId, 'actorId');
    const projection = this.registry.projection(sessionRef(ref));
    if (!projection || projection.attempt.backend !== 'native-interactive') {
      throw new AgentSessionSurfaceError(
        'session_not_found',
        'native SessionAttempt is unavailable',
      );
    }
    if (
      projection.attempt.observer?.processIdentityRoot !==
      agentSessionSurfaceRoot(processIdentity ?? null)
    ) {
      throw new AgentSessionSurfaceError(
        'stale_native_process',
        'native end process identity does not match the registered attempt',
      );
    }
    const exitProjection = {
      exitCode: typeof exit.exitCode === 'number' ? exit.exitCode : null,
      signal: typeof exit.signal === 'string' ? exit.signal : null,
    };
    const result = receipt(
      'end-native',
      actorId,
      {
        status: 'ended',
        workConsoleId: projection.console.consoleId,
        sessionAttemptId: projection.attempt.sessionAttemptId,
        exit: exitProjection,
        completionClaimed: false,
      },
      this.now,
    );
    this.registry.recordNativeEnded(ref, result, exitProjection);
    return result;
  }

  planStart(input) {
    this.registry.observe(this.runtime.list());
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
              version: '4.0.0-alpha.3',
            },
          },
          threadStartParams: input.structured?.threadStartParams ?? {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            approvalPolicy: 'on-request',
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
      if (operation === 'wait-status-change')
        return this.waitStatusChange(request);
      return this.#session(request.session).port.snapshot({
        requestedSequence: request.requestedSequence ?? 0,
      });
    }
    if (operation === 'plan-start') return this.planStart(request.input ?? {});
    if (operation === 'plan-native-start')
      return this.planNativeStart(request.input ?? {});
    if (operation === 'plan-native-bind-work')
      return this.planNativeBindWork(request.input ?? request);
    if (operation === 'start') return this.start(request);
    if (operation === 'start-native') return this.startNative(request);
    if (operation === 'bind-native-work') return this.bindNativeWork(request);
    if (operation === 'heartbeat-native') return this.heartbeatNative(request);
    if (operation === 'project-native-work')
      return this.projectNativeWork(request);
    if (operation === 'end-native') return this.endNative(request);
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

  #throwNativeWorkConflict(conflict, workRef) {
    const active = conflict.attempt;
    const console = conflict.console;
    const assignment = workRef?.entityId ?? 'requested Work';
    throw new AgentSessionSurfaceError(
      'native_work_already_active',
      [
        `Work '${assignment}' already has an active Agent.`,
        `Active Agent: ${active.provider ?? 'unknown provider'} (attempt ${active.sessionAttemptId}, status ${active.status})`,
        `Active Console: ${console.consoleId}`,
        '',
        'Kungfu stopped this session before it could become a second writer. This is expected Work protection, not a system failure.',
        'Next: return to the terminal running the active Agent; or exit that Agent normally and retry this Work; or choose a different Work in this terminal.',
        'Inspect all sessions with `kungfu agent session list --json`.',
      ].join('\n'),
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
    planNativeStart: (input) =>
      invoke({ operation: 'plan-native-start', client, actorId, input }),
    planNativeBindWork: (session, workRef, options = {}) =>
      invoke({
        operation: 'plan-native-bind-work',
        client,
        actorId,
        input: { session, workRef, ...options },
      }),
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
    startNative: (plan, processIdentity) =>
      invoke({
        operation: 'start-native',
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
        processIdentity,
      }),
    bindNativeWork: (plan) =>
      invoke({
        operation: 'bind-native-work',
        client,
        actorId,
        plan,
        expectedPlanRoot: plan.root,
      }),
    heartbeatNative: (session, processIdentity, observation) =>
      invoke({
        operation: 'heartbeat-native',
        client,
        actorId,
        session,
        processIdentity,
        observation,
      }),
    projectNativeWork: (session, processIdentity, projection) =>
      invoke({
        operation: 'project-native-work',
        actorId,
        client,
        session,
        processIdentity,
        projection,
      }),
    endNative: (session, processIdentity, exit) =>
      invoke({
        operation: 'end-native',
        client,
        actorId,
        session,
        processIdentity,
        exit,
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
