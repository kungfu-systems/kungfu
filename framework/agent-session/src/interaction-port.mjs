const MODES = new Set(['when-ready', 'queue', 'interrupt']);
const PROVIDER_INPUT_WAIT = new Int32Array(new SharedArrayBuffer(4));

function pauseProviderInput(milliseconds) {
  Atomics.wait(PROVIDER_INPUT_WAIT, 0, 0, milliseconds);
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InteractionPortError('invalid_argument', `${label} is required`);
  }
  return value;
}

function nullOutcome() {
  return { semanticOutcome: null, workState: null };
}

export class InteractionPortError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InteractionPortError';
    this.code = code;
  }
}

export class AgentSessionInteractionPort {
  constructor({
    host,
    transport,
    adapter,
    queueLimit = 32,
    now = () => Date.now(),
    pause = pauseProviderInput,
  }) {
    if (
      !host ||
      typeof host.status !== 'function' ||
      typeof host.snapshot !== 'function'
    ) {
      throw new InteractionPortError(
        'invalid_host',
        'interaction port requires a Capsule host',
      );
    }
    if (!transport || typeof transport.submitInput !== 'function') {
      throw new InteractionPortError(
        'invalid_transport',
        'interaction port requires Capsule peer transport',
      );
    }
    if (!adapter || typeof adapter.inspect !== 'function') {
      throw new InteractionPortError(
        'invalid_adapter',
        'interaction port requires a provider adapter',
      );
    }
    if (typeof pause !== 'function') {
      throw new InteractionPortError(
        'invalid_argument',
        'interaction port pause must be a function',
      );
    }
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 1) {
      throw new InteractionPortError(
        'invalid_argument',
        'queueLimit must be a positive safe integer',
      );
    }
    this.host = host;
    this.transport = transport;
    this.adapter = adapter;
    this.queueLimit = queueLimit;
    this.now = now;
    this.pause = pause;
    this.queue = [];
  }

  status() {
    const observation = this.#observe();
    return {
      schema: 'kungfu.agent-session.interaction-status/v1',
      ...observation.hostStatus,
      interactionState: observation.interaction.state,
      providerAdapter: {
        provider: this.adapter.provider,
        providerVersion: this.adapter.providerVersion,
        adapterVersion: this.adapter.adapterVersion,
        compatible: observation.interaction.compatible,
        tested: this.adapter.tested,
        signatureIds: observation.interaction.signatureIds,
        reason: observation.interaction.reason,
        rawHumanFallback: true,
        knownLimits: [...this.adapter.knownLimits],
      },
      queuedInstructions: this.queue.length,
    };
  }

  snapshot({ requestedSequence = 0 } = {}) {
    return {
      schema: 'kungfu.agent-session.interaction-snapshot/v1',
      status: this.status(),
      terminal: this.host.snapshot(requestedSequence),
    };
  }

  instruct(request) {
    const mode = request.mode ?? 'when-ready';
    if (!MODES.has(mode)) {
      throw new InteractionPortError(
        'invalid_argument',
        `unsupported instruction mode '${String(mode)}'`,
      );
    }
    required(request.actionId, 'actionId');
    required(request.inputId, 'inputId');
    const observation = this.#observe();
    const blocked = this.#admissionBlock(observation);
    if (blocked) return this.#held(request, blocked);
    if (observation.interaction.state === 'ready') {
      return this.#deliverInstruction(request);
    }
    if (observation.interaction.state === 'busy' && mode === 'queue') {
      return this.#enqueue(request, 'provider-busy');
    }
    if (observation.interaction.state === 'busy' && mode === 'interrupt') {
      const controlReceipt = this.interrupt({
        ...request,
        inputId: `${request.inputId}:interrupt`,
      });
      const held = this.#enqueue(request, 'interrupt-sent-awaiting-ready');
      return { ...held, controlReceipt };
    }
    return this.#held(request, `state-${observation.interaction.state}`);
  }

  flushQueued() {
    if (this.queue.length === 0) {
      return {
        schema: 'kungfu.agent-session.interaction-receipt/v1',
        operation: 'instruct',
        status: 'held',
        reason: 'queue-empty',
        queueDepth: 0,
        deliveryReceipt: null,
        ...nullOutcome(),
      };
    }
    const observation = this.#observe();
    const blocked = this.#admissionBlock(observation);
    if (blocked || observation.interaction.state !== 'ready') {
      return {
        schema: 'kungfu.agent-session.interaction-receipt/v1',
        operation: 'instruct',
        status: 'held',
        reason: blocked ?? `state-${observation.interaction.state}`,
        queueDepth: this.queue.length,
        deliveryReceipt: null,
        ...nullOutcome(),
      };
    }
    const request = this.queue.shift();
    try {
      return this.#deliverInstruction(request);
    } catch (error) {
      return {
        schema: 'kungfu.agent-session.interaction-receipt/v1',
        operation: 'instruct',
        actionId: request.actionId,
        inputId: request.inputId,
        status: 'rejected',
        reason: error.code ?? 'delivery-failed',
        queueDepth: this.queue.length,
        deliveryReceipt: null,
        ...nullOutcome(),
      };
    }
  }

  sendKey(request) {
    if (request.automatic !== false) {
      throw new InteractionPortError(
        'manual_key_required',
        'sendKey is an explicit raw-human fallback',
      );
    }
    const observation = this.#observe();
    const blocked = this.#admissionBlock(observation, { allowUnknown: true });
    if (blocked) return this.#held(request, blocked, 'send-key');
    const data = this.adapter.encodeKey(request.key);
    const deliveryReceipt = this.transport.submitInput({ ...request, data });
    return {
      schema: 'kungfu.agent-session.interaction-receipt/v1',
      operation: 'send-key',
      actionId: request.actionId,
      inputId: request.inputId,
      status: deliveryReceipt.status,
      reason: null,
      queueDepth: this.queue.length,
      deliveryReceipt,
      rawHumanFallback: true,
      ...nullOutcome(),
    };
  }

  interrupt(request) {
    const observation = this.#observe();
    const blocked = this.#admissionBlock(observation, { allowUnknown: true });
    if (blocked) return this.#held(request, blocked, 'interrupt');
    if (typeof this.transport.submitSignal !== 'function') {
      throw new InteractionPortError(
        'interrupt_unavailable',
        'transport does not expose fenced signal delivery',
      );
    }
    const controlReceipt = this.transport.submitSignal({
      ...request,
      signal: 'SIGINT',
    });
    return {
      schema: 'kungfu.agent-session.interaction-receipt/v1',
      operation: 'interrupt',
      actionId: request.actionId,
      inputId: request.inputId,
      status: controlReceipt.status,
      reason: null,
      queueDepth: this.queue.length,
      controlReceipt,
      signalOutcome: null,
      ...nullOutcome(),
    };
  }

  #observe() {
    const hostStatus = this.transport.status();
    const terminal = this.host.snapshot(hostStatus.output.earliestSequence);
    const interaction = this.adapter.inspect({
      lines: terminal.vt.lines,
      volatileTail: terminal.frames.map((frame) => frame.data).join(''),
      lifecycleState: hostStatus.lifecycleState,
      inputAdmission: hostStatus.inputAdmission,
      foreground: hostStatus.foreground,
    });
    return { hostStatus, interaction };
  }

  #admissionBlock(observation, { allowUnknown = false } = {}) {
    if (
      observation.hostStatus.lifecycleState === 'ended' ||
      observation.hostStatus.inputAdmission === 'closed'
    ) {
      return 'provider-ended';
    }
    if (!observation.interaction.compatible)
      return observation.interaction.reason ?? 'adapter-incompatible';
    if (observation.hostStatus.foreground.provider !== this.adapter.provider)
      return 'foreground-provider-mismatch';
    if (
      !allowUnknown &&
      ['approval-needed', 'unknown'].includes(observation.interaction.state)
    ) {
      return `automatic-delivery-held-${observation.interaction.state}`;
    }
    return null;
  }

  #enqueue(request, reason) {
    if (this.queue.length >= this.queueLimit) {
      return {
        ...this.#held(request, 'instruction-queue-full'),
        status: 'rejected',
      };
    }
    this.queue.push({ ...request });
    return {
      ...this.#held(request, reason),
      queued: true,
      queueDepth: this.queue.length,
    };
  }

  #deliverInstruction(request) {
    const data = this.adapter.encodeInstruction(request.text);
    let deliveryReceipt = this.transport.submitInput({ ...request, data });
    if (this.adapter.instructionSubmitStrategy === 'separate-enter') {
      this.pause(this.adapter.instructionSubmitDelayMilliseconds);
      deliveryReceipt = this.transport.submitInput({
        ...request,
        actionId: `${request.actionId}:submit`,
        inputId: `${request.inputId}:submit`,
        data: this.adapter.instructionSubmitData,
      });
    }
    return {
      schema: 'kungfu.agent-session.interaction-receipt/v1',
      operation: 'instruct',
      actionId: request.actionId,
      inputId: request.inputId,
      status: deliveryReceipt.status,
      reason: null,
      queueDepth: this.queue.length,
      deliveryReceipt,
      deliveredAt: this.now(),
      ...nullOutcome(),
    };
  }

  #held(request, reason, operation = 'instruct') {
    return {
      schema: 'kungfu.agent-session.interaction-receipt/v1',
      operation,
      actionId: request.actionId ?? null,
      inputId: request.inputId ?? null,
      status: 'held',
      reason,
      queued: false,
      queueDepth: this.queue.length,
      deliveryReceipt: null,
      requiresHuman:
        /approval-needed|unknown|version-drift|provider-mismatch/u.test(reason),
      ...nullOutcome(),
    };
  }
}
