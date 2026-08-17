const ATTENTION_ACTIONS = Object.freeze({
  'needs-answer': ['reply', 'review-changes', 'end-attempt'],
  'needs-approval': ['inspect-request', 'approve', 'deny'],
  blocked: ['inspect-session', 'retry-or-start-new-attempt'],
  'ready-for-review': ['review-changes', 'start-new-attempt'],
});

function attention(kind, reason, message) {
  return {
    schema: 'kungfu.work-agent-attention/v1',
    kind,
    reason,
    message,
    nextActions: [...ATTENTION_ACTIONS[kind]],
  };
}

/**
 * Project Work projection for one Agent Session attempt.
 *
 * Provider readiness proves only that input can be accepted. It never proves
 * Work completion, so a ready provider is deliberately presented as waiting
 * for an answer with an explicit path to human review.
 */
export function projectWorkAgentState(session = {}) {
  const live = session.live === true;
  const lifecycle = session.lifecycleState ?? '';
  const interaction = session.interactionState ?? '';
  const attemptStatus = session.attempt?.status ?? session.attemptStatus ?? '';
  const exitCode = session.exit?.exitCode ?? session.exit?.code ?? null;
  const controlledEnd = session.exit?.controlRequest?.operation === 'end';
  const interactionReason =
    session.providerAdapter?.reason ?? session.interactionReason ?? null;
  const interactionSignatures = Array.isArray(
    session.providerAdapter?.signatureIds,
  )
    ? session.providerAdapter.signatureIds
    : [];

  if (
    attemptStatus === 'unrecoverable' ||
    lifecycle === 'lost-control' ||
    lifecycle === 'degraded'
  ) {
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'unrecoverable',
      attention: attention(
        'blocked',
        'attempt-cannot-be-reattached',
        'The Agent process cannot be reattached. Start a new attempt to continue this Work.',
      ),
    };
  }

  if (
    lifecycle === 'ended' ||
    lifecycle === 'exited' ||
    attemptStatus === 'ended' ||
    attemptStatus === 'exited'
  ) {
    if (exitCode !== null && exitCode !== 0 && !controlledEnd) {
      return {
        schema: 'kungfu.project-work-agent-state/v1',
        attempt: 'ended',
        attention: attention(
          'blocked',
          'agent-exited-with-error',
          'The Agent process ended with an error. Inspect the session before retrying.',
        ),
      };
    }
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'ended',
      attention: attention(
        'ready-for-review',
        controlledEnd
          ? 'agent-attempt-ended-by-controller'
          : 'agent-attempt-ended',
        controlledEnd
          ? 'The Agent attempt was ended for review. Review the project changes before completing Work.'
          : 'The Agent attempt ended. Review the project changes before completing Work.',
      ),
    };
  }

  if (live && interaction === 'approval-needed') {
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'waiting',
      attention: attention(
        'needs-approval',
        'provider-request-needs-review',
        'The Agent needs your approval before it can continue.',
      ),
    };
  }

  if (live && interaction === 'unknown') {
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'waiting',
      attention: attention(
        'blocked',
        interactionReason ?? 'interaction-state-needs-review',
        'Kungfu cannot safely interpret the Agent state. Inspect the session before continuing.',
      ),
    };
  }

  if (live && interaction === 'ready') {
    if (interactionSignatures.includes('synthetic.ready.review')) {
      return {
        schema: 'kungfu.project-work-agent-state/v1',
        attempt: 'waiting',
        attention: attention(
          'ready-for-review',
          'agent-reported-review-boundary',
          'The Agent reached the deterministic review boundary. Review the project changes before completing Work.',
        ),
      };
    }
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'waiting',
      attention: attention(
        'needs-answer',
        'agent-is-waiting',
        'The Agent is waiting for you. Reply, or review the project changes if the task is ready.',
      ),
    };
  }

  if (live && interaction === 'busy') {
    return {
      schema: 'kungfu.project-work-agent-state/v1',
      attempt: 'working',
      attention: null,
    };
  }

  return {
    schema: 'kungfu.project-work-agent-state/v1',
    attempt:
      lifecycle === 'starting' || attemptStatus === 'planned'
        ? 'starting'
        : 'working',
    attention: null,
  };
}
