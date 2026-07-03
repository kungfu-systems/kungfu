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
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { bindElectronHost } from './sandbox-host';

export type SandboxedViewOptions = {
  // the view's manifest capability declaration
  declared: readonly string[];
  // the real capability handles (created in the trusted renderer / main)
  caps: Record<string, Record<string, unknown>>;
  // the view page to load (a harness html that requires the view bundle)
  entryUrl: string;
  // preload path (defaults to the built sandbox preload beside this module)
  preload?: string;
};

export function createSandboxedView(options: SandboxedViewOptions): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: options.preload ?? path.join(__dirname, '../preload/sandbox.js'),
      additionalArguments: [`--kfx-declared=${JSON.stringify([...options.declared])}`],
    },
  });

  const host = bindElectronHost(ipcMain, win.webContents, options.caps, options.declared);
  win.on('closed', () => host.dispose());

  void win.loadURL(options.entryUrl);
  return win;
}
