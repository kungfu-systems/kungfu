import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const WORK_CONSOLE_REGISTRY_SCHEMA = 'kungfu.work-console-registry/v2';
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

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`${label} is required`), {
      code: 'invalid_argument',
    });
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function historyBoundary() {
  return {
    schema: WORK_CONSOLE_HISTORY_BOUNDARY_SCHEMA,
    state: 'session-activity-only',
    semanticAdmissionReceiptRoot: null,
    processExitSettlesWork: false,
    selfReportSettlesWork: false,
    authority: 'observer-only',
  };
}

function normalizeBinding(value) {
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
    for (const field of [
      'workspaceId',
      'profileId',
      'entityType',
      'entityId',
    ]) {
      required(binding.workRef[field], `workRef.${field}`);
    }
    return { kind: 'work', workRef: clone(binding.workRef) };
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

function bindingIdentityKey(bindingValue) {
  const binding = normalizeBinding(bindingValue);
  if (binding.kind !== 'work') return binding.kind;
  const { workspaceId, profileId, entityType, entityId } = binding.workRef;
  return canonical({ workspaceId, profileId, entityType, entityId });
}

function attemptWorkBinding(value) {
  if (value == null) return null;
  return normalizeBinding({ kind: 'work', workRef: value.workRef ?? value });
}

export function primaryWorkConsoleId({ workspaceId, binding }) {
  const normalized = normalizeBinding(binding);
  if (normalized.kind === 'work') {
    const { profileId, entityType, entityId } = normalized.workRef;
    return `work:${profileId}:${entityType}:${entityId}`;
  }
  return `assistant:${required(workspaceId, 'workspaceId')}`;
}

function normalizeAttempt(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionAttemptId =
    typeof value.sessionAttemptId === 'string'
      ? value.sessionAttemptId
      : value.attemptId;
  if (typeof sessionAttemptId !== 'string' || sessionAttemptId.length === 0)
    return null;
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
            work:
              value.observer.work && typeof value.observer.work === 'object'
                ? clone(value.observer.work)
                : null,
            diagnostic:
              typeof value.observer.diagnostic === 'string'
                ? value.observer.diagnostic
                : null,
          },
        }
      : {}),
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
    ...(value.workBinding
      ? { workBinding: attemptWorkBinding(value.workBinding) }
      : {}),
    historyProtection: historyBoundary(),
  };
}

function normalizeConsole(value, fallbackWorkspaceId = 'home') {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.consoleId !== 'string' || value.consoleId.length === 0)
    return null;
  const binding = normalizeBinding(
    value.binding ?? {
      kind: value.bindingKind === 'work' ? 'work' : 'workspace-assistant',
      workRef: value.workRef ?? null,
    },
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
        normalizeAttempt({
          ...attempt,
          backend: attempt?.backend ?? value.backend,
        }),
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
    consoles: (Array.isArray(value?.consoles) ? value.consoles : [])
      .map((entry) => {
        try {
          return normalizeConsole(entry, fallbackWorkspaceId);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  };
}

export class JsonFileWorkConsoleRegistryStore {
  constructor(filePath) {
    this.filePath = path.resolve(required(filePath, 'registry file path'));
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    const stat = lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `WorkConsole registry '${this.filePath}' is not a regular file`,
      );
    }
    return JSON.parse(readFileSync(this.filePath, 'utf8'));
  }

  save(value) {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.filePath);
  }
}

export class WorkConsoleRegistry {
  constructor({ store = null, snapshot = null, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.value = normalizeWorkConsoleRegistry(snapshot ?? store?.load());
    this.#recoverInterruptedAttempts();
  }

  snapshot() {
    return clone(this.value);
  }

  resolve(input = {}) {
    const binding = normalizeBinding(input.binding);
    const inferredWorkspaceId =
      typeof input.workConsoleId === 'string'
        ? input.workConsoleId.startsWith('assistant:')
          ? input.workConsoleId.slice('assistant:'.length)
          : `legacy:${input.workConsoleId}`
        : null;
    const workspaceId =
      binding.workRef?.workspaceId ??
      input.workspaceId ??
      required(inferredWorkspaceId, 'workspaceId');
    const canonicalId = primaryWorkConsoleId({ workspaceId, binding });
    const workConsoleId = input.workConsoleId ?? canonicalId;
    const existing = this.value.consoles.find(
      (entry) => entry.consoleId === workConsoleId,
    );
    if (
      existing &&
      bindingIdentityKey(existing.binding) !== bindingIdentityKey(binding)
    ) {
      throw Object.assign(
        new Error(
          `WorkConsole '${workConsoleId}' is already bound to another work identity`,
        ),
        { code: 'console_binding_mismatch' },
      );
    }
    const primary = this.value.consoles.find(
      (entry) =>
        entry.workspaceId === workspaceId &&
        bindingIdentityKey(entry.binding) === bindingIdentityKey(binding),
    );
    return {
      schema: 'kungfu.work-console-resolution/v1',
      workspaceId,
      workConsoleId:
        existing?.consoleId ??
        (input.workConsoleId
          ? workConsoleId
          : (primary?.consoleId ?? workConsoleId)),
      canonicalWorkConsoleId: canonicalId,
      existing: Boolean(primary ?? existing),
      binding,
    };
  }

  recordPlan(plan) {
    const resolved = this.resolve({
      workspaceId: plan.workspaceId,
      workConsoleId: plan.workConsoleId,
      binding: plan.binding,
    });
    const now = this.now();
    let console = this.value.consoles.find(
      (entry) => entry.consoleId === resolved.workConsoleId,
    );
    if (!console) {
      console = {
        consoleId: resolved.workConsoleId,
        workspaceId: resolved.workspaceId,
        binding: resolved.binding,
        runtimeProfileId: plan.runtimeProfileId ?? 'unknown',
        backend: plan.backend ?? 'capsule',
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      this.value.consoles.push(console);
    }
    let attempt = console.attempts.find(
      (entry) => entry.sessionAttemptId === plan.sessionAttemptId,
    );
    if (!attempt) {
      attempt = {
        sessionAttemptId: plan.sessionAttemptId,
        runId: plan.sessionAttemptId,
        provider: plan.provider,
        providerVersion: plan.providerVersion,
        backend: plan.backend ?? 'capsule',
        status: 'planned',
        startedAt: now,
        receipts: [],
        plans: [],
        historyProtection: historyBoundary(),
      };
      console.attempts.push(attempt);
    } else {
      attempt.backend = plan.backend ?? attempt.backend;
    }
    if (!attempt.plans.some((candidate) => candidate.planRoot === plan.root)) {
      attempt.plans.push({
        operation: plan.operation,
        planRoot: plan.root,
        recordedAt: now,
        effects: [...plan.effects],
        workEffects: [],
        rollback: plan.rollback,
      });
    }
    console.runtimeProfileId =
      plan.runtimeProfileId ?? console.runtimeProfileId;
    console.backend = plan.backend ?? console.backend;
    console.updatedAt = now;
    this.#save();
    return clone({ console, attempt });
  }

  recordStarted(plan, receipt) {
    const { console, attempt } = this.#find(plan);
    attempt.status = 'running';
    attempt.startedAt = receipt.recordedAt;
    attempt.endedAt = undefined;
    this.#appendReceipt(attempt, receipt);
    console.updatedAt = receipt.recordedAt;
    this.#save();
  }

  recordReceipt(ref, receipt) {
    const found = this.#find(ref, false);
    if (!found) return;
    this.#appendReceipt(found.attempt, receipt);
    found.console.updatedAt = receipt.recordedAt;
    this.#save();
  }

  recordNativeStarted(plan, receipt, observer) {
    this.recordStarted(plan, receipt);
    const { console, attempt } = this.#find(plan);
    attempt.backend = 'native-interactive';
    attempt.observer = clone(observer);
    console.backend = 'native-interactive';
    console.updatedAt = receipt.recordedAt;
    this.#save();
  }

  recordNativeHeartbeat(ref, observer) {
    const { console, attempt } = this.#find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw Object.assign(
        new Error('native heartbeat requires a native-interactive attempt'),
        { code: 'attempt_backend_mismatch' },
      );
    }
    attempt.status = 'running';
    attempt.endedAt = undefined;
    attempt.observer = clone(observer);
    console.updatedAt = observer.observedAt;
    // Heartbeat recency is live observer state, not durable Work evidence.  A
    // worker restart invalidates it and recovery records the attempt as
    // disconnected, so persisting every pulse only churns the Project runtime
    // while a provider-native UI owns the terminal.  Later durable operations
    // (bind/end) naturally include the latest in-memory observer projection.
  }

  bindNativeWork(ref, workRef, receipt = null) {
    const { console, attempt } = this.#find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw Object.assign(
        new Error('native Work binding requires a native-interactive attempt'),
        { code: 'attempt_backend_mismatch' },
      );
    }
    if (!['planned', 'running', 'detached'].includes(attempt.status)) {
      throw Object.assign(
        new Error('native Work binding requires an active SessionAttempt'),
        { code: 'attempt_not_active' },
      );
    }
    const binding = attemptWorkBinding(workRef);
    if (binding.workRef.workspaceId !== console.workspaceId) {
      throw Object.assign(
        new Error('WorkRef workspace differs from the Agent Console workspace'),
        { code: 'work_workspace_mismatch' },
      );
    }
    if (
      attempt.workBinding &&
      bindingIdentityKey(attempt.workBinding) !== bindingIdentityKey(binding)
    ) {
      throw Object.assign(
        new Error('SessionAttempt is already bound to another Work'),
        { code: 'attempt_work_binding_mismatch' },
      );
    }
    const conflict = this.activeWorkConflict(binding, ref);
    if (conflict) {
      throw Object.assign(new Error('Work already has an active Agent'), {
        code: 'native_work_already_active',
        conflict,
      });
    }
    attempt.workBinding = binding;
    if (receipt) this.#appendReceipt(attempt, receipt);
    console.updatedAt = this.now();
    this.#save();
    return clone({ console, attempt });
  }

  activeWorkConflict(bindingValue, excludeRef = null) {
    const binding = normalizeBinding(bindingValue);
    if (binding.kind !== 'work') return null;
    for (const console of this.value.consoles) {
      for (const attempt of console.attempts) {
        const mayStillOwnNativeWork =
          attempt.status === 'orphaned' &&
          attempt.backend === 'native-interactive';
        if (
          !mayStillOwnNativeWork &&
          !['planned', 'running', 'detached'].includes(attempt.status)
        )
          continue;
        if (
          excludeRef &&
          console.consoleId ===
            (excludeRef.workConsoleId ?? excludeRef.consoleId) &&
          attempt.sessionAttemptId ===
            (excludeRef.sessionAttemptId ?? excludeRef.attemptId)
        ) {
          continue;
        }
        const activeBinding = attempt.workBinding ?? console.binding;
        if (
          activeBinding.kind === 'work' &&
          bindingIdentityKey(activeBinding) === bindingIdentityKey(binding)
        ) {
          return clone({ console, attempt });
        }
      }
    }
    return null;
  }

  recordNativeEnded(ref, receipt, exit) {
    const { console, attempt } = this.#find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw Object.assign(
        new Error('native end requires a native-interactive attempt'),
        { code: 'attempt_backend_mismatch' },
      );
    }
    attempt.status = 'exited';
    attempt.endedAt = receipt.recordedAt;
    attempt.exit = clone(exit);
    if (attempt.observer) {
      attempt.observer = {
        ...attempt.observer,
        state: 'disconnected',
        observedAt: receipt.recordedAt,
        diagnostic: 'provider-process-ended',
      };
    }
    this.#appendReceipt(attempt, receipt);
    console.updatedAt = receipt.recordedAt;
    this.#save();
  }

  observe(sessions) {
    let changed = false;
    for (const session of sessions) {
      const status = session.port.status();
      const found = this.#find(status, false);
      if (!found) continue;
      const next = status.lifecycleState === 'ended' ? 'exited' : 'running';
      if (found.attempt.status !== next) {
        found.attempt.status = next;
        if (next === 'exited') found.attempt.endedAt = this.now();
        found.console.updatedAt = this.now();
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  projection(ref) {
    const found = this.#find(ref, false);
    return found ? clone(found) : null;
  }

  console(workConsoleId) {
    const console = this.value.consoles.find(
      (entry) => entry.consoleId === workConsoleId,
    );
    return console ? clone(console) : null;
  }

  #find(ref, requiredEntry = true) {
    const workConsoleId = ref.workConsoleId ?? ref.consoleId;
    const sessionAttemptId = ref.sessionAttemptId ?? ref.attemptId;
    const console = this.value.consoles.find(
      (entry) => entry.consoleId === workConsoleId,
    );
    const attempt = console?.attempts.find(
      (entry) => entry.sessionAttemptId === sessionAttemptId,
    );
    if ((!console || !attempt) && requiredEntry) {
      throw Object.assign(
        new Error(
          `SessionAttempt '${String(sessionAttemptId)}' is not registered`,
        ),
        { code: 'session_not_registered' },
      );
    }
    return console && attempt ? { console, attempt } : null;
  }

  #appendReceipt(attempt, value) {
    const receipt = {
      operation: value.operation,
      status: value.status,
      recordedAt: value.recordedAt,
      receiptRoot: value.receiptRoot,
      semanticOutcome: null,
      workState: null,
      proof: null,
    };
    if (
      !attempt.receipts.some(
        (candidate) => candidate.receiptRoot === receipt.receiptRoot,
      )
    ) {
      attempt.receipts.push(receipt);
    }
  }

  #recoverInterruptedAttempts() {
    const now = this.now();
    let changed = false;
    for (const console of this.value.consoles) {
      for (const attempt of console.attempts) {
        if (!['planned', 'running', 'detached'].includes(attempt.status))
          continue;
        const backend = attempt.backend ?? console.backend;
        attempt.status = ['direct', 'capsule', 'structured'].includes(backend)
          ? 'unrecoverable'
          : 'orphaned';
        if (backend === 'native-interactive' && attempt.observer) {
          attempt.observer = {
            ...attempt.observer,
            state: 'disconnected',
            observedAt: now,
            diagnostic: 'agent-session-worker-restarted',
          };
        }
        attempt.endedAt = now;
        attempt.receipts.push({
          operation: 'recover',
          status: attempt.status,
          reason: 'worker-runtime-continuity-lost',
          recordedAt: now,
          receiptRoot: null,
          semanticOutcome: null,
          workState: null,
          proof: null,
        });
        console.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  #save() {
    this.store?.save(this.value);
  }
}
