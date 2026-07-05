// Electron glue for the per-session OS window registry (ADR-0016 stage 2). The
// lifecycle logic is electron-free in session-windows; this is the thin shell
// that supplies real BrowserWindows and `screen` displays and wires the ipcMain
// channels — the same pure-core / glue split terminal-host uses.
//
// Gated by KF_SESSION_WINDOWS (see index.ts): default off keeps the single-window
// app exactly as it is (parity by construction); the multi-window path is
// exercised by flipping the flag on a real machine, the discipline ADR-0016
// stage 1 used for the main-process host.
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

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

// A minimal placeholder page (ADR-0016 stage 2). What stage 2 proves is the
// window lifecycle, bounds, F7 restore and persistence; mounting the real
// terminal view against this window's runId over the host proxy is stage 3,
// which swaps this data: URL for a session-window renderer entry.
function placeholderPage(runId: string, windowId: string): string {
  const r = escapeHtml(runId);
  const w = escapeHtml(windowId);
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>Session ${r}</title>`,
    '<style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ddd;',
    'font:14px/1.6 -apple-system,system-ui,sans-serif;display:flex;',
    'align-items:center;justify-content:center}main{text-align:center}',
    'code{color:#6cf}small{color:#888}</style>',
    `<main><div>managed session <code>${r}</code></div>`,
    '<div><small>ADR-0016 stage 2 — window shell (terminal view lands in stage 3)</small></div>',
    `<div><small>window ${w}</small></div></main>`,
  ].join('');
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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on('ready-to-show', () => win.show());
  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      placeholderPage(args.runId, args.windowId),
    )}`,
  );
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
