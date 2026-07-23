export const RUNTIME_PEER_CONTINUITY_SCHEMA =
  'kungfu.runtime.peer-continuity/v1';

export const AGENT_SESSION_PEER_RECOVERY = Object.freeze({
  schema: 'kungfu.runtime.peer-recovery/v1',
  processExit: 'lost-control',
  durableState: 'none',
  guidance:
    'End the old SessionAttempt and start a new attempt or use provider-supported resume; never claim PTY process recovery.',
});

const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export function positiveIntegerString(value, label) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
    throw new TypeError(`${label} must be a positive integer string`);
  }
  return value;
}

export function coordinatorAuthority({ runtimeGeneration, coordinatorEpoch }) {
  return {
    schema: RUNTIME_PEER_CONTINUITY_SCHEMA,
    runtime_generation: positiveIntegerString(
      runtimeGeneration,
      'runtimeGeneration',
    ),
    coordinator_epoch: positiveIntegerString(
      coordinatorEpoch,
      'coordinatorEpoch',
    ),
  };
}

function validateAuthority(value, label) {
  if (
    !value ||
    value.schema !== RUNTIME_PEER_CONTINUITY_SCHEMA ||
    typeof value !== 'object'
  ) {
    throw new TypeError(`${label} has an unsupported continuity schema`);
  }
  return coordinatorAuthority({
    runtimeGeneration: value.runtime_generation,
    coordinatorEpoch: value.coordinator_epoch,
  });
}

export function admitCoordinator(observed, candidateValue) {
  const candidate = validateAuthority(candidateValue, 'candidate authority');
  if (observed == null) {
    return {
      accepted: true,
      admission: 'accepted',
      reason: 'initial coordinator authority accepted',
    };
  }
  const current = validateAuthority(observed, 'observed authority');
  const currentGeneration = BigInt(current.runtime_generation);
  const candidateGeneration = BigInt(candidate.runtime_generation);
  if (candidateGeneration < currentGeneration) {
    return {
      accepted: false,
      admission: 'stale_generation',
      reason: 'runtime generation moved backwards',
    };
  }
  if (
    candidateGeneration === currentGeneration &&
    BigInt(candidate.coordinator_epoch) <= BigInt(current.coordinator_epoch)
  ) {
    return {
      accepted: false,
      admission: 'stale_coordinator',
      reason: 'coordinator epoch did not advance',
    };
  }
  return {
    accepted: true,
    admission: 'accepted',
    reason: 'coordinator authority advanced',
  };
}

export function peerContinuityObservation({
  lastAuthority = null,
  reconnectAttempt,
}) {
  return {
    schema: RUNTIME_PEER_CONTINUITY_SCHEMA,
    reconnect_attempt: positiveIntegerString(
      reconnectAttempt,
      'reconnectAttempt',
    ),
    last_authority:
      lastAuthority == null
        ? null
        : validateAuthority(lastAuthority, 'last authority'),
  };
}
