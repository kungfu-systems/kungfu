// SPDX-License-Identifier: Apache-2.0

const ROOT = /^sha256:[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ENVELOPE_SCHEMA = 'kungfu.action-loop.envelope/v0';
const RECEIPT_SCHEMA = 'kungfu.action-loop.step-receipt/v0';

function result(ok, code, details = {}) {
  return {
    schema: 'kungfu.action-loop.recovery-result/v0',
    ok,
    code,
    ...details,
  };
}

function fail(code, message, details = {}) {
  return result(false, code, { message, ...details });
}

function validRoot(value) {
  return typeof value === 'string' && ROOT.test(value);
}

function validIdentity(value) {
  return typeof value === 'string' && IDENTITY.test(value);
}

export function validateEnvelope(contract, envelope) {
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object')
    return fail('invalid-envelope', 'envelope must be an object');
  if (envelope.schema !== ENVELOPE_SCHEMA)
    return fail('invalid-envelope', `schema must be ${ENVELOPE_SCHEMA}`);
  if (!validIdentity(envelope.loopId))
    return fail('invalid-envelope', 'loopId is invalid');
  if (!validRoot(envelope.loopRoot))
    return fail('invalid-root', 'loopRoot is invalid', { field: 'loopRoot' });
  if (!validIdentity(envelope.idempotencyKey))
    return fail('invalid-envelope', 'idempotencyKey is invalid');
  if (!contract.states.includes(envelope.state))
    return fail('invalid-envelope', 'state is not declared by the contract');
  if (!envelope.roles || Array.isArray(envelope.roles))
    return fail('missing-role', 'roles must be an object');

  for (const role of contract.roles) {
    const binding = envelope.roles[role.id];
    if (!binding || Array.isArray(binding) || typeof binding !== 'object')
      return fail('missing-role', `${role.id} binding is required`, {
        role: role.id,
      });
    if (!validIdentity(binding.id))
      return fail('missing-role', `${role.id} identity is required`, {
        role: role.id,
      });
    const rootMayBePending =
      role.id === 'episode' &&
      ['planned', 'bound', 'running'].includes(envelope.state);
    if (binding.root === null && rootMayBePending) continue;
    if (!validRoot(binding.root))
      return fail('invalid-root', `${role.id} root is invalid`, {
        role: role.id,
      });
  }

  const factRef = envelope.factRef;
  if (
    !factRef ||
    !validIdentity(factRef.name) ||
    !validRoot(factRef.cutRoot) ||
    !Number.isSafeInteger(factRef.revision) ||
    factRef.revision < 0
  )
    return fail(
      'invalid-envelope',
      'factRef must carry name, cutRoot, and revision',
    );
  if (!Array.isArray(envelope.acceptedSteps))
    return fail('invalid-envelope', 'acceptedSteps must be an array');
  if (!Array.isArray(envelope.residualRisk))
    return fail('invalid-envelope', 'residualRisk must be an array');
  if (envelope.nativeAuthority !== undefined) {
    const authority = envelope.nativeAuthority;
    if (
      !authority ||
      authority.schema !== 'kungfu.action-loop.native-authority/v0' ||
      !validIdentity(authority.id) ||
      !validRoot(authority.root) ||
      authority.state !== 'current' ||
      typeof authority.binding?.path !== 'string' ||
      !validRoot(authority.binding?.root) ||
      !validIdentity(authority.profile?.id) ||
      !validRoot(authority.profile?.root)
    ) {
      return fail(
        'invalid-native-authority',
        'nativeAuthority must bind one native binary and Profile exact root',
      );
    }
  }
  return result(true, 'valid-envelope');
}

function validateReceipt(envelope, receipt) {
  if (!receipt || Array.isArray(receipt) || typeof receipt !== 'object')
    return fail('invalid-receipt', 'step receipt must be an object');
  if (receipt.schema !== RECEIPT_SCHEMA)
    return fail('invalid-receipt', `receipt schema must be ${RECEIPT_SCHEMA}`);
  if (receipt.loopId !== envelope.loopId)
    return fail(
      'invalid-receipt',
      'receipt loopId does not match the envelope',
    );
  if (receipt.idempotencyKey !== envelope.idempotencyKey)
    return fail(
      'idempotency-conflict',
      'receipt idempotency key does not match',
    );
  if (!validRoot(receipt.receiptRoot))
    return fail('invalid-root', 'receiptRoot is invalid');
  if (receipt.status !== 'accepted')
    return fail(
      'invalid-receipt',
      'only accepted authority receipts advance recovery',
    );
  if (
    !Array.isArray(receipt.preconditionRoots) ||
    !Array.isArray(receipt.resultRoots)
  )
    return fail('invalid-receipt', 'receipt root sets must be arrays');
  if (![...receipt.preconditionRoots, ...receipt.resultRoots].every(validRoot))
    return fail('invalid-root', 'receipt root sets contain an invalid root');
  return result(true, 'valid-receipt');
}

export function classifyRecovery(contract, envelope, receipts) {
  const envelopeResult = validateEnvelope(contract, envelope);
  if (!envelopeResult.ok) return envelopeResult;
  if (!Array.isArray(receipts))
    return fail('invalid-receipt', 'receipts must be an array');

  const ordered = contract.orderedSteps;
  const accepted = new Map();
  for (const receipt of receipts) {
    const receiptResult = validateReceipt(envelope, receipt);
    if (!receiptResult.ok) return receiptResult;
    const stepIndex = ordered.findIndex(({ id }) => id === receipt.stepId);
    if (stepIndex === -1)
      return fail('invalid-receipt', `unknown stepId: ${receipt.stepId}`);
    const previous = accepted.get(receipt.stepId);
    if (previous && previous.receiptRoot !== receipt.receiptRoot)
      return fail(
        'idempotency-conflict',
        'one step has conflicting accepted receipts',
        {
          stepId: receipt.stepId,
          receiptRoots: [previous.receiptRoot, receipt.receiptRoot],
        },
      );
    accepted.set(receipt.stepId, receipt);
  }

  let prefixLength = 0;
  while (
    prefixLength < ordered.length &&
    accepted.has(ordered[prefixLength].id)
  )
    prefixLength += 1;
  for (let index = prefixLength + 1; index < ordered.length; index += 1) {
    if (accepted.has(ordered[index].id))
      return fail(
        'out-of-order-step',
        'an accepted receipt skips a required step',
        {
          missingStep: ordered[prefixLength].id,
          observedStep: ordered[index].id,
        },
      );
  }

  const derivedState =
    prefixLength === 0 ? 'planned' : ordered[prefixLength - 1].to;
  if (envelope.state !== derivedState)
    return fail(
      'state-receipt-mismatch',
      'envelope state differs from accepted receipts',
      {
        envelopeState: envelope.state,
        derivedState,
      },
    );
  if (derivedState === 'settled')
    return result(true, 'already-settled', {
      state: derivedState,
      nextStep: null,
      acceptedReceiptRoots: ordered.map(
        ({ id }) => accepted.get(id).receiptRoot,
      ),
    });
  return result(true, 'resume', {
    state: derivedState,
    nextStep: ordered[prefixLength].id,
    acceptedReceiptRoots: ordered
      .slice(0, prefixLength)
      .map(({ id }) => accepted.get(id).receiptRoot),
  });
}

export function classifyPrecondition(envelope, observation) {
  if (observation.atlasCurrent === false)
    return fail('stale-atlas', 'the bound Atlas is stale');
  if (observation.warrantState === 'expired')
    return fail('warrant-expired', 'the bound Warrant has expired');
  if (observation.warrantState === 'revoked')
    return fail('warrant-revoked', 'the bound Warrant is revoked');
  if (
    observation.factRef &&
    (observation.factRef.cutRoot !== envelope.factRef.cutRoot ||
      observation.factRef.revision !== envelope.factRef.revision)
  )
    return fail('stale-ref', 'the Fact ref differs from expected-old');
  if (observation.externalEffect === 'unknown')
    return fail(
      'external-effect-unknown',
      'an external effect lacks an accepted receipt',
      { nextStep: 'inspect-external-effect' },
    );
  if (
    observation.episodeState &&
    observation.episodeState !== envelope.roles.episode.state
  )
    return fail(
      'episode-state-mismatch',
      'the Episode lifecycle state differs',
    );
  return result(true, 'preconditions-current');
}
