// SPDX-License-Identifier: Apache-2.0

import type { ProductSearchDocument } from './product-search.js';

export type GlobalWorkRow = {
  canonical_root: string;
  object_kind: string;
  subject: string;
  display: {
    title?: string;
    status?: string;
    portfolio_state?: string;
    next_actions?: string[];
    updated_at?: string;
  };
  observations: Array<{
    workspace_id?: string;
    availability?: string;
    display?: {
      updated_at?: string;
    };
  }>;
  conflict?: boolean;
};

export type GlobalWorkSnapshot = {
  schema:
    | 'kungfu.workspace-federation.query/v1'
    | 'kungfu.gui.global-work-snapshot/v1';
  observed_at?: string;
  aggregate: {
    state?: string;
    component_count?: number;
    available_component_count?: number;
    unknown_component_count?: number;
    conflict_count?: number;
  };
  verification?: { ok?: boolean };
  proof?: { proof_root?: string };
  global_work: {
    projection_root?: string;
    visible_work: GlobalWorkRow[];
    visible_work_count?: number;
    canonical_work_count?: number;
    conflict_count?: number;
    label_collision_count?: number;
  };
};

export type GlobalWorkFilter = 'active' | 'completed' | 'all';

const TERMINAL_WORK_STATUSES = new Set([
  'archived',
  'closed',
  'complete',
  'completed',
  'merged',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function parseGlobalWorkSnapshot(value: unknown): GlobalWorkSnapshot {
  const root = object(value);
  const candidate =
    root?.schema === 'kungfu.gui.global-work-observer/v2'
      ? object(root.query)
      : root?.schema === 'kungfu.gui.global-work-observer-event/v1'
        ? object(root.snapshot)
        : root;
  const globalWork = object(candidate?.global_work);
  if (
    ![
      'kungfu.workspace-federation.query/v1',
      'kungfu.gui.global-work-snapshot/v1',
    ].includes(String(candidate?.schema)) ||
    !globalWork ||
    !Array.isArray(globalWork.visible_work)
  ) {
    throw new Error('Kungfu returned an invalid global Work snapshot');
  }
  return candidate as unknown as GlobalWorkSnapshot;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function isCompletedGlobalWork(row: GlobalWorkRow): boolean {
  return (
    clean(row.display.portfolio_state).toLocaleLowerCase() === 'completed' ||
    TERMINAL_WORK_STATUSES.has(clean(row.display.status).toLocaleLowerCase())
  );
}

export function filterGlobalWork(
  snapshot: GlobalWorkSnapshot,
  filter: GlobalWorkFilter,
): GlobalWorkRow[] {
  if (filter === 'all') return snapshot.global_work.visible_work;
  const completed = filter === 'completed';
  return snapshot.global_work.visible_work.filter(
    (row) => isCompletedGlobalWork(row) === completed,
  );
}

export function globalWorkSearchDocuments(
  snapshot: GlobalWorkSnapshot,
): ProductSearchDocument[] {
  return snapshot.global_work.visible_work.map((row, index) => {
    const status =
      clean(row.display.status) || clean(row.display.portfolio_state) || 'open';
    const workspaces = row.observations
      .map((observation) => clean(observation.workspace_id))
      .filter(Boolean);
    const nextActions = (row.display.next_actions ?? [])
      .map(clean)
      .filter(Boolean);
    const kind = clean(row.object_kind) || 'work';
    return {
      id: `work.global.${row.canonical_root}`,
      kind: 'work',
      title:
        clean(row.display.title) || clean(row.subject) || row.canonical_root,
      summary: [
        `Work · ${status}`,
        workspaces.length > 0 ? workspaces.join(' · ') : '',
        nextActions.length > 0 ? `Next: ${nextActions.join(' · ')}` : '',
        row.conflict ? 'Conflicting observations require attention.' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      section: 'Global Work',
      keywords: [
        kind,
        clean(row.subject),
        status,
        clean(row.display.portfolio_state),
        ...workspaces,
      ].filter(Boolean),
      priority: index,
      action: { kind: 'open-work', workId: row.canonical_root },
    };
  });
}
