export type AgentSessionProductState =
  | 'available'
  | 'starting'
  | 'working'
  | 'recovering'
  | 'action-required'
  | 'ended';

export type AgentSessionProductProjection = {
  state: AgentSessionProductState;
  reason: string;
  recommendedAction: string | null;
};

export type AgentSessionComposerPresentation = {
  state: 'ready' | 'waiting' | 'blocked';
  label: string;
  guidance: string;
  canSend: boolean;
};

type AgentSessionStatusCompatibilityInput = {
  product?: AgentSessionProductProjection;
  live?: boolean;
  lifecycleState?: string;
  interactionState?: string;
};

const LABELS: Record<AgentSessionProductState, string> = {
  available: 'Available',
  starting: 'Starting',
  working: 'Working',
  recovering: 'Recovering',
  'action-required': 'Action required',
  ended: 'Ended',
};

const DETAILS: Record<string, string> = {
  'ready-for-input': 'Ready for your next instruction.',
  'attempt-starting': 'The session is starting automatically.',
  'provider-working': 'The session is working.',
  'reattaching-session': 'Reattaching to the current session.',
  'provider-request-needs-review': 'Review the provider request to continue.',
  'interaction-state-needs-review':
    'Review the session before continuing or starting a new attempt.',
  'automatic-recovery-cannot-continue':
    'Review the session before continuing or starting a new attempt.',
  'prior-attempt-cannot-be-reattached':
    'Start a new attempt or use provider-supported resume.',
  'attempt-ended': 'This attempt has ended.',
};

export function agentSessionProductLabel(
  product: AgentSessionProductProjection,
): string {
  return LABELS[product.state];
}

export function resolveAgentSessionProduct(
  status: AgentSessionStatusCompatibilityInput,
): AgentSessionProductProjection {
  if (status.product) return status.product;
  if (['ended', 'exited'].includes(status.lifecycleState ?? '')) {
    return {
      state: 'ended',
      reason: 'attempt-ended',
      recommendedAction: null,
    };
  }
  if (['unrecoverable', 'lost-control'].includes(status.lifecycleState ?? '')) {
    return {
      state: 'action-required',
      reason: 'prior-attempt-cannot-be-reattached',
      recommendedAction: 'start-new-attempt-or-provider-resume',
    };
  }
  if (status.interactionState === 'approval-needed') {
    return {
      state: 'action-required',
      reason: 'provider-request-needs-review',
      recommendedAction: 'review-provider-request',
    };
  }
  if (['starting', 'planned'].includes(status.lifecycleState ?? '')) {
    return {
      state: 'starting',
      reason: 'attempt-starting',
      recommendedAction: null,
    };
  }
  if (status.live !== false && status.interactionState === 'busy') {
    return {
      state: 'working',
      reason: 'provider-working',
      recommendedAction: null,
    };
  }
  if (
    status.live !== false &&
    status.lifecycleState === 'ready' &&
    status.interactionState === 'ready'
  ) {
    return {
      state: 'available',
      reason: 'ready-for-input',
      recommendedAction: null,
    };
  }
  return {
    state: 'recovering',
    reason: 'reattaching-session',
    recommendedAction: null,
  };
}

export function agentSessionProductDetail(
  product: AgentSessionProductProjection,
): string {
  return DETAILS[product.reason] ?? 'Review the current session state.';
}

export function resolveAgentSessionComposer({
  product,
  inputAdmission,
  controllerHolderId,
  actorId,
  providerLabel = 'Agent',
  submitting = false,
}: {
  product: AgentSessionProductProjection;
  inputAdmission?: string;
  controllerHolderId?: string | null;
  actorId?: string;
  providerLabel?: string;
  submitting?: boolean;
}): AgentSessionComposerPresentation {
  if (submitting) {
    return {
      state: 'waiting',
      label: 'Sending…',
      guidance: `Delivering this instruction to the active ${providerLabel} session.`,
      canSend: false,
    };
  }
  if (inputAdmission !== 'open') {
    return {
      state: 'blocked',
      label: 'Input paused',
      guidance: 'This session is not accepting new instructions right now.',
      canSend: false,
    };
  }
  if (product.state === 'action-required') {
    return {
      state: 'blocked',
      label: 'Action required',
      guidance: agentSessionProductDetail(product),
      canSend: false,
    };
  }
  if (product.state === 'working') {
    return {
      state: 'waiting',
      label: `${providerLabel} is working`,
      guidance: `You can prepare the next instruction now. Send unlocks when ${providerLabel} is available.`,
      canSend: false,
    };
  }
  if (product.state === 'starting' || product.state === 'recovering') {
    return {
      state: 'waiting',
      label:
        product.state === 'starting'
          ? `Starting ${providerLabel}`
          : 'Reconnecting',
      guidance:
        'You can prepare an instruction while the session becomes available.',
      canSend: false,
    };
  }
  if (product.state === 'ended') {
    return {
      state: 'blocked',
      label: 'Session ended',
      guidance: 'Start or attach another session to continue.',
      canSend: false,
    };
  }
  if (!controllerHolderId) {
    return {
      state: 'blocked',
      label: 'Control required',
      guidance: 'Request control above before sending an instruction.',
      canSend: false,
    };
  }
  if (controllerHolderId !== actorId) {
    return {
      state: 'blocked',
      label: 'Controlled elsewhere',
      guidance: 'Another attached client currently controls this session.',
      canSend: false,
    };
  }
  return {
    state: 'ready',
    label: 'Ready to send',
    guidance: 'Press Enter to send · Shift+Enter for a new line.',
    canSend: true,
  };
}

export function instructionWasDelivered(status: unknown): boolean {
  return status === 'written' || status === 'delivered';
}
