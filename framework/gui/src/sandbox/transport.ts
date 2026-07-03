// Electron-free transport for the sandboxed-ipc capability channel: the channel
// names, the contextBridge-safe bridge shape a preload exposes, and the pure
// adapter that turns that bridge into the api GuestChannel page-side. Kept out
// of the preload/main electron glue so it is contract-testable without Electron.
import type { GuestChannel, HostEvent, HostRequest } from '@kungfu-tech/api/capability';

export const INVOKE_CHANNEL = 'kfx:cap-invoke';
export const EVENT_CHANNEL = 'kfx:cap-event';

// What contextBridge exposes to a sandboxed page: plain functions + data only
// (a dynamic Proxy cannot cross contextBridge). The page's own runtime wraps
// this into the ergonomic capability object with createCapabilityGuest.
export type SandboxBridge = {
  declared: string[];
  invoke: (cap: string, method: string, args: unknown[]) => Promise<unknown>;
  on: (fn: (event: HostEvent) => void) => () => void;
};

// Page-side: build a GuestChannel over the exposed bridge.
export function bridgeChannel(bridge: SandboxBridge): GuestChannel {
  return {
    invoke: (req: HostRequest) => bridge.invoke(req.cap, req.method, req.args),
    onEvent: (fn) => bridge.on(fn),
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
