// The Node child-side guest proxy (ADR-0014): the missing sibling of
// framework/core/src/python/kungfu/capability/guest.py. A sandboxed Node child
// reaches only its declared capabilities, forwarded to the trusted host over a
// newline-delimited JSON channel carried on its stdio. Until now the Node guest
// half (createCapabilityGuest in ./sandbox) had only an Electron IPC transport;
// this binds it to a child process's stdio so the same guest object runs in an
// OS-sandboxed CLI child, not just an isolated renderer.
//
// The wire protocol is the one serveSubprocessCapabilities (./subprocess) speaks
// from the host side: the child writes `invoke` frames to its stdout and reads
// `result`/`event` frames from its stdin. Diagnostics MUST go to stderr — the
// child's stdout is the relay, and anything else written there corrupts it.
import { createInterface } from 'node:readline';

import {
  type GuestChannel,
  type HostEvent,
  createCapabilityGuest,
} from './sandbox';

type ResultFrame = {
  t: 'result';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};
type EventFrame = { t: 'event'; callback: number; args: unknown[] };

// The stdio channel a sandboxed Node child speaks to its host. Reads host->child
// frames on the input stream: a result wakes the invoke() waiting on its id; an
// event fires the registered listeners. Structural streams so a test can drive
// it without a real child process.
export type NodeGuestStreams = {
  input: NodeJS.ReadableStream;
  output: { write: (chunk: string) => void };
};

export function createStdioGuestChannel(
  streams: NodeGuestStreams,
): GuestChannel & { close: () => void } {
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Set<(event: HostEvent) => void>();
  let seq = 0;

  const send = (msg: unknown): void => {
    streams.output.write(`${JSON.stringify(msg)}\n`);
  };

  const lines = createInterface({ input: streams.input });
  lines.on('line', (line: string) => {
    if (!line) return;
    let msg: ResultFrame | EventFrame;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore anything that is not a protocol frame
    }
    if (msg.t === 'result' && typeof msg.id === 'number') {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error ?? 'capability call failed'));
    } else if (msg.t === 'event' && typeof msg.callback === 'number') {
      for (const fn of listeners)
        fn({ callback: msg.callback, args: msg.args ?? [] });
    }
  });

  return {
    invoke(req) {
      const id = (seq += 1);
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ t: 'invoke', id, ...req });
      });
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      lines.close();
    },
  };
}

// Build the capability object a sandboxed Node child receives: exactly the
// declared capabilities, each call and each callback argument marshalled over
// the child's stdio to the trusted host. The uniform surface (ADR-0014): every
// method returns a Promise, the same shape the trusted tier presents in-process.
export function connectStdio(
  declared: readonly string[],
  streams: NodeGuestStreams = { input: process.stdin, output: process.stdout },
): { caps: Record<string, unknown>; close: () => void } {
  const channel = createStdioGuestChannel(streams);
  const caps = createCapabilityGuest(declared, channel);
  return { caps, close: channel.close };
}
