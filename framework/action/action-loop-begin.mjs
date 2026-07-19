// SPDX-License-Identifier: Apache-2.0

import {
  classifyPrecondition,
  classifyRecovery,
  validateEnvelope,
} from './action-loop.mjs';

const ROOT = /^sha256:[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const BEGIN_REQUEST_SCHEMA = 'kungfu.action-loop.begin-request/v0';
const RESPONSE_SCHEMA = 'kungfu.action-loop.begin-response/v0';
const CHECKPOINT_SCHEMA = 'kungfu.action-loop.checkpoint/v0';
const ENVELOPE_SCHEMA = 'kungfu.action-loop.envelope/v0';

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

function validIdentity(value) {
  return typeof value === 'string' && IDENTITY.test(value);
}

function requirePort(adapters, group, operation) {
  const port = adapters?.[group];
  if (!port || typeof port[operation] !== 'function') {
    throw new TypeError(`${group}.${operation} adapter is required`);
  }
  return port[operation].bind(port);
}

function validateRoleBinding(binding, role, { rootMayBeNull = false } = {}) {
  if (!isObject(binding) || !validIdentity(binding.id)) {
    return failure('invalid-adapter-receipt', `${role} binding is invalid`, {
      role,
    });
  }
  if (!(rootMayBeNull && binding.root === null) && !validRoot(binding.root)) {
    return failure('invalid-adapter-receipt', `${role} root is invalid`, {
      role,
    });
  }
  if (typeof binding.state !== 'string' || binding.state.length === 0) {
    return failure('invalid-adapter-receipt', `${role} state is required`, {
      role,
    });
  }
  return null;
}

function validateFactRef(factRef) {
  return (
    isObject(factRef) &&
    validIdentity(factRef.name) &&
    validRoot(factRef.cutRoot) &&
    Number.isSafeInteger(factRef.revision) &&
    factRef.revision >= 0
  );
}

function validateStepReceipt(receipt, request, stepId) {
  if (
    !isObject(receipt) ||
    receipt.schema !== 'kungfu.action-loop.step-receipt/v0' ||
    receipt.loopId !== request.loopId ||
    receipt.stepId !== stepId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
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

function validateBeginRequest(request) {
  if (!isObject(request) || request.schema !== BEGIN_REQUEST_SCHEMA) {
    return failure('invalid-request', `schema must be ${BEGIN_REQUEST_SCHEMA}`);
  }
  for (const field of ['loopId', 'idempotencyKey', 'loopRef']) {
    if (!validIdentity(request[field])) {
      return failure('invalid-request', `${field} is invalid`, { field });
    }
  }
  if (!validRoot(request.loopRoot)) {
    return failure('invalid-root', 'loopRoot is invalid', {
      field: 'loopRoot',
    });
  }
  if (!isObject(request.factRef) || !validIdentity(request.factRef.name)) {
    return failure('invalid-request', 'factRef.name is required');
  }
  if (request.factRef.cutRoot !== null || request.factRef.revision !== 0) {
    return failure(
      'expected-old-required',
      'begin requires a new Fact ref at revision zero',
    );
  }
  for (const role of ['pursuit', 'atlas', 'warrant', 'episode', 'fact']) {
    if (!isObject(request[role])) {
      return failure('missing-role', `${role} input is required`, { role });
    }
  }
  return null;
}

function envelopeFrom(request, state, roles, factRef, acceptedSteps) {
  return {
    schema: ENVELOPE_SCHEMA,
    loopId: request.loopId,
    loopRoot: request.loopRoot,
    idempotencyKey: request.idempotencyKey,
    state,
    roles,
    factRef,
    acceptedSteps,
    residualRisk: [],
  };
}

function deniedResolution(result, role) {
  if (!isObject(result)) {
    return failure(
      'invalid-adapter-receipt',
      `${role} adapter returned no resolution`,
      { role },
    );
  }
  if (result.status === 'decision-required') {
    return failure(
      'decision-required',
      `${role} requires an explicit authority decision`,
      { role, decisionRequest: result.decisionRequest ?? {} },
    );
  }
  if (result.status === 'denied') {
    return failure(
      result.code || 'unauthorized',
      result.message || `${role} denied`,
      {
        role,
        details: result.details ?? {},
      },
    );
  }
  if (result.status !== 'resolved') {
    return failure(
      'invalid-adapter-receipt',
      `${role} adapter resolution status is invalid`,
      { role },
    );
  }
  return null;
}

async function resolveBeginRoles(request, adapters) {
  const pursuit = await requirePort(
    adapters,
    'pursuitSource',
    'resolve',
  )(request.pursuit, request);
  const pursuitFailure = deniedResolution(pursuit, 'pursuit');
  if (pursuitFailure) return pursuitFailure;

  const atlas = await requirePort(
    adapters,
    'atlasCompiler',
    'verify',
  )(request.atlas, request);
  const atlasFailure = deniedResolution(atlas, 'atlas');
  if (atlasFailure) return atlasFailure;

  const warrant = await requirePort(
    adapters,
    'warrantResolver',
    'resolve',
  )(request.warrant, {
    request,
    pursuit: pursuit.binding,
    atlas: atlas.binding,
  });
  const warrantFailure = deniedResolution(warrant, 'warrant');
  if (warrantFailure) return warrantFailure;

  const bindings = {
    pursuit: pursuit.binding,
    atlas: atlas.binding,
    warrant: warrant.binding,
    episode: {
      id: request.episode.id,
      root: null,
      state: 'open',
    },
    fact: request.fact,
  };
  for (const [role, binding] of Object.entries(bindings)) {
    const invalid = validateRoleBinding(binding, role, {
      rootMayBeNull: role === 'episode',
    });
    if (invalid) return invalid;
  }
  return { ok: true, bindings };
}

async function saveCheckpoint(contract, request, envelope, receipts, adapters) {
  const recovery = classifyRecovery(contract, envelope, receipts);
  if (!recovery.ok) return recovery;
  const saved = await requirePort(
    adapters,
    'checkpointStore',
    'save',
  )({
    schema: CHECKPOINT_SCHEMA,
    loopRef: request.loopRef,
    expectedOld: envelope.factRef,
    envelope,
    receipts,
  });
  if (
    !isObject(saved) ||
    saved.status !== 'accepted' ||
    !validRoot(saved.checkpointRoot) ||
    !validateFactRef(saved.factRef) ||
    !isObject(saved.envelope)
  ) {
    const code = saved?.code || 'invalid-adapter-receipt';
    return failure(
      code,
      saved?.message ||
        'checkpoint adapter did not return an accepted Fact ref',
      { writeOccurred: saved?.writeOccurred === true },
    );
  }
  const checked = validateEnvelope(contract, saved.envelope);
  if (!checked.ok) {
    return failure(
      'invalid-adapter-receipt',
      'checkpoint adapter returned an invalid envelope projection',
      { cause: checked },
    );
  }
  return {
    ok: true,
    checkpointRoot: saved.checkpointRoot,
    envelope: saved.envelope,
    factRef: saved.factRef,
    writeOccurred: saved.writeOccurred === true,
  };
}

export async function beginActionLoop(contract, request, adapters) {
  const invalid = validateBeginRequest(request);
  if (invalid) return invalid;

  const existing = await requirePort(
    adapters,
    'checkpointStore',
    'load',
  )(request.loopRef);
  if (existing?.status === 'current') {
    if (existing.envelope?.idempotencyKey !== request.idempotencyKey) {
      return failure(
        'idempotency-conflict',
        'loopRef already belongs to another idempotency key',
      );
    }
    return resumeActionLoop(contract, request.loopRef, adapters);
  }
  if (existing && existing.status !== 'absent') {
    return failure(
      existing.code || 'checkpoint-unavailable',
      existing.message || 'loop checkpoint could not be inspected',
    );
  }

  const resolved = await resolveBeginRoles(request, adapters);
  if (!resolved.ok) return resolved;

  const bind = await requirePort(
    adapters,
    'workProfileBinder',
    'bind',
  )({
    loopId: request.loopId,
    loopRoot: request.loopRoot,
    idempotencyKey: request.idempotencyKey,
    loopRef: request.loopRef,
    roles: resolved.bindings,
    factRef: request.factRef,
  });
  const bindReceiptFailure = validateStepReceipt(
    bind?.receipt,
    request,
    'bind-roles',
  );
  if (bindReceiptFailure) return bindReceiptFailure;
  if (!validateFactRef(bind.factRef)) {
    return failure(
      'invalid-adapter-receipt',
      'Work Profile bind did not return the current Fact ref',
    );
  }
  const boundRoles = { ...resolved.bindings, ...(bind.roles ?? {}) };
  const boundEnvelope = envelopeFrom(
    request,
    'bound',
    boundRoles,
    bind.factRef,
    ['bind-roles'],
  );
  const boundValidation = validateEnvelope(contract, boundEnvelope);
  if (!boundValidation.ok) return boundValidation;

  const boundCheckpoint = await saveCheckpoint(
    contract,
    request,
    boundEnvelope,
    [bind.receipt],
    adapters,
  );
  if (!boundCheckpoint.ok) return boundCheckpoint;
  const durableBoundEnvelope = boundCheckpoint.envelope;

  let opened;
  try {
    opened = await requirePort(
      adapters,
      'episodeRecorder',
      'resumeOrBegin',
    )({
      loopId: request.loopId,
      loopRoot: request.loopRoot,
      idempotencyKey: request.idempotencyKey,
      episode: request.episode,
      envelope: durableBoundEnvelope,
    });
  } catch (error) {
    return failure(
      'recovery-required',
      'Episode open outcome is not accepted; resume from the bound checkpoint',
      {
        nextStep: 'open-episode',
        checkpoint: boundCheckpoint,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const openReceiptFailure = validateStepReceipt(
    opened?.receipt,
    request,
    'open-episode',
  );
  if (openReceiptFailure) return openReceiptFailure;
  const episodeFailure = validateRoleBinding(opened.binding, 'episode', {
    rootMayBeNull: true,
  });
  if (episodeFailure) return episodeFailure;

  const runningEnvelope = envelopeFrom(
    request,
    'running',
    { ...boundRoles, episode: opened.binding },
    opened.factRef ?? durableBoundEnvelope.factRef,
    ['bind-roles', 'open-episode'],
  );
  const runningValidation = validateEnvelope(contract, runningEnvelope);
  if (!runningValidation.ok) return runningValidation;

  const checkpointed = await saveCheckpoint(
    contract,
    request,
    runningEnvelope,
    [bind.receipt, opened.receipt],
    adapters,
  );
  if (!checkpointed.ok) return checkpointed;
  return response(true, 'begun', {
    loopRef: request.loopRef,
    envelope: checkpointed.envelope,
    receipts: [bind.receipt, opened.receipt],
    checkpointRoot: checkpointed.checkpointRoot,
    nextStep: 'seal-episode',
    writeOccurred: true,
  });
}

export async function checkpointActionLoop(
  contract,
  { loopRef, envelope, receipts },
  adapters,
) {
  const validation = validateEnvelope(contract, envelope);
  if (!validation.ok) return validation;
  if (!Array.isArray(receipts)) {
    return failure('invalid-receipt', 'receipts must be an array');
  }
  const request = {
    loopRef,
    loopId: envelope.loopId,
    loopRoot: envelope.loopRoot,
    idempotencyKey: envelope.idempotencyKey,
  };
  const saved = await saveCheckpoint(
    contract,
    request,
    envelope,
    receipts,
    adapters,
  );
  if (!saved.ok) return saved;
  return response(true, 'checkpointed', {
    loopRef,
    envelope: saved.envelope,
    checkpointRoot: saved.checkpointRoot,
    writeOccurred: saved.writeOccurred,
  });
}

export async function resumeActionLoop(contract, loopRef, adapters) {
  if (!validIdentity(loopRef)) {
    return failure('invalid-request', 'loopRef is invalid');
  }
  const loaded = await requirePort(
    adapters,
    'checkpointStore',
    'load',
  )(loopRef);
  if (!isObject(loaded) || loaded.status !== 'current') {
    return failure(
      loaded?.code || 'loop-not-found',
      loaded?.message || 'loopRef has no current checkpoint',
    );
  }
  const envelopeValidation = validateEnvelope(contract, loaded.envelope);
  if (!envelopeValidation.ok) return envelopeValidation;
  if (!Array.isArray(loaded.receipts)) {
    return failure('invalid-receipt', 'checkpoint receipts must be an array');
  }
  const recovery = classifyRecovery(contract, loaded.envelope, loaded.receipts);
  if (!recovery.ok) return recovery;

  const [atlas, warrant, episode, factRef] = await Promise.all([
    requirePort(
      adapters,
      'atlasCompiler',
      'observe',
    )(loaded.envelope.roles.atlas),
    requirePort(
      adapters,
      'warrantResolver',
      'observe',
    )(loaded.envelope.roles.warrant),
    requirePort(
      adapters,
      'episodeRecorder',
      'inspect',
    )(loaded.envelope.roles.episode),
    requirePort(adapters, 'checkpointStore', 'resolve')(loopRef),
  ]);
  const preconditions = classifyPrecondition(loaded.envelope, {
    atlasCurrent: atlas?.current === true,
    warrantState: warrant?.state,
    episodeState: episode?.state,
    externalEffect: episode?.externalEffect ?? 'accepted',
    factRef,
  });
  if (!preconditions.ok) return preconditions;

  return response(
    true,
    recovery.code === 'already-settled' ? 'already-settled' : 'resumed',
    {
      loopRef,
      envelope: loaded.envelope,
      receipts: loaded.receipts,
      checkpointRoot: loaded.checkpointRoot,
      state: recovery.state,
      nextStep: recovery.nextStep,
      acceptedReceiptRoots: recovery.acceptedReceiptRoots,
      writeOccurred: false,
    },
  );
}

export function createExplicitCompatibilityAdapters() {
  return {
    pursuitSource: {
      async resolve(source) {
        if (
          !isObject(source) ||
          source.explicit !== true ||
          source.binding?.state !== 'active'
        ) {
          return {
            status: 'denied',
            code: 'pursuit-unavailable',
            message: 'an explicit active Mission/Go Pursuit is required',
          };
        }
        return { status: 'resolved', binding: source.binding };
      },
    },
    atlasCompiler: {
      async verify(source) {
        if (
          !isObject(source) ||
          source.verification?.valid !== true ||
          source.verification.atlasRoot !== source.binding?.root ||
          (source.verification.diagnostics ?? []).length !== 0
        ) {
          return {
            status: 'denied',
            code: 'stale-atlas',
            message:
              'the Xinfa Atlas must have an exact clean verification receipt',
          };
        }
        return { status: 'resolved', binding: source.binding };
      },
      async observe(binding) {
        return { current: binding?.state === 'current' };
      },
    },
    warrantResolver: {
      async resolve(source, context) {
        if (!isObject(source) || source.explicit !== true) {
          return {
            status: 'decision-required',
            decisionRequest: {
              code: 'explicit-warrant-required',
              pursuitRoot: context.pursuit?.root,
              atlasRoot: context.atlas?.root,
            },
          };
        }
        if (!['issued', 'attenuated'].includes(source.binding?.state)) {
          return {
            status: 'denied',
            code:
              source.binding?.state === 'revoked'
                ? 'warrant-revoked'
                : source.binding?.state === 'expired'
                  ? 'warrant-expired'
                  : 'unauthorized',
            message: 'the explicit Warrant is not active',
          };
        }
        return { status: 'resolved', binding: source.binding };
      },
      async observe(binding) {
        return { state: binding?.state };
      },
    },
  };
}

export function createCorePublicAdapters(invoke) {
  if (typeof invoke !== 'function') {
    throw new TypeError('Core public adapter invoke function is required');
  }
  return {
    workProfileBinder: {
      bind(input) {
        return invoke('work-profile-bind', input);
      },
    },
    episodeRecorder: {
      resumeOrBegin(input) {
        return invoke('episode-resume-or-begin', input);
      },
      inspect(binding) {
        return invoke('episode-inspect', binding);
      },
    },
    checkpointStore: {
      load(loopRef) {
        return invoke('checkpoint-load', loopRef);
      },
      save(checkpoint) {
        return invoke('checkpoint-save', checkpoint);
      },
      resolve(loopRef) {
        return invoke('checkpoint-resolve', loopRef);
      },
    },
  };
}

export const actionLoopBeginContract = Object.freeze({
  beginRequestSchema: BEGIN_REQUEST_SCHEMA,
  checkpointSchema: CHECKPOINT_SCHEMA,
  responseSchema: RESPONSE_SCHEMA,
});
