// The main-process factory for a sandboxed kfx view: a BrowserWindow with node
// stripped (nodeIntegration:false / contextIsolation:true / sandbox:true), the
// sandbox preload, and the view's declared capability keys passed as an
// additionalArgument. The capability host is bound to the window's webContents
// so the isolated view's only reach is the declared capabilities over IPC.
//
// This is the production form of the harness proven live: in a real sandboxed
// renderer window.require/process/Buffer are absent, __kfxBridge carries only
// the declared keys, a declared call round-trips, and an undeclared call is
// rejected host-side.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';

import { bindElectronHost } from './sandbox-host';

// default resource bounds for a sandboxed view (option A's resource-limit half)
const DEFAULT_MEMORY_CAP_KB = 512 * 1024; // 512 MiB working set
const SAMPLE_INTERVAL_MS = 2000;

export type SandboxedViewOptions = {
  // the view's manifest capability declaration
  declared: readonly string[];
  // the real capability handles (created in the trusted renderer / main)
  caps: Record<string, Record<string, unknown>>;
  // the view page to load (a harness html that requires the view bundle)
  entryUrl: string;
  // preload path (defaults to the built sandbox preload beside this module)
  preload?: string;
  // working-set cap in KiB; over it the view is killed
  memoryCapKb?: number;
};

// Give each sandboxed view its own session partition with the network denied:
// a sandboxed view loads a local bundle and reaches the outside only through
// its declared capabilities, never http(s).
function lockedDownPartition(id: string) {
  const partition = `sandbox:${id}`;
  const ses = session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = details.url.startsWith('file:') || details.url.startsWith('devtools:');
    callback({ cancel: !ok });
  });
  return partition;
}

export function createSandboxedView(options: SandboxedViewOptions): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: lockedDownPartition(String(Date.now())),
      preload: options.preload ?? path.join(__dirname, '../preload/sandbox.js'),
      additionalArguments: [`--kfx-declared=${JSON.stringify([...options.declared])}`],
    },
  });

  const host = bindElectronHost(ipcMain, win.webContents, options.caps, options.declared);

  // resource guard: sample the view's process working set; kill on breach
  const cap = options.memoryCapKb ?? DEFAULT_MEMORY_CAP_KB;
  const pid = win.webContents.getOSProcessId();
  const sampler = setInterval(() => {
    if (win.isDestroyed()) return;
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (metric && metric.memory.workingSetSize > cap) win.destroy();
  }, SAMPLE_INTERVAL_MS);

  win.on('closed', () => {
    clearInterval(sampler);
    host.dispose();
  });

  void win.loadURL(options.entryUrl);
  return win;
}
