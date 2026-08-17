// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import type {
  GlobalWorkFilter,
  GlobalWorkRow,
  GlobalWorkSnapshot,
  ProjectAgentSessionSnapshot,
  ProjectWorkCapturePlan,
  ProjectWorkCaptureReceipt,
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
  Projects,
  ProjectsCatalog,
  WorkStartReceipt,
} from '@kungfu-tech/api/capability';
import {
  filterGlobalWork,
  isCompletedGlobalWork,
} from '@kungfu-tech/api/capability';
import { Box, Text, useApp } from 'ink';
import React from 'react';

import { resolveMeasuredListWindow } from '../list-window/index.js';
import {
  KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
  KUNGFU_PROJECT_DISCOVERY_PATTERN,
  TerminalAmbientScene,
  type TerminalDimensions,
} from '../profile-shell.js';
import {
  ProjectFileTreeNavigation,
  type ProjectPathCopyNotice,
  ProjectPathCopyOverlay,
  projectNavigationWidth,
  projectWorkAmbientRows,
} from '../project-files-view/index.js';
import type {
  ProjectWorkQuickAction,
  ProjectWorkspaceSelection,
} from '../projects-view/index.js';
import { terminalCanvasRows } from '../terminal-canvas.js';
import { projectWorkSessionState } from './project-work-session-state.js';
import { NativeWorkProjectionView } from './project-work-session-view.js';

export type WorkSort = 'updated-desc' | 'project-asc' | 'title-asc';

export function agentBootstrapLine(
  bootstrap: ProjectAgentSessionSnapshot['bootstrap'],
): string {
  if (!bootstrap) return 'Bootstrap · unavailable';
  return `Bootstrap · ${bootstrap.state} · Work mutations ${bootstrap.mutationsAllowed ? 'enabled' : 'blocked'}`;
}

type ProjectWorkDimensionSource = {
  get(): TerminalDimensions;
  subscribe(listener: (dimensions: TerminalDimensions) => void): () => void;
};

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
  const workPanelDimensions = {
    columns: Math.max(12, dimensions.columns - navigationWidth - 6),
    rows: Math.max(3, panelRows - 2),
  };
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
          {model.counts.all === 0 ? (
            <TerminalAmbientScene
              dimensions={workPanelDimensions}
              pattern={KUNGFU_EMPTY_WORK_NEBULA_PATTERN}
            />
          ) : visibleItems.length === 0 ? (
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

export type ProjectWorkActionRequest = {
  id: number;
  action: ProjectWorkQuickAction;
};

type ProjectWorkComposer = {
  step: 'objective' | 'acceptance' | 'preview' | 'capturing';
  objective: string;
  acceptanceCriterion: string;
  plan?: ProjectWorkCapturePlan;
};

function ProjectWorkDock({
  title,
  detail,
  tone,
}: {
  title: string;
  detail: string;
  tone: 'cyan' | 'green';
}) {
  return (
    <Box
      height={4}
      flexShrink={0}
      flexDirection="column"
      borderStyle="double"
      borderColor={tone}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={tone} wrap="truncate-end">
        {title}
      </Text>
      <Text wrap="truncate-end">{detail}</Text>
    </Box>
  );
}

export function ProjectWorkHost({
  projects,
  project,
  dimensions,
  ensureAgentSession,
  onContinueRetainedWork,
  onOpenProjects,
  onOpenLab,
  onOpenCapturedWork,
  onInputModeChange,
  onWorkspacePointer,
  loadingWork,
  actionRequest,
  onActionHandled,
  isInputCaptured,
  initialWorkReceipt,
  allowNewWorkOverRetainedRun = false,
}: {
  projects: Projects;
  project: ProjectWorkspaceSelection;
  dimensions: ProjectWorkDimensionSource;
  ensureAgentSession: (runtimeDir: string) => Promise<unknown>;
  onContinueRetainedWork: (receipt: WorkStartReceipt) => Promise<void>;
  onOpenProjects: () => void;
  onOpenLab: () => void;
  onOpenCapturedWork: (
    plan: ProjectWorkCapturePlan,
    receipt: ProjectWorkCaptureReceipt,
  ) => void;
  onInputModeChange: (active: boolean) => void;
  onWorkspacePointer: () => void;
  loadingWork: boolean;
  actionRequest?: ProjectWorkActionRequest;
  onActionHandled?: (id: number) => void;
  isInputCaptured: () => boolean;
  initialWorkReceipt?: WorkStartReceipt;
  allowNewWorkOverRetainedRun?: boolean;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [plan, setPlan] = React.useState<ProjectWorkRunPlan>();
  const [composer, setComposer] = React.useState<ProjectWorkComposer>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(
    'Press Enter to create the first Work in this Project.',
  );
  const [runs, setRuns] = React.useState<ProjectWorkRunSnapshot[]>(() =>
    projects.runs(),
  );
  const [restoringRuns, setRestoringRuns] = React.useState(true);
  const [fileTreeFocused, setFileTreeFocused] = React.useState(false);
  const [loadingFrame, setLoadingFrame] = React.useState(0);
  const [copyNotice, setCopyNotice] = React.useState<ProjectPathCopyNotice>();
  const [agentReply, setAgentReply] = React.useState<string>();
  const workDiscoveryLoading = loadingWork || restoringRuns;
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => projects.subscribeRuns(setRuns), [projects]);
  React.useEffect(() => {
    let active = true;
    setRestoringRuns(true);
    const restore = async () => {
      await ensureAgentSession(project.runtime_dir);
      if (initialWorkReceipt) {
        await projects.restoreRun(initialWorkReceipt, project.workspace_root);
      } else {
        await projects.syncSessions({
          workspace: project.workspace_root,
          workspaceId: project.workspace_id,
        });
      }
    };
    void restore()
      .catch((error) => {
        if (active)
          setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setRestoringRuns(false);
      });
    return () => {
      active = false;
    };
  }, [
    ensureAgentSession,
    initialWorkReceipt,
    project.workspace_id,
    project.workspace_root,
    project.runtime_dir,
    projects,
  ]);
  React.useEffect(() => {
    if (!workDiscoveryLoading) return;
    const timer = setInterval(
      () => setLoadingFrame((current) => (current + 1) % 4),
      180,
    );
    return () => clearInterval(timer);
  }, [workDiscoveryLoading]);
  React.useEffect(() => {
    if (!copyNotice) return;
    const timeout = setTimeout(() => setCopyNotice(undefined), 3500);
    return () => clearTimeout(timeout);
  }, [copyNotice]);
  const workspaceInputActive = Boolean(composer) || agentReply !== undefined;
  React.useEffect(() => {
    onInputModeChange(workspaceInputActive);
    return () => {
      if (workspaceInputActive) onInputModeChange(false);
    };
  }, [onInputModeChange, workspaceInputActive]);

  const {
    visibleRun,
    session,
    attention,
    providerSessionActive,
    visibleWorkId,
    projectWorkCount,
    retainedAgentFinished,
    retainedAgentReviewable,
  } = projectWorkSessionState({
    runs,
    workspace: project.workspace_root,
    allowNewWorkOverRetainedRun,
  });
  const visibleRunProvider = visibleRun?.provider;
  React.useEffect(() => {
    if (!visibleRunProvider) return;
    setMessage(
      visibleWorkId
        ? `Observing Work · ${visibleWorkId}`
        : `Observing ${visibleRunProvider} workspace session`,
    );
  }, [visibleRunProvider, visibleWorkId]);
  React.useEffect(() => {
    if (
      !visibleRun?.id ||
      (!session?.live &&
        !(
          session?.backend === 'native-interactive' &&
          session.lifecycleState !== 'ended'
        ))
    )
      return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void projects
        .refreshRun(visibleRun.id)
        .catch((error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [
    projects,
    session?.backend,
    session?.lifecycleState,
    session?.live,
    visibleRun?.id,
  ]);
  const mockScenario = process.env.KUNGFU_MOCK_AGENT_SCENARIO;
  const selectedProvider = mockScenario ? 'mock' : 'codex';
  const selectedAgentLabel = mockScenario
    ? `Mock Agent · ${mockScenario}`
    : 'Codex';
  const visibleAgentLabel = visibleRun?.provider
    ? visibleRun.provider
    : selectedAgentLabel;
  const canvasRows = terminalCanvasRows(size.rows);
  const projectWorkAmbientDimensions = {
    columns: Math.max(12, size.columns - projectNavigationWidth(size) - 8),
    rows: projectWorkAmbientRows(size),
  };
  const emptyProjectIdle =
    !workDiscoveryLoading && !visibleRun && !plan && !composer;
  const loadingSpinner = ['◐', '◓', '◑', '◒'][loadingFrame];
  const beginNewWork = React.useCallback(() => {
    if (workDiscoveryLoading || busy || visibleRun?.running) return;
    if (visibleRun?.receipt) {
      setMessage(
        'Review and complete the retained Work before creating another Work.',
      );
      return;
    }
    setPlan(undefined);
    setComposer({
      step: 'objective',
      objective: '',
      acceptanceCriterion: '',
    });
    setMessage('Describe one outcome for this Project.');
  }, [busy, visibleRun?.receipt, visibleRun?.running, workDiscoveryLoading]);
  React.useEffect(() => {
    if (!actionRequest) return;
    beginNewWork();
    onActionHandled?.(actionRequest.id);
  }, [actionRequest, beginNewWork, onActionHandled]);
  const previewCodex = React.useCallback(() => {
    if (busy || visibleRun?.running || visibleRun?.receipt) return;
    setBusy(true);
    setMessage(
      `Verifying ${selectedAgentLabel}, native binding, and the selected Work…`,
    );
    void projects
      .planRun(selectedProvider, {
        workspace: project.workspace_root,
        scenario: mockScenario,
      })
      .then((nextPlan) => {
        setPlan(nextPlan);
        setMessage(
          nextPlan.executable
            ? 'Exact Work plan is ready for confirmation.'
            : 'The Work plan is blocked; inspect the verification evidence below.',
        );
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    project.workspace_root,
    projects,
    mockScenario,
    selectedAgentLabel,
    selectedProvider,
    visibleRun?.receipt,
    visibleRun?.running,
  ]);
  const continueRetainedWork = React.useCallback(() => {
    const receipt = visibleRun?.receipt;
    if (busy || !retainedAgentReviewable || !receipt) return;
    setBusy(true);
    setMessage('Refreshing the Agent attempt before independent review…');
    void projects
      .refreshRun(visibleRun.id)
      .then(async (refreshed) => {
        const current = refreshed ?? visibleRun;
        if (current.session?.live && current.session.controllable !== false) {
          setMessage(
            'Ending this Agent attempt and opening independent review…',
          );
          await projects.endRun(current.id);
        }
        return onContinueRetainedWork(current.receipt ?? receipt);
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    onContinueRetainedWork,
    projects,
    retainedAgentReviewable,
    visibleRun,
    visibleRun?.receipt,
  ]);
  const submitAgentReply = React.useCallback(() => {
    if (!visibleRun || agentReply === undefined || !agentReply.trim() || busy)
      return;
    setBusy(true);
    setMessage('Delivering your answer to the same Agent Session…');
    void projects
      .replyToRun(visibleRun.id, agentReply.trim())
      .then(() => setAgentReply(undefined))
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [agentReply, busy, projects, visibleRun]);
  const decideAgentApproval = React.useCallback(
    (approved: boolean) => {
      if (!visibleRun || busy) return;
      setBusy(true);
      setMessage(
        approved
          ? 'Approving the bounded Agent request…'
          : 'Denying the Agent request; Work remains open.',
      );
      void projects
        .approveRun(visibleRun.id, approved)
        .catch((error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusy(false));
    },
    [busy, projects, visibleRun],
  );
  const retryAgentAttempt = React.useCallback(() => {
    if (!visibleRun?.work || busy) return;
    setBusy(true);
    setMessage(
      'Ending the blocked attempt and planning one fresh Agent attempt…',
    );
    const end =
      session?.live && session.controllable !== false
        ? projects.endRun(visibleRun.id)
        : Promise.resolve(visibleRun);
    void end
      .then(() =>
        projects.planRun(selectedProvider, {
          workspace: project.workspace_root,
          work: visibleRun.work,
          scenario: mockScenario,
        }),
      )
      .then((nextPlan) => {
        setPlan(nextPlan);
        setMessage('Fresh Agent attempt is ready for confirmation.');
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    mockScenario,
    project.workspace_root,
    projects,
    selectedProvider,
    session?.controllable,
    session?.live,
    visibleRun,
  ]);
  const confirmRun = React.useCallback(() => {
    if (!plan?.executable || busy) return;
    const acceptedPlan = plan;
    setPlan(undefined);
    setBusy(true);
    setMessage(
      `Launching ${acceptedPlan.agent.label} for ${acceptedPlan.work.title}…`,
    );
    void projects
      .run(
        selectedProvider,
        {
          workspace: project.workspace_root,
          work: acceptedPlan.work.assignmentId,
          scenario: mockScenario,
          expectedPlanRoot: acceptedPlan.planRoot,
        },
        () => undefined,
      )
      .then((receipt) =>
        setMessage(
          receipt.ok
            ? 'Agent Work is retained. Follow the receipt next action below.'
            : `Agent Work ended with status ${receipt.status}.`,
        ),
      )
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    mockScenario,
    plan,
    project.workspace_root,
    projects,
    selectedProvider,
  ]);
  const captureComposedWork = React.useCallback(() => {
    if (!composer?.plan || busy) return;
    const capturePlan = composer.plan;
    setComposer({ ...composer, step: 'capturing' });
    setBusy(true);
    setMessage('Capturing the exact request without admitting or running it…');
    void projects
      .captureWork(project.workspace_root, capturePlan)
      .then((receipt) => onOpenCapturedWork(capturePlan, receipt))
      .catch((error) => {
        setComposer({ ...composer, step: 'preview' });
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [busy, composer, onOpenCapturedWork, project.workspace_root, projects]);

  React.useEffect(() => {
    if (fileTreeFocused) return;
    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      if (isInputCaptured()) return;
      if (agentReply !== undefined) {
        if (value === '\u001b') {
          setAgentReply(undefined);
        } else if (value === '\u007f' || value === '\b') {
          setAgentReply((current) => current?.slice(0, -1) ?? '');
        } else if (value === '\r' || value === '\n') {
          submitAgentReply();
        } else if (
          [...value].every((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint >= 0x20 && codePoint !== 0x7f;
          })
        ) {
          setAgentReply((current) => `${current ?? ''}${value}`.slice(0, 1000));
        }
        return;
      }
      if (composer) {
        if (composer.step === 'capturing') return;
        if (composer.step === 'preview') {
          if (value === '\u001b' || value === 'b') {
            setComposer({ ...composer, step: 'acceptance', plan: undefined });
          } else if (value === '\r' || value === '\n') {
            captureComposedWork();
          }
          return;
        }
        if (value === '\u001b') {
          setComposer(undefined);
          setMessage('New Work cancelled; nothing was captured.');
          return;
        }
        if (value === '\u007f' || value === '\b') {
          setComposer((current) =>
            current?.step === 'objective'
              ? { ...current, objective: current.objective.slice(0, -1) }
              : current
                ? {
                    ...current,
                    acceptanceCriterion: current.acceptanceCriterion.slice(
                      0,
                      -1,
                    ),
                  }
                : current,
          );
          return;
        }
        if (value === '\r' || value === '\n') {
          if (composer.step === 'objective') {
            if (!composer.objective.trim()) return;
            setComposer({ ...composer, step: 'acceptance' });
            setMessage(
              'Define the result that independent review should check.',
            );
          } else {
            if (!composer.acceptanceCriterion.trim()) return;
            try {
              setComposer({
                ...composer,
                step: 'preview',
                plan: projects.prepareWork(
                  composer.objective,
                  composer.acceptanceCriterion,
                ),
              });
              setMessage('Review this Work before capturing it.');
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          return;
        }
        const printable = [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 0x20 && codePoint !== 0x7f;
        });
        if (printable) {
          setComposer((current) =>
            current?.step === 'objective'
              ? {
                  ...current,
                  objective: `${current.objective}${value}`.slice(0, 320),
                }
              : current
                ? {
                    ...current,
                    acceptanceCriterion:
                      `${current.acceptanceCriterion}${value}`.slice(0, 320),
                  }
                : current,
          );
        }
        return;
      }
      if (plan) {
        if (value === '\u001b' || value === 'b' || value === 'n') {
          setPlan(undefined);
          setMessage('Work start cancelled; no effects were performed.');
        } else if (value === '\r' || value === 'y') {
          confirmRun();
        }
        return;
      }
      if (value === 'q' || value === '\u0003') return exit();
      if (value === 'a') return onOpenLab();
      if (value === 't') {
        setFileTreeFocused(true);
        return;
      }
      if (value === 'p' || value === '\u001b') return onOpenProjects();
      if (value === 'v' && retainedAgentReviewable)
        return continueRetainedWork();
      if (value === '\r' && retainedAgentReviewable)
        return continueRetainedWork();
      if (attention?.kind === 'blocked' && value === 'r')
        return retryAgentAttempt();
      if (session?.controllable === false) return;
      if (value === 'n') return beginNewWork();
      if (attention?.kind === 'needs-approval' && value === 'y')
        return decideAgentApproval(true);
      if (attention?.kind === 'needs-approval' && value === 'n')
        return decideAgentApproval(false);
      if (attention?.kind === 'needs-answer' && value === 'i') {
        setAgentReply('');
        return;
      }
      if (value === '\r') return beginNewWork();
      if (value === 'r') previewCodex();
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    beginNewWork,
    agentReply,
    attention?.kind,
    captureComposedWork,
    composer,
    confirmRun,
    continueRetainedWork,
    decideAgentApproval,
    exit,
    isInputCaptured,
    onOpenLab,
    onOpenProjects,
    plan,
    previewCodex,
    fileTreeFocused,
    projects.prepareWork,
    retainedAgentReviewable,
    retryAgentAttempt,
    session?.controllable,
    submitAgentReply,
  ]);

  const eventRows = Math.max(3, canvasRows - 15);
  const visibleEvents = visibleRun?.events.slice(-eventRows) ?? [];
  const visibleTerminalLines = session?.terminalLines
    .filter((line) => line.trim())
    .slice(-eventRows);
  const projectName =
    path.basename(project.workspace_root) || project.display_path;
  return (
    <Box
      width={size.columns}
      height={canvasRows}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      position="relative"
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">
        PROJECT · {projectName}
      </Text>
      <Text dimColor wrap="truncate-end">
        {project.workspace_root}
      </Text>
      <Box flexGrow={1}>
        <ProjectFileTreeNavigation
          root={project.workspace_root}
          dimensions={dimensions}
          workCount={workDiscoveryLoading ? undefined : projectWorkCount}
          focused={fileTreeFocused}
          isInputCaptured={isInputCaptured}
          onFocus={() => setFileTreeFocused(true)}
          onOpenWork={() => setFileTreeFocused(false)}
          onOpenProjects={onOpenProjects}
          onOpenLab={onOpenLab}
          onWorkspacePointer={onWorkspacePointer}
          onCopyNotice={setCopyNotice}
          topOffset={5}
        />
        <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <Text wrap="truncate-end">
            Create Work, choose an Agent, and keep the result in this Project.
          </Text>
          <Text bold color="yellow" wrap="truncate-end">
            {workDiscoveryLoading
              ? `${loadingSpinner} LOADING: discovering retained Work in this Project`
              : providerSessionActive || session?.attempt === 'working'
                ? 'RUNNING: the Agent is working in this Project'
                : attention
                  ? `ATTENTION: ${attention.message}`
                  : retainedAgentFinished
                    ? 'NEXT: [Enter] review Project changes with a fresh Agent'
                    : visibleRun?.receipt
                      ? 'NEXT: inspect the retained failure before retrying'
                      : 'NEXT: [Enter or /new] create Work'}
          </Text>
          <Text dimColor wrap="truncate-end">
            [t] focus Files · [n or /new] New Work · [p/Esc] Projects · [a]
            Agent Work Lab · [q] quit
          </Text>
          <Box flexDirection="column" marginTop={1} flexGrow={1}>
            {workDiscoveryLoading ? (
              <>
                <Box flexGrow={1} alignItems="center" justifyContent="center">
                  <TerminalAmbientScene
                    dimensions={projectWorkAmbientDimensions}
                    pattern={KUNGFU_PROJECT_DISCOVERY_PATTERN}
                  />
                </Box>
                <ProjectWorkDock
                  title={`${loadingSpinner} LOADING PROJECT WORK`}
                  detail="Reading retained Work and evidence before showing this Project."
                  tone="cyan"
                />
              </>
            ) : visibleRun ? (
              <>
                <Text bold color={providerSessionActive ? 'yellow' : 'green'}>
                  {providerSessionActive
                    ? `◌ ${visibleAgentLabel.toUpperCase()} SESSION RUNNING`
                    : `✓ ${visibleAgentLabel.toUpperCase()} SESSION`}
                </Text>
                {session?.bootstrap ? (
                  <Text
                    color={
                      session.bootstrap.state === 'verified'
                        ? 'green'
                        : 'yellow'
                    }
                  >
                    {agentBootstrapLine(session.bootstrap)}
                  </Text>
                ) : null}
                {session?.nativeObserver ? (
                  <NativeWorkProjectionView session={session} />
                ) : null}
                {visibleTerminalLines && visibleTerminalLines.length > 0 ? (
                  visibleTerminalLines.map((line, index) => (
                    <Text key={`${index}:${line}`} wrap="truncate-end">
                      {line}
                    </Text>
                  ))
                ) : visibleEvents.length > 0 ? (
                  visibleEvents.map((event) => (
                    <Text key={`${event.index}:${event.root ?? event.text}`}>
                      <Text color={event.status === 'failed' ? 'red' : 'cyan'}>
                        {String(event.index).padStart(2, '0')} {event.stage}
                      </Text>{' '}
                      {event.activity?.text || event.text}
                    </Text>
                  ))
                ) : session?.nativeObserver ? null : (
                  <Text color="yellow">
                    {visibleRun.running
                      ? `${visibleAgentLabel} is working; waiting for the next retained event…`
                      : 'No streamed events were retained for this run.'}
                  </Text>
                )}
                {visibleRun.error ? (
                  <Text color="red">{visibleRun.error}</Text>
                ) : null}
                {visibleRun.receipt ? (
                  <>
                    <Text bold color={visibleRun.receipt.ok ? 'green' : 'red'}>
                      {visibleRun.receipt.status} ·{' '}
                      {visibleRun.receipt.workPhase}
                    </Text>
                    {visibleRun.receipt.nextActions
                      .slice(0, 2)
                      .map((action) => (
                        <Text key={action}>Next · {action}</Text>
                      ))}
                  </>
                ) : null}
                {attention ? (
                  <Box
                    flexDirection="column"
                    borderStyle="double"
                    borderColor={
                      attention.kind === 'blocked' ? 'red' : 'yellow'
                    }
                    paddingX={1}
                  >
                    <Text
                      bold
                      color={attention.kind === 'blocked' ? 'red' : 'yellow'}
                    >
                      {attention.kind.replaceAll('-', ' ').toUpperCase()}
                    </Text>
                    <Text>{attention.message}</Text>
                    <Text bold>
                      {attention.kind === 'ready-for-review'
                        ? '[v/Enter] review changes'
                        : attention.kind === 'blocked'
                          ? '[r] end this attempt and plan a fresh attempt'
                          : session?.controllable === false
                            ? 'Continue in the provider-native terminal; TUI is observer only'
                            : attention.kind === 'needs-approval'
                              ? '[y] approve · [n] deny'
                              : attention.kind === 'needs-answer'
                                ? '[i] answer · [v/Enter] review changes'
                                : 'Inspect the Agent Session state'}
                    </Text>
                  </Box>
                ) : null}
              </>
            ) : emptyProjectIdle ? (
              <>
                <Box flexGrow={1} alignItems="center" justifyContent="center">
                  <TerminalAmbientScene
                    dimensions={projectWorkAmbientDimensions}
                    pattern={KUNGFU_EMPTY_WORK_NEBULA_PATTERN}
                  />
                </Box>
                <ProjectWorkDock
                  title="PROJECT OPENED"
                  detail="No Work yet. Press [Enter] to describe it, then choose an Agent."
                  tone="green"
                />
              </>
            ) : null}
          </Box>
          {agentReply !== undefined ? (
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor="cyan"
              paddingX={1}
            >
              <Text bold color="cyan">
                ANSWER AGENT
              </Text>
              <Text inverse>{agentReply || ' '}</Text>
              <Text bold>[Enter] send · [Esc] cancel</Text>
            </Box>
          ) : plan ? (
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor={plan.executable ? 'yellow' : 'red'}
              paddingX={1}
            >
              <Text bold color={plan.executable ? 'yellow' : 'red'}>
                CONFIRM WORK START
              </Text>
              <Text>
                {plan.work.title} · {plan.agent.label}
              </Text>
              <Text color={plan.agent.verification.ok ? 'green' : 'red'}>
                Agent{' '}
                {plan.agent.verification.ok
                  ? `verified · ${plan.agent.verification.version || 'available'}`
                  : `failed · ${plan.agent.verification.error || 'unavailable'}`}
              </Text>
              <Text color={plan.admissionBinding.ok ? 'green' : 'red'}>
                Native binding · {plan.admissionBinding.state}
              </Text>
              {plan.effects.slice(0, 4).map((effect, index) => (
                <Text key={`${effect.stage}:${effect.label}`}>
                  {index + 1}. {effect.label}
                </Text>
              ))}
              <Text bold>
                {plan.executable
                  ? '[y/Enter] Start Work · [b/Esc] back'
                  : '[b/Esc] back · repair verification before retrying'}
              </Text>
            </Box>
          ) : composer ? (
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor={composer.step === 'preview' ? 'yellow' : 'cyan'}
              paddingX={1}
            >
              <Text
                bold
                color={composer.step === 'preview' ? 'yellow' : 'cyan'}
              >
                {composer.step === 'objective'
                  ? 'NEW WORK · OBJECTIVE'
                  : composer.step === 'acceptance'
                    ? 'NEW WORK · ACCEPTANCE'
                    : composer.step === 'capturing'
                      ? 'CAPTURING WORK'
                      : 'CONFIRM WORK CAPTURE'}
              </Text>
              {composer.step === 'objective' ? (
                <>
                  <Text>What should the Agent accomplish in this Project?</Text>
                  <Text>
                    Objective: <Text inverse>{composer.objective || ' '}</Text>
                  </Text>
                  <Text bold>[Enter] continue · [Esc] cancel</Text>
                </>
              ) : composer.step === 'acceptance' ? (
                <>
                  <Text>How will independent review know it is done?</Text>
                  <Text>
                    Check:{' '}
                    <Text inverse>{composer.acceptanceCriterion || ' '}</Text>
                  </Text>
                  <Text bold>[Enter] preview · [Esc] cancel</Text>
                </>
              ) : composer.plan ? (
                <>
                  <Text>
                    Work ID ·{' '}
                    <Text color="cyan">{composer.plan.assignmentId}</Text>
                  </Text>
                  <Text>Objective · {composer.plan.objective}</Text>
                  <Text bold>Acceptance criteria</Text>
                  {composer.plan.acceptanceChecks.map((check, index) => (
                    <Text key={check}>
                      {index + 1}. {check}
                    </Text>
                  ))}
                  <Text color="yellow">
                    This only captures the request. No Work is admitted and no
                    Agent runs yet.
                  </Text>
                  <Text bold>
                    {composer.step === 'capturing'
                      ? '◌ Waiting for the canonical capture receipt…'
                      : '[Enter] capture Work · [b/Esc] edit acceptance'}
                  </Text>
                </>
              ) : null}
            </Box>
          ) : workDiscoveryLoading || emptyProjectIdle ? null : (
            <Text color={busy ? 'yellow' : undefined}>
              {busy ? '◌ ' : '✓ '}
              {message}
            </Text>
          )}
        </Box>
      </Box>
      {copyNotice ? (
        <ProjectPathCopyOverlay notice={copyNotice} dimensions={size} />
      ) : null}
    </Box>
  );
}
