// Main-process manager for embedded sandboxed kfx views. A sandboxed view runs
// in an isolated renderer with node stripped; it is embedded in the shell window
// as a child WebContentsView and positioned over the shell's content area. The
// view reaches only its declared capabilities, and those real capabilities live
// in the trusted node-integrated renderer (they hold the native binding). So the
// capability path is three hops:
//
//   sandboxed view --IPC(INVOKE_CHANNEL)--> main (this manager, a relay)
//     --IPC(kfx:host-invoke)--> trusted renderer's capability host (real caps)
//
// and events flow back the reverse way. Main is a pure relay: it never sees the
// real capabilities and never interprets the {cap,method,args} payload — the
// declared-only enforcement lives in the trusted renderer's createCapabilityHost
// (co-located with the caps it guards). This keeps the guest<->host callback and
// subscription protocol intact end to end; the relay just forwards two channels.
import { readFileSync } from 'node:fs';
import type { BrowserWindow, WebContents, WebContentsView } from 'electron';

import type { HostEvent, HostRequest } from '@kungfu-tech/api/capability';
import {
  HOST_EVENT_CHANNEL,
  HOST_INVOKE_CHANNEL,
  HOST_REPLY_CHANNEL,
} from '../sandbox/channels';
import { EVENT_CHANNEL, INVOKE_CHANNEL } from '../sandbox/transport';
import { sandboxWebPreferences, startResourceGuard } from './sandbox-view';

// The global the isolated harness page exposes; main injects the view bundle
// source through its `load` method (see sandbox-view-harness/harness.ts). The
// bundle is read by main (trusted) and shipped as a string, so the sandboxed
// renderer never gets fs/require — it only receives the wrapped source.
const HARNESS_GLOBAL = '__kfxHarness';

export type EnsureViewOptions = {
  id: string;
  // capability keys the view's manifest declares
  declared: readonly string[];
  // absolute path to the view bundle the isolated harness will load
  bundlePath: string;
  // preload override (the built sandbox preload by default, via webPrefs)
  preload?: string;
  // working-set cap in KiB; over it the view is killed
  memoryCapKb?: number;
};

export type Rect = { x: number; y: number; width: number; height: number };

// The Electron surface the manager needs, kept as a small structural type so the
// manager is unit-constructible with fakes and only the app supplies real
// electron. WebContentsView / BrowserWindow / ipcMain match these shapes.
type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: { sender: WebContents }, payload: unknown) => unknown,
  ) => void;
  removeHandler: (channel: string) => void;
  on: (
    channel: string,
    listener: (event: { sender: WebContents }, payload: unknown) => void,
  ) => void;
};

type WebContentsViewCtor = new (opts: {
  webPreferences: ReturnType<typeof sandboxWebPreferences>;
}) => WebContentsView;

export type SandboxManagerDeps = {
  // the shell (trusted) window: its contentView hosts the child views and its
  // webContents runs the trusted capability host service
  shell: Pick<BrowserWindow, 'contentView'> & { webContents: WebContents };
  ipcMain: IpcMainLike;
  WebContentsView: WebContentsViewCtor;
  // resolve the isolated harness page URL (the manager stays free of the app's
  // asset layout; the app / harness supplies this)
  harnessEntry: () => string;
  // read a view bundle's source (main is trusted; defaults to node fs). Injected
  // so the manager is unit-constructible without the real filesystem.
  readBundleSource?: (bundlePath: string) => string;
};

type ViewEntry = {
  id: string;
  view: WebContentsView;
  stopGuard: () => void;
  visible: boolean;
};

export class SandboxManager {
  private readonly deps: SandboxManagerDeps;
  private readonly views = new Map<string, ViewEntry>();
  // route an INVOKE by the sender webContents id back to the view id
  private readonly bySender = new Map<number, string>();
  // pending main<->trusted-renderer request correlation
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private reqSeq = 0;

  constructor(deps: SandboxManagerDeps) {
    this.deps = deps;
    const { ipcMain } = deps;

    // Hop 1 -> 2: an invoke from a sandboxed view is forwarded to the trusted
    // renderer's host, keyed to the view the sender belongs to.
    ipcMain.handle(INVOKE_CHANNEL, (event, payload) => {
      const viewId = this.bySender.get(event.sender.id);
      if (!viewId) {
        return Promise.reject(
          new Error('sandboxed invoke from an unknown view'),
        );
      }
      return this.forwardToHost(viewId, payload as HostRequest);
    });

    // Hop 2 reply: the trusted renderer answers a forwarded invoke.
    ipcMain.on(HOST_REPLY_CHANNEL, (_event, payload) => {
      const { reqId, ok, value, error } = payload as {
        reqId: number;
        ok: boolean;
        value?: unknown;
        error?: string;
      };
      const waiter = this.pending.get(reqId);
      if (!waiter) return;
      this.pending.delete(reqId);
      if (ok) waiter.resolve(value);
      else waiter.reject(new Error(error ?? 'sandbox host error'));
    });

    // Host -> guest event: a bridged callback fired in the trusted host; relay
    // it to the owning sandboxed view.
    ipcMain.on(HOST_EVENT_CHANNEL, (_event, payload) => {
      const { id, event } = payload as { id: string; event: HostEvent };
      const entry = this.views.get(id);
      if (entry && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.send(EVENT_CHANNEL, event);
      }
    });
  }

  private forwardToHost(id: string, req: HostRequest): Promise<unknown> {
    const trusted = this.deps.shell.webContents;
    if (trusted.isDestroyed()) {
      return Promise.reject(new Error('trusted renderer is gone'));
    }
    this.reqSeq += 1;
    const reqId = this.reqSeq;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      trusted.send(HOST_INVOKE_CHANNEL, { id, reqId, req });
    });
  }

  // Create (or reuse) the sandboxed view and embed it in the shell content view.
  ensureView(opts: EnsureViewOptions): void {
    if (this.views.has(opts.id)) return;
    const view = new this.deps.WebContentsView({
      webPreferences: sandboxWebPreferences({
        declared: opts.declared,
        partitionId: `${opts.id}:${this.reqSeq}`,
        preload: opts.preload,
      }),
    });
    this.deps.shell.contentView.addChildView(view);
    // start hidden until the shell reports the content-area rect
    view.setVisible(false);

    const stopGuard = startResourceGuard(view.webContents, {
      memoryCapKb: opts.memoryCapKb,
      onBreach: () => this.destroyView(opts.id),
    });

    const entry: ViewEntry = { id: opts.id, view, stopGuard, visible: false };
    this.views.set(opts.id, entry);
    this.bySender.set(view.webContents.id, opts.id);

    // Once the harness page is up, ship the bundle source into it. Main reads
    // the file (trusted) and hands the isolated page a string; the page wraps it
    // with a require shim and mounts the view. Nothing widens the sandbox.
    const read =
      this.deps.readBundleSource ?? ((p: string) => readFileSync(p, 'utf8'));
    view.webContents.on('did-finish-load', () => {
      if (view.webContents.isDestroyed()) return;
      let source: string;
      try {
        source = read(opts.bundlePath);
      } catch (e) {
        void view.webContents.executeJavaScript(
          `window.${HARNESS_GLOBAL}.fail(${JSON.stringify(
            `cannot read bundle: ${(e as Error).message}`,
          )})`,
        );
        return;
      }
      void view.webContents.executeJavaScript(
        `window.${HARNESS_GLOBAL}.load(${JSON.stringify(source)})`,
      );
    });

    void view.webContents.loadURL(this.deps.harnessEntry());
  }

  // Position the view over the shell's content area (WebContentsView is an
  // overlay; the shell reports its content rect and we mirror it here).
  setBounds(id: string, rect: Rect): void {
    const entry = this.views.get(id);
    if (!entry) return;
    entry.view.setBounds(rect);
  }

  show(id: string): void {
    const entry = this.views.get(id);
    if (!entry) return;
    entry.visible = true;
    entry.view.setVisible(true);
  }

  hide(id: string): void {
    const entry = this.views.get(id);
    if (!entry) return;
    entry.visible = false;
    entry.view.setVisible(false);
  }

  destroyView(id: string): void {
    const entry = this.views.get(id);
    if (!entry) return;
    this.views.delete(id);
    this.bySender.delete(entry.view.webContents.id);
    entry.stopGuard();
    this.deps.shell.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) {
      // WebContentsView has no window to close; drop its renderer explicitly
      (
        entry.view.webContents as WebContents & { close?: () => void }
      ).close?.();
    }
  }

  has(id: string): boolean {
    return this.views.has(id);
  }
}
