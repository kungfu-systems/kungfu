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

const ATTEMPT_STATES = new Set([
  'planned',
  'running',
  'detached',
  'exited',
  'orphaned',
  'unrecoverable',
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

function bindingKey(binding) {
  return canonical(binding);
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
      .map(normalizeAttempt)
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
    if (existing && bindingKey(existing.binding) !== bindingKey(binding)) {
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
        bindingKey(entry.binding) === bindingKey(binding),
    );
    return {
      schema: 'kungfu.work-console-resolution/v1',
      workspaceId,
      workConsoleId: primary?.consoleId ?? workConsoleId,
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
        status: 'planned',
        startedAt: now,
        receipts: [],
        plans: [],
      };
      console.attempts.push(attempt);
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
        attempt.status = ['direct', 'capsule', 'structured'].includes(
          console.backend,
        )
          ? 'unrecoverable'
          : 'orphaned';
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
