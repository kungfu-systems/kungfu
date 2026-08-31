import { semanticRoot, validateWorkRef } from './session-contract.mjs';

export const ACTIVE_WORK_LEASE_SCHEMA = 'kungfu.active-work-lease/v1';

function refKey(ref) {
  return `${ref.workConsoleId ?? ref.consoleId}\u0000${ref.sessionAttemptId ?? ref.attemptId}`;
}

export function canonicalWorkIdentity(workRef, { compatibility = false } = {}) {
  const value = validateWorkRef(workRef, { compatibility });
  return {
    workspaceId: value.workspaceId,
    profileId: value.profileId,
    entityType: value.entityType,
    ...(value.initiativeId ? { initiativeId: value.initiativeId } : {}),
    entityId: value.entityId,
  };
}

export function activeWorkKey(workRef, options = {}) {
  return semanticRoot(canonicalWorkIdentity(workRef, options));
}

function normalizeLease(value, { compatibility = false } = {}) {
  if (!value || typeof value !== 'object') return null;
  try {
    const workRef = validateWorkRef(value.workRef, { compatibility });
    const workKey = activeWorkKey(workRef, { compatibility });
    if (value.workKey !== workKey) return null;
    if (
      value.schema !== ACTIVE_WORK_LEASE_SCHEMA ||
      typeof value.leaseId !== 'string' ||
      typeof value.workConsoleId !== 'string' ||
      typeof value.sessionAttemptId !== 'string' ||
      typeof value.provider !== 'string' ||
      typeof value.runtimeProfileId !== 'string' ||
      typeof value.acquiredAt !== 'number' ||
      !['active', 'recovery-pending'].includes(value.state)
    )
      return null;
    return {
      schema: ACTIVE_WORK_LEASE_SCHEMA,
      leaseId: value.leaseId,
      workKey,
      workRef,
      workConsoleId: value.workConsoleId,
      sessionAttemptId: value.sessionAttemptId,
      provider: value.provider,
      runtimeProfileId: value.runtimeProfileId,
      acquiredAt: value.acquiredAt,
      state: value.state,
      ...(typeof value.recoveryDeadlineAt === 'number'
        ? { recoveryDeadlineAt: value.recoveryDeadlineAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export function normalizeActiveWorkLeases(value) {
  const leases = (Array.isArray(value) ? value : [])
    .map((lease) => normalizeLease(lease, { compatibility: true }))
    .filter(Boolean);
  const seen = new Set();
  for (const lease of leases) {
    if (seen.has(lease.workKey)) {
      throw Object.assign(
        new Error(`duplicate active Work lease for '${lease.workKey}'`),
        { code: 'duplicate_active_work_lease' },
      );
    }
    seen.add(lease.workKey);
  }
  return leases;
}

function sameWork(left, right) {
  if (left.workKey === activeWorkKey(right)) return true;
  const candidate = left.workRef;
  if (candidate.initiativeId && right.initiativeId) return false;
  return (
    candidate.workspaceId === right.workspaceId &&
    candidate.profileId === right.profileId &&
    candidate.entityType === right.entityType &&
    candidate.entityId === right.entityId
  );
}

export class ActiveWorkLeaseService {
  constructor({ state, now = () => Date.now() }) {
    this.state = state;
    this.now = now;
  }

  snapshot() {
    return structuredClone(this.state.activeWorkLeases);
  }

  reapExpiredRecovery() {
    const expired = [];
    this.state.activeWorkLeases = this.state.activeWorkLeases.filter(
      (lease) => {
        const keep =
          lease.state !== 'recovery-pending' ||
          typeof lease.recoveryDeadlineAt !== 'number' ||
          lease.recoveryDeadlineAt > this.now();
        if (!keep) expired.push(lease);
        return keep;
      },
    );
    return structuredClone(expired);
  }

  conflict(workRef, excludeRef = null) {
    const validated = validateWorkRef(workRef);
    const excluded = excludeRef ? refKey(excludeRef) : null;
    const lease = this.state.activeWorkLeases.find(
      (candidate) =>
        sameWork(candidate, validated) &&
        (!excluded || refKey(candidate) !== excluded),
    );
    return lease ? structuredClone(lease) : null;
  }

  reapExpiredAmbientAttempts() {
    const now = this.now();
    const expired = [];
    for (const console of this.state.consoles) {
      for (const attempt of console.attempts) {
        const binding = attempt.workBinding ?? console.binding;
        const observer = attempt.observer;
        const expiresAt =
          typeof observer?.observedAt === 'number' &&
          typeof observer?.staleAfterMs === 'number'
            ? observer.observedAt + observer.staleAfterMs
            : null;
        if (
          !['planned', 'running', 'detached'].includes(attempt.status) ||
          attempt.backend !== 'native-interactive' ||
          !attempt.sessionAttemptId.startsWith('native:codex:ambient:') ||
          binding.kind === 'work' ||
          expiresAt === null ||
          expiresAt > now
        )
          continue;
        const ref = {
          workConsoleId: console.consoleId,
          sessionAttemptId: attempt.sessionAttemptId,
        };
        attempt.status = 'orphaned';
        attempt.endedAt = now;
        attempt.observer = {
          ...observer,
          state: 'disconnected',
          observedAt: now,
          diagnostic: 'ambient-native-process-evidence-expired',
        };
        attempt.receipts.push({
          operation: 'recover',
          status: 'orphaned',
          reason: 'ambient-native-process-evidence-expired',
          recordedAt: now,
          receiptRoot: null,
          semanticOutcome: null,
          workState: null,
          proof: null,
        });
        this.release(ref);
        console.updatedAt = now;
        expired.push(ref);
      }
    }
    return structuredClone(expired);
  }

  acquire({ workRef, console, attempt }) {
    return this.switch({ workRef, console, attempt });
  }

  switch({ workRef, console, attempt, previousWorkRef = null }) {
    const workKey = activeWorkKey(workRef);
    const ownerKey = refKey({
      workConsoleId: console.consoleId,
      sessionAttemptId: attempt.sessionAttemptId,
    });
    // One detached worker owns this service and its RPC loop serializes every
    // mutation. The compare and append therefore form the single-host CAS.
    const existing = this.state.activeWorkLeases.find((candidate) =>
      sameWork(candidate, workRef),
    );
    if (existing && refKey(existing) !== ownerKey) {
      throw Object.assign(new Error('Work already has an active Agent lease'), {
        code: 'native_work_already_active',
        lease: structuredClone(existing),
      });
    }
    const lease = existing ?? {
      schema: ACTIVE_WORK_LEASE_SCHEMA,
      leaseId: `work-lease:${workKey.slice('sha256:'.length, 23)}:${attempt.sessionAttemptId}`,
      workKey,
      workRef: validateWorkRef(workRef),
      workConsoleId: console.consoleId,
      sessionAttemptId: attempt.sessionAttemptId,
      provider: attempt.provider,
      runtimeProfileId: attempt.runtimeProfileId,
      acquiredAt: this.now(),
      state: 'active',
    };
    const previous = previousWorkRef ? validateWorkRef(previousWorkRef) : null;
    this.state.activeWorkLeases = this.state.activeWorkLeases.filter(
      (candidate) =>
        !(
          previous &&
          refKey(candidate) === ownerKey &&
          sameWork(candidate, previous) &&
          candidate.workKey !== workKey
        ),
    );
    if (!existing) this.state.activeWorkLeases.push(lease);
    return structuredClone(lease);
  }

  release(ref) {
    const ownerKey = refKey(ref);
    const released = [];
    this.state.activeWorkLeases = this.state.activeWorkLeases.filter(
      (lease) => {
        if (refKey(lease) !== ownerKey) return true;
        released.push(lease);
        return false;
      },
    );
    return structuredClone(released);
  }

  markRecoveryPending(ref, recoveryDeadlineAt) {
    const ownerKey = refKey(ref);
    const lease = this.state.activeWorkLeases.find(
      (candidate) => refKey(candidate) === ownerKey,
    );
    if (!lease) return null;
    lease.state = 'recovery-pending';
    lease.recoveryDeadlineAt = recoveryDeadlineAt;
    return structuredClone(lease);
  }

  recordProcessEvidence(ref) {
    const ownerKey = refKey(ref);
    const lease = this.state.activeWorkLeases.find(
      (candidate) => refKey(candidate) === ownerKey,
    );
    if (!lease) return null;
    lease.state = 'active';
    Reflect.deleteProperty(lease, 'recoveryDeadlineAt');
    return structuredClone(lease);
  }
}
