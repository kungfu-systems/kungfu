// SPDX-License-Identifier: Apache-2.0

import {
  checkpointActionLoop,
  resumeActionLoop,
} from './action-loop-begin.mjs';
import { classifyRecovery, validateEnvelope } from './action-loop.mjs';

const ROOT = /^sha256:[0-9a-f]{64}$/;
const RESPONSE_SCHEMA = 'kungfu.action-loop.settlement-response/v0';

function response(ok, code, details = {}) {
  return { schema: RESPONSE_SCHEMA, ok, code, ...details };
}

function failure(code, message, details = {}) {
  return response(false, code, { message, ...details });
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function validRoot(value) {
  return typeof value === 'string' && ROOT.test(value);
}

function requirePort(adapters, group, operation) {
  const port = adapters?.[group];
  if (!port || typeof port[operation] !== 'function') {
    throw new TypeError(`${group}.${operation} adapter is required`);
  }
  return port[operation].bind(port);
}

function validateReceipt(envelope, receipt, stepId) {
  if (
    !isObject(receipt) ||
    receipt.schema !== 'kungfu.action-loop.step-receipt/v0' ||
    receipt.loopId !== envelope.loopId ||
    receipt.stepId !== stepId ||
    receipt.idempotencyKey !== envelope.idempotencyKey ||
    receipt.status !== 'accepted' ||
    !validRoot(receipt.receiptRoot) ||
    !Array.isArray(receipt.preconditionRoots) ||
    !Array.isArray(receipt.resultRoots) ||
    ![...receipt.preconditionRoots, ...receipt.resultRoots].every(validRoot)
  ) {
    return failure(
      'invalid-adapter-receipt',
      `${stepId} adapter did not return an accepted authority receipt`,
      { stepId },
    );
  }
  return null;
}

function validateBinding(binding, role) {
  if (
    !isObject(binding) ||
    typeof binding.id !== 'string' ||
    !validRoot(binding.root) ||
    typeof binding.state !== 'string'
  ) {
    return failure(
      'invalid-adapter-receipt',
      `${role} adapter returned an invalid binding`,
      { role },
    );
  }
  return null;
}

function validFactRef(value) {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    validRoot(value.cutRoot) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

function withFactRef(envelope, factRef) {
  if (factRef === undefined) return envelope;
  if (!validFactRef(factRef)) {
    return null;
  }
  return {
    ...envelope,
    factRef,
    roles: {
      ...envelope.roles,
      fact: { ...envelope.roles.fact, root: factRef.cutRoot },
    },
  };
}

function withStep(envelope, stepId, state, roles) {
  return {
    ...envelope,
    state,
    roles: { ...envelope.roles, ...roles },
    acceptedSteps: [...envelope.acceptedSteps, stepId],
  };
}

async function checkpoint(contract, loopRef, envelope, receipts, adapters) {
  const saved = await checkpointActionLoop(
    contract,
    { loopRef, envelope, receipts },
    adapters,
  );
  if (!saved.ok) return saved;
  return {
    ok: true,
    envelope: saved.envelope,
    checkpointRoot: saved.checkpointRoot,
  };
}

async function sealEpisode(
  contract,
  loopRef,
  envelope,
  receipts,
  request,
  adapters,
) {
  let sealed;
  try {
    sealed = await requirePort(
      adapters,
      'episodeRecorder',
      'seal',
    )({
      loopRef,
      loopId: envelope.loopId,
      loopRoot: envelope.loopRoot,
      idempotencyKey: envelope.idempotencyKey,
      envelope,
      episode: envelope.roles.episode,
      result: request.result ?? {},
    });
  } catch (error) {
    return failure(
      'external-effect-unknown',
      'Episode seal outcome is unknown; inspect the exact Episode before retry',
      {
        nextStep: 'inspect-external-effect',
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const receiptFailure = validateReceipt(
    envelope,
    sealed?.receipt,
    'seal-episode',
  );
  if (receiptFailure) return receiptFailure;
  const bindingFailure = validateBinding(sealed.binding, 'episode');
  if (bindingFailure) return bindingFailure;
  if (sealed.binding.state !== 'sealed') {
    return failure(
      'episode-state-mismatch',
      'Episode seal did not produce sealed state',
    );
  }
  let nextEnvelope = withStep(envelope, 'seal-episode', 'episode-sealed', {
    episode: sealed.binding,
  });
  nextEnvelope = withFactRef(nextEnvelope, sealed.factRef);
  if (nextEnvelope === null) {
    return failure(
      'invalid-adapter-receipt',
      'Episode seal returned an invalid Fact ref',
    );
  }
  const saved = await checkpoint(
    contract,
    loopRef,
    nextEnvelope,
    [...receipts, sealed.receipt],
    adapters,
  );
  if (!saved.ok) return saved;
  return {
    ok: true,
    envelope: saved.envelope,
    receipts: [...receipts, sealed.receipt],
  };
}

async function refreshAtlas(
  contract,
  loopRef,
  envelope,
  receipts,
  request,
  adapters,
) {
  const refreshed = await requirePort(
    adapters,
    'atlasRefresher',
    'refresh',
  )({
    loopRef,
    loopId: envelope.loopId,
    loopRoot: envelope.loopRoot,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    predecessor: envelope.roles.atlas,
    successor: request.successorAtlas,
    episode: envelope.roles.episode,
  });
  if (refreshed?.status === 'blocked') {
    return failure(
      refreshed.code || 'stale-atlas',
      refreshed.message || 'successor Atlas is not verified',
      { diagnostics: refreshed.diagnostics ?? [] },
    );
  }
  const receiptFailure = validateReceipt(
    envelope,
    refreshed?.receipt,
    'refresh-atlas',
  );
  if (receiptFailure) return receiptFailure;
  const bindingFailure = validateBinding(refreshed.binding, 'atlas');
  if (bindingFailure) return bindingFailure;
  if (refreshed.binding.state !== 'current') {
    return failure('stale-atlas', 'successor Atlas is not current');
  }
  let nextEnvelope = withStep(envelope, 'refresh-atlas', 'atlas-refreshed', {
    atlas: refreshed.binding,
  });
  nextEnvelope = withFactRef(nextEnvelope, refreshed.factRef);
  if (nextEnvelope === null) {
    return failure(
      'invalid-adapter-receipt',
      'Atlas refresh returned an invalid Fact ref',
    );
  }
  const saved = await checkpoint(
    contract,
    loopRef,
    nextEnvelope,
    [...receipts, refreshed.receipt],
    adapters,
  );
  if (!saved.ok) return saved;
  return {
    ok: true,
    envelope: saved.envelope,
    receipts: [...receipts, refreshed.receipt],
    atlas: refreshed,
  };
}

async function reviewCompletion(
  contract,
  loopRef,
  envelope,
  receipts,
  request,
  adapters,
) {
  const reviewed = await requirePort(
    adapters,
    'completionReviewer',
    'review',
  )({
    loopRef,
    loopId: envelope.loopId,
    loopRoot: envelope.loopRoot,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    completion: request.completion,
  });
  if (reviewed?.status === 'pending' || reviewed?.verdict !== 'fit') {
    return failure(
      reviewed?.code || 'review-pending',
      reviewed?.message || 'independent completion review is not fit',
      {
        verdict: reviewed?.verdict ?? 'pending',
        evidenceRequests: reviewed?.evidenceRequests ?? [],
        nextStep: 'review-completion',
      },
    );
  }
  const receiptFailure = validateReceipt(
    envelope,
    reviewed?.receipt,
    'review-completion',
  );
  if (receiptFailure) return receiptFailure;
  for (const field of [
    'completionClaimRoot',
    'independentReviewRoot',
    'continuationPlanRoot',
  ]) {
    if (!validRoot(reviewed[field])) {
      return failure('invalid-adapter-receipt', `${field} is invalid`, {
        field,
      });
    }
  }
  const nextEnvelope = withStep(envelope, 'review-completion', 'reviewed', {});
  const saved = await checkpoint(
    contract,
    loopRef,
    nextEnvelope,
    [...receipts, reviewed.receipt],
    adapters,
  );
  if (!saved.ok) return saved;
  return {
    ok: true,
    envelope: saved.envelope,
    receipts: [...receipts, reviewed.receipt],
    review: reviewed,
  };
}

async function settleFact(
  contract,
  loopRef,
  envelope,
  receipts,
  request,
  adapters,
) {
  const settled = await requirePort(
    adapters,
    'factCommitter',
    'settle',
  )({
    loopRef,
    loopId: envelope.loopId,
    loopRoot: envelope.loopRoot,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    receipts,
    settlement: request.settlement,
  });
  if (settled?.status === 'denied') {
    return failure(
      settled.code || 'settlement-denied',
      settled.message || 'Fact settlement was denied',
      { writeOccurred: settled.writeOccurred === true },
    );
  }
  const receiptFailure = validateReceipt(
    envelope,
    settled?.receipt,
    'settle-fact-ref',
  );
  if (receiptFailure) return receiptFailure;
  const checked = validateEnvelope(contract, settled.envelope);
  if (!checked.ok) return checked;
  if (settled.envelope.state !== 'settled') {
    return failure(
      'state-receipt-mismatch',
      'Fact settlement did not persist settled state',
    );
  }
  const finalReceipts = [...receipts, settled.receipt];
  const recovery = classifyRecovery(contract, settled.envelope, finalReceipts);
  if (!recovery.ok || recovery.code !== 'already-settled') {
    return recovery.ok
      ? failure(
          'state-receipt-mismatch',
          'final settlement receipt is incomplete',
        )
      : recovery;
  }
  return response(true, 'settled', {
    loopRef,
    envelope: settled.envelope,
    receipts: finalReceipts,
    checkpointRoot: settled.checkpointRoot,
    settlementReceiptRoot: settled.receipt.receiptRoot,
    writeOccurred: settled.writeOccurred === true,
  });
}

export async function settleActionLoop(contract, request, adapters) {
  if (!isObject(request) || typeof request.loopRef !== 'string') {
    return failure('invalid-request', 'loopRef is required');
  }
  const resumed = await resumeActionLoop(contract, request.loopRef, adapters);
  if (!resumed.ok) return resumed;
  if (resumed.code === 'already-settled') {
    return response(true, 'already-settled', {
      loopRef: request.loopRef,
      envelope: resumed.envelope,
      receipts: resumed.receipts,
      checkpointRoot: resumed.checkpointRoot,
      writeOccurred: false,
    });
  }

  let envelope = resumed.envelope;
  let receipts = resumed.receipts;
  let nextStep = resumed.nextStep;
  if (nextStep === 'seal-episode') {
    const step = await sealEpisode(
      contract,
      request.loopRef,
      envelope,
      receipts,
      request,
      adapters,
    );
    if (!step.ok) return step;
    ({ envelope, receipts } = step);
    nextStep = 'refresh-atlas';
  }
  if (nextStep === 'refresh-atlas') {
    const step = await refreshAtlas(
      contract,
      request.loopRef,
      envelope,
      receipts,
      request,
      adapters,
    );
    if (!step.ok) return step;
    ({ envelope, receipts } = step);
    nextStep = 'review-completion';
  }
  if (nextStep === 'review-completion') {
    const step = await reviewCompletion(
      contract,
      request.loopRef,
      envelope,
      receipts,
      request,
      adapters,
    );
    if (!step.ok) return step;
    ({ envelope, receipts } = step);
    nextStep = 'settle-fact-ref';
  }
  if (nextStep === 'settle-fact-ref') {
    return settleFact(
      contract,
      request.loopRef,
      envelope,
      receipts,
      request,
      adapters,
    );
  }
  return failure('out-of-order-step', `settlement cannot execute ${nextStep}`, {
    nextStep,
  });
}

export function createSettlementCoreAdapters(invoke) {
  if (typeof invoke !== 'function') {
    throw new TypeError('Core public adapter invoke function is required');
  }
  return {
    episodeRecorder: {
      seal(input) {
        return invoke('episode-seal', input);
      },
    },
    atlasRefresher: {
      refresh(input) {
        return invoke('work-profile-atlas-refresh', input);
      },
    },
    completionReviewer: {
      review(input) {
        return invoke('completion-review', input);
      },
    },
    factCommitter: {
      settle(input) {
        return invoke('fact-settle', input);
      },
    },
  };
}

export const actionLoopSettlementContract = Object.freeze({
  responseSchema: RESPONSE_SCHEMA,
});
