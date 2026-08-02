import { normalizeActiveWorkLeases } from './active-work-lease.mjs';
import { semanticRoot, validateWorkRef } from './session-contract.mjs';

export const WORK_CONSOLE_REGISTRY_SCHEMA = 'kungfu.work-console-registry/v3';
export const WORK_CONSOLE_HISTORY_BOUNDARY_SCHEMA =
  'kungfu.work-console-history-boundary/v1';

const ATTEMPT_STATES = new Set([
  'planned',
  'running',
  'detached',
  'exited',
  'orphaned',
  'unrecoverable',
]);
const ATTEMPT_BACKENDS = new Set([
  'capsule',
  'structured',
  'tmux',
  'direct',
  'native-interactive',
]);
const OBSERVER_STATES = new Set([
  'fresh',
  'stale',
  'disconnected',
  'degraded',
  'unknown',
]);

export function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`${label} is required`), {
      code: 'invalid_argument',
    });
  }
  return value;
}

export function clone(value) {
  return structuredClone(value);
}

export function historyBoundary() {
  return {
    schema: WORK_CONSOLE_HISTORY_BOUNDARY_SCHEMA,
    state: 'session-activity-only',
    semanticAdmissionReceiptRoot: null,
    processExitSettlesWork: false,
    selfReportSettlesWork: false,
    authority: 'observer-only',
  };
}

export function normalizeBinding(value, { compatibility = false } = {}) {
  const binding = value ?? { kind: 'workspace-assistant', workRef: null };
  if (!['work', 'workspace-assistant'].includes(binding.kind)) {
    throw Object.assign(
      new Error(`unsupported binding kind '${String(binding.kind)}'`),
      { code: 'invalid_argument' },
    );
  }
  if (binding.kind === 'work') {
    if (!binding.workRef || typeof binding.workRef !== 'object') {
      throw Object.assign(new Error('work binding requires a WorkRef'), {
        code: 'invalid_argument',
      });
    }
    return {
      kind: 'work',
      workRef: validateWorkRef(binding.workRef, { compatibility }),
    };
  }
  return { kind: 'workspace-assistant', workRef: null };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

export function bindingIdentityKey(bindingValue) {
  const binding = normalizeBinding(bindingValue, { compatibility: true });
  if (binding.kind !== 'work') return binding.kind;
  const { workspaceId, profileId, entityType, entityId, initiativeId } =
    binding.workRef;
  return canonical({
    workspaceId,
    profileId,
    entityType,
    ...(initiativeId ? { initiativeId } : {}),
    entityId,
  });
}

export function attemptWorkBinding(value, { compatibility = false } = {}) {
  if (value == null) return null;
  return normalizeBinding(
    { kind: 'work', workRef: value.workRef ?? value },
    { compatibility },
  );
}

export function primaryWorkConsoleId({ workspaceId, binding }) {
  const normalized = normalizeBinding(binding);
  if (normalized.kind === 'work') {
    const { profileId, entityType, entityId, initiativeId } =
      normalized.workRef;
    return [
      'work',
      profileId,
      entityType,
      ...(initiativeId ? [initiativeId] : []),
      entityId,
    ].join(':');
  }
  return `assistant:${required(workspaceId, 'workspaceId')}`;
}

function normalizeAttempt(value, { compatibility = false } = {}) {
  if (!value || typeof value !== 'object') return null;
  const sessionAttemptId =
    typeof value.sessionAttemptId === 'string'
      ? value.sessionAttemptId
      : value.attemptId;
  if (typeof sessionAttemptId !== 'string' || sessionAttemptId.length === 0)
    return null;
  const workBinding = value.workBinding
    ? attemptWorkBinding(value.workBinding, { compatibility })
    : null;
  const retainedWork =
    value.observer?.work && typeof value.observer.work === 'object'
      ? clone(value.observer.work)
      : null;
  const workProjection =
    value.workProjection && typeof value.workProjection === 'object'
      ? clone(value.workProjection)
      : retainedWork && workBinding
        ? {
            schema: 'kungfu.native-work-projection/v1',
            workRefRoot: semanticRoot(workBinding.workRef),
            state: value.observer?.state === 'fresh' ? 'fresh' : 'stale',
            observedAt:
              typeof value.observer?.observedAt === 'number'
                ? value.observer.observedAt
                : 0,
            source: 'bounded-fallback',
            queryCount: 1,
            queryProofRoot: retainedWork.queryProofRoot ?? null,
            work: retainedWork,
            diagnostic:
              typeof value.observer?.diagnostic === 'string'
                ? value.observer.diagnostic
                : null,
          }
        : null;
  return {
    sessionAttemptId,
    runId:
      typeof value.runId === 'string' && value.runId.length > 0
        ? value.runId
        : sessionAttemptId,
    provider: typeof value.provider === 'string' ? value.provider : 'unknown',
    providerVersion:
      typeof value.providerVersion === 'string'
        ? value.providerVersion
        : 'unknown',
    runtimeProfileId:
      typeof value.runtimeProfileId === 'string'
        ? value.runtimeProfileId
        : 'unknown',
    backend: ATTEMPT_BACKENDS.has(value.backend) ? value.backend : 'capsule',
    status: ATTEMPT_STATES.has(value.status) ? value.status : 'orphaned',
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    ...(typeof value.endedAt === 'number' ? { endedAt: value.endedAt } : {}),
    receipts: Array.isArray(value.receipts)
      ? value.receipts.filter(
          (receipt) => receipt && typeof receipt === 'object',
        )
      : [],
    plans: Array.isArray(value.plans)
      ? value.plans.filter((plan) => plan && typeof plan === 'object')
      : [],
    ...(value.observer && typeof value.observer === 'object'
      ? {
          observer: {
            schema:
              value.observer.schema === 'kungfu.attempt-heartbeat/v1'
                ? value.observer.schema
                : 'kungfu.attempt-heartbeat/v1',
            state: OBSERVER_STATES.has(value.observer.state)
              ? value.observer.state
              : 'unknown',
            observedAt:
              typeof value.observer.observedAt === 'number'
                ? value.observer.observedAt
                : 0,
            staleAfterMs:
              typeof value.observer.staleAfterMs === 'number' &&
              value.observer.staleAfterMs > 0
                ? value.observer.staleAfterMs
                : 2000,
            processIdentityRoot:
              typeof value.observer.processIdentityRoot === 'string'
                ? value.observer.processIdentityRoot
                : '',
            workRefRoot:
              typeof value.observer.workRefRoot === 'string'
                ? value.observer.workRefRoot
                : null,
            diagnostic:
              typeof value.observer.diagnostic === 'string'
                ? value.observer.diagnostic
                : null,
          },
        }
      : {}),
    ...(workProjection ? { workProjection } : {}),
    ...(value.exit && typeof value.exit === 'object'
      ? {
          exit: {
            exitCode:
              typeof value.exit.exitCode === 'number'
                ? value.exit.exitCode
                : null,
            signal:
              typeof value.exit.signal === 'string' ? value.exit.signal : null,
          },
        }
      : {}),
    ...(workBinding ? { workBinding } : {}),
    historyProtection: historyBoundary(),
  };
}

function normalizeConsole(
  value,
  fallbackWorkspaceId = 'home',
  { compatibility = false } = {},
) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.consoleId !== 'string' || value.consoleId.length === 0)
    return null;
  const binding = normalizeBinding(
    value.binding ?? {
      kind: value.bindingKind === 'work' ? 'work' : 'workspace-assistant',
      workRef: value.workRef ?? null,
    },
    { compatibility },
  );
  const workspaceId =
    typeof value.workspaceId === 'string'
      ? value.workspaceId
      : (binding.workRef?.workspaceId ?? fallbackWorkspaceId);
  return {
    consoleId: value.consoleId,
    workspaceId,
    binding,
    runtimeProfileId:
      typeof value.runtimeProfileId === 'string'
        ? value.runtimeProfileId
        : 'unknown',
    backend: ['capsule', 'structured', 'tmux', 'direct'].includes(value.backend)
      ? value.backend
      : 'capsule',
    attempts: (Array.isArray(value.attempts) ? value.attempts : [])
      .map((attempt) =>
        normalizeAttempt(
          {
            ...attempt,
            backend: attempt?.backend ?? value.backend,
            runtimeProfileId:
              attempt?.runtimeProfileId ?? value.runtimeProfileId,
          },
          { compatibility },
        ),
      )
      .filter(Boolean),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

export function normalizeWorkConsoleRegistry(value) {
  const fallbackWorkspaceId =
    value && typeof value.workspaceId === 'string' ? value.workspaceId : 'home';
  return {
    schema: WORK_CONSOLE_REGISTRY_SCHEMA,
    activeWorkLeases: normalizeActiveWorkLeases(value?.activeWorkLeases),
    consoles: (Array.isArray(value?.consoles) ? value.consoles : [])
      .map((entry) => {
        try {
          return normalizeConsole(entry, fallbackWorkspaceId, {
            compatibility: true,
          });
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  };
}
