import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ActiveWorkLeaseService } from './active-work-lease.mjs';
import { SessionLifecycleService } from './session-lifecycle-service.mjs';
import {
  attemptWorkBinding,
  bindingIdentityKey,
  clone,
  historyBoundary,
  normalizeBinding,
  normalizeNativeBootstrap,
  normalizeWorkConsoleRegistry,
  primaryWorkConsoleId,
  required,
} from './work-console-model.mjs';
import { WorkProjectionService } from './work-projection-service.mjs';

export {
  WORK_CONSOLE_HISTORY_BOUNDARY_SCHEMA,
  WORK_CONSOLE_REGISTRY_SCHEMA,
  normalizeNativeBootstrap,
  normalizeWorkConsoleRegistry,
  primaryWorkConsoleId,
} from './work-console-model.mjs';

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
    this.workLeases = new ActiveWorkLeaseService({
      state: this.value,
      now: this.now,
    });
    this.lifecycle = new SessionLifecycleService({
      find: (ref, requiredEntry = true) => this.#find(ref, requiredEntry),
      appendReceipt: (attempt, receipt) =>
        this.#appendReceipt(attempt, receipt),
      workLeases: this.workLeases,
      now: this.now,
    });
    this.workProjection = new WorkProjectionService({
      find: (ref, requiredEntry = true) => this.#find(ref, requiredEntry),
    });
    this.#migrateActiveWorkLeases();
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
        runtimeProfileId: plan.runtimeProfileId ?? 'unknown',
        backend: plan.backend ?? 'capsule',
        status: 'planned',
        startedAt: now,
        bootstrap: normalizeNativeBootstrap(
          plan.bootstrap,
          plan.sessionAttemptId,
        ),
        receipts: [],
        plans: [],
        historyProtection: historyBoundary(),
      };
      console.attempts.push(attempt);
    } else {
      attempt.backend = plan.backend ?? attempt.backend;
      attempt.runtimeProfileId =
        plan.runtimeProfileId ?? attempt.runtimeProfileId;
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
    if (resolved.binding.kind === 'work') {
      this.#reapExpiredWorkLeases();
      this.workLeases.acquire({
        workRef: resolved.binding.workRef,
        console,
        attempt,
      });
    }
    console.updatedAt = now;
    this.#save();
    return clone({ console, attempt });
  }

  recordStarted(plan, receipt) {
    this.lifecycle.recordStarted(plan, receipt);
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
    this.lifecycle.recordNativeStarted(plan, receipt, observer);
    this.#save();
  }

  recordNativeHeartbeat(ref, observer) {
    this.lifecycle.recordNativeHeartbeat(ref, observer);
    // Heartbeat recency is live observer state, not durable Work evidence.  A
    // worker restart invalidates it and recovery records the attempt as
    // disconnected, so persisting every pulse only churns the Project runtime
    // while a provider-native UI owns the terminal.  Later durable operations
    // (bind/end) naturally include the latest in-memory observer projection.
  }

  recordNativeWorkProjection(ref, projection) {
    this.workProjection.recordNative(ref, projection);
    this.#save();
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
    const previousBinding = attempt.workBinding ?? null;
    const bindingChanged =
      previousBinding &&
      bindingIdentityKey(previousBinding) !== bindingIdentityKey(binding);
    const externalProject = binding.workRef.workspaceId !== console.workspaceId;
    if (
      externalProject &&
      !(
        ref.bindingScope === 'explicit-external-project' &&
        ref.sourceWorkspaceId === console.workspaceId
      )
    ) {
      throw Object.assign(
        new Error(
          'WorkRef workspace differs without explicit cross-project authority',
        ),
        { code: 'work_workspace_mismatch' },
      );
    }
    this.#reapExpiredWorkLeases();
    try {
      this.workLeases.switch({
        workRef: binding.workRef,
        console,
        attempt,
        previousWorkRef: previousBinding?.workRef ?? null,
      });
    } catch (error) {
      if (error?.code !== 'native_work_already_active') throw error;
      throw Object.assign(new Error('Work already has an active Agent'), {
        code: 'native_work_already_active',
        conflict: this.#leaseConflictProjection(error.lease),
      });
    }
    attempt.workBinding = binding;
    if (bindingChanged) Reflect.deleteProperty(attempt, 'workProjection');
    if (receipt) this.#appendReceipt(attempt, receipt);
    console.updatedAt = this.now();
    this.#save();
    return clone({ console, attempt });
  }

  activeWorkConflict(bindingValue, excludeRef = null) {
    const binding = normalizeBinding(bindingValue);
    if (binding.kind !== 'work') return null;
    this.#reapExpiredWorkLeases();
    const lease = this.workLeases.conflict(binding.workRef, excludeRef);
    return lease ? this.#leaseConflictProjection(lease) : null;
  }

  reapExpiredAmbientAttempts() {
    const expired = this.workLeases.reapExpiredAmbientAttempts();
    if (expired.length > 0) this.#save();
    return expired;
  }
  recordNativeEnded(ref, receipt, exit) {
    this.lifecycle.recordNativeEnded(ref, receipt, exit);
    this.#save();
  }
  observe(sessions) {
    const changed = this.lifecycle.observe(sessions);
    if (changed) this.#save();
  }

  projection(ref) {
    const found = this.#find(ref, false);
    if (!found) return null;
    const activeWorkLease = this.value.activeWorkLeases.find(
      (lease) =>
        lease.workConsoleId === found.console.consoleId &&
        lease.sessionAttemptId === found.attempt.sessionAttemptId,
    );
    return clone({ ...found, activeWorkLease: activeWorkLease ?? null });
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
          const recoveryDeadlineAt =
            attempt.observer.observedAt + attempt.observer.staleAfterMs;
          this.workLeases.markRecoveryPending(
            {
              workConsoleId: console.consoleId,
              sessionAttemptId: attempt.sessionAttemptId,
            },
            recoveryDeadlineAt,
          );
          attempt.observer = {
            ...attempt.observer,
            state: 'disconnected',
            observedAt: now,
            diagnostic: 'agent-session-worker-restarted',
          };
        }
        if (backend !== 'native-interactive') {
          this.workLeases.release({
            workConsoleId: console.consoleId,
            sessionAttemptId: attempt.sessionAttemptId,
          });
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

  #migrateActiveWorkLeases() {
    if (this.value.activeWorkLeases.length > 0) return;
    let changed = false;
    for (const console of this.value.consoles) {
      for (const attempt of console.attempts) {
        if (!['planned', 'running', 'detached'].includes(attempt.status))
          continue;
        const binding = attempt.workBinding ?? console.binding;
        if (binding.kind !== 'work') continue;
        try {
          this.workLeases.acquire({
            workRef: binding.workRef,
            console,
            attempt,
          });
          changed = true;
        } catch (error) {
          if (error?.code !== 'native_work_already_active') throw error;
          attempt.status = 'orphaned';
          attempt.endedAt = this.now();
          changed = true;
        }
      }
    }
    if (changed) this.#save();
  }

  #reapExpiredWorkLeases() {
    const expired = this.workLeases.reapExpiredRecovery();
    for (const lease of expired) {
      const found = this.#find(lease, false);
      if (!found) continue;
      found.attempt.receipts.push({
        operation: 'release-work-lease',
        status: 'expired',
        reason: 'exact-native-process-evidence-expired-after-worker-restart',
        recordedAt: this.now(),
        receiptRoot: null,
        semanticOutcome: null,
        workState: null,
        proof: null,
      });
      found.console.updatedAt = this.now();
    }
    if (expired.length > 0) this.#save();
  }

  #leaseConflictProjection(lease) {
    const found = this.#find(lease, false);
    if (!found) {
      return {
        lease: clone(lease),
        console: {
          consoleId: lease.workConsoleId,
          workspaceId: lease.workRef.workspaceId,
        },
        attempt: {
          sessionAttemptId: lease.sessionAttemptId,
          provider: lease.provider,
          runtimeProfileId: lease.runtimeProfileId,
          status: lease.state,
        },
      };
    }
    return clone({ ...found, lease });
  }

  #save() {
    this.store?.save(this.value);
  }
}
