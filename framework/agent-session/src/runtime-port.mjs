import { PeerTransportError } from './peer-transport.mjs';

export const ACTION_ENVELOPE_CARRIER_TYPE = 1000;
const ACTION_PREFIX = 'agent-session.transport.';

function requireBinding(binding) {
  for (const member of [
    'Watcher',
    'encodeActionEnvelope',
    'decodeActionEnvelope',
  ]) {
    if (typeof binding?.[member] !== 'function') {
      throw new PeerTransportError(
        'native_binding_unavailable',
        `Kungfu native binding is missing ${member}`,
      );
    }
  }
  return binding;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PeerTransportError(
      'invalid_argument',
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

/**
 * ADR-0077 production adapter for AgentSession transport frames.
 *
 * The native Watcher is itself a live runtime Peer. Its public mmap journal is
 * the one output writer, and the writer's existing bus publication is the nng
 * notice. No socket, polling file or Coordinator byte proxy is introduced.
 */
export class NativeKungfuJournalNoticePort {
  constructor({
    binding,
    runtimeDir,
    peerName,
    maxFrames = 4096,
    millisecondsSleepAfterStep = 2,
  }) {
    this.binding = requireBinding(binding);
    if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
      throw new PeerTransportError(
        'invalid_argument',
        'runtimeDir is required',
      );
    }
    if (typeof peerName !== 'string' || peerName.length === 0) {
      throw new PeerTransportError('invalid_argument', 'peerName is required');
    }
    this.maxFrames = positiveSafeInteger(maxFrames, 'maxFrames');
    this.peer = new this.binding.Watcher(
      runtimeDir,
      peerName,
      true,
      millisecondsSleepAfterStep,
      true,
    );
    this.frames = [];
    this.nextCursor = 1;
    this.nativeDropped = 0n;
    if (!this.peer.isStarted()) this.peer.start();
  }

  append(frame) {
    const cursor = this.nextCursor;
    const payload = { cursor, ...structuredClone(frame) };
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const encoded = this.binding.encodeActionEnvelope({
      version: 1,
      action_type: `${ACTION_PREFIX}${frame.kind}`,
      schema_ref: {
        id: frame.payload?.schema ?? 'kungfu.agent-session.transport-frame/v1',
        version: 1,
      },
      payload: {
        encoding: 'json',
        data: json,
        content_type: 'application/json',
        state: 'inline',
      },
    });
    if (
      !this.peer.issueRawPublic(
        ACTION_ENVELOPE_CARRIER_TYPE,
        Buffer.from(encoded),
      )
    ) {
      throw new PeerTransportError(
        'peer_not_ready',
        'live Peer has no public journal writer',
      );
    }
    this.nextCursor += 1;
    this.#retain(payload);
    return structuredClone(payload);
  }

  read({ fromCursor = 0 }) {
    this.drain();
    const earliestCursor = this.frames[0]?.cursor ?? this.nextCursor;
    const gap =
      this.nativeDropped > 0n || fromCursor + 1 < earliestCursor
        ? {
            fromCursor,
            toCursor: earliestCursor - 1,
            reason:
              this.nativeDropped > 0n
                ? 'native-peer-queue-overflow'
                : 'bounded-journal-retention-overflow',
            nativeDropped: this.nativeDropped.toString(),
          }
        : null;
    this.nativeDropped = 0n;
    return {
      earliestCursor,
      nextCursor: this.nextCursor - 1,
      gap,
      frames: structuredClone(
        this.frames.filter((frame) => frame.cursor > fromCursor),
      ),
    };
  }

  notice() {
    // The native journal writer already emits the ADR-0077 nng notice. A
    // second explicit notice here would duplicate the wakeup plane.
  }

  follow(sourceLocation, fromTime = 0n) {
    if (!this.peer.requestReadFromPublic(sourceLocation, fromTime)) {
      throw new PeerTransportError(
        'peer_not_ready',
        'live Peer cannot request the source public journal yet',
      );
    }
  }

  drain() {
    const result = this.peer.drainCustomData();
    this.nativeDropped += result.dropped;
    for (const frame of result.frames) {
      if (frame.carrierType !== ACTION_ENVELOPE_CARRIER_TYPE) continue;
      const envelope = this.binding.decodeActionEnvelope(frame.data);
      if (
        !envelope?.action_type?.startsWith(ACTION_PREFIX) ||
        envelope.payload?.encoding !== 2 ||
        !(envelope.payload.data instanceof Uint8Array)
      ) {
        continue;
      }
      let decoded;
      try {
        decoded = JSON.parse(
          Buffer.from(envelope.payload.data).toString('utf8'),
        );
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(decoded.cursor) || decoded.cursor < 1) continue;
      if (this.frames.some((item) => item.cursor === decoded.cursor)) continue;
      this.nextCursor = Math.max(this.nextCursor, decoded.cursor + 1);
      this.#retain(decoded);
    }
  }

  health() {
    return {
      schema: 'kungfu.agent-session.native-peer-health/v1',
      started: this.peer.isStarted(),
      live: this.peer.isLive(),
      usable: this.peer.isUsable(),
      transport: 'mmap-journal+nng-notice',
      coordinatorByteProxy: false,
    };
  }

  close() {
    this.peer.quit();
  }

  #retain(frame) {
    this.frames.push(structuredClone(frame));
    this.frames.sort((left, right) => left.cursor - right.cursor);
    while (this.frames.length > this.maxFrames) this.frames.shift();
  }
}
