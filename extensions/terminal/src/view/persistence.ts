// Workspace layout persistence for the managed session workspace (W4).
//
// The set of open sessions and their arrangement is a journal-backed config
// fact, not a private GUI file: it lives in the runtime home's ConfigStore at a
// stable location, so the CLI and agents read and write the same record the GUI
// shows (the same shape shell-state.ts uses for shell state). This is the F4
// boundary — session lifecycle identity is a config fact the workspace owns —
// and the F5 contract — a stable, tolerant JSON read that other surfaces can
// depend on.
//
// Only the durable (tmux-backed) identity is restorable across an app restart:
// on relaunch the in-memory session map is empty, so the workspace re-adopts
// each persisted tmux session by runId. Direct (non-durable) sessions are
// recorded for completeness but cannot be brought back — their process died
// with the previous renderer.
import type { DomainState, KfLocation } from '@kungfu-tech/kfx';

// One JSON blob, addressed like shell state (system/shell/…/live).
export const WORKSPACE_LOCATION: KfLocation = {
  category: 'system',
  group: 'shell',
  name: 'terminal-workspace',
  mode: 'live',
};

export type PersistedPane = {
  runId: string;
  provider: string;
  title: string;
  backend: 'tmux' | 'direct';
  command?: string;
  args?: string[];
  cwd?: string;
  startedAt: number;
  order: number;
};

export type WorkspaceLayout = {
  version: 1;
  workspaceId: string;
  panes: PersistedPane[];
};

export function emptyLayout(): WorkspaceLayout {
  return { version: 1, workspaceId: 'default', panes: [] };
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
  const backend = v.backend === 'direct' ? 'direct' : 'tmux';
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
  };
}

// Tolerant read (F5): a malformed or partial blob yields an empty layout or
// drops only the bad panes — it never throws, because the GUI, CLI and agents
// all read this record and a boot must not hinge on its shape.
export function parseWorkspaceLayout(raw: string): WorkspaceLayout {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null) return emptyLayout();
    const o = obj as Record<string, unknown>;
    const rawPanes = Array.isArray(o.panes) ? o.panes : [];
    const panes = rawPanes
      .map((p, i) => parsePane(p, i))
      .filter((p): p is PersistedPane => p !== null);
    return {
      version: 1,
      workspaceId:
        typeof o.workspaceId === 'string' ? o.workspaceId : 'default',
      panes,
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
          row.location.category === WORKSPACE_LOCATION.category &&
          row.location.group === WORKSPACE_LOCATION.group &&
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
