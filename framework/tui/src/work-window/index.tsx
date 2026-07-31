// SPDX-License-Identifier: Apache-2.0

import type {
  GlobalWorkFilter,
  GlobalWorkRow,
  GlobalWorkSnapshot,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import {
  filterGlobalWork,
  isCompletedGlobalWork,
} from '@kungfu-tech/api/capability';
import { Box, Text } from 'ink';
import React from 'react';

import { resolveMeasuredListWindow } from '../list-window/index.js';
import type { TerminalDimensions } from '../profile-shell.js';
import { terminalCanvasRows } from '../terminal-canvas.js';

export type WorkSort = 'updated-desc' | 'project-asc' | 'title-asc';

export type WorkWindowItem = {
  id: string;
  title: string;
  status: string;
  projectKey: string;
  projectName: string;
  projectPath: string;
  updatedAt: string;
  nextActions: string[];
  conflict: boolean;
};

export type WorkWindowGroup = {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
  items: WorkWindowItem[];
};

export type WorkWindowModel = {
  filter: GlobalWorkFilter;
  sort: WorkSort;
  counts: Record<GlobalWorkFilter, number>;
  groups: WorkWindowGroup[];
  items: WorkWindowItem[];
  observedAt: string;
  verified: boolean;
  notice?: string;
};

const FILTERS: GlobalWorkFilter[] = ['active', 'completed', 'all'];
const FILTER_LABELS: Record<GlobalWorkFilter, string> = {
  active: 'Active',
  completed: 'Completed',
  all: 'All',
};
const SORT_LABELS: Record<WorkSort, string> = {
  'updated-desc': 'Updated ↓',
  'project-asc': 'Project A–Z',
  'title-asc': 'Title A–Z',
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function newestTimestamp(row: GlobalWorkRow): string {
  return (
    [
      row.display.updated_at,
      ...row.observations.map((row) => row.display?.updated_at),
    ]
      .map(clean)
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? ''
  );
}

function compareUpdated(left: WorkWindowItem, right: WorkWindowItem): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const safeLeft = Number.isFinite(leftTime)
    ? leftTime
    : Number.NEGATIVE_INFINITY;
  const safeRight = Number.isFinite(rightTime)
    ? rightTime
    : Number.NEGATIVE_INFINITY;
  return safeRight - safeLeft || left.title.localeCompare(right.title);
}

function projectIdentity(
  row: GlobalWorkRow,
  catalog?: ProjectsCatalog,
): Pick<WorkWindowItem, 'projectKey' | 'projectName' | 'projectPath'> {
  const ids = [
    ...new Set(
      row.observations.map((row) => clean(row.workspace_id)).filter(Boolean),
    ),
  ].sort();
  const known = new Map(
    catalog?.projects.map((project) => [project.id, project]),
  );
  const projects = ids.map((id) => {
    const project = known.get(id);
    return {
      id,
      name:
        project?.name ||
        (id === 'home' ? 'Home' : id.replace(/^project:/u, 'Project ')),
      path: project?.path || '',
    };
  });
  if (projects.length === 0) {
    return {
      projectKey: 'unknown',
      projectName: 'Unknown Project',
      projectPath: '',
    };
  }
  const singleProject = projects[0];
  if (singleProject && projects.length === 1) {
    return {
      projectKey: singleProject.id,
      projectName: singleProject.name,
      projectPath: singleProject.path,
    };
  }
  return {
    projectKey: projects.map((project) => project.id).join('|'),
    projectName: `Shared · ${projects.map((project) => project.name).join(' + ')}`,
    projectPath: projects
      .map((project) => project.path)
      .filter(Boolean)
      .join(' · '),
  };
}

export function cycleWorkSort(sort: WorkSort): WorkSort {
  const sorts: WorkSort[] = ['updated-desc', 'project-asc', 'title-asc'];
  return sorts[(sorts.indexOf(sort) + 1) % sorts.length] ?? 'updated-desc';
}

export function buildWorkWindowModel(
  snapshot: GlobalWorkSnapshot,
  {
    filter = 'active',
    sort = 'updated-desc',
    projects,
  }: {
    filter?: GlobalWorkFilter;
    sort?: WorkSort;
    projects?: ProjectsCatalog;
  } = {},
): WorkWindowModel {
  const rows = filterGlobalWork(snapshot, filter);
  const items = rows.map((row): WorkWindowItem => {
    const status =
      clean(row.display.status) || clean(row.display.portfolio_state) || 'open';
    return {
      id: row.canonical_root,
      title:
        clean(row.display.title) || clean(row.subject) || row.canonical_root,
      status: row.conflict ? 'degraded' : status,
      ...projectIdentity(row, projects),
      updatedAt: newestTimestamp(row),
      nextActions: (row.display.next_actions ?? []).map(clean).filter(Boolean),
      conflict: Boolean(row.conflict),
    };
  });
  const byProject = new Map<string, WorkWindowGroup>();
  for (const item of items) {
    const group = byProject.get(item.projectKey) ?? {
      id: item.projectKey,
      name: item.projectName,
      path: item.projectPath,
      updatedAt: '',
      items: [],
    };
    group.items.push(item);
    if (
      Number.isFinite(Date.parse(item.updatedAt)) &&
      (!Number.isFinite(Date.parse(group.updatedAt)) ||
        Date.parse(item.updatedAt) > Date.parse(group.updatedAt))
    ) {
      group.updatedAt = item.updatedAt;
    }
    byProject.set(item.projectKey, group);
  }
  const groups = [...byProject.values()];
  for (const group of groups) {
    group.items.sort(
      sort === 'title-asc'
        ? (left, right) => left.title.localeCompare(right.title)
        : compareUpdated,
    );
  }
  groups.sort(
    sort === 'updated-desc'
      ? (left, right) => {
          const leftTime = Date.parse(left.updatedAt);
          const rightTime = Date.parse(right.updatedAt);
          return (
            (Number.isFinite(rightTime)
              ? rightTime
              : Number.NEGATIVE_INFINITY) -
              (Number.isFinite(leftTime)
                ? leftTime
                : Number.NEGATIVE_INFINITY) ||
            left.name.localeCompare(right.name)
          );
        }
      : (left, right) => left.name.localeCompare(right.name),
  );
  const orderedItems = groups.flatMap((group) => group.items);
  const allRows = snapshot.global_work.visible_work;
  const completed = allRows.filter(isCompletedGlobalWork).length;
  const state = snapshot.aggregate.state ?? 'unknown';
  return {
    filter,
    sort,
    counts: {
      active: allRows.length - completed,
      completed,
      all: allRows.length,
    },
    groups,
    items: orderedItems,
    observedAt: snapshot.observed_at ?? '',
    verified: snapshot.verification?.ok === true,
    notice:
      state === 'complete'
        ? undefined
        : `${state} machine view · ${snapshot.aggregate.unknown_component_count ?? 0} Projects unknown`,
  };
}

export function formatWorkUpdatedAt(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown';
  const delta = Math.max(0, now - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function workWindowListContainsPoint({
  dimensions,
  column,
  row,
  topOffset = 0,
}: {
  dimensions: TerminalDimensions;
  column: number;
  row: number;
  topOffset?: number;
}): boolean {
  const navigationWidth = Math.min(
    24,
    Math.max(18, Math.floor(dimensions.columns * 0.2)),
  );
  return (
    column > navigationWidth &&
    column <= dimensions.columns &&
    row >= topOffset + 4 &&
    row <= topOffset + terminalCanvasRows(dimensions.rows) - 2
  );
}

export function WorkWindow({
  model,
  dimensions,
  selected,
  busy,
}: {
  model: WorkWindowModel;
  dimensions: TerminalDimensions;
  selected: number;
  busy: boolean;
}) {
  const canvasRows = terminalCanvasRows(dimensions.rows);
  const navigationWidth = Math.min(
    24,
    Math.max(18, Math.floor(dimensions.columns * 0.2)),
  );
  const panelRows = Math.max(3, canvasRows - 6);
  const viewportRows = Math.max(1, panelRows - 2);
  const window = resolveMeasuredListWindow({
    selected,
    itemCount: model.items.length,
    viewportRows,
    rowCost: (index, start) => {
      const item = model.items[index];
      const previous = model.items[index - 1];
      return (
        2 +
        (index === start || item?.projectKey !== previous?.projectKey ? 1 : 0)
      );
    },
  });
  const visibleItems = model.items.slice(window.start, window.end);
  let priorProject = '';

  return (
    <Box
      width={dimensions.columns}
      height={canvasRows}
      flexDirection="column"
      borderStyle="round"
      borderColor={model.verified ? 'cyan' : 'yellow'}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">
          ALL WORK · {FILTER_LABELS[model.filter]} · {model.items.length}
        </Text>
        <Text color={busy ? 'yellow' : undefined} wrap="truncate-end">
          {busy ? '◌ Updating…' : `Sort · ${SORT_LABELS[model.sort]}`}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        Every machine-local Work item, grouped by the Project that owns it.
      </Text>
      <Box height={panelRows} overflow="hidden">
        <Box
          width={navigationWidth}
          height={panelRows}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          <Text bold wrap="truncate-end">
            WORK
          </Text>
          {FILTERS.map((filter) => (
            <Text
              key={filter}
              bold={model.filter === filter}
              color={model.filter === filter ? 'cyan' : undefined}
              wrap="truncate-end"
            >
              {model.filter === filter ? '›' : ' '} {FILTER_LABELS[filter]}{' '}
              {model.counts[filter]}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor wrap="truncate-end">
            [f/←→] view
          </Text>
          <Text dimColor wrap="truncate-end">
            [s] sort
          </Text>
        </Box>
        <Box
          flexGrow={1}
          height={panelRows}
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          overflow="hidden"
        >
          {visibleItems.length === 0 ? (
            <Text color="yellow" wrap="truncate-end">
              No {FILTER_LABELS[model.filter]} Work.
            </Text>
          ) : (
            visibleItems.map((item, index) => {
              const showProject = item.projectKey !== priorProject;
              priorProject = item.projectKey;
              const itemIndex = window.start + index;
              return (
                <React.Fragment key={item.id}>
                  {showProject ? (
                    <Text bold color="magenta" wrap="truncate-end">
                      PROJECT · {item.projectName}
                      {item.projectPath ? ` · ${item.projectPath}` : ''}
                    </Text>
                  ) : null}
                  <Text
                    bold={itemIndex === selected}
                    color={
                      item.conflict
                        ? 'red'
                        : itemIndex === selected
                          ? 'cyan'
                          : undefined
                    }
                    wrap="truncate-end"
                  >
                    {itemIndex === selected ? '›' : ' '} {item.title}{' '}
                    <Text dimColor>[{item.status}]</Text>
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}Project {item.projectName} · Updated{' '}
                    {formatWorkUpdatedAt(item.updatedAt)}
                    {item.nextActions[0]
                      ? ` · Next: ${item.nextActions[0]}`
                      : ''}
                  </Text>
                </React.Fragment>
              );
            })
          )}
        </Box>
      </Box>
      <Text color={model.notice ? 'yellow' : undefined} wrap="truncate-end">
        {model.notice ||
          `Observed ${formatWorkUpdatedAt(model.observedAt)} · read-only machine view`}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑↓/jk Work · ←→/hl or f view · s sort · [2] Project(s) · r refresh · q
        quit
      </Text>
    </Box>
  );
}
