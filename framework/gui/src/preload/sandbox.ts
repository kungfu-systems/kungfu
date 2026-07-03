// Preload for a sandboxed kfx renderer. This is the ONLY bridge the isolated
// view gets. Under nodeIntegration:false / contextIsolation:true / sandbox:true
// the page has no node, no require. contextBridge can only carry functions and
// clonable data — not a dynamic Proxy — so the preload exposes a plain bridge
// (the declared keys + an invoke function + an event subscription), and the
// sandboxed renderer's own runtime builds the ergonomic capability object over
// it with createCapabilityGuest (see ../sandbox/transport bridgeChannel). The
// enforcement is host-side regardless: only declared capabilities resolve.
import { contextBridge, ipcRenderer } from 'electron';

import {
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type SandboxBridge,
  readDeclared,
} from '../sandbox/transport';

const bridge: SandboxBridge = {
  declared: readDeclared(process.argv),
  invoke: (cap, method, args) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, { cap, method, args }),
  on: (fn) => {
    const listener = (
      _event: unknown,
      payload: { callback: number; args: unknown[] },
    ) => fn(payload);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('__kfxBridge', bridge);
