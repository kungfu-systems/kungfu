import { randomUUID } from 'node:crypto';
import {
  AGENT_SESSION_PEER_RECOVERY,
  admitCoordinator,
  coordinatorAuthority,
  positiveIntegerString,
} from './runtime-continuity.mjs';

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerTransportError('invalid_argument', `${label} is required`);
  }
  return value;
}

function epoch(value, label) {
  try {
    return positiveIntegerString(value, label);
  } catch {
    throw new PeerTransportError(
      'invalid_argument',
      `${label} must be a positive integer string`,
    );
  }
}

function requirePort(port) {
  for (const method of ['append', 'read', 'notice']) {
    if (typeof port?.[method] !== 'function') {
      throw new PeerTransportError(
        'invalid_transport',
        `journal/notice port must implement ${method}()`,
      );
    }
  }
  return port;
}

function sameForeground(expected, current) {
  if (!expected) return false;
  return (
    expected.provider === current.provider &&
    expected.profileRoot === current.profileRoot &&
    expected.executable === current.executable &&
    JSON.stringify(expected.argv) === JSON.stringify(current.argv) &&
    expected.processStartIdentity === current.processStartIdentity
  );
}

export class PeerTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PeerTransportError';
    this.code = code;
  }
}

/**
 * The Capsule-side authority state that rides a Kungfu journal + notice port.
 *
 * The injected port is deliberately smaller than a socket or broker API:
 * append-only frames, cursor reads and payload-free wakeup notices. Production
 * adapters bind it to ADR-0077 mmap journals and nng notices; tests use the
 * deterministic port below. The Coordinator never sees terminal bytes.
 */
export class AgentSessionCapsulePeerTransport {
  constructor({ host, port, now = () => Date.now(), leaseTtlMs = 30_000 }) {
    if (!host || typeof host.status !== 'function') {
      throw new PeerTransportError(
        'invalid_host',
        'peer transport requires a started Capsule host',
      );
    }
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) {
      throw new PeerTransportError(
        'invalid_argument',
        'leaseTtlMs must be a positive safe integer',
      );
    }
    this.host = host;
    this.port = requirePort(port);
    this.now = now;
    this.leaseTtlMs = leaseTtlMs;
    this.registration = null;
    this.runtimeContinuity = null;
    this.supervisorGeneration = null;
    this.attachments = new Map();
    this.controller = null;
    this.inputReceipts = new Map();
    this.lastPublishedSequence = 0;
    this.pendingResize = null;
  }

  register({
    runtimeGeneration = '1',
    coordinatorEpoch,
    supervisorGeneration,
  }) {
    const status = this.host.status();
    let candidate;
    try {
      candidate = coordinatorAuthority({
        runtimeGeneration,
        coordinatorEpoch,
      });
    } catch (error) {
      throw new PeerTransportError('invalid_argument', error.message);
    }
    const decision = admitCoordinator(this.runtimeContinuity, candidate);
    if (!decision.accepted) {
      throw new PeerTransportError(decision.admission, decision.reason);
    }
    const next = {
      schema: 'kungfu.agent-session.peer-registration/v1',
      peerKind: 'agent-session-capsule',
      runtimeIdentity: status.runtimeIdentity,
      capsuleId: status.capsuleId,
      workConsoleId: status.workConsoleId,
      sessionAttemptId: status.sessionAttemptId,
      capsuleGeneration: status.capsuleGeneration,
      sessionStreamEpoch: status.sessionStreamEpoch,
      processStartIdentity: status.foreground.processStartIdentity,
      runtimeGeneration: candidate.runtime_generation,
      coordinatorEpoch: candidate.coordinator_epoch,
      runtimeContinuity: candidate,
      supervisorGeneration: epoch(supervisorGeneration, 'supervisorGeneration'),
      recovery: AGENT_SESSION_PEER_RECOVERY,
      registeredAt: this.now(),
      capabilities: [
        'journal-output-writer',
        'notice-wakeup',
        'multi-reader-cursor',
        'controller-lease',
        'input-dedup',
        'supervisor-adoption',
      ],
    };
    this.registration = next;
    this.runtimeContinuity = candidate;
    this.supervisorGeneration = next.supervisorGeneration;
    return this.#append('durable-lifecycle', 'peer-registration', next);
  }

  reregister({ runtimeGeneration, coordinatorEpoch }) {
    const current = this.#requireRegistration();
    return this.register({
      runtimeGeneration: runtimeGeneration ?? current.runtimeGeneration,
      coordinatorEpoch,
      supervisorGeneration: current.supervisorGeneration,
    });
  }

  adopt({
    runtimeIdentity,
    capsuleGeneration,
    processStartIdentity,
    previousSupervisorGeneration,
    supervisorGeneration,
  }) {
    const registration = this.#requireRegistration();
    const status = this.host.status();
    if (runtimeIdentity !== status.runtimeIdentity) {
      throw new PeerTransportError(
        'stale_runtime',
        'runtime identity mismatch',
      );
    }
    if (capsuleGeneration !== status.capsuleGeneration) {
      throw new PeerTransportError(
        'stale_generation',
        'capsule generation mismatch',
      );
    }
    if (processStartIdentity !== status.foreground.processStartIdentity) {
      throw new PeerTransportError(
        'stale_process',
        'provider process identity mismatch',
      );
    }
    if (previousSupervisorGeneration !== this.supervisorGeneration) {
      throw new PeerTransportError(
        'stale_supervisor',
        'previous supervisor generation mismatch',
      );
    }
    const nextSupervisorGeneration = epoch(
      supervisorGeneration,
      'supervisorGeneration',
    );
    if (
      BigInt(nextSupervisorGeneration) <= BigInt(previousSupervisorGeneration)
    ) {
      throw new PeerTransportError(
        'stale_supervisor',
        'adopting supervisor generation must advance',
      );
    }
    this.supervisorGeneration = nextSupervisorGeneration;
    this.registration = {
      ...registration,
      supervisorGeneration: this.supervisorGeneration,
      recovery: registration.recovery,
      adoptedAt: this.now(),
    };
    return this.#append('durable-lifecycle', 'supervisor-adopted', {
      schema: 'kungfu.agent-session.adoption-receipt/v1',
      status: 'adopted',
      sessionAttemptId: status.sessionAttemptId,
      capsuleGeneration: status.capsuleGeneration,
      sessionStreamEpoch: status.sessionStreamEpoch,
      processStartIdentity: status.foreground.processStartIdentity,
      previousSupervisorGeneration,
      supervisorGeneration: this.supervisorGeneration,
      adoptedAt: this.now(),
    });
  }

  attach({ attachmentId, actorId, fromSequence = 0 }) {
    this.#requireRegistration();
    required(attachmentId, 'attachmentId');
    required(actorId, 'actorId');
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) {
      throw new PeerTransportError(
        'invalid_argument',
        'fromSequence must be a non-negative safe integer',
      );
    }
    const existing = this.attachments.get(attachmentId);
    if (existing) return this.read(attachmentId);
    const attachment = {
      attachmentId,
      actorId,
      journalCursor: 0,
      outputSequence: fromSequence,
      attachedAt: this.now(),
    };
    this.attachments.set(attachmentId, attachment);
    this.#append('auditable-control', 'attachment-opened', {
      schema: 'kungfu.agent-session.attachment-receipt/v1',
      status: 'attached',
      attachmentId,
      actorId,
      fromSequence,
      attachedAt: attachment.attachedAt,
    });
    return this.read(attachmentId);
  }

  detach({ attachmentId, actorId }) {
    const attachment = this.#requireAttachment(attachmentId);
    if (actorId !== attachment.actorId) {
      throw new PeerTransportError(
        'attachment_owner_mismatch',
        'only the attachment owner may detach it',
      );
    }
    this.attachments.delete(attachmentId);
    return this.#append('auditable-control', 'attachment-closed', {
      schema: 'kungfu.agent-session.attachment-receipt/v1',
      status: 'detached',
      attachmentId,
      actorId,
      detachedAt: this.now(),
    });
  }

  publishOutput() {
    this.#requireRegistration();
    const snapshot = this.host.snapshot(this.lastPublishedSequence);
    if (snapshot.receipt.gap) {
      this.#append('volatile-terminal-transport', 'output-gap', {
        schema: 'kungfu.agent-session.output-gap/v1',
        ...snapshot.receipt.gap,
        sessionAttemptId: this.host.status().sessionAttemptId,
        sessionStreamEpoch: this.host.status().sessionStreamEpoch,
      });
    }
    const unpublished = snapshot.frames.filter(
      (frame) => frame.endSequence > this.lastPublishedSequence,
    );
    if (unpublished.length > 0) {
      const first = unpublished[0];
      const chunks = unpublished.map((frame) => {
        const encoded = Buffer.from(frame.data, 'utf8');
        const skipped = Math.max(
          0,
          this.lastPublishedSequence - frame.startSequence,
        );
        return encoded.subarray(skipped);
      });
      this.#append('volatile-terminal-transport', 'output-bytes', {
        schema: 'kungfu.agent-session.output-frame/v1',
        sessionAttemptId: this.host.status().sessionAttemptId,
        sessionStreamEpoch: this.host.status().sessionStreamEpoch,
        startSequence: Math.max(
          first.startSequence,
          this.lastPublishedSequence,
        ),
        endSequence: snapshot.receipt.nextSequence,
        data: Buffer.concat(chunks).toString('utf8'),
      });
    }
    this.lastPublishedSequence = snapshot.receipt.nextSequence;
    return snapshot.receipt;
  }

  read(attachmentId) {
    const attachment = this.#requireAttachment(attachmentId);
    this.publishOutput();
    const journal = this.port.read({ fromCursor: attachment.journalCursor });
    const outputFrames = journal.frames.filter(
      (frame) =>
        frame.kind === 'output-bytes' &&
        frame.payload.endSequence > attachment.outputSequence,
    );
    const newest = outputFrames.at(-1);
    if (newest) attachment.outputSequence = newest.payload.endSequence;
    attachment.journalCursor = journal.nextCursor;
    const hostSnapshot = this.host.snapshot(attachment.outputSequence);
    const transportGap = journal.frames
      .filter((frame) => frame.kind === 'output-gap')
      .at(-1)?.payload;
    const gap = journal.gap ?? transportGap ?? hostSnapshot.receipt.gap;
    return {
      schema: 'kungfu.agent-session.attachment-read/v1',
      attachmentId,
      sessionAttemptId: this.host.status().sessionAttemptId,
      sessionStreamEpoch: this.host.status().sessionStreamEpoch,
      journalCursor: attachment.journalCursor,
      outputSequence: attachment.outputSequence,
      gap,
      snapshot: gap ? hostSnapshot.vt : null,
      frames: outputFrames,
    };
  }

  acquireControl({ leaseId = randomUUID(), holderId, planRoot, ttlMs }) {
    this.#requireRegistration();
    required(leaseId, 'leaseId');
    required(holderId, 'holderId');
    required(planRoot, 'planRoot');
    const now = this.now();
    const current = this.#activeController(now);
    if (current) {
      if (current.leaseId === leaseId && current.holderId === holderId) {
        return { ...current.receipt, status: 'duplicate' };
      }
      return this.#append('auditable-control', 'controller-denied', {
        schema: 'kungfu.agent-session.controller-lease-receipt/v1',
        status: 'denied',
        reason: 'controller-held',
        leaseId,
        holderId,
        currentLeaseId: current.leaseId,
        currentHolderId: current.holderId,
        planRoot,
        decidedAt: now,
      });
    }
    return this.#grantController({ leaseId, holderId, planRoot, ttlMs, now });
  }

  releaseControl({ leaseId, holderId, planRoot }) {
    const current = this.#activeController(this.now());
    if (
      !current ||
      current.leaseId !== leaseId ||
      current.holderId !== holderId
    ) {
      throw new PeerTransportError(
        'stale_controller_lease',
        'controller lease does not match the active holder',
      );
    }
    current.state = 'released';
    return this.#append('auditable-control', 'controller-released', {
      schema: 'kungfu.agent-session.controller-lease-receipt/v1',
      status: 'released',
      leaseId,
      holderId,
      planRoot: required(planRoot, 'planRoot'),
      releasedAt: this.now(),
    });
  }

  takeoverControl({
    expectedLeaseId,
    leaseId = randomUUID(),
    holderId,
    planRoot,
    approved,
    ttlMs,
  }) {
    const current = this.#activeController(this.now());
    if (!current || current.leaseId !== expectedLeaseId || approved !== true) {
      throw new PeerTransportError(
        'takeover_precondition_failed',
        'takeover requires the exact active lease and explicit policy approval',
      );
    }
    current.state = 'superseded';
    const receipt = this.#grantController({
      leaseId,
      holderId,
      planRoot,
      ttlMs,
      now: this.now(),
    });
    return { ...receipt, previousLeaseId: expectedLeaseId, takeover: true };
  }

  submitInput({
    leaseId,
    holderId,
    coordinatorEpoch,
    expectedForeground,
    ...action
  }) {
    const existing = this.inputReceipts.get(action.inputId);
    if (existing) return { ...existing, status: 'duplicate' };
    if (coordinatorEpoch !== this.#requireRegistration().coordinatorEpoch) {
      throw new PeerTransportError(
        'stale_coordinator',
        'input Coordinator epoch does not match current registration',
      );
    }
    const current = this.#activeController(this.now());
    if (
      !current ||
      current.leaseId !== leaseId ||
      current.holderId !== holderId
    ) {
      throw new PeerTransportError(
        'stale_controller_lease',
        'input requires the exact active controller lease',
      );
    }
    const status = this.host.status();
    if (!sameForeground(expectedForeground, status.foreground)) {
      throw new PeerTransportError(
        'foreground_mismatch',
        'input expected foreground does not match the provider',
      );
    }
    const receipt = this.host.input(action);
    const delivered = this.#append('auditable-control', 'input-delivered', {
      ...receipt,
      controllerLeaseId: leaseId,
      controllerHolderId: holderId,
    });
    this.inputReceipts.set(action.inputId, delivered);
    return delivered;
  }

  submitSignal({
    leaseId,
    holderId,
    coordinatorEpoch,
    expectedForeground,
    ...action
  }) {
    const existing = this.inputReceipts.get(action.inputId);
    if (existing) return { ...existing, status: 'duplicate' };
    if (coordinatorEpoch !== this.#requireRegistration().coordinatorEpoch) {
      throw new PeerTransportError(
        'stale_coordinator',
        'signal Coordinator epoch does not match current registration',
      );
    }
    const current = this.#activeController(this.now());
    if (
      !current ||
      current.leaseId !== leaseId ||
      current.holderId !== holderId
    ) {
      throw new PeerTransportError(
        'stale_controller_lease',
        'signal requires the exact active controller lease',
      );
    }
    const status = this.host.status();
    if (!sameForeground(expectedForeground, status.foreground)) {
      throw new PeerTransportError(
        'foreground_mismatch',
        'signal expected foreground does not match the provider',
      );
    }
    const receipt = this.host.signal(action);
    const delivered = this.#append('auditable-control', 'interrupt-delivered', {
      ...receipt,
      inputId: required(action.inputId, 'inputId'),
      controllerLeaseId: leaseId,
      controllerHolderId: holderId,
      semanticOutcome: null,
      workState: null,
    });
    this.inputReceipts.set(action.inputId, delivered);
    return delivered;
  }

  queueResize({ leaseId, holderId, ...action }) {
    const current = this.#activeController(this.now());
    if (
      !current ||
      current.leaseId !== leaseId ||
      current.holderId !== holderId
    ) {
      throw new PeerTransportError(
        'stale_controller_lease',
        'resize requires the exact active controller lease',
      );
    }
    this.pendingResize = action;
    return {
      schema: 'kungfu.agent-session.resize-queued/v1',
      status: 'coalesced',
      actionId: action.actionId,
      cols: action.cols,
      rows: action.rows,
    };
  }

  flushResize() {
    if (!this.pendingResize) return null;
    const action = this.pendingResize;
    this.pendingResize = null;
    return this.#append(
      'auditable-control',
      'resize-applied',
      this.host.resize(action),
    );
  }

  status() {
    const registration = this.#requireRegistration();
    const host = this.host.status();
    const controller = this.#activeController(this.now());
    return {
      schema: 'kungfu.agent-session.peer-status/v1',
      ...host,
      runtimeGeneration: registration.runtimeGeneration,
      coordinatorEpoch: registration.coordinatorEpoch,
      runtimeContinuity: registration.runtimeContinuity,
      supervisorGeneration: this.supervisorGeneration,
      recovery: registration.recovery,
      controllerLease: controller
        ? {
            leaseId: controller.leaseId,
            holderId: controller.holderId,
            expiresAt: controller.expiresAt,
            state: controller.state,
          }
        : null,
      attachments: this.attachments.size,
      publishedOutputSequence: this.lastPublishedSequence,
    };
  }

  #grantController({ leaseId, holderId, planRoot, ttlMs, now }) {
    required(leaseId, 'leaseId');
    required(holderId, 'holderId');
    required(planRoot, 'planRoot');
    const duration = ttlMs ?? this.leaseTtlMs;
    if (!Number.isSafeInteger(duration) || duration < 1) {
      throw new PeerTransportError(
        'invalid_argument',
        'ttlMs must be a positive safe integer',
      );
    }
    const status = this.host.status();
    const receipt = this.#append('auditable-control', 'controller-granted', {
      schema: 'kungfu.agent-session.controller-lease-receipt/v1',
      status: 'granted',
      leaseId,
      holderId,
      planRoot,
      capsuleGeneration: status.capsuleGeneration,
      sessionStreamEpoch: status.sessionStreamEpoch,
      issuedAt: now,
      expiresAt: now + duration,
    });
    this.controller = {
      leaseId,
      holderId,
      state: 'active',
      expiresAt: now + duration,
      receipt,
    };
    return receipt;
  }

  #activeController(now) {
    if (!this.controller || this.controller.state !== 'active') return null;
    if (now >= this.controller.expiresAt) {
      this.controller.state = 'expired';
      this.#append('auditable-control', 'controller-expired', {
        schema: 'kungfu.agent-session.controller-lease-receipt/v1',
        status: 'expired',
        leaseId: this.controller.leaseId,
        holderId: this.controller.holderId,
        expiredAt: now,
      });
      return null;
    }
    return this.controller;
  }

  #append(frameClass, kind, payload) {
    const frame = this.port.append({ frameClass, kind, payload });
    this.port.notice({
      schema: 'kungfu.agent-session.notice/v1',
      kind,
      cursor: frame.cursor,
      sessionAttemptId: this.host.status().sessionAttemptId,
    });
    return { ...payload, journalCursor: frame.cursor };
  }

  #requireRegistration() {
    if (!this.registration) {
      throw new PeerTransportError(
        'peer_not_registered',
        'Capsule peer is not registered',
      );
    }
    return this.registration;
  }

  #requireAttachment(attachmentId) {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) {
      throw new PeerTransportError(
        'attachment_not_found',
        `attachment '${attachmentId}' is not open`,
      );
    }
    return attachment;
  }
}

/** Deterministic test adapter for the same append/read/notice contract. */
export class InMemoryJournalNoticePort {
  constructor({ maxFrames = 256 } = {}) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
      throw new PeerTransportError(
        'invalid_argument',
        'maxFrames must be a positive safe integer',
      );
    }
    this.maxFrames = maxFrames;
    this.nextCursor = 1;
    this.frames = [];
    this.notices = [];
    this.dropNotices = false;
  }

  append(frame) {
    const stored = { cursor: this.nextCursor, ...structuredClone(frame) };
    this.nextCursor += 1;
    this.frames.push(stored);
    while (this.frames.length > this.maxFrames) this.frames.shift();
    return structuredClone(stored);
  }

  read({ fromCursor = 0 }) {
    const earliestCursor = this.frames[0]?.cursor ?? this.nextCursor;
    const gap =
      fromCursor + 1 < earliestCursor
        ? {
            fromCursor,
            toCursor: earliestCursor - 1,
            reason: 'bounded-journal-retention-overflow',
          }
        : null;
    return {
      earliestCursor,
      nextCursor: this.nextCursor - 1,
      gap,
      frames: structuredClone(
        this.frames.filter((frame) => frame.cursor > fromCursor),
      ),
    };
  }

  notice(value) {
    if (!this.dropNotices) this.notices.push(structuredClone(value));
  }
}
