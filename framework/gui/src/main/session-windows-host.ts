// Electron glue for the per-session OS window registry (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2). The
// lifecycle logic is electron-free in session-windows; this is the thin shell
// that supplies real BrowserWindows and `screen` displays and wires the ipcMain
// channels — the same pure-core / glue split terminal-host uses.
//
// Gated by KF_SESSION_WINDOWS (see index.ts): default off keeps the single-window
// app exactly as it is (parity by construction); the multi-window path is
// exercised by flipping the flag on a real machine, the discipline KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481
// stage 1 used for the main-process host.
import path from 'node:path';
import { BrowserWindow, type IpcMain, screen } from 'electron';

import {
  SESSION_WINDOW_CLOSE_CHANNEL,
  SESSION_WINDOW_OPEN_CHANNEL,
  SESSION_WINDOW_RESTORE_CHANNEL,
  SESSION_WINDOW_SNAPSHOT_CHANNEL,
} from '../sandbox/channels';
import {
  type SessionWindow,
  type SessionWindowRegistry,
  createSessionWindowRegistry,
} from './session-windows';
import {
  type DisplayInfo,
  type Placement,
  type Rect,
  displayKey,
} from './window-placement';

function toDisplayInfo(d: Electron.Display): DisplayInfo {
  return { id: displayKey(d), workArea: d.workArea };
}

// The per-session window renderer entry, with the runId it should mount (and its
// windowId, for logging). Dev serves it from the electron-vite dev server; a
// packaged app loads the built file — the same dev/prod split the shell and the
// sandbox harness use. Query is percent-encoded, so a runId is safe in the URL.
function sessionWindowEntry(runId: string, windowId: string): string {
  const query =
    `?runId=${encodeURIComponent(runId)}` +
    `&windowId=${encodeURIComponent(windowId)}`;
  return process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/session-window/index.html${query}`
    : `file://${path.join(
        __dirname,
        '../renderer/session-window/index.html',
      )}${query}`;
}

function createSessionWindow(args: {
  windowId: string;
  runId: string;
  bounds: Rect;
}): SessionWindow {
  const win = new BrowserWindow({
    x: args.bounds.x,
    y: args.bounds.y,
    width: args.bounds.width,
    height: args.bounds.height,
    show: false,
    backgroundColor: '#1e1e1e',
    title: `Session ${args.runId}`,
    webPreferences: {
      // KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 3: the window renderer mounts the terminal view and
      // reaches the main-process host over the relay via ipcRenderer, so it runs
      // node-integrated like the shell (a first-party window loading a
      // first-party bundle) rather than the stage-2 sandboxed placeholder.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  win.on('ready-to-show', () => win.show());
  void win.loadURL(sessionWindowEntry(args.runId, args.windowId));
  return {
    getBounds: () => win.getBounds(),
    focus: () => {
      if (!win.isDestroyed()) win.focus();
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    // end-of-gesture events, so persistence is not written on every drag pixel
    onBoundsChanged: (cb) => {
      win.on('moved', cb);
      win.on('resized', cb);
    },
    onClosed: (cb) => win.on('closed', cb),
  };
}

// Create the registry backed by Electron and register the ipcMain handlers.
// Called once, under the flag, after the app is ready (screen needs a ready app).
export function bindSessionWindows(opts: {
  ipcMain: IpcMain;
  getShellWindow: () => BrowserWindow | null;
  // true once the app is quitting: window closes during shutdown must not be
  // persisted, or they would wipe the set that restore needs (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2).
  isQuitting?: () => boolean;
}): SessionWindowRegistry {
  const registry = createSessionWindowRegistry({
    displays: () => ({
      list: screen.getAllDisplays().map(toDisplayInfo),
      primaryId: displayKey(screen.getPrimaryDisplay()),
    }),
    displayKeyForBounds: (bounds) =>
      displayKey(screen.getDisplayMatching(bounds)),
    createWindow: createSessionWindow,
    onChange: (snapshot) => {
      // On app quit every window closes, which would emit an empty snapshot and
      // overwrite the persisted set; skip persistence during shutdown so the
      // last live layout survives for restore.
      if (opts.isQuitting?.()) return;
      const shell = opts.getShellWindow();
      if (shell && !shell.isDestroyed()) {
        shell.webContents.send(SESSION_WINDOW_SNAPSHOT_CHANNEL, { snapshot });
      }
    },
    now: () => Date.now(),
  });

  // Fresh pop-out from the shell grid; returns where the window actually landed.
  opts.ipcMain.handle(SESSION_WINDOW_OPEN_CHANNEL, (_e, payload) => {
    const { windowId, runId } = payload as { windowId: string; runId: string };
    return registry.open({ windowId, runId });
  });
  // Restore the persisted window set on boot; each saved rectangle is clamped
  // back onto a present display (F7).
  opts.ipcMain.handle(SESSION_WINDOW_RESTORE_CHANNEL, (_e, payload) => {
    const { windows } = payload as {
      windows: Array<{ windowId: string; runId: string; saved: Placement }>;
    };
    return windows.map((entry) =>
      registry.open({
        windowId: entry.windowId,
        runId: entry.runId,
        saved: entry.saved,
      }),
    );
  });
  opts.ipcMain.on(SESSION_WINDOW_CLOSE_CHANNEL, (_e, payload) => {
    const { runId } = payload as { runId: string };
    registry.close(runId);
  });

  return registry;
}
