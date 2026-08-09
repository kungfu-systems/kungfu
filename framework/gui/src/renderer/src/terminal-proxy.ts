// Renderer-side proxy for the main-process managed session host (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481
// stage 1). It presents the same Terminal surface the in-renderer host does,
// but every method crosses IPC, so calls resolve asynchronously — the terminal
// view already awaits both shapes through its `resolve()` helper, so it is
// unchanged. Subscriptions round-trip a real stop(): the guest mints the subId,
// so stop() releases exactly that host-side stream (see terminal-host.ts).
//
// Only reached when KF_TERMINAL_HOST=main; otherwise the renderer keeps the
// in-process host and this module is never constructed.
import type { Subscription, Terminal } from '@kungfu-tech/api/capability';

import {
  TERMINAL_CALL_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_SUBSCRIBE_CHANNEL,
  TERMINAL_UNSUBSCRIBE_CHANNEL,
} from '../../sandbox/channels';

export type IpcRendererLike = {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  on: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void;
};

type SubscribeMethod = 'onData' | 'onExit';

export function createTerminalProxy(ipc: IpcRendererLike): Terminal {
  const listeners = new Map<number, (...args: unknown[]) => void>();
  let subSeq = 0;

  ipc.on(TERMINAL_EVENT_CHANNEL, (_event, payload) => {
    const { subId, args } = payload as { subId: number; args: unknown[] };
    listeners.get(subId)?.(...args);
  });

  const call = (method: string, args: unknown[]): Promise<unknown> =>
    ipc.invoke(TERMINAL_CALL_CHANNEL, { method, args });

  const subscribe = (
    method: SubscribeMethod,
    runId: string,
    cb: (...args: unknown[]) => void,
  ): Subscription => {
    subSeq += 1;
    const subId = subSeq;
    listeners.set(subId, cb);
    void ipc.invoke(TERMINAL_SUBSCRIBE_CHANNEL, { method, runId, subId });
    return {
      stop: () => {
        if (!listeners.delete(subId)) return;
        void ipc.invoke(TERMINAL_UNSUBSCRIBE_CHANNEL, { subId });
      },
    };
  };

  // The proxy is async where the Terminal type is sync; the view awaits every
  // call through resolve(), so the surface it codes against is unchanged. The
  // cast is the KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9 tier bridge: one source over a sync or async handle.
  const proxy = {
    spawn: (options: unknown) => call('spawn', [options]),
    write: (runId: string, data: string) => call('write', [runId, data]),
    resize: (runId: string, cols: number, rows: number) =>
      call('resize', [runId, cols, rows]),
    kill: (runId: string, signal?: string) => call('kill', [runId, signal]),
    detach: (runId: string) => call('detach', [runId]),
    onData: (runId: string, onData: (data: string) => void) =>
      subscribe('onData', runId, (data) => onData(data as string)),
    onExit: (runId: string, onExit: (exit: unknown) => void) =>
      subscribe('onExit', runId, (exit) => onExit(exit)),
    discover: () => call('discover', []),
    reattach: (runId: string) => call('reattach', [runId]),
    adopt: (spec: unknown) => call('adopt', [spec]),
    list: () => call('list', []),
    get: (runId: string) => call('get', [runId]),
  };
  return proxy as unknown as Terminal;
}
