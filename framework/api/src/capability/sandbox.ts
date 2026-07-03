// The sandboxed-ipc trust tier's enforcement core: a capability proxy that
// makes `capabilities` a real boundary. A sandboxed kfx runs with no node
// access (isolated renderer); the only surface it reaches is the capability
// handles its manifest declares, forwarded over a channel to the trusted host.
// Undeclared capabilities are unreachable — not merely un-injected but absent,
// because the guest proxy is built from the declared set alone.
//
// This module is transport-agnostic: in the app the channel is Electron IPC
// (preload + contextBridge on the guest, ipcMain on the host); in tests it is
// any request/response + event pair. Calls become async at the boundary (an
// IPC hop cannot be synchronous), so a sandboxed view codes against a Promise
// surface — inherent to the isolation, not incidental.

// A callback argument a guest passes (e.g. a subscription listener) is replaced
// on the wire by this marker; the host swaps in a forwarding function.
type CallbackRef = { __sandboxCallback: number };

function isCallbackRef(value: unknown): value is CallbackRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CallbackRef).__sandboxCallback === 'number'
  );
}

// ── host (trusted) ─────────────────────────────────────────────────────────

export type HostRequest = { cap: string; method: string; args: unknown[] };
export type HostEvent = { callback: number; args: unknown[] };

export type CapabilityHost = {
  // resolve one guest call against the real capabilities; rejects an
  // undeclared capability or a missing method
  handle: (req: HostRequest) => Promise<unknown>;
  // drop any subscriptions a disconnecting guest left open
  dispose: () => void;
};

// `emit` sends a host->guest event (a bridged callback firing). `caps` is the
// real capability object; only `declared` keys are reachable.
export function createCapabilityHost(
  caps: Record<string, Record<string, unknown>>,
  declared: readonly string[],
  emit: (event: HostEvent) => void,
): CapabilityHost {
  const allowed = new Set(declared);
  const subscriptions = new Map<number, { stop?: () => void }>();

  const revive = (args: unknown[]): unknown[] =>
    args.map((arg) => {
      if (!isCallbackRef(arg)) return arg;
      const id = arg.__sandboxCallback;
      // a forwarding function: when the real capability calls it, ship the
      // arguments back to the guest's registered callback
      return (...callbackArgs: unknown[]) => emit({ callback: id, args: callbackArgs });
    });

  return {
    async handle({ cap, method, args }) {
      if (!allowed.has(cap)) {
        throw new Error(`capability '${cap}' is not declared by this kfx`);
      }
      const handle = caps[cap];
      const fn = handle?.[method];
      if (typeof fn !== 'function') {
        throw new Error(`capability '${cap}' has no method '${method}'`);
      }
      const result = (fn as (...a: unknown[]) => unknown).apply(handle, revive(args));
      // a Subscription-shaped result ({ stop }) is retained host-side and
      // referenced by the callback id the guest sent, so the guest can stop it
      if (result && typeof (result as { stop?: unknown }).stop === 'function') {
        const cbId = args.find(isCallbackRef)?.__sandboxCallback;
        if (cbId !== undefined) subscriptions.set(cbId, result as { stop: () => void });
        return { __sandboxSubscription: cbId };
      }
      return result;
    },
    dispose() {
      for (const sub of subscriptions.values()) sub.stop?.();
      subscriptions.clear();
    },
  };
}

// ── guest (sandboxed) ──────────────────────────────────────────────────────

export type GuestChannel = {
  invoke: (req: HostRequest) => Promise<unknown>;
  // register for host->guest callback events; returns an unsubscribe
  onEvent: (fn: (event: HostEvent) => void) => () => void;
};

// Build the capability object a sandboxed view receives. It contains exactly
// the declared capabilities and nothing else; each method call and each
// callback argument is marshalled over the channel.
export function createCapabilityGuest(
  declared: readonly string[],
  channel: GuestChannel,
): Record<string, unknown> {
  let callbackSeq = 0;
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  channel.onEvent(({ callback, args }) => callbacks.get(callback)?.(...args));

  const marshal = (args: unknown[]): unknown[] =>
    args.map((arg) => {
      if (typeof arg !== 'function') return arg;
      const id = (callbackSeq += 1);
      callbacks.set(id, arg as (...a: unknown[]) => void);
      return { __sandboxCallback: id } satisfies CallbackRef;
    });

  const caps: Record<string, unknown> = {};
  for (const cap of declared) {
    caps[cap] = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]) =>
            channel.invoke({ cap, method, args: marshal(args) });
        },
      },
    );
  }
  return caps;
}
