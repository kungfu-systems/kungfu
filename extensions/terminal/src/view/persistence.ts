// Workspace layout persistence for the managed session workspace (W4).
//
// This file owns presentation persistence only. WorkConsole, SessionAttempt,
// binding, lifecycle and receipts belong to the Core Agent Session registry;
// panes/windows merely retain stable identity references used to reconstruct a
// view after reload.
//
// Only the durable (tmux-backed) identity is restorable across an app restart:
// on relaunch the in-memory session map is empty, so the workspace re-adopts
// each persisted tmux session by runId. Direct (non-durable) sessions are
// recorded for completeness but cannot be brought back — their process died
// with the previous renderer.
import type { DomainState, KfLocation } from '@kungfu-tech/kfx';

// One JSON blob, addressed like shell state (system/shell/…/live).
export const WORKSPACE_LOCATION: KfLocation = {
  role: 'system',
  namespace: 'shell',
  name: 'terminal-workspace',
  mode: 'live',
};

export type PersistedPane = {
  runId: string;
  provider: string;
  title: string;
  backend: 'capsule' | 'tmux' | 'direct';
  command?: string;
  args?: string[];
  cwd?: string;
  startedAt: number;
  order: number;
  consoleId?: string;
  attemptId?: string;
  runtimeProfileId?: string;
};

// An OS window that shows one session (ADR-0016 stage 2). Window identity is a
// separate layer from session identity: this record *references* a session by
// runId — it does not carry terminal state — so the in-shell grid and the OS
// windows are two views of the same session set, and neither owns the other.
// `displayId` is the F7 stable display key (see gui window-placement.displayKey)
// the window was last seen on; on restore the main process clamps the saved
// rectangle back onto a currently-connected display.
export type PersistedWindow = {
  windowId: string;
  runId: string;
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lastSeenAt: number;
};

export type WorkspaceLayout = {
  version: 1;
  workspaceId: string;
  panes: PersistedPane[];
  windows: PersistedWindow[];
};

export function emptyLayout(): WorkspaceLayout {
  return { version: 1, workspaceId: 'default', panes: [], windows: [] };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function parsePane(value: unknown, index: number): PersistedPane | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.runId !== 'string' || v.runId.length === 0) return null;
  if (typeof v.provider !== 'string') return null;
  const backend =
    v.backend === 'capsule'
      ? 'capsule'
      : v.backend === 'direct'
        ? 'direct'
        : 'tmux';
  return {
    runId: v.runId,
    provider: v.provider,
    title: typeof v.title === 'string' ? v.title : v.runId,
    backend,
    command: typeof v.command === 'string' ? v.command : undefined,
    args: asStringArray(v.args),
    cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
    order: typeof v.order === 'number' ? v.order : index,
    consoleId: typeof v.consoleId === 'string' ? v.consoleId : undefined,
    attemptId: typeof v.attemptId === 'string' ? v.attemptId : undefined,
    runtimeProfileId:
      typeof v.runtimeProfileId === 'string' ? v.runtimeProfileId : undefined,
  };
}

function parseWindow(value: unknown): PersistedWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.windowId !== 'string' || v.windowId.length === 0) return null;
  if (typeof v.runId !== 'string' || v.runId.length === 0) return null;
  if (typeof v.displayId !== 'string' || v.displayId.length === 0) return null;
  // A window with a non-numeric rectangle cannot be placed, so drop it rather
  // than restore it at NaN and let the OS decide — same tolerant policy as panes.
  if (
    typeof v.x !== 'number' ||
    typeof v.y !== 'number' ||
    typeof v.width !== 'number' ||
    typeof v.height !== 'number'
  ) {
    return null;
  }
  return {
    windowId: v.windowId,
    runId: v.runId,
    displayId: v.displayId,
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    lastSeenAt: typeof v.lastSeenAt === 'number' ? v.lastSeenAt : 0,
  };
}

// Tolerant read (F5): a malformed or partial blob yields an empty layout or
// drops only the bad panes/windows — it never throws, because the GUI, CLI and
// agents all read this record and a boot must not hinge on its shape.
export function parseWorkspaceLayout(raw: string): WorkspaceLayout {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null) return emptyLayout();
    const o = obj as Record<string, unknown>;
    const rawPanes = Array.isArray(o.panes) ? o.panes : [];
    const panes = rawPanes
      .map((p, i) => parsePane(p, i))
      .filter((p): p is PersistedPane => p !== null);
    const rawWindows = Array.isArray(o.windows) ? o.windows : [];
    const windows = rawWindows
      .map((w) => parseWindow(w))
      .filter((w): w is PersistedWindow => w !== null);
    return {
      version: 1,
      workspaceId:
        typeof o.workspaceId === 'string' ? o.workspaceId : 'default',
      panes,
      windows,
    };
  } catch {
    return emptyLayout();
  }
}

export function loadWorkspaceLayout(domain: DomainState): WorkspaceLayout {
  try {
    const entry = domain
      .configs()
      .find(
        (row) =>
          row.location.role === WORKSPACE_LOCATION.role &&
          row.location.namespace === WORKSPACE_LOCATION.namespace &&
          row.location.name === WORKSPACE_LOCATION.name,
      );
    return entry ? parseWorkspaceLayout(entry.value) : emptyLayout();
  } catch {
    return emptyLayout();
  }
}

export function saveWorkspaceLayout(
  domain: DomainState,
  layout: WorkspaceLayout,
): void {
  try {
    domain.setConfig(WORKSPACE_LOCATION, JSON.stringify(layout));
  } catch {
    // persistence is best-effort; a failed write never breaks the workspace
  }
}
