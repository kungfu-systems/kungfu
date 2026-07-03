// Electron-free transport layer for the sandboxed-ipc capability channel: the
// channel names and the pure functions that map an ipcRenderer-shaped surface
// onto the api-level GuestChannel. Kept out of the preload/main electron glue
// so it can be contract-tested with a mock ipc, without Electron.
import type { GuestChannel, HostEvent, HostRequest } from '@kungfu-tech/api/capability';

export const INVOKE_CHANNEL = 'kfx:cap-invoke';
export const EVENT_CHANNEL = 'kfx:cap-event';

// minimal ipcRenderer surface, so the mapping is testable with a mock
export type IpcRendererLike = {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: HostEvent) => void) => void;
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
};

// A GuestChannel that speaks over an ipcRenderer-shaped surface.
export function guestChannelOverIpc(ipc: IpcRendererLike): GuestChannel {
  return {
    invoke: (req: HostRequest) => ipc.invoke(INVOKE_CHANNEL, req),
    onEvent: (fn) => {
      const listener = (_event: unknown, payload: HostEvent) => fn(payload);
      ipc.on(EVENT_CHANNEL, listener);
      return () => ipc.removeListener(EVENT_CHANNEL, listener);
    },
  };
}

// Read the declared capability keys the main process passed to a preload via
// webPreferences.additionalArguments.
export function readDeclared(argv: readonly string[]): string[] {
  const flag = '--kfx-declared=';
  const entry = argv.find((a) => a.startsWith(flag));
  if (!entry) return [];
  try {
    const parsed = JSON.parse(entry.slice(flag.length));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
