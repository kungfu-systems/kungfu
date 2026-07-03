// Main-process side of a sandboxed kfx: the capability host. A sandboxed
// renderer's guest calls arrive over IPC; this resolves them against the real
// capabilities but only for the keys the view's manifest declared. Because the
// real capabilities live in the trusted node-integrated renderer (they hold the
// native binding), the concrete app injects a `caps` surface that forwards to
// it; the enforcement — declared-only, method-checked — is here and in the
// api-level createCapabilityHost.
//
// The wiring is a pure function (installCapabilityHost) taking abstract
// invoke/send hooks so it is contract-tested without Electron; the ipcMain and
// BrowserWindow glue below is the thin electron-only shell.
import {
  type HostEvent,
  type HostRequest,
  createCapabilityHost,
} from '@kungfu-tech/api/capability';

import { EVENT_CHANNEL, INVOKE_CHANNEL } from '../sandbox/transport';

export type HostWiring = {
  // register the single handler for INVOKE_CHANNEL requests from this view
  onInvoke: (handler: (req: HostRequest) => Promise<unknown>) => void;
  // push a bridged-callback event back to the sandboxed renderer
  send: (event: HostEvent) => void;
  caps: Record<string, Record<string, unknown>>;
  declared: readonly string[];
};

// Pure: wire a capability host over abstract transport hooks. Returns the host
// so the caller can dispose subscriptions when the view closes.
export function installCapabilityHost(wiring: HostWiring) {
  const host = createCapabilityHost(wiring.caps, wiring.declared, wiring.send);
  wiring.onInvoke((req) => host.handle(req));
  return host;
}

// ── electron glue ───────────────────────────────────────────────────────────
// A concrete Electron binding of the wiring for one sandboxed view. Kept behind
// a dynamic-shaped import of electron so this module stays importable (and
// testable) outside the main process.

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, payload: HostRequest) => Promise<unknown>,
  ) => void;
  removeHandler: (channel: string) => void;
};
type WebContentsLike = { send: (channel: string, payload: HostEvent) => void };

export function bindElectronHost(
  ipcMain: IpcMainLike,
  webContents: WebContentsLike,
  caps: Record<string, Record<string, unknown>>,
  declared: readonly string[],
) {
  const host = installCapabilityHost({
    onInvoke: (handler) =>
      ipcMain.handle(INVOKE_CHANNEL, (_e, req) => handler(req)),
    send: (event) => webContents.send(EVENT_CHANNEL, event),
    caps,
    declared,
  });
  return {
    dispose() {
      host.dispose();
      ipcMain.removeHandler(INVOKE_CHANNEL);
    },
  };
}
