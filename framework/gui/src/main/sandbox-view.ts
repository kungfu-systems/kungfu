import path from 'node:path';
// Main-process building blocks for a sandboxed kfx renderer: the locked-down
// webPreferences (node stripped, contextIsolation, sandbox, network denied), the
// resource guard (working-set sampler that kills on breach), and the standalone
// `createSandboxedView` (a BrowserWindow form, proven live in the harness). The
// embedded production form — a WebContentsView placed inside the shell window —
// reuses the same pieces from sandbox-manager; keeping them here as one source
// means the standalone and embedded views can never drift on isolation posture.
//
// In a real sandboxed renderer window.require/process/Buffer are absent,
// __kfxBridge carries only the declared keys, a declared call round-trips, and
// an undeclared call is rejected host-side.
import {
  BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences,
  app,
  ipcMain,
  session,
} from 'electron';

import { bindElectronHost } from './sandbox-host';

// default resource bounds for a sandboxed view (option A's resource-limit half)
export const DEFAULT_MEMORY_CAP_KB = 512 * 1024; // 512 MiB working set
const SAMPLE_INTERVAL_MS = 2000;

// Give each sandboxed view its own session partition with the network denied:
// a sandboxed view loads a local bundle and reaches the outside only through
// its declared capabilities, never http(s).
export function lockedDownPartition(id: string): string {
  const partition = `sandbox:${id}`;
  const ses: Session = session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok =
      details.url.startsWith('file:') || details.url.startsWith('devtools:');
    callback({ cancel: !ok });
  });
  return partition;
}

// The webPreferences that strip node and lock a sandboxed renderer to its
// declared capabilities. Shared by the standalone window and the embedded
// WebContentsView so the isolation posture is defined exactly once.
export function sandboxWebPreferences(opts: {
  declared: readonly string[];
  partitionId: string;
  preload?: string;
}): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    partition: lockedDownPartition(opts.partitionId),
    preload: opts.preload ?? path.join(__dirname, '../preload/sandbox.js'),
    additionalArguments: [
      `--kfx-declared=${JSON.stringify([...opts.declared])}`,
    ],
  };
}

// Sample a renderer's OS process working set; call onBreach when it exceeds the
// cap. Returns a stop function to clear the sampler. Kept transport-free so both
// the standalone window (destroy the window) and the embedded view (remove +
// destroy the webContents) supply their own kill action.
export function startResourceGuard(
  webContents: WebContents,
  opts: { memoryCapKb?: number; onBreach: () => void },
): () => void {
  const cap = opts.memoryCapKb ?? DEFAULT_MEMORY_CAP_KB;
  const sampler = setInterval(() => {
    if (webContents.isDestroyed()) return;
    // Read the pid each tick: an embedded WebContentsView has no OS process yet
    // at construction (getOSProcessId() returns 0 until the renderer spawns), so
    // capturing it once would never match a metric.
    const pid = webContents.getOSProcessId();
    if (!pid) return;
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (metric && metric.memory.workingSetSize > cap) opts.onBreach();
  }, SAMPLE_INTERVAL_MS);
  return () => clearInterval(sampler);
}

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

// Standalone sandboxed view: a hidden BrowserWindow with node stripped and the
// capability host bound directly to concrete caps. This is the contract-proven
// form; the embedded, shell-integrated form lives in sandbox-manager.
export function createSandboxedView(
  options: SandboxedViewOptions,
): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: sandboxWebPreferences({
      declared: options.declared,
      partitionId: String(Date.now()),
      preload: options.preload,
    }),
  });

  const host = bindElectronHost(
    ipcMain,
    win.webContents,
    options.caps,
    options.declared,
  );

  const stopGuard = startResourceGuard(win.webContents, {
    memoryCapKb: options.memoryCapKb,
    onBreach: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  });

  win.on('closed', () => {
    stopGuard();
    host.dispose();
  });

  void win.loadURL(options.entryUrl);
  return win;
}
