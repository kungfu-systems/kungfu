// The CLI-plane transport for the capability relay (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847): pure stdio framing
// that connects a trusted capability host to a sandboxed guest running in a child
// process, over the child's stdio as newline-delimited JSON. It is the sibling of
// the GUI-plane Electron IPC transport (framework/gui/src/sandbox) — the same
// transport-agnostic contract (HostRequest/HostEvent), a different channel.
//
// It is deliberately decoupled from the host implementation: the caller passes a
// factory that builds the host given an event sink (compose it with
// createCapabilityHost from ./sandbox), so the framing serves any host and stays
// testable without a capability instance. The host holds the real capabilities;
// an undeclared capability is rejected there and never reachable from the child.
//
// Wire protocol (one JSON object per line, both directions):
//   child -> host   { "t": "invoke", "id": n, "cap", "method", "args" }
//   host  -> child  { "t": "result", "id": n, "ok": true,  "value" }
//                   { "t": "result", "id": n, "ok": false, "error" }
//   host  -> child  { "t": "event",  "callback": n, "args" }   (a bridged callback)
//   host  -> child  { "t": "control", "action": "shutdown" }    (graceful stop)
//
// Every frame crosses the relay serialized: this is the sandbox tier's defining
// property (KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9). A capability result is a copy, not a live handle — 64-bit
// identifiers are emitted as decimal strings (bigintSafe), functions and typed
// arrays do not survive JSON. The trusted co-resident tier keeps those by
// reference; the relay deliberately does not.
import { createInterface } from 'node:readline';

import { bigintSafe } from './types.js';

export type HostRequest = { cap: string; method: string; args: unknown[] };
export type HostEvent = { callback: number; args: unknown[] };

// The trusted side of one guest connection: resolve a call, and drop any
// subscriptions the guest left open on disconnect. createCapabilityHost
// (./sandbox) produces exactly this shape.
export type RelayHost = {
  handle: (req: HostRequest) => Promise<unknown>;
  dispose: () => void;
};

// The subset of a child process this needs — structural so a caller can pass a
// Node ChildProcess or a test double.
export type SubprocessChannel = {
  stdout: NodeJS.ReadableStream;
  stdin: { write: (chunk: string) => void };
  once: (event: 'exit' | 'close', cb: () => void) => void;
};

export type SubprocessHost = {
  dispose: () => void;
  requestShutdown: () => void;
};

export function serveSubprocessCapabilities(
  child: SubprocessChannel,
  createHost: (emit: (event: HostEvent) => void) => RelayHost,
): SubprocessHost {
  const send = (msg: unknown): void => {
    child.stdin.write(`${JSON.stringify(msg, bigintSafe)}\n`);
  };
  const host = createHost((event) => send({ t: 'event', ...event }));
  let pendingInvocations = 0;
  let shutdownRequested = false;
  let shutdownSent = false;

  const sendShutdownWhenReady = (): void => {
    if (shutdownRequested && !shutdownSent && pendingInvocations === 0) {
      shutdownSent = true;
      send({ t: 'control', action: 'shutdown' });
    }
  };

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line: string) => {
    if (!line) return;
    let msg: {
      t?: string;
      id?: number;
      cap?: string;
      method?: string;
      args?: unknown[];
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore anything that is not a protocol frame
    }
    if (msg.t !== 'invoke' || typeof msg.id !== 'number') return;
    const id = msg.id;
    pendingInvocations += 1;
    Promise.resolve()
      .then(() =>
        host.handle({
          cap: msg.cap ?? '',
          method: msg.method ?? '',
          args: msg.args ?? [],
        }),
      )
      .then((value) => send({ t: 'result', id, ok: true, value }))
      .catch((e: unknown) =>
        send({ t: 'result', id, ok: false, error: (e as Error).message }),
      )
      .finally(() => {
        pendingInvocations -= 1;
        sendShutdownWhenReady();
      });
  });

  const dispose = () => {
    lines.close();
    host.dispose();
  };
  // A process may exit while its stdout pipe still holds the guest's final
  // capability invocation. `close` is the transport boundary: Node emits it
  // only after the child stdio streams have closed, so readline can deliver
  // the last complete frame before the relay is torn down.
  child.once('close', dispose);
  return {
    dispose,
    requestShutdown: () => {
      shutdownRequested = true;
      sendShutdownWhenReady();
    },
  };
}
