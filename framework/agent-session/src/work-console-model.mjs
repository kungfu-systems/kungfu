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
const BOOTSTRAP_STATES = new Set(['pending', 'verified', 'degraded']);
const ROOT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

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

export function normalizeNativeBootstrap(value, sessionAttemptId) {
  const requestedState = BOOTSTRAP_STATES.has(value?.state)
    ? value.state
    : 'pending';
  const receiptRoot = ROOT_PATTERN.test(value?.receiptRoot)
    ? value.receiptRoot
    : null;
  const exactAttempt = value?.attemptId === sessionAttemptId;
  const verified =
    requestedState === 'verified' &&
    exactAttempt &&
    receiptRoot !== null &&
    value?.mutationsAllowed === true;
  return {
    schema: 'kungfu.agent-bootstrap-receipt/v1',
    state:
      requestedState === 'verified' && !verified ? 'degraded' : requestedState,
    attemptId: sessionAttemptId,
    receiptRoot,
    mutationsAllowed: verified,
  };
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

function retainedObserverWork(value) {
  return value.observer?.work && typeof value.observer.work === 'object'
    ? clone(value.observer.work)
    : null;
}

function normalizeWorkProjection(value, workBinding) {
  if (value.workProjection && typeof value.workProjection === 'object')
    return clone(value.workProjection);
  const retainedWork = retainedObserverWork(value);
  if (!retainedWork || !workBinding) return null;
  return {
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
  };
}

function normalizeAttemptObserver(observer) {
  if (!observer || typeof observer !== 'object') return null;
  return {
    schema: 'kungfu.attempt-heartbeat/v1',
    state: OBSERVER_STATES.has(observer.state) ? observer.state : 'unknown',
    observedAt:
      typeof observer.observedAt === 'number' ? observer.observedAt : 0,
    staleAfterMs:
      typeof observer.staleAfterMs === 'number' && observer.staleAfterMs > 0
        ? observer.staleAfterMs
        : 2000,
    processIdentityRoot:
      typeof observer.processIdentityRoot === 'string'
        ? observer.processIdentityRoot
        : '',
    workRefRoot:
      typeof observer.workRefRoot === 'string' ? observer.workRefRoot : null,
    diagnostic:
      typeof observer.diagnostic === 'string' ? observer.diagnostic : null,
  };
}

function normalizeAttemptExit(exit) {
  if (!exit || typeof exit !== 'object') return null;
  return {
    exitCode: typeof exit.exitCode === 'number' ? exit.exitCode : null,
    signal: typeof exit.signal === 'string' ? exit.signal : null,
  };
}

function objectList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object')
    : [];
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
  const workProjection = normalizeWorkProjection(value, workBinding);
  const observer = normalizeAttemptObserver(value.observer);
  const exit = normalizeAttemptExit(value.exit);
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
    receipts: objectList(value.receipts),
    plans: objectList(value.plans),
    ...(observer ? { observer } : {}),
    ...(workProjection ? { workProjection } : {}),
    ...(exit ? { exit } : {}),
    ...(workBinding ? { workBinding } : {}),
    bootstrap: normalizeNativeBootstrap(value.bootstrap, sessionAttemptId),
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
