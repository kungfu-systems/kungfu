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
  };
  observations: Array<{
    workspace_id?: string;
    availability?: string;
  }>;
  conflict?: boolean;
};

export type GlobalWorkSnapshot = {
  schema: 'kungfu.workspace-federation.query/v1';
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
    candidate?.schema !== 'kungfu.workspace-federation.query/v1' ||
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
        `${kind} · ${status}`,
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
