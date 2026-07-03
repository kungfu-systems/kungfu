// Shell-renderer client for the sandboxed-ipc view path. The shell renderer is
// node-integrated (contextIsolation:false), so it reaches ipcRenderer directly
// and needs no preload. This module pairs the two sides the shell drives:
//   - registerHost/disposeHost: the trusted-renderer capability host for a view,
//     created before the embedded view is asked to load so its first invoke has
//     a host to answer it;
//   - ensure/setBounds/show/hide/destroy: the main-process WebContentsView the
//     shell positions over its content area.
import {
  DESTROY_CHANNEL,
  ENSURE_CHANNEL,
  HIDE_CHANNEL,
  SET_BOUNDS_CHANNEL,
  SHOW_CHANNEL,
} from '../../sandbox/channels';
import { SandboxHostService } from './sandbox-host-service';

type IpcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void;
};

export type Rect = { x: number; y: number; width: number; height: number };

const ipcRenderer = (window.require('electron') as { ipcRenderer: IpcRenderer })
  .ipcRenderer;

const hostService = new SandboxHostService(ipcRenderer);

export const sandboxClient = {
  // trusted-renderer capability host for a view (real caps live here)
  registerHost(
    id: string,
    caps: Record<string, Record<string, unknown>>,
    declared: readonly string[],
  ): void {
    hostService.register(id, caps, declared);
  },
  disposeHost(id: string): void {
    hostService.dispose(id);
  },
  // main-process embedded WebContentsView lifecycle / layout
  ensure(
    id: string,
    opts: { bundlePath: string; declared: readonly string[] },
  ): Promise<unknown> {
    return ipcRenderer.invoke(ENSURE_CHANNEL, {
      id,
      bundlePath: opts.bundlePath,
      declared: [...opts.declared],
    });
  },
  setBounds(id: string, rect: Rect): void {
    ipcRenderer.send(SET_BOUNDS_CHANNEL, { id, rect });
  },
  show(id: string): void {
    ipcRenderer.send(SHOW_CHANNEL, { id });
  },
  hide(id: string): void {
    ipcRenderer.send(HIDE_CHANNEL, { id });
  },
  destroy(id: string): void {
    ipcRenderer.send(DESTROY_CHANNEL, { id });
  },
};
