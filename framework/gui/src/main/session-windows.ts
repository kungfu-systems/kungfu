// Per-session OS window registry (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2). One session can be popped
// out of the in-shell grid into its own restorable OS window, placed on the
// display the user left it on. This module owns the *lifecycle* — which session
// has a window, where it sits, and cleanup on close — but stays electron-free:
// index.ts supplies the Electron BrowserWindow + screen implementation of the
// deps below. The same pure-core / thin-glue split terminal-host uses; the only
// non-trivial geometry (F7 clamp) already lives in window-placement.
//
// Window identity is a layer above session identity: a record references a
// session by runId and never holds terminal state, so a window closing does not
// end the session (the durable host outlives it) — it just drops the view.
import {
  type DisplayInfo,
  type Placement,
  type Rect,
  centeredBounds,
  placeWindow,
} from './window-placement';

// Default size for a fresh pop-out (no saved placement); centered on the
// primary display's work area.
const DEFAULT_WINDOW_WIDTH = 900;
const DEFAULT_WINDOW_HEIGHT = 680;

// The OS window this registry drives. index.ts implements it over a
// BrowserWindow; onBoundsChanged must be wired to end-of-gesture events
// ('moved' / 'resized'), not the continuous ones, so persistence is not chatty.
export type SessionWindow = {
  getBounds(): Rect;
  focus(): void;
  close(): void;
  onBoundsChanged(cb: () => void): void;
  onClosed(cb: () => void): void;
};

// A window row as persisted into WorkspaceLayout.windows[] (structurally the
// terminal extension's PersistedWindow; it crosses IPC as plain JSON, so the
// renderer maps it there — no cross-package import from a main-process module).
export type SessionWindowSnapshot = {
  windowId: string;
  runId: string;
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lastSeenAt: number;
};

export type SessionWindowDeps = {
  // currently-connected displays plus the primary's stable key (F7 input)
  displays: () => { list: DisplayInfo[]; primaryId: string };
  // the stable display key for whichever display a rectangle now sits on,
  // used to refresh a record after the user drags it to another monitor
  displayKeyForBounds: (bounds: Rect) => string;
  // create an OS window at bounds showing runId (glue: a BrowserWindow)
  createWindow: (args: {
    windowId: string;
    runId: string;
    bounds: Rect;
  }) => SessionWindow;
  // persist hook, called on every open-set or bounds change with the full set
  onChange: (snapshot: SessionWindowSnapshot[]) => void;
  // clock for lastSeenAt, a dep so the core stays deterministic
  now: () => number;
};

export type OpenSpec = {
  windowId: string;
  runId: string;
  // saved placement when restoring; omit for a fresh pop-out
  saved?: Placement;
};

type WindowRecord = {
  windowId: string;
  runId: string;
  displayId: string;
  window: SessionWindow;
};

export type SessionWindowRegistry = {
  open: (spec: OpenSpec) => Placement;
  close: (runId: string) => void;
  has: (runId: string) => boolean;
  snapshot: () => SessionWindowSnapshot[];
  closeAll: () => void;
};

export function createSessionWindowRegistry(
  deps: SessionWindowDeps,
): SessionWindowRegistry {
  const byRun = new Map<string, WindowRecord>();

  function snapshot(): SessionWindowSnapshot[] {
    const now = deps.now();
    return [...byRun.values()].map((r) => {
      const b = r.window.getBounds();
      return {
        windowId: r.windowId,
        runId: r.runId,
        displayId: r.displayId,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        lastSeenAt: now,
      };
    });
  }

  function emitChange(): void {
    deps.onChange(snapshot());
  }

  function freshPlacement(list: DisplayInfo[], primaryId: string): Placement {
    const primary = list.find((d) => d.id === primaryId) ?? list[0];
    if (!primary)
      return {
        displayId: '',
        bounds: {
          x: 0,
          y: 0,
          width: DEFAULT_WINDOW_WIDTH,
          height: DEFAULT_WINDOW_HEIGHT,
        },
      };
    return {
      displayId: primary.id,
      bounds: centeredBounds(
        primary.workArea,
        DEFAULT_WINDOW_WIDTH,
        DEFAULT_WINDOW_HEIGHT,
      ),
    };
  }

  function open(spec: OpenSpec): Placement {
    // One window per session: a second open just focuses the existing one.
    const existing = byRun.get(spec.runId);
    if (existing) {
      existing.window.focus();
      return {
        displayId: existing.displayId,
        bounds: existing.window.getBounds(),
      };
    }

    const { list, primaryId } = deps.displays();
    // Restore clamps the saved rectangle onto a present display (F7); a fresh
    // pop-out centers a default size on the primary.
    const placement = spec.saved
      ? placeWindow(spec.saved, list, primaryId)
      : freshPlacement(list, primaryId);

    const window = deps.createWindow({
      windowId: spec.windowId,
      runId: spec.runId,
      bounds: placement.bounds,
    });
    const rec: WindowRecord = {
      windowId: spec.windowId,
      runId: spec.runId,
      displayId: placement.displayId,
      window,
    };
    byRun.set(spec.runId, rec);

    window.onBoundsChanged(() => {
      // The window may have crossed to another monitor; refresh its display key.
      rec.displayId = deps.displayKeyForBounds(window.getBounds());
      emitChange();
    });
    window.onClosed(() => {
      byRun.delete(spec.runId);
      emitChange();
    });

    emitChange();
    return placement;
  }

  function close(runId: string): void {
    // cleanup + emitChange run in the onClosed handler
    byRun.get(runId)?.window.close();
  }

  return {
    open,
    close,
    has: (runId) => byRun.has(runId),
    snapshot,
    closeAll: () => {
      for (const rec of [...byRun.values()]) rec.window.close();
    },
  };
}
