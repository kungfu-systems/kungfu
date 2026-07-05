// Per-session OS window renderer (ADR-0016 stage 3). A separate BrowserWindow
// renderer that mounts the terminal view against a single runId, reaching the
// durable session host in the main process over the terminal relay — the same
// host the shell's grid uses, so a session renders identically in the grid and
// in its own window. Node-integrated like the shell because it needs ipcRenderer
// to reach the relay; unlike the shell it holds no zero-copy runtime, only the
// terminal proxy, because a session window renders one live terminal and nothing
// else. The stage-2 placeholder page is replaced by this entry.
import * as capability from '@kungfu-tech/api/capability';
import type { KfxCapabilities, KfxEntry, Shell } from '@kungfu-tech/kfx';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import { loadKfx } from '../src/kfx-loader';
import {
  type IpcRendererLike,
  createTerminalProxy,
} from '../src/terminal-proxy';

// The externals contract `kungfu sdk kfx build` injects into every kfx bundle:
// one React instance and one capability surface (see renderer/src/main.tsx).
const SHARED_MODULES = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  '@kungfu-tech/api': capability,
  '@kungfu-tech/api/capability': capability,
};

// Render a plain failure line into #root. A session window has no shell chrome
// to fall back to, so a misconfigured launch should still say why.
function fail(message: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = message;
  root.setAttribute(
    'style',
    'height:100vh;display:flex;align-items:center;justify-content:center;' +
      'color:#c46b6b;font:12px/1.5 monospace;padding:16px;text-align:center',
  );
}

function main(): void {
  const runId = new URLSearchParams(window.location.search).get('runId');
  if (!runId) {
    fail('session window opened without a runId');
    return;
  }

  // The durable host runs in the main process (ADR-0016); a window can only reach
  // it over ipc, so this renderer is always a relay client and never owns an
  // in-renderer host.
  let ipc: IpcRendererLike;
  try {
    ipc = (window.require('electron') as { ipcRenderer: IpcRendererLike })
      .ipcRenderer;
  } catch (e) {
    fail(`electron ipc unavailable: ${(e as Error).message}`);
    return;
  }
  const terminal = createTerminalProxy(ipc);

  // Load the terminal kfx the same way the shell does, so its code and its CSS
  // (injected by loadKfx) match the grid exactly; the single-session branch is
  // selected by shell.params.sessionWindowRunId below.
  const loaded = loadKfx(window.process.env, SHARED_MODULES);
  const entry = loaded.entries.find(
    (e: KfxEntry) =>
      e.tier === 'node-integrated' && e.capabilities.includes('terminal'),
  );
  if (!entry) {
    fail('terminal view not found on the extension path');
    return;
  }

  // Only caps.terminal is real and only shell.params is read (to select the
  // single-session branch and carry the runId); the rest of the capability and
  // shell surfaces are absent by construction — this window is a view onto one
  // live session, not the full workspace.
  const caps = { terminal } as unknown as KfxCapabilities;
  const shell = { params: { sessionWindowRunId: runId } } as unknown as Shell;

  createRoot(document.getElementById('root') as HTMLElement).render(
    <entry.View caps={caps} shell={shell} />,
  );
}

main();
