// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentRuntimeProfile,
  AgentWorkLab,
  ProjectFileTreeEntry,
  ProjectTemplateCreationReceipt,
  ProjectTemplateWorkspaceSelection,
  ProjectTourEpisodeEvent,
  ProjectTourEpisodeReport,
  ProjectWork,
  ProjectWorkReference,
  ProjectWorkRunEvent,
  Projects,
  WorkClosePlan,
  WorkCloseReceipt,
  WorkReviewEvent,
  WorkReviewPlan,
  WorkReviewReceipt,
  WorkStartEvent,
  WorkStartPlan,
  WorkStartReceipt,
} from '@kungfu-tech/api/capability';
import { Box, Text, useApp } from 'ink';
import React from 'react';

import { boundedIndex, decodeShellKey } from '../navigation.js';
import {
  ProfileShell,
  type ProfileShellModel,
  type TerminalDimensions,
  compactProfileNavigationWidth,
  resolveProfileShellLayout,
} from '../profile-shell.js';
import {
  ProjectFileTreeNavigation,
  type ProjectPathCopyNotice,
  ProjectPathCopyOverlay,
  projectNavigationWidth,
} from '../project-files-view/index.js';
import {
  KUNGFU_WORK_DISCOVERY_PATTERN,
  type TerminalAnimationCell,
  TitledBorderWindow,
  terminalAnimationsEnabled,
  terminalCanvasRows,
  useTerminalAnimationFrame,
} from '../terminal-canvas.js';
import { decodeTerminalMouseInput } from '../terminal-lifecycle.js';

type DimensionSource = {
  get(): TerminalDimensions;
  subscribe(listener: (dimensions: TerminalDimensions) => void): () => void;
};

type SelectableAgentProfile = Omit<
  AgentRuntimeProfile,
  'provider' | 'bootstrap' | 'source'
> & {
  provider: AgentRuntimeProfile['provider'] | 'synthetic';
  bootstrap: {
    adapter: AgentRuntimeProfile['provider'] | 'synthetic';
    envelope: 'required' | 'disabled';
  };
  source: AgentRuntimeProfile['source'] | 'qualification';
};

export type OpenedStarterProject = {
  receipt?: ProjectTemplateCreationReceipt;
  workspace: ProjectTemplateWorkspaceSelection;
  work?: ProjectWork;
  works?: ProjectWork[];
};

export type ProjectTourLiveEvent = ProjectWorkRunEvent | WorkReviewEvent;

type ProjectTourLiveLine = {
  id: number;
  status: string;
  text: string;
};

type ProjectTourLiveClock = {
  now(): number;
  repeat(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
};

type ProjectTourLiveStreamOptions<Line extends ProjectTourLiveLine> = {
  active(): boolean;
  nextId(): number;
  project(event: ProjectTourLiveEvent, id: number): Line | null;
  operationLine(id: number, status: string, text: string): Line;
  append(line: Line): void;
  replace(line: Line): void;
  delay(milliseconds: number): Promise<void>;
  activityDelayMs: number;
  protocolDelayMs: number;
  clock?: ProjectTourLiveClock;
};

const projectTourLiveClock: ProjectTourLiveClock = {
  now: () => Date.now(),
  repeat: (callback, milliseconds) => setInterval(callback, milliseconds),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const PROJECT_TOUR_ACTIVE_STAGE_STATUSES = new Set([
  'progress',
  'running',
  'started',
  'waiting',
]);

function projectTourEventKey(event: ProjectTourLiveEvent): string {
  return `${event.schema}:${event.index}`;
}

function projectTourElapsedText(text: string, seconds: number): string {
  return `${text.replace(/ · \d+s elapsed$/u, '')} · ${seconds}s elapsed`;
}

export class ProjectTourLiveStream<Line extends ProjectTourLiveLine> {
  readonly #clock: ProjectTourLiveClock;
  readonly #seen = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #elapsed:
    | {
        stage: string;
        line: Line;
        startedAt: number;
        lastSecond: number;
        handle: unknown;
      }
    | undefined;
  #disposed = false;

  constructor(readonly options: ProjectTourLiveStreamOptions<Line>) {
    this.#clock = options.clock ?? projectTourLiveClock;
  }

  push(event: ProjectTourLiveEvent): void {
    const key = projectTourEventKey(event);
    if (this.#disposed || this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#tail = this.#tail.then(async () => {
      if (!this.options.active() || this.#disposed) return;
      const line = this.options.project(event, this.options.nextId());
      if (!line) return;

      if (event.activity) this.#stopElapsed();
      else if (
        this.#elapsed?.stage === event.stage &&
        !PROJECT_TOUR_ACTIVE_STAGE_STATUSES.has(event.status)
      )
        this.#stopElapsed();

      this.options.append(line);
      if (
        !event.activity &&
        PROJECT_TOUR_ACTIVE_STAGE_STATUSES.has(event.status)
      )
        this.#startElapsed(event.stage, line);
      await this.options.delay(
        event.activity
          ? this.options.activityDelayMs
          : this.options.protocolDelayMs,
      );
    });
  }

  async during<T>(
    text: string,
    operation: () => Promise<T>,
    completedText = `${text} · complete`,
  ): Promise<T> {
    await this.flush();
    if (!this.options.active() || this.#disposed)
      throw new Error('Project tour stopped');
    const line = this.options.operationLine(
      this.options.nextId(),
      'running',
      text,
    );
    this.options.append(line);
    this.#startElapsed('operation', line);
    try {
      const result = await operation();
      this.#stopElapsed();
      this.options.replace({
        ...line,
        status: 'completed',
        text: completedText,
      });
      return result;
    } catch (error) {
      this.#stopElapsed();
      this.options.replace({
        ...line,
        status: 'failed',
        text: `${text} · failed`,
      });
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopElapsed();
  }

  #startElapsed(stage: string, line: Line): void {
    this.#stopElapsed();
    const elapsed = {
      stage,
      line,
      startedAt: this.#clock.now(),
      lastSecond: 0,
      handle: undefined as unknown,
    };
    elapsed.handle = this.#clock.repeat(() => {
      if (!this.options.active() || this.#disposed) return;
      const seconds = Math.floor(
        (this.#clock.now() - elapsed.startedAt) / 1000,
      );
      if (seconds <= elapsed.lastSecond) return;
      elapsed.lastSecond = seconds;
      elapsed.line = {
        ...elapsed.line,
        text: projectTourElapsedText(elapsed.line.text, seconds),
      };
      this.options.replace(elapsed.line);
    }, 250);
    this.#elapsed = elapsed;
  }

  #stopElapsed(): void {
    if (!this.#elapsed) return;
    this.#clock.cancel(this.#elapsed.handle);
    this.#elapsed = undefined;
  }
}

function starterInitialWork(project: OpenedStarterProject): ProjectWork {
  if (!project.receipt)
    throw new Error('Opened Project Work has no exact captured request');
  return {
    ...project.receipt.initialWork,
    title: 'Create an evidence-backed launch brief',
    objective:
      'Turn the supplied product notes, customer feedback, and release facts into the launch brief without inventing unsupported claims.',
    acceptanceChecks: [
      'Names the product and target user',
      'Includes three evidence-backed benefits',
      'Separates confirmed facts from open questions',
      'Proposes one next action',
      'Does not invent quotes, dates, or metrics',
    ],
  };
}

export function openedProjectWorks(
  project: OpenedStarterProject,
): ProjectWork[] {
  const retained = project.works ?? project.receipt?.works ?? [];
  const works =
    retained.length > 0
      ? retained
      : [project.work ?? starterInitialWork(project)];
  if (
    project.work &&
    !works.some(
      (work) =>
        work.initiativeId === project.work?.initiativeId &&
        work.assignmentId === project.work?.assignmentId,
    )
  ) {
    return [...works, project.work];
  }
  return works;
}

export function openedProjectWork(project: OpenedStarterProject): ProjectWork {
  if (project.work) return project.work;
  return openedProjectWorks(project).at(-1) ?? starterInitialWork(project);
}

export function openedProjectWorkReference(
  project: OpenedStarterProject,
  selectedWork = openedProjectWork(project),
): ProjectWorkReference {
  return {
    destination: project.workspace.selected.workspace_root,
    initialWork: {
      initiativeId: selectedWork.initiativeId,
      assignmentId: selectedWork.assignmentId,
      requestPath: selectedWork.requestPath,
    },
  };
}

export function reviewReceiptCanResume(receipt?: WorkReviewReceipt): boolean {
  return Boolean(
    receipt &&
      [
        'reviewer-failed',
        'settlement-interrupted',
        'failed',
        'plan-drift',
        'confirmation-required',
        'not-executable',
      ].includes(receipt.status),
  );
}

export function workReceiptHasRetainedSession(
  receipt?: WorkStartReceipt,
): boolean {
  const session = (
    receipt?.agentReport as
      | { session?: Record<string, unknown> | null }
      | undefined
  )?.session;
  return Boolean(session?.workConsoleId && session?.sessionAttemptId);
}

function retainedWorkPresentation(work: ProjectWork): {
  status: string;
  summary: string;
} {
  if (work.settled || work.phase === 'continuation-decided') {
    return {
      status: 'completed · evidence retained',
      summary:
        'Work is complete. Open it to inspect the retained review and completion evidence.',
    };
  }
  if (work.phase) {
    return {
      status: work.phase,
      summary: `${work.objective} · Open this Work to inspect its retained state.`,
    };
  }
  return {
    status: 'pending admission',
    summary: `${work.objective} · Press Enter to choose an Agent and preview every effect.`,
  };
}

function activeWorkPresentation(
  work: ProjectWork,
  workReceipt?: WorkStartReceipt,
  reviewReceipt?: WorkReviewReceipt,
  closeReceipt?: WorkCloseReceipt,
): { status: string; summary: string; notice: string } {
  if (!workReceipt && !reviewReceipt && !closeReceipt) {
    const retained = retainedWorkPresentation(work);
    return {
      ...retained,
      notice: work.settled
        ? 'Completed · independently reviewed · human-confirmed · portable evidence retained'
        : 'Captured only · no Agent has run · no completion is claimed · read AGENTS.md before starting',
    };
  }
  const agentFinished = workReceipt?.status === 'agent-finished';
  const agentFailed = workReceipt?.status === 'agent-failed';
  const authorityStarted = Boolean(workReceipt?.writeOccurred);
  const reviewPassed = reviewReceipt?.status === 'review-passed';
  const revisionRequired = reviewReceipt?.status === 'revision-required';
  const reviewCanResume = reviewReceiptCanResume(reviewReceipt);
  const completed = closeReceipt?.status === 'completed';
  const closeCanResume =
    closeReceipt?.status === 'settlement-interrupted' &&
    closeReceipt.workPhase === 'continuation-decided';
  const status = completed
    ? 'completed · evidence retained'
    : closeCanResume
      ? 'closing · portable seal paused'
      : reviewPassed
        ? 'independently reviewed · decision required'
        : revisionRequired
          ? `${reviewReceipt.workPhase} · revision required`
          : reviewCanResume
            ? `${reviewReceipt?.workPhase ?? 'executing'} · review settlement paused`
            : agentFinished
              ? `${workReceipt.workPhase} · review required`
              : agentFailed || authorityStarted
                ? `${workReceipt?.workPhase ?? 'captured'} · attention required`
                : 'pending admission';
  const summary = completed
    ? 'Work is complete. The human close decision and portable evidence snapshot are retained.'
    : closeCanResume
      ? 'Your close decision is retained. Press Enter to resume only the portable evidence seal.'
      : reviewPassed
        ? 'Independent review passed. Press Enter to inspect the evidence and make the final completion decision.'
        : revisionRequired
          ? 'Independent review found required revisions. Inspect the failed criteria before running Work again.'
          : reviewCanResume
            ? 'Review evidence and completed authority effects are retained. Press Enter to resume only the remaining review settlement.'
            : agentFinished
              ? 'The Agent run is retained. Press Enter to review the deliverable and run an independent assessment.'
              : agentFailed
                ? 'The Agent report is retained, but the run failed. Inspect the failure and current Work state before continuing.'
                : authorityStarted
                  ? `Work start stopped at ${workReceipt?.failedAt ?? 'an authority stage'}. Inspect the retained receipts before recovery.`
                  : 'Captured safely. Press Enter to inspect it, choose an Agent, and preview every effect before starting.';
  const notice = completed
    ? 'Completed · independently reviewed · human-confirmed · portable evidence retained'
    : closeCanResume
      ? 'Close decision retained · portable seal paused · the decision will not repeat'
      : reviewPassed
        ? 'Independent review retained · your explicit completion decision is next'
        : revisionRequired
          ? 'Review failed · Work is not complete · revise before another review'
          : reviewCanResume
            ? 'Review settlement paused · retained evidence will be reused · completed steps will not repeat'
            : agentFinished
              ? 'Agent exit is not completion · independent review remains required'
              : agentFailed
                ? 'Agent run failed · retained evidence needs inspection · no completion is claimed'
                : authorityStarted
                  ? 'Work start is incomplete · inspect current authority before retrying · no completion is claimed'
                  : 'Captured only · no Agent has run · no completion is claimed · read AGENTS.md before starting';
  return { status, summary, notice };
}

export function starterProjectModel(
  project: OpenedStarterProject,
  workReceipt?: WorkStartReceipt,
  reviewReceipt?: WorkReviewReceipt,
  closeReceipt?: WorkCloseReceipt,
  selectedWork = openedProjectWork(project),
): ProfileShellModel {
  const { receipt, workspace } = project;
  const selected = workspace.selected;
  const works = openedProjectWorks(project);
  const active = activeWorkPresentation(
    selectedWork,
    workReceipt,
    reviewReceipt,
    closeReceipt,
  );
  return {
    profile: {
      id: receipt?.templateId ?? 'kungfu.project-work',
      title: 'Project',
      version:
        selected.display_path.split('/').filter(Boolean).at(-1) ?? 'open',
      suiteRoot: receipt?.templateRoot ?? selectedWork.requestRoot,
      qualified: receipt?.verification.ok ?? true,
      qualificationLabel: 'CAPTURE',
    },
    subject: {
      id: 'work',
      title: `Work · ${works.length}`,
      subtitle: selected.display_path,
    },
    navigation: [
      { id: 'files', label: 'Files', status: 'tree' },
      { id: 'work', label: 'Work', status: String(works.length) },
    ],
    cards: works.map((work) => {
      const presentation =
        work.assignmentId === selectedWork.assignmentId
          ? active
          : retainedWorkPresentation(work);
      return {
        id: work.assignmentId,
        title: work.title,
        status: presentation.status,
        summary: presentation.summary,
      };
    }),
    evidence: [
      { label: 'workspace identity', value: selected.identity_root },
      { label: 'Work request', value: selectedWork.requestRoot },
      { label: 'capture receipt', value: selectedWork.receiptRoot },
      {
        label: 'query proof',
        value:
          closeReceipt?.sealedState?.stateRoot ??
          selectedWork.stateRoot ??
          selectedWork.receiptRoot,
      },
    ],
    notice: active.notice,
    navigationTitle: 'Project',
    subjectNoun: 'Work',
    modeLabel: 'Project',
    retainNavigationInCompact: true,
    footer:
      't Files · ↑↓/jk Work · Enter open · /new New Work · p Projects · [1] All Work',
  };
}

type StarterProjectStage =
  | 'overview'
  | 'detail'
  | 'agents'
  | 'preview'
  | 'running'
  | 'result'
  | 'review'
  | 'review-agents'
  | 'review-preview'
  | 'reviewing'
  | 'review-result'
  | 'close-preview'
  | 'closing'
  | 'close-result';

export type StarterProjectInputContext = {
  stage: StarterProjectStage;
  planExecutable: boolean;
  reviewPlanExecutable: boolean;
  reviewReceipt?: WorkReviewReceipt;
  closePlanExecutable: boolean;
  closeReceipt?: WorkCloseReceipt;
  workReceipt?: WorkStartReceipt;
};

export type StarterProjectInputAction =
  | { kind: 'none' }
  | { kind: 'exit' }
  | { kind: 'open-terminal' }
  | { kind: 'open-agents' }
  | { kind: 'select-profile'; delta: -1 | 1 }
  | { kind: 'preview-start' }
  | { kind: 'start' }
  | { kind: 'open-review-agents' }
  | { kind: 'preview-review' }
  | { kind: 'run-review' }
  | { kind: 'reset-review'; stage: 'detail' }
  | { kind: 'preview-close' }
  | { kind: 'close-work' }
  | { kind: 'create-next-work' }
  | { kind: 'open-projects' }
  | { kind: 'open-lab' }
  | { kind: 'select-work'; delta: -1 | 1 }
  | { kind: 'select-region'; delta: -1 | 1 }
  | { kind: 'set-stage'; stage: StarterProjectStage; clearError: boolean };

const NO_STARTER_PROJECT_INPUT_ACTION = { kind: 'none' } as const;

function stageNavigationAction(
  enter: boolean,
  back: boolean,
  enterAction: StarterProjectInputAction,
  backStage: StarterProjectStage,
): StarterProjectInputAction {
  if (enter) return enterAction;
  if (back) return { kind: 'set-stage', stage: backStage, clearError: true };
  return NO_STARTER_PROJECT_INPUT_ACTION;
}

function profileSelectionAction(
  key: ReturnType<typeof decodeShellKey>,
  enter: boolean,
  back: boolean,
  enterAction: StarterProjectInputAction,
  backStage: StarterProjectStage,
): StarterProjectInputAction {
  if (key === 'next-card') return { kind: 'select-profile', delta: 1 };
  if (key === 'previous-card') return { kind: 'select-profile', delta: -1 };
  return stageNavigationAction(enter, back, enterAction, backStage);
}

function reviewResultAction(
  enter: boolean,
  back: boolean,
  reviewReceipt?: WorkReviewReceipt,
): StarterProjectInputAction {
  if (enter && reviewReceiptCanResume(reviewReceipt))
    return { kind: 'set-stage', stage: 'review', clearError: true };
  if (enter && reviewReceipt?.status === 'review-passed')
    return { kind: 'preview-close' };
  if (enter && reviewReceipt?.status === 'revision-required')
    return { kind: 'reset-review', stage: 'detail' };
  if (enter || back)
    return { kind: 'set-stage', stage: 'overview', clearError: true };
  return NO_STARTER_PROJECT_INPUT_ACTION;
}

function closeResultAction(
  input: string,
  enter: boolean,
  back: boolean,
  closeReceipt?: WorkCloseReceipt,
): StarterProjectInputAction {
  if (
    enter &&
    closeReceipt?.status === 'settlement-interrupted' &&
    closeReceipt.workPhase === 'continuation-decided'
  )
    return { kind: 'preview-close' };
  if (closeReceipt?.status === 'completed' && (enter || input === 'n'))
    return { kind: 'create-next-work' };
  if (back) return { kind: 'set-stage', stage: 'overview', clearError: true };
  return NO_STARTER_PROJECT_INPUT_ACTION;
}

function overviewInputAction(
  input: string,
  key: ReturnType<typeof decodeShellKey>,
  enter: boolean,
  context: StarterProjectInputContext,
): StarterProjectInputAction {
  if (enter)
    return {
      kind: 'set-stage',
      stage: starterProjectOverviewEnterStage(
        context.workReceipt,
        context.reviewReceipt,
        context.closeReceipt,
      ),
      clearError: true,
    };
  if (input === 'n' && context.closeReceipt?.status === 'completed')
    return { kind: 'create-next-work' };
  if (input === 'p') return { kind: 'open-projects' };
  if (key === 'agent-work-lab') return { kind: 'open-lab' };
  if (key === 'next-card') return { kind: 'select-work', delta: 1 };
  if (key === 'previous-card') return { kind: 'select-work', delta: -1 };
  if (key === 'next-region') return { kind: 'select-region', delta: 1 };
  if (key === 'previous-region') return { kind: 'select-region', delta: -1 };
  return NO_STARTER_PROJECT_INPUT_ACTION;
}

export function starterProjectInputAction(
  input: string,
  context: StarterProjectInputContext,
): StarterProjectInputAction {
  const key = decodeShellKey(input);
  const enter = input === '\r' || input === '\n';
  const back =
    input === '\u001b' || input === '\u007f' || input === '\b' || input === 'b';
  if (['running', 'reviewing', 'closing'].includes(context.stage))
    return NO_STARTER_PROJECT_INPUT_ACTION;
  if (input === 'q' || input === '\u0003') return { kind: 'exit' };
  if (context.stage === 'overview' && input === 't')
    return { kind: 'open-terminal' };
  if (context.stage === 'detail')
    return stageNavigationAction(
      enter || input === 's',
      back,
      { kind: 'open-agents' },
      'overview',
    );
  if (context.stage === 'agents')
    return profileSelectionAction(
      key,
      enter,
      back,
      { kind: 'preview-start' },
      'detail',
    );
  if (context.stage === 'preview')
    return stageNavigationAction(
      enter && context.planExecutable,
      back,
      { kind: 'start' },
      'agents',
    );
  if (context.stage === 'review') {
    if (input === 'a') return { kind: 'reset-review', stage: 'detail' };
    return stageNavigationAction(
      enter || input === 'r',
      back,
      { kind: 'open-review-agents' },
      'overview',
    );
  }
  if (context.stage === 'review-agents')
    return profileSelectionAction(
      key,
      enter,
      back,
      { kind: 'preview-review' },
      'review',
    );
  if (context.stage === 'review-preview')
    return stageNavigationAction(
      enter && context.reviewPlanExecutable,
      back,
      { kind: 'run-review' },
      'review-agents',
    );
  if (context.stage === 'review-result')
    return reviewResultAction(enter, back, context.reviewReceipt);
  if (context.stage === 'close-preview')
    return stageNavigationAction(
      enter && context.closePlanExecutable,
      back,
      { kind: 'close-work' },
      'review-result',
    );
  if (context.stage === 'close-result')
    return closeResultAction(input, enter, back, context.closeReceipt);
  if (context.stage === 'result')
    return stageNavigationAction(
      enter && context.workReceipt?.status === 'agent-finished',
      enter || back,
      { kind: 'set-stage', stage: 'review', clearError: true },
      'overview',
    );
  return overviewInputAction(input, key, enter, context);
}

export function starterProjectOverviewEnterStage(
  workReceipt?: WorkStartReceipt,
  reviewReceipt?: WorkReviewReceipt,
  closeReceipt?: WorkCloseReceipt,
): 'detail' | 'result' | 'review' | 'review-result' | 'close-result' {
  if (closeReceipt) return 'close-result';
  if (reviewReceiptCanResume(reviewReceipt)) return 'review';
  if (reviewReceipt?.status === 'revision-required') return 'detail';
  if (reviewReceipt) return 'review-result';
  if (workReceipt?.status === 'agent-finished') return 'review';
  return workReceipt ? 'result' : 'detail';
}

export function starterWorkEventLine(
  event: WorkStartEvent | WorkReviewEvent,
): string {
  const source = event.activity?.kind ?? 'kungfu';
  return `${String(event.index).padStart(2, '0')} ${source.padEnd(6)} ${event.text}`;
}

export function agentProfileSourceLabel(
  origin: 'configured' | 'discovered' | 'qualification',
  detail = '',
): string {
  if (origin === 'configured') return 'Configured · Kungfu config';
  if (origin === 'qualification')
    return 'Qualification fixture · deterministic and credential-free';
  const normalized = detail.replaceAll('_', ' ').trim();
  return normalized
    ? `Auto-discovered · ${normalized}`
    : 'Auto-discovered · local machine';
}

export function deterministicMockAgentSelection(
  scenario: string,
): SelectableAgentProfile {
  const reviewer = scenario === 'review-fit';
  return {
    schema: 'kungfu.agent-runtime-profile/v1',
    id: `kungfu.mock-agent.${scenario}`,
    label: reviewer
      ? 'Mock Reviewer · deterministic-fit'
      : `Mock Agent · ${scenario}`,
    provider: 'synthetic',
    launch: {
      executable: process.env.KUNGFU_MOCK_AGENT_EXECUTABLE ?? process.execPath,
      argv: [],
      interactiveArgv: [],
      versionArgv: ['--version'],
      shellMode: false,
    },
    cwdPolicy: 'workspace-root',
    backendDefault: 'direct',
    bootstrap: { adapter: 'synthetic', envelope: 'required' },
    source: 'qualification',
    lastVerified: null,
  };
}

export function deterministicMockSelectionForStage(
  scenario: string | undefined,
  stage: 'agents' | 'review-agents',
): SelectableAgentProfile | null {
  const normalized = scenario?.trim();
  if (!normalized) return null;
  return deterministicMockAgentSelection(
    stage === 'review-agents' ? 'review-fit' : normalized,
  );
}

export function projectSectionNavigationAtPoint({
  dimensions,
  column,
  row,
}: {
  dimensions: TerminalDimensions;
  column: number;
  row: number;
}): 'files' | 'work' | null {
  const layout = resolveProfileShellLayout(dimensions);
  const navigationWidth =
    layout.mode === 'one-column'
      ? compactProfileNavigationWidth(dimensions)
      : layout.navigationWidth;
  if (column < 1 || column > navigationWidth) {
    return null;
  }
  const index = row - 5;
  return index === 0 ? 'files' : index === 1 ? 'work' : null;
}

function StarterWorkPanel({
  dimensions,
  heading,
  subtitle,
  footer,
  children,
}: {
  dimensions: TerminalDimensions;
  heading: string;
  subtitle: string;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      width={dimensions.columns}
      height={Math.max(8, dimensions.rows)}
      paddingX={1}
      flexDirection="column"
    >
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
        overflow="hidden"
      >
        <Text bold color="cyan">
          {heading}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          {children}
        </Box>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}

export function StarterProjectHost({
  project,
  lab,
  ensureAgentSession,
  dimensions,
  isInputCaptured,
  onOpenLab,
  onOpenProjects,
  onCreateNextWork,
  onRetainedAgentSession,
  onWorkspacePointer,
  initialWorkReceipt,
  initialReviewReceipt,
  initialCloseReceipt,
}: {
  project: OpenedStarterProject;
  lab: AgentWorkLab;
  ensureAgentSession: (runtimeDir: string) => Promise<string>;
  dimensions: DimensionSource;
  isInputCaptured: () => boolean;
  onOpenLab: () => void;
  onOpenProjects: () => void;
  onCreateNextWork: () => void;
  onRetainedAgentSession?: (receipt: WorkStartReceipt) => void;
  onWorkspacePointer: () => void;
  initialWorkReceipt?: WorkStartReceipt;
  initialReviewReceipt?: WorkReviewReceipt;
  initialCloseReceipt?: WorkCloseReceipt;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [copyNotice, setCopyNotice] = React.useState<ProjectPathCopyNotice>();
  const [activeRegion, setActiveRegion] = React.useState(1);
  const [stage, setStage] = React.useState<StarterProjectStage>('overview');
  const [profiles, setProfiles] = React.useState<SelectableAgentProfile[]>([]);
  const [profileSources, setProfileSources] = React.useState<
    Record<string, string>
  >({});
  const [selectedProfile, setSelectedProfile] = React.useState(0);
  const [plan, setPlan] = React.useState<WorkStartPlan>();
  const [events, setEvents] = React.useState<WorkStartEvent[]>([]);
  const [workReceipt, setWorkReceipt] = React.useState<
    WorkStartReceipt | undefined
  >(initialWorkReceipt);
  const [reviewPlan, setReviewPlan] = React.useState<WorkReviewPlan>();
  const [reviewEvents, setReviewEvents] = React.useState<WorkReviewEvent[]>([]);
  const [reviewReceipt, setReviewReceipt] = React.useState<
    WorkReviewReceipt | undefined
  >(initialReviewReceipt);
  const [closePlan, setClosePlan] = React.useState<WorkClosePlan>();
  const [closeReceipt, setCloseReceipt] = React.useState<
    WorkCloseReceipt | undefined
  >(initialCloseReceipt);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [activityFrame, setActivityFrame] = React.useState(0);
  const works = React.useMemo(() => openedProjectWorks(project), [project]);
  const initialWork = React.useMemo(
    () => openedProjectWork(project),
    [project],
  );
  const [selectedWorkIndex, setSelectedWorkIndex] = React.useState(() =>
    Math.max(
      0,
      works.findIndex(
        (work) =>
          work.initiativeId === initialWork.initiativeId &&
          work.assignmentId === initialWork.assignmentId,
      ),
    ),
  );
  const selectedWork = works[selectedWorkIndex] ?? initialWork;
  const selectedCard = selectedWorkIndex;
  const selectionRequest = React.useRef(0);
  const workReference = React.useMemo(
    () => openedProjectWorkReference(project, selectedWork),
    [project, selectedWork],
  );
  const model = React.useMemo(
    () =>
      starterProjectModel(
        project,
        workReceipt,
        reviewReceipt,
        closeReceipt,
        selectedWork,
      ),
    [closeReceipt, project, reviewReceipt, selectedWork, workReceipt],
  );

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    if (!copyNotice) return;
    const timeout = setTimeout(() => setCopyNotice(undefined), 3500);
    return () => clearTimeout(timeout);
  }, [copyNotice]);
  React.useEffect(() => {
    if (
      !busy &&
      stage !== 'running' &&
      stage !== 'reviewing' &&
      stage !== 'closing'
    )
      return undefined;
    const timer = setInterval(
      () => setActivityFrame((current) => (current + 1) % 4),
      180,
    );
    return () => clearInterval(timer);
  }, [busy, stage]);
  const selectWork = React.useCallback(
    (nextWork: ProjectWork) => {
      const nextIndex = works.findIndex(
        (work) =>
          work.initiativeId === nextWork.initiativeId &&
          work.assignmentId === nextWork.assignmentId,
      );
      if (nextIndex < 0 || nextIndex === selectedWorkIndex) return;
      const request = selectionRequest.current + 1;
      selectionRequest.current = request;
      setSelectedWorkIndex(nextIndex);
      setStage('overview');
      setPlan(undefined);
      setReviewPlan(undefined);
      setClosePlan(undefined);
      setEvents([]);
      setReviewEvents([]);
      setWorkReceipt(undefined);
      setReviewReceipt(undefined);
      setCloseReceipt(undefined);
      setError('');
      setBusy('loading retained Work');
      void lab
        .resumeProjectWork(openedProjectWorkReference(project, nextWork))
        .then((resumed) => {
          if (selectionRequest.current !== request) return;
          setWorkReceipt(resumed.workReceipt);
          setReviewReceipt(resumed.reviewReceipt);
          setCloseReceipt(resumed.closeReceipt);
        })
        .catch((reason) => {
          if (selectionRequest.current !== request) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (selectionRequest.current === request) setBusy('');
        });
    },
    [lab, project, selectedWorkIndex, works],
  );
  const selectAdjacentWork = React.useCallback(
    (delta: number) => {
      const index = boundedIndex(selectedCard, delta, works.length);
      const work = works[index];
      if (work) selectWork(work);
    },
    [selectWork, selectedCard, works],
  );
  const loadAgents = React.useCallback(
    (nextStage: 'agents' | 'review-agents') => {
      const deterministicMock = deterministicMockSelectionForStage(
        process.env.KUNGFU_MOCK_AGENT_SCENARIO,
        nextStage,
      );
      if (deterministicMock) {
        setProfiles([deterministicMock]);
        setSelectedProfile(0);
        setProfileSources({
          [deterministicMock.id]: agentProfileSourceLabel('qualification'),
        });
        setError('');
        setBusy('');
        setStage(nextStage);
        return;
      }
      setBusy('discovering verified Agents');
      setError('');
      void lab
        .discoverAgents()
        .then((catalog) => {
          const available = new Map<string, SelectableAgentProfile>();
          const sources: Record<string, string> = {};
          for (const row of catalog.discovered) {
            if (row.available) {
              available.set(row.profile.id, row.profile);
              sources[row.profile.id] = agentProfileSourceLabel(
                'discovered',
                row.pathClass,
              );
            }
          }
          for (const profile of catalog.configured) {
            available.set(profile.id, profile);
            sources[profile.id] = agentProfileSourceLabel('configured');
          }
          const values = Array.from(available.values());
          if (values.length === 0) {
            throw new Error(
              'No supported Agent is available. Run `kungfu agent runtime discover`.',
            );
          }
          const preferred =
            catalog.defaultProfileId ?? catalog.recommendedProfileId ?? '';
          setProfiles(values);
          setSelectedProfile(
            Math.max(
              0,
              values.findIndex((profile) => profile.id === preferred),
            ),
          );
          setProfileSources(sources);
          setStage(nextStage);
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => setBusy(''));
    },
    [lab],
  );
  const openAgents = React.useCallback(
    () => loadAgents('agents'),
    [loadAgents],
  );
  const openReviewAgents = React.useCallback(
    () => loadAgents('review-agents'),
    [loadAgents],
  );
  const preview = React.useCallback(() => {
    const profile = profiles[selectedProfile];
    if (!profile) return;
    setBusy('verifying exact Work start plan');
    setError('');
    void ensureAgentSession(project.workspace.selected.runtime_dir)
      .then(() => lab.planStarterWork(workReference, profile.id))
      .then((value) => {
        setPlan(value);
        setStage('preview');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [
    ensureAgentSession,
    lab,
    profiles,
    project,
    selectedProfile,
    workReference,
  ]);
  const start = React.useCallback(() => {
    if (!plan) return;
    setEvents([]);
    setWorkReceipt(undefined);
    setError('');
    setBusy('starting governed Work');
    setStage('running');
    void ensureAgentSession(project.workspace.selected.runtime_dir)
      .then(() =>
        lab.startStarterWork(plan, (event) =>
          setEvents((current) => [...current, event]),
        ),
      )
      .then((receipt) => {
        setWorkReceipt(receipt);
        if (workReceiptHasRetainedSession(receipt) && onRetainedAgentSession) {
          onRetainedAgentSession(receipt);
        } else {
          setStage('result');
        }
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStage('result');
      })
      .finally(() => setBusy(''));
  }, [ensureAgentSession, lab, onRetainedAgentSession, plan, project]);
  const previewReview = React.useCallback(() => {
    const profile = profiles[selectedProfile];
    if (!profile || !workReceipt) return;
    setBusy('verifying independent review plan');
    setError('');
    void lab
      .planStarterReview(workReceipt, profile.id)
      .then((value) => {
        setReviewPlan(value);
        setStage('review-preview');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [lab, profiles, selectedProfile, workReceipt]);
  const runReview = React.useCallback(() => {
    if (!reviewPlan) return;
    setReviewEvents([]);
    setReviewReceipt(undefined);
    setError('');
    setBusy('running independent review');
    setStage('reviewing');
    void lab
      .runStarterReview(reviewPlan, (event) =>
        setReviewEvents((current) => [...current, event]),
      )
      .then((receipt) => {
        setReviewReceipt(receipt);
        setStage('review-result');
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStage('review-result');
      })
      .finally(() => setBusy(''));
  }, [lab, reviewPlan]);
  const previewClose = React.useCallback(() => {
    setBusy('verifying final Work close plan');
    setError('');
    void lab
      .planStarterClose(workReference)
      .then((value) => {
        setClosePlan(value);
        setStage('close-preview');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [lab, workReference]);
  const closeWork = React.useCallback(() => {
    if (!closePlan) return;
    setCloseReceipt(undefined);
    setError('');
    setBusy('retaining final Work decision and evidence');
    setStage('closing');
    void lab
      .closeStarterWork(closePlan)
      .then((receipt) => {
        setCloseReceipt(receipt);
        setStage('close-result');
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStage('close-result');
      })
      .finally(() => setBusy(''));
  }, [closePlan, lab]);
  React.useEffect(() => {
    if (activeRegion === 0) return;
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const input = String(chunk);
      if (decodeTerminalMouseInput(input).length > 0) return;
      const action = starterProjectInputAction(input, {
        stage,
        planExecutable: Boolean(plan?.executable),
        reviewPlanExecutable: Boolean(reviewPlan?.executable),
        reviewReceipt,
        closePlanExecutable: Boolean(closePlan?.executable),
        closeReceipt,
        workReceipt,
      });
      if (action.kind === 'none') return;
      if (action.kind === 'exit') return exit();
      if (action.kind === 'open-terminal') return setActiveRegion(0);
      if (action.kind === 'open-agents') return openAgents();
      if (action.kind === 'select-profile')
        return setSelectedProfile((current) =>
          boundedIndex(current, action.delta, profiles.length),
        );
      if (action.kind === 'preview-start') return preview();
      if (action.kind === 'start') return start();
      if (action.kind === 'open-review-agents') return openReviewAgents();
      if (action.kind === 'preview-review') return previewReview();
      if (action.kind === 'run-review') return runReview();
      if (action.kind === 'preview-close') return previewClose();
      if (action.kind === 'close-work') return closeWork();
      if (action.kind === 'create-next-work') return onCreateNextWork();
      if (action.kind === 'open-projects') return onOpenProjects();
      if (action.kind === 'open-lab') return onOpenLab();
      if (action.kind === 'select-work')
        return selectAdjacentWork(action.delta);
      if (action.kind === 'select-region')
        return setActiveRegion((current) =>
          boundedIndex(current, action.delta, 3),
        );
      if (action.kind === 'reset-review') {
        setReviewPlan(undefined);
        setReviewReceipt(undefined);
      }
      if (
        (action.kind === 'set-stage' && action.clearError) ||
        action.kind === 'reset-review'
      )
        setError('');
      setStage(action.stage);
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    activeRegion,
    exit,
    isInputCaptured,
    closePlan?.executable,
    closeReceipt,
    closeWork,
    onOpenLab,
    onOpenProjects,
    onCreateNextWork,
    openAgents,
    openReviewAgents,
    plan?.executable,
    preview,
    previewClose,
    previewReview,
    profiles.length,
    reviewPlan?.executable,
    reviewReceipt,
    runReview,
    selectAdjacentWork,
    stage,
    start,
    workReceipt,
  ]);

  const spinner = ['◐', '◓', '◑', '◒'][activityFrame];
  if (stage === 'detail') {
    return (
      <StarterWorkPanel
        dimensions={size}
        heading="Work details"
        subtitle="Captured in this Project · no Agent has run"
        footer="[Enter/s] choose Agent · [Esc/b] back · [q] quit"
      >
        <Text bold>{plan?.work.title ?? selectedWork.title}</Text>
        <Text>{selectedWork.objective}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Acceptance criteria</Text>
          {selectedWork.acceptanceChecks.map((check, index) => (
            <Text key={check}>
              {index + 1}. {check}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>What starting will do</Text>
          <Text>1. Admit this captured Work into native authority.</Text>
          <Text>2. Bind a selected, verified Agent to a two-hour lease.</Text>
          <Text>3. Start the Agent in this project with an exact WorkRef.</Text>
          <Text>4. Keep the result unsettled until independent review.</Text>
        </Box>
        {busy ? (
          <Text color="yellow">
            {spinner} {busy}
          </Text>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
      </StarterWorkPanel>
    );
  }
  if (stage === 'agents' || stage === 'review-agents') {
    const reviewing = stage === 'review-agents';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          reviewing ? 'Choose an independent reviewer' : 'Choose an Agent'
        }
        subtitle={
          reviewing
            ? 'A fresh process receives no prior transcript and reviews the project read-only'
            : 'Available Agents with their exact source'
        }
        footer="[j/k] select · [Enter] verify plan · [Esc/b] back · [q] quit"
      >
        {profiles.map((profile, index) => (
          <Box key={profile.id} flexDirection="column">
            <Box>
              <Text
                bold={index === selectedProfile}
                color={index === selectedProfile ? 'cyan' : undefined}
              >
                {index === selectedProfile ? '› ' : '  '}
                {profile.label}
              </Text>
              <Text dimColor>
                {' '}
                · {profile.provider} · {profile.cwdPolicy}
              </Text>
            </Box>
            <Text color={index === selectedProfile ? 'green' : undefined}>
              {'    '}
              {profileSources[profile.id] ?? 'Source unknown'}
              {reviewing ? ' · fresh read-only process' : ''}
            </Text>
          </Box>
        ))}
        {busy ? (
          <Text color="yellow">
            {spinner} {busy}
          </Text>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
      </StarterWorkPanel>
    );
  }
  if (stage === 'preview' && plan) {
    return (
      <StarterWorkPanel
        dimensions={size}
        heading="Confirm Work start"
        subtitle={`${plan.agent.label} · plan ${plan.planRoot.slice(0, 18)}…`}
        footer={
          plan.executable
            ? '[Enter] start Work · [Esc/b] choose another Agent · [q] quit'
            : '[Esc/b] choose another Agent · repair the failed verification first'
        }
      >
        <Text bold>Kungfu will perform these effects once:</Text>
        {plan.effects.map((effect, index) => (
          <Text key={effect.stage}>
            {index + 1}. {effect.label}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text color={plan.agent.verification.ok ? 'green' : 'red'}>
            Agent {plan.agent.verification.ok ? 'verified' : 'not verified'} ·{' '}
            {plan.agent.verification.version ?? plan.agent.verification.error}
          </Text>
          <Text color={plan.admissionBinding.ok ? 'green' : 'red'}>
            {plan.admissionBinding.override
              ? 'Development binding · source checkout override admitted'
              : plan.admissionBinding.ok
                ? `Native binding verified · ${plan.admissionBinding.state}`
                : 'Work start blocked · native runtime does not match this checkout'}
          </Text>
          <Text color="yellow">
            Completion, review, Git commit, push, and publication are not
            included.
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor={plan.executable ? 'green' : 'red'}
          paddingX={1}
          marginTop={1}
          flexDirection="column"
        >
          <Text bold color={plan.executable ? 'green' : 'red'}>
            {plan.executable
              ? `PRESS ENTER TO START ${plan.agent.label.toLocaleUpperCase()}`
              : 'START IS BLOCKED'}
          </Text>
          <Text>
            {plan.executable
              ? 'The Agent will begin working in this project. Live activity will appear on the next screen.'
              : 'Restart this development TUI so it can bind the current source checkout, then verify the plan again.'}
          </Text>
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'running') {
    const visibleRows = Math.max(4, size.rows - 9);
    const visible = events.slice(-visibleRows);
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={`${spinner} Agent Work is running`}
        subtitle={`${plan?.agent.label ?? 'Agent'} · ${events.length} admitted activity events`}
        footer="The Agent may take several minutes · input is paused until a canonical receipt arrives"
      >
        {visible.length === 0 ? (
          <Text color="yellow">Waiting for the first authority event…</Text>
        ) : null}
        {visible.map((event) => (
          <Text
            key={`${event.index}-${event.stage}-${event.status}`}
            color={
              event.status === 'failed'
                ? 'red'
                : event.status === 'completed'
                  ? 'green'
                  : event.activity?.kind === 'agent'
                    ? 'cyan'
                    : 'yellow'
            }
          >
            {starterWorkEventLine(event)}
          </Text>
        ))}
      </StarterWorkPanel>
    );
  }
  if (stage === 'result') {
    const successful = workReceipt?.status === 'agent-finished';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          successful ? 'Agent run retained' : 'Work start needs attention'
        }
        subtitle={
          workReceipt
            ? `${workReceipt.status} · Work phase ${workReceipt.workPhase}`
            : 'No canonical receipt was returned'
        }
        footer={
          successful
            ? '[Enter] review Work · [Esc/b] project overview · [q] quit'
            : '[Enter/Esc] return to project · [q] quit'
        }
      >
        <Box
          borderStyle="round"
          borderColor={successful ? 'green' : 'red'}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color={successful ? 'green' : 'red'}>
            {successful
              ? 'THE AGENT FINISHED. THE WORK IS NOT SELF-CERTIFIED.'
              : `FAILED AT ${workReceipt?.failedAt ?? 'agent run'}`}
          </Text>
          <Text>
            {successful
              ? project.receipt
                ? 'Review the retained Project evidence before accepting completion.'
                : 'Review the project changes and retained evidence before accepting completion.'
              : (workReceipt?.message ?? error)}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Next</Text>
          {(workReceipt?.nextActions ?? ['inspect the exact failure']).map(
            (action, index) => (
              <Text key={action}>
                {index + 1}. {action.replaceAll('-', ' ')}
              </Text>
            ),
          )}
          <Text color="yellow">
            No completion claim, independent review, commit, push, or
            publication was performed.
          </Text>
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'review') {
    const checks =
      workReceipt?.work?.acceptanceChecks ?? plan?.work.acceptanceChecks ?? [];
    const resuming = reviewReceiptCanResume(reviewReceipt);
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={resuming ? 'Resume Review Work' : 'Review Work'}
        subtitle={
          resuming
            ? 'Kungfu will reuse exact retained evidence and continue only unfinished authority effects'
            : 'Agent exit is evidence, not a completion decision'
        }
        footer={
          resuming
            ? '[Enter/r] verify retained reviewer · [a] revise with fresh Agent · [Esc/b] project overview · [q] quit'
            : '[Enter/r] choose a fresh reviewer · [a] revise with fresh Agent · [Esc/b] project overview · [q] quit'
        }
      >
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            {resuming
              ? 'REVIEW SETTLEMENT CAN RESUME'
              : 'THE DELIVERABLE IS READY FOR INDEPENDENT REVIEW'}
          </Text>
          <Text>
            {resuming
              ? 'If the exact passing reviewer report still matches this Work and these files, no Agent will be rerun.'
              : 'Kungfu will start a fresh Agent with no prior transcript and read-only project access.'}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Acceptance criteria</Text>
          {checks.map((check, index) => (
            <Text key={check}>
              {index + 1}. {check}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">
            A passing review records stage-ready, a proof-bound completion
            claim, and native independent review.
          </Text>
          <Text dimColor>
            A failed criterion leaves Work executing. Git, push, publication,
            and the final close-or-continue decision remain outside this step.
          </Text>
        </Box>
        {busy ? (
          <Text color="yellow">
            {spinner} {busy}
          </Text>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
      </StarterWorkPanel>
    );
  }
  if (stage === 'review-preview' && reviewPlan) {
    const retained = reviewPlan.reviewExecution.mode === 'retained-evidence';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          retained ? 'Confirm review settlement' : 'Confirm independent review'
        }
        subtitle={`${reviewPlan.reviewer.label} · plan ${reviewPlan.planRoot.slice(0, 18)}…`}
        footer={
          reviewPlan.executable
            ? retained
              ? '[Enter] resume settlement · [Esc/b] choose another reviewer · [q] quit'
              : '[Enter] run review · [Esc/b] choose another reviewer · [q] quit'
            : '[Esc/b] choose another reviewer · repair verification first'
        }
      >
        <Box flexDirection="column">
          <Text bold>Reviewer boundary</Text>
          <Text color="green">
            {retained
              ? 'Exact passing report retained · no new Agent process'
              : `Fresh process · ${reviewPlan.reviewer.priorTranscriptBytes} prior transcript bytes · ${reviewPlan.reviewer.permissionMode} project access`}
          </Text>
          {retained ? (
            <Text dimColor>
              Report · {reviewPlan.reviewExecution.reportRoot?.slice(0, 18)}… ·
              original review cut{' '}
              {reviewPlan.reviewExecution.reviewCut?.slice(0, 18)}…
            </Text>
          ) : null}
          <Text>
            Primary evidence · {reviewPlan.deliverable.path} ·{' '}
            {reviewPlan.deliverable.root.slice(0, 18)}…
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Kungfu will perform these effects in order:</Text>
          {reviewPlan.effects.map((effect, index) => (
            <Text key={effect.stage}>
              {index + 1}. {effect.label}
            </Text>
          ))}
        </Box>
        <Box
          borderStyle="round"
          borderColor={reviewPlan.executable ? 'green' : 'red'}
          paddingX={1}
          marginTop={1}
          flexDirection="column"
        >
          <Text bold color={reviewPlan.executable ? 'green' : 'red'}>
            {reviewPlan.executable
              ? retained
                ? 'PRESS ENTER TO RESUME THE REMAINING SETTLEMENT'
                : 'PRESS ENTER TO RUN THE INDEPENDENT REVIEW'
              : 'REVIEW IS BLOCKED'}
          </Text>
          <Text>
            {reviewPlan.executable
              ? retained
                ? 'Kungfu will not rerun the reviewer or repeat authority effects that already succeeded.'
                : 'Every criterion must pass before Kungfu records completion evidence.'
              : 'This reviewer cannot provide a verified read-only review process.'}
          </Text>
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'reviewing') {
    const visibleRows = Math.max(4, size.rows - 9);
    const visible = reviewEvents.slice(-visibleRows);
    const retained = reviewPlan?.reviewExecution.mode === 'retained-evidence';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={`${spinner} ${
          retained
            ? 'Review settlement is resuming'
            : 'Independent review is running'
        }`}
        subtitle={`${reviewPlan?.reviewer.label ?? 'Reviewer'} · ${reviewEvents.length} admitted activity events`}
        footer={
          retained
            ? 'Retained review evidence is being settled · input is paused until a canonical receipt arrives'
            : 'The reviewer is read-only · input is paused until a canonical receipt arrives'
        }
      >
        {visible.length === 0 ? (
          <Text color="yellow">Waiting for the first reviewer event…</Text>
        ) : null}
        {visible.map((event) => (
          <Text
            key={`${event.index}-${event.stage}-${event.status}`}
            color={
              event.status === 'failed'
                ? 'red'
                : event.status === 'completed'
                  ? 'green'
                  : event.activity?.kind === 'agent'
                    ? 'cyan'
                    : 'yellow'
            }
          >
            {starterWorkEventLine(event)}
          </Text>
        ))}
      </StarterWorkPanel>
    );
  }
  if (stage === 'review-result') {
    const passed = reviewReceipt?.status === 'review-passed';
    const resumable = reviewReceiptCanResume(reviewReceipt);
    const assessment = reviewReceipt?.assessment;
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          passed
            ? 'Independent review passed'
            : resumable
              ? 'Review settlement paused'
              : 'Review needs action'
        }
        subtitle={
          reviewReceipt
            ? `${reviewReceipt.status} · Work phase ${reviewReceipt.workPhase}`
            : 'No canonical review receipt was returned'
        }
        footer={
          resumable
            ? '[Enter] resume remaining settlement · [Esc/b] project overview · [q] quit'
            : passed
              ? '[Enter] complete Work · [Esc/b] project overview · [q] quit'
              : '[Enter/Esc] project overview · [q] quit'
        }
      >
        <Box
          borderStyle="round"
          borderColor={passed ? 'green' : 'red'}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color={passed ? 'green' : 'red'}>
            {passed
              ? 'ALL ACCEPTANCE CRITERIA PASSED'
              : resumable
                ? 'REVIEW EVIDENCE IS RETAINED'
                : 'WORK IS NOT COMPLETE'}
          </Text>
          <Text>{assessment?.summary ?? reviewReceipt?.message ?? error}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Acceptance report</Text>
          {(assessment?.criteria ?? []).map((row) => (
            <Box key={row.criterion} flexDirection="column">
              <Text color={row.passed ? 'green' : 'red'}>
                {row.passed ? '✓' : '×'} {row.criterion}
              </Text>
              {!row.passed ? <Text dimColor> {row.evidence}</Text> : null}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {passed ? (
            <>
              <Text color="green">
                Native independent review ·{' '}
                {reviewReceipt?.nativeVerdict ?? 'fit'}
              </Text>
              <Text color="yellow">
                Review is complete. Press Enter to make the final Work
                completion decision.
              </Text>
            </>
          ) : resumable ? (
            <>
              <Text color="yellow">
                Work remains {reviewReceipt?.workPhase ?? 'executing'}; press
                Enter to resume only the unfinished settlement.
              </Text>
              <Text dimColor>
                The exact reviewer report will be reused when its WorkRef,
                prompt, reviewer identity, and file roots still match.
              </Text>
            </>
          ) : (
            <>
              <Text color="yellow">
                Work remains {reviewReceipt?.workPhase ?? 'executing'}; no
                passing completion is claimed.
              </Text>
              <Text dimColor>
                Revise the deliverable, then run a fresh independent review
                again.
              </Text>
            </>
          )}
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'close-preview' && closePlan) {
    const retained = closePlan.decision.mode === 'retained';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          retained ? 'Resume Work completion' : 'Confirm Work completion'
        }
        subtitle={`Independent review · fit · plan ${closePlan.planRoot.slice(0, 18)}…`}
        footer={
          closePlan.executable
            ? '[Enter] complete Work · [Esc/b] review evidence · [q] quit'
            : '[Esc/b] review evidence · completion is blocked'
        }
      >
        <Box
          borderStyle="round"
          borderColor="green"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="green">
            INDEPENDENT REVIEW PASSED
          </Text>
          <Text>
            Every acceptance criterion passed against the retained project
            evidence.
          </Text>
          <Text dimColor>Review · {closePlan.review.root.slice(0, 22)}…</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            {retained
              ? 'Your close decision is already retained. Kungfu will finish:'
              : 'When you confirm, Kungfu will:'}
          </Text>
          {closePlan.effects.map((effect, index) => (
            <Text key={effect.stage}>
              {index + 1}. {effect.label}
            </Text>
          ))}
        </Box>
        <Box
          borderStyle="round"
          borderColor={closePlan.executable ? 'cyan' : 'red'}
          paddingX={1}
          marginTop={1}
          flexDirection="column"
        >
          <Text bold color={closePlan.executable ? 'cyan' : 'red'}>
            {closePlan.executable
              ? retained
                ? 'PRESS ENTER TO FINISH RETAINING THE EVIDENCE'
                : 'PRESS ENTER TO COMPLETE THIS WORK'
              : 'WORK COMPLETION IS BLOCKED'}
          </Text>
          <Text>
            {retained
              ? 'The human decision will not repeat; only the unfinished portable seal resumes.'
              : 'This is the final human decision. It does not commit, push, or publish project files.'}
          </Text>
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'closing') {
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={`${spinner} Completing Work`}
        subtitle="Retaining the human decision and portable evidence"
        footer="Input is paused until the canonical completion receipt arrives"
      >
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexDirection="column"
        >
          <Text color="cyan">
            {spinner} Binding your decision to the exact independent review
          </Text>
          <Text color="yellow">
            {spinner} Sealing a runtime-independent evidence snapshot
          </Text>
        </Box>
      </StarterWorkPanel>
    );
  }
  if (stage === 'close-result') {
    const completed = closeReceipt?.status === 'completed';
    const resumable =
      closeReceipt?.status === 'settlement-interrupted' &&
      closeReceipt.workPhase === 'continuation-decided';
    return (
      <StarterWorkPanel
        dimensions={size}
        heading={
          completed
            ? 'Work completed'
            : resumable
              ? 'Evidence seal paused'
              : 'Work completion needs attention'
        }
        subtitle={
          closeReceipt
            ? `${closeReceipt.status} · Work phase ${closeReceipt.workPhase}`
            : 'No canonical completion receipt was returned'
        }
        footer={
          resumable
            ? '[Enter] resume evidence seal · [Esc/b] project overview · [q] quit'
            : completed
              ? '[Enter/n] create next Work · [Esc/b] project overview · [q] quit'
              : '[Enter/Esc] project overview · [q] quit'
        }
      >
        <Box
          borderStyle="round"
          borderColor={completed ? 'green' : resumable ? 'yellow' : 'red'}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color={completed ? 'green' : resumable ? 'yellow' : 'red'}>
            {completed
              ? 'COMPLETED · EVIDENCE RETAINED'
              : resumable
                ? 'CLOSE DECISION RETAINED · SEAL CAN RESUME'
                : 'WORK WAS NOT CLOSED'}
          </Text>
          <Text>{closeReceipt?.message ?? error}</Text>
        </Box>
        {completed && closeReceipt?.sealedState ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Portable Work evidence</Text>
            <Text color="green">
              ✓ State root · {closeReceipt.sealedState.stateRoot}
            </Text>
            <Text> {closeReceipt.sealedState.statePath}</Text>
            <Text dimColor>
              Runtime-independent verification is available. Git commit, push,
              and publication remain separate choices.
            </Text>
          </Box>
        ) : null}
        {completed ? (
          <Box
            borderStyle="double"
            borderColor="cyan"
            paddingX={1}
            marginTop={1}
            flexDirection="column"
          >
            <Text bold color="cyan">
              CREATE YOUR NEXT WORK
            </Text>
            <Text>
              Describe a real outcome, define how you will judge it, then choose
              an Agent for the same governed Work loop.
            </Text>
            <Text bold>[Enter/n] Create next Work</Text>
          </Box>
        ) : null}
      </StarterWorkPanel>
    );
  }

  return (
    <Box
      width={size.columns}
      height={terminalCanvasRows(size.rows)}
      position="relative"
      overflow="hidden"
    >
      <ProfileShell
        model={model}
        dimensions={size}
        selectedCard={selectedCard}
        activeRegion={activeRegion}
        busy={Boolean(busy)}
        navigationWidth={projectNavigationWidth(size)}
        navigationPanel={
          <ProjectFileTreeNavigation
            root={project.workspace.selected.workspace_root}
            dimensions={dimensions}
            workCount={works.length}
            focused={activeRegion === 0}
            isInputCaptured={isInputCaptured}
            onFocus={() => setActiveRegion(0)}
            onOpenWork={() => setActiveRegion(1)}
            onOpenProjects={onOpenProjects}
            onOpenLab={onOpenLab}
            onWorkspacePointer={onWorkspacePointer}
            onCopyNotice={setCopyNotice}
            topOffset={3}
          />
        }
      />
      {copyNotice ? (
        <ProjectPathCopyOverlay notice={copyNotice} dimensions={size} />
      ) : null}
    </Box>
  );
}

export const PROJECT_TOUR_STORY_STEPS = [
  'Create a disposable Project from the shipped Starter template',
  'Open the Project and inspect its real file tree',
  'Start the launch brief; retain an intentional transport disconnect (exit 75)',
  'Resume the same launch brief; retain an intentional Agent crash (exit 23)',
  'Resume again and complete deliverables/launch-brief.md',
  'Run a fresh read-only Mock Reviewer and settle through native Work authority',
  'Capture the next business outcome beside the completed Work history',
] as const;

export const PROJECT_TOUR_GUIDE_SCENES = [
  {
    id: 'starter-project',
    kicker: 'KEEP THE WORK WHEN THE CHAT ENDS · STARTER PROJECT',
    title: 'Watch one real Work lifecycle; only the Agent is mocked',
    detail:
      'Session-first tools bind work to chat. Kungfu keeps Work outside it, so Agents are replaceable. The temporary Project is deleted.',
  },
  {
    id: 'connection-loss',
    kicker: 'COMMON FAILURE · WE INTENTIONALLY DROP THE CONNECTION',
    title: 'The Mock Agent starts the launch brief, then loses transport',
    detail:
      'It reads Project sources, separates confirmed facts from open questions, then the tour ends the connection with exit 75.',
  },
  {
    id: 'connection-retained',
    kicker: 'THE WORK SURVIVES THE CONNECTION',
    title:
      'The session is gone. The Work is not. Kungfu does not silently retry.',
    detail:
      'Work retains objective, checks, Attempt history, and next action—not chat reconstruction. A user or automation starts the next Agent.',
  },
  {
    id: 'agent-crash',
    kicker: 'COMMON FAILURE · WE INTENTIONALLY CRASH THE PROCESS',
    title: 'A new process resumes the same Work, then stops unexpectedly',
    detail:
      'It recovers the objective without prior chat and starts the brief. The tour then stops the process with exit 23.',
  },
  {
    id: 'same-work',
    kicker: 'EPISODE 1 COMPLETE · TWO FAILURES · ONE WORK',
    title: 'The Agent stopped twice. The launch-brief Work is still here.',
    detail:
      'Both Attempts remain under the same launch-brief Work. Objective, checks, and next action stay intact for Episode 2.',
  },
  {
    id: 'recovery',
    kicker: 'EPISODE 2 · RECOVER, REVIEW, AND SETTLE',
    title: 'Start from retained Work—not a reconstructed chat',
    detail:
      'Two failed Attempts remain under one Work. A third Mock Agent gets the original objective, checks, and evidence—not either transcript.',
  },
  {
    id: 'independent-review',
    kicker: 'AGENT EXIT IS NOT COMPLETION · INDEPENDENT REVIEW',
    title: 'A fresh, read-only Mock Reviewer checks the launch brief',
    detail:
      'The file is evidence. The Agent cannot approve it; a fresh read-only Reviewer gets no transcript and checks every criterion.',
  },
  {
    id: 'native-settlement',
    kicker: 'KUNGFU SETTLES REVIEWED WORK',
    title: 'A passing review still does not complete the Work by itself',
    detail:
      'Kungfu binds review to this Work and file in a settlement receipt. It proves declared checks—not universal business truth.',
  },
  {
    id: 'next-work',
    kicker: 'EPISODE 2 COMPLETE · REVIEWED, SETTLED, NEXT WORK READY',
    title: 'Use /new for the next outcome, then Run Agent',
    detail:
      'Sessions were replaceable Attempts. /new adds the next outcome beside settled history; it never reopens completed Work.',
  },
] as const;

export const PROJECT_TOUR_EPISODE_TWO_STANDALONE_SCENE = {
  id: 'standalone-recovery',
  kicker: 'EPISODE 2 · RECOVER, REVIEW, AND SETTLE',
  title: 'Episode 1 proved survival. Now isolate the next authority boundary.',
  detail:
    'This chapter starts real Starter Work with a fresh Mock Agent, then keeps Agent exit, independent review, and settlement distinct.',
} as const;

export const PROJECT_TOUR_PACING = {
  guideDwellMs: 8000,
  guideGapMs: 400,
  activityEventMs: 900,
  protocolEventMs: 600,
  summaryDwellMs: 1800,
  finalDwellMs: 3200,
} as const;

export const PROJECT_TOUR_EPISODE_TWO_EVENT_SCALE = 0.5;
export const PROJECT_TOUR_EPISODE_TWO_GUIDE_SCALE = 0.875;
export const PROJECT_TOUR_EPISODE_TWO_FINAL_GUIDE_SCALE = 0.8;

export const PROJECT_TOUR_SPEED_RANGE = {
  min: 0.25,
  max: 4,
} as const;

export const PROJECT_TOUR_EPISODES = ['1', '2', 'all'] as const;
export type ProjectTourEpisode = (typeof PROJECT_TOUR_EPISODES)[number];

export const PROJECT_TOUR_EPISODE_SCENE_IDS = {
  '1': PROJECT_TOUR_GUIDE_SCENES.slice(0, 5).map((scene) => scene.id),
  '2': PROJECT_TOUR_GUIDE_SCENES.slice(5).map((scene) => scene.id),
} as const;

export function parseProjectTourEpisode(value?: string): ProjectTourEpisode {
  const episode = value ?? '1';
  if (!PROJECT_TOUR_EPISODES.includes(episode as ProjectTourEpisode)) {
    throw new Error('--project-tour-episode must be 1, 2, or all');
  }
  return episode as ProjectTourEpisode;
}

export type ProjectTourLaunchOptions = {
  root?: string;
  speed: number;
  episode: ProjectTourEpisode;
};

function projectTourOptionValue(
  argv: readonly string[],
  option: string,
  missingMessage: string,
): string | undefined {
  const index = argv.indexOf(option);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error(missingMessage);
  return value;
}

export function parseProjectTourLaunchOptions(
  argv: readonly string[],
): ProjectTourLaunchOptions {
  return {
    root: projectTourOptionValue(
      argv,
      '--project-work-tour-root',
      '--project-work-tour-root requires a destination',
    ),
    speed: parseProjectTourSpeed(
      projectTourOptionValue(
        argv,
        '--project-tour-speed',
        '--project-tour-speed requires a multiplier',
      ),
    ),
    episode: parseProjectTourEpisode(
      projectTourOptionValue(
        argv,
        '--project-tour-episode',
        '--project-tour-episode requires 1, 2, or all',
      ),
    ),
  };
}

export function parseProjectTourSpeed(value?: string): number {
  if (value === undefined) return 1;
  const speed = Number(value);
  if (
    !Number.isFinite(speed) ||
    speed < PROJECT_TOUR_SPEED_RANGE.min ||
    speed > PROJECT_TOUR_SPEED_RANGE.max
  ) {
    throw new Error(
      `--project-tour-speed must be between ${PROJECT_TOUR_SPEED_RANGE.min} and ${PROJECT_TOUR_SPEED_RANGE.max}`,
    );
  }
  return speed;
}

export function playbackQuitRequested(chunk: Buffer | string): boolean {
  return /^[qQ]$/u.test(String(chunk));
}

export function projectTourTemporaryContainer(
  destination: string,
  systemTemporaryRoot = tmpdir(),
): string | null {
  const temporaryRoot = path.resolve(systemTemporaryRoot);
  const projectRoot = path.resolve(destination);
  const container = path.dirname(projectRoot);
  if (temporaryRoot === path.parse(temporaryRoot).root) return null;
  if (path.basename(projectRoot) !== 'my-first-kungfu-project') return null;
  if (!/^kungfu-project-tour-[a-z0-9_-]+$/iu.test(path.basename(container)))
    return null;
  if (path.dirname(container) !== temporaryRoot) return null;
  return container;
}

export function cleanupProjectTourTemporaryProject(
  destination: string,
  options: {
    systemTemporaryRoot?: string;
    remove?: (container: string) => void;
  } = {},
): string {
  const container = projectTourTemporaryContainer(
    destination,
    options.systemTemporaryRoot,
  );
  if (!container) {
    throw new Error(
      `refusing to remove unrecognized Project tour path: ${destination}`,
    );
  }
  const remove =
    options.remove ??
    ((target: string) => rmSync(target, { recursive: true, force: true }));
  remove(container);
  return container;
}

export function projectTourPacingForSpeed(speed: number) {
  parseProjectTourSpeed(String(speed));
  return {
    guideDwellMs: Math.round(PROJECT_TOUR_PACING.guideDwellMs / speed),
    guideGapMs: Math.round(PROJECT_TOUR_PACING.guideGapMs / speed),
    activityEventMs: Math.round(PROJECT_TOUR_PACING.activityEventMs / speed),
    protocolEventMs: Math.round(PROJECT_TOUR_PACING.protocolEventMs / speed),
    summaryDwellMs: Math.round(PROJECT_TOUR_PACING.summaryDwellMs / speed),
    finalDwellMs: Math.round(PROJECT_TOUR_PACING.finalDwellMs / speed),
  };
}

export function projectTourEpisodeNarrationBudget(
  episode: Exclude<ProjectTourEpisode, 'all'>,
): number {
  const guideDwellMs =
    episode === '1'
      ? PROJECT_TOUR_EPISODE_SCENE_IDS['1'].length *
        PROJECT_TOUR_PACING.guideDwellMs
      : PROJECT_TOUR_PACING.guideDwellMs +
        2 *
          Math.round(
            PROJECT_TOUR_PACING.guideDwellMs *
              PROJECT_TOUR_EPISODE_TWO_GUIDE_SCALE,
          ) +
        Math.round(
          PROJECT_TOUR_PACING.guideDwellMs *
            PROJECT_TOUR_EPISODE_TWO_FINAL_GUIDE_SCALE,
        );
  const guideCount = PROJECT_TOUR_EPISODE_SCENE_IDS[episode].length;
  return guideDwellMs + guideCount * PROJECT_TOUR_PACING.guideGapMs;
}

export const PROJECT_TOUR_STREAM_TRANSITIONS = {
  A1: 'NEW MOCK AGENT PROCESS · CREATE THE LAUNCH BRIEF',
  A2: 'NEW PROCESS · A1 KEPT ABOVE · SAME LAUNCH-BRIEF WORK',
  REC: 'RECOVERY PROCESS · A1 + A2 KEPT ABOVE · COMPLETE THE SAME BRIEF',
  REV: 'FRESH MOCK REVIEWER · PRIOR ATTEMPTS KEPT ABOVE · READ-ONLY',
  SET: 'KUNGFU SETTLEMENT · PASSING REVIEW KEPT ABOVE · SAME WORK',
} as const;

export type ProjectTourGuideScene = {
  readonly id: string;
  readonly kicker: string;
  readonly title: string;
  readonly detail: string;
};

export type ProjectTourResult =
  | {
      state: 'completed';
      report: {
        schema: 'kungfu.project-work.tui-tour/v1';
        status: 'qualified';
        episode: ProjectTourEpisode;
        reportRoot: string;
        eventCount: number;
        projectPath: string;
        workCount: number;
      };
    }
  | { state: 'failed'; message: string };

type TourEvent = {
  title: string;
  detail: string;
  tone: 'good' | 'bad' | 'info';
};

export type ProjectTourStreamLine = {
  id: number;
  section: string;
  sectionTag: string;
  index: number | null;
  source: 'agent' | 'tool' | 'kungfu' | 'receipt';
  status: string;
  text: string;
};

export function updateProjectTourStream(
  current: readonly ProjectTourStreamLine[],
  line: ProjectTourStreamLine,
  mode: 'append' | 'begin' | 'replace',
): ProjectTourStreamLine[] {
  if (mode === 'begin') return [line];
  if (mode === 'replace')
    return current.map((currentLine) =>
      currentLine.id === line.id ? line : currentLine,
    );
  return [...current, line].slice(-120);
}

export function projectTourProtocolLine(
  event: ProjectWorkRunEvent | WorkReviewEvent,
  section: string,
  sectionTag: string,
  id: number,
): ProjectTourStreamLine {
  return {
    id,
    section,
    sectionTag,
    index: event.index,
    source: event.activity?.kind ?? 'kungfu',
    status: event.status,
    text: event.activity?.text || event.text,
  };
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

export function projectTourAudienceLine(
  event: ProjectWorkRunEvent | WorkReviewEvent,
  section: string,
  sectionTag: string,
  id: number,
): ProjectTourStreamLine | null {
  const line = projectTourProtocolLine(event, section, sectionTag, id);
  if (!event.activity) {
    if (
      ![
        'admit',
        'assess',
        'claim',
        'kickoff',
        'lease',
        'plan',
        'review',
        'run',
        'stage',
      ].includes(event.stage) &&
      !/Agent process (?:exited|finished)|Every acceptance criterion passed/u.test(
        line.text,
      )
    )
      return null;
    return { ...line, text: sentenceCase(line.text.trim()) };
  }

  let text = line.text.trim();
  const source = /^tool · /u.test(text) ? 'tool' : line.source;
  if (
    !text ||
    text === 'mock›' ||
    /^Kungfu Mock Agent\b/u.test(text) ||
    /^KUNGFU_REVIEW_RESULT\b/u.test(text)
  )
    return null;

  text = text
    .replace(/^(?:agent|tool|output) · /u, '')
    .replace(/^MOCK WORKING: /u, '')
    .replace(/^MOCK DISCONNECTED: the transport closed /u, 'Connection lost · ')
    .replace(/^MOCK CRASH: the process stopped /u, 'Process crashed · stopped ')
    .replace(/^MOCK FILE WRITTEN: /u, 'Wrote ')
    .replace(/^MOCK READY FOR REVIEW: /u, 'Review ready · ');
  return { ...line, source, text: sentenceCase(text) };
}

export function projectTourArtifactPreview(content: string): string[] {
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  const title = lines.find((line) => /^# /u.test(line))?.replace(/^# /u, '');
  const sectionLine = (heading: string) => {
    const index = lines.indexOf(`## ${heading}`);
    if (index < 0) return null;
    return (
      lines.slice(index + 1).find((line) => line && !/^#/u.test(line)) ?? null
    );
  };
  const openQuestionIndex = lines.indexOf('## Open questions');
  const openQuestions =
    openQuestionIndex < 0
      ? []
      : lines
          .slice(openQuestionIndex + 1)
          .filter((line) => /^- /u.test(line))
          .slice(0, 3)
          .map((line) => line.replace(/^- /u, ''));
  return [
    title ? `FILE · ${title}` : null,
    sectionLine('Who it is for'),
    sectionLine('Why it matters'),
    openQuestions.length > 0 ? `OPEN · ${openQuestions.join(' · ')}` : null,
  ].filter((line): line is string => Boolean(line));
}

export function projectTourReceiptText(receipt: WorkCloseReceipt): string {
  return `Settlement receipt recorded · Work completed · ${receipt.receiptRoot}`;
}

export function projectTourSummaryMode(columns: number): 'compact' | 'wide' {
  return columns < 100 ? 'compact' : 'wide';
}

export function projectTourSummaryTitles(
  mode: 'compact' | 'wide',
  showingReviewEvidence: boolean,
): readonly string[] {
  if (mode === 'compact') {
    return [
      'FILES',
      showingReviewEvidence
        ? 'LAUNCH BRIEF · REVIEW EVIDENCE'
        : 'PROJECT WORK · RETAINED HISTORY',
    ];
  }
  return [
    'FILES',
    'PROJECT WORK',
    showingReviewEvidence
      ? 'LAUNCH BRIEF · REVIEW EVIDENCE'
      : 'RETAINED WORK HISTORY',
  ];
}

export function projectTourActivityWidth(
  availableWidth: number,
  heading: string,
): number {
  const width = availableWidth - heading.length - 1;
  return width >= 9 ? width : 0;
}

export function projectTourActivityCells(
  frame: number,
  width: number,
): TerminalAnimationCell[] {
  return (
    KUNGFU_WORK_DISCOVERY_PATTERN.render(frame, {
      width: Math.max(1, width),
      height: 1,
    })[0] ?? []
  );
}

function ProjectTourActivityNebula({ width }: { width: number }) {
  const enabled = terminalAnimationsEnabled(process.env);
  const frame = useTerminalAnimationFrame({
    active: width > 0,
    enabled,
    pattern: KUNGFU_WORK_DISCOVERY_PATTERN,
  });
  const cells = projectTourActivityCells(frame, width);
  return (
    <Text>
      {cells.map((cell, column) => (
        <Text
          key={`${KUNGFU_WORK_DISCOVERY_PATTERN.id}-activity-${column}`}
          color={cell.color}
        >
          {cell.glyph}
        </Text>
      ))}
    </Text>
  );
}

export function projectTourLayout(rows: number): {
  canvasRows: number;
  summaryRows: number;
  streamRows: number;
  visibleStreamRows: number;
} {
  const canvasRows = Math.max(12, terminalCanvasRows(rows) - 3);
  const availableRows = Math.max(9, canvasRows - 3);
  const summaryRows = Math.max(
    5,
    Math.min(12, Math.floor(availableRows * 0.44)),
  );
  const streamRows = Math.max(4, availableRows - summaryRows);
  return {
    canvasRows,
    summaryRows,
    streamRows,
    visibleStreamRows: Math.max(2, streamRows - 3),
  };
}

function terminalCharacterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  )
    return 2;
  return 1;
}

function projectTourWrapLine(value: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = Array.from(value.trim());
  while (remaining.length > 0) {
    let cells = 0;
    let take = 0;
    let lastWhitespace = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const character = remaining[index] ?? '';
      const characterWidth = terminalCharacterWidth(character);
      if (cells + characterWidth > width) break;
      cells += characterWidth;
      take = index + 1;
      if (/\s/u.test(character)) lastWhitespace = index;
    }

    if (take < remaining.length && lastWhitespace > 0) take = lastWhitespace;
    if (take === 0) take = 1;

    const lineCharacters = remaining.slice(0, take);
    const line = lineCharacters.join('').trimEnd();
    const lineCells = lineCharacters.reduce(
      (total, character) => total + terminalCharacterWidth(character),
      0,
    );
    lines.push(line.padEnd(line.length + width - lineCells));
    remaining = remaining.slice(take);
    while (remaining[0] && /\s/u.test(remaining[0]))
      remaining = remaining.slice(1);
  }
  return lines.length > 0 ? lines : [' '.repeat(width)];
}

export function projectTourGuidePanelLines(
  scene: ProjectTourGuideScene,
  width: number,
): string[] {
  const fit = (value: string) => projectTourWrapLine(value, width)[0];
  const detail = projectTourWrapLine(scene.detail, width).slice(0, 2);
  return [
    fit(`TOUR GUIDE · ${scene.kicker}`),
    fit(scene.title),
    detail[0] ?? ' '.repeat(width),
    detail[1] ?? ' '.repeat(width),
    ' '.repeat(width),
    fit('LIVE EVENT STREAM PAUSED · THE TOUR WILL RESUME AUTOMATICALLY'),
  ];
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function shortWorkState(work: ProjectWork): string {
  if (work.settled) return 'settled';
  if (work.phase === 'executing') return 'recovery needed';
  return work.phase ?? 'captured';
}

function treeLabel(entry: ProjectFileTreeEntry): string {
  const indent = '  '.repeat(entry.depth);
  if (entry.kind === 'directory') return `${indent}▸ ${entry.name}/`;
  return `${indent}· ${entry.name}`;
}

function resultRoot(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function projectTourWindowRows(
  rows: readonly React.ReactNode[],
  count: number,
): React.ReactNode[] {
  const visible = rows.slice(0, count);
  return [
    ...visible,
    ...Array.from({ length: Math.max(0, count - visible.length) }, (_, index) =>
      ' '.repeat(index + 1),
    ),
  ];
}

export function ProjectTourHeader({
  columns,
  episode,
  step,
  projectName,
  playbackSpeed,
}: {
  columns: number;
  episode: Exclude<ProjectTourEpisode, 'all'>;
  step: number;
  projectName: string;
  playbackSpeed: number;
}) {
  const totalSteps = episode === '1' ? 4 : 3;
  return (
    <Box
      width={columns}
      height={3}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text bold color="cyan" wrap="truncate-end">
          Kungfu Project → Work → Agent · EPISODE {episode}/2 · STEP{' '}
          {Math.min(step + 1, totalSteps)}/{totalSteps} · {projectName}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text bold color="yellow">
          SPEED {playbackSpeed}×
        </Text>
      </Box>
    </Box>
  );
}

export function ProjectTourView({
  lab,
  projects,
  destination,
  columns,
  rows,
  playbackSpeed = 1,
  episode = '1',
  onSettled,
}: {
  lab: AgentWorkLab;
  projects: Projects;
  destination: string;
  columns: number;
  rows: number;
  playbackSpeed?: number;
  episode?: ProjectTourEpisode;
  onSettled: (result: ProjectTourResult) => void;
}) {
  const pacing = React.useMemo(
    () => projectTourPacingForSpeed(playbackSpeed),
    [playbackSpeed],
  );
  const [step, setStep] = React.useState(0);
  const [displayEpisode, setDisplayEpisode] = React.useState<
    Exclude<ProjectTourEpisode, 'all'>
  >(episode === '2' ? '2' : '1');
  const [events, setEvents] = React.useState<TourEvent[]>([]);
  const [files, setFiles] = React.useState<ProjectFileTreeEntry[]>([]);
  const [works, setWorks] = React.useState<ProjectWork[]>([]);
  const [guide, setGuide] = React.useState<ProjectTourGuideScene | null>(null);
  const [artifactPreview, setArtifactPreview] = React.useState<string[]>([]);
  const [streamHeading, setStreamHeading] = React.useState(
    'WAITING FOR MOCK AGENT',
  );
  const [streamLines, setStreamLines] = React.useState<ProjectTourStreamLine[]>(
    [],
  );
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true;
    const record = (event: TourEvent) => {
      if (!active) return;
      setEvents((current) => [...current, event].slice(-8));
    };
    const refreshFiles = () => {
      if (!active) return;
      setFiles(
        projects.files(destination, {
          expandedPaths: new Set(['deliverables', 'inputs']),
          maxDepth: 3,
          maxEntries: 18,
        }),
      );
    };
    let streamSequence = 0;
    const beginStream = (section: string, sectionTag: string, text: string) => {
      if (!active) return;
      streamSequence += 1;
      setStreamHeading(`${section} · RUNNING`);
      const line: ProjectTourStreamLine = {
        id: streamSequence,
        section,
        sectionTag,
        index: null,
        source: 'kungfu',
        status: 'running',
        text,
      };
      setStreamLines((current) =>
        updateProjectTourStream(current, line, 'begin'),
      );
    };
    const appendStream = (
      section: string,
      sectionTag: string,
      source: ProjectTourStreamLine['source'],
      status: string,
      text: string,
    ) => {
      if (!active) return;
      streamSequence += 1;
      setStreamHeading(section);
      const line: ProjectTourStreamLine = {
        id: streamSequence,
        section,
        sectionTag,
        index: null,
        source,
        status,
        text,
      };
      setStreamLines((current) =>
        updateProjectTourStream(current, line, 'append'),
      );
    };
    const completeTour = (
      completedEpisode: ProjectTourEpisode,
      evidence: Record<string, unknown>,
      eventCount: number,
      workCount: number,
    ) => {
      const report = {
        schema: 'kungfu.project-work.tui-tour/v1' as const,
        status: 'qualified' as const,
        episode: completedEpisode,
        reportRoot: resultRoot({ episode: completedEpisode, ...evidence }),
        eventCount,
        projectPath: destination,
        workCount,
      };
      if (active) onSettled({ state: 'completed', report });
    };

    const sceneById = (sceneId: string): ProjectTourGuideScene | undefined =>
      sceneId === PROJECT_TOUR_EPISODE_TWO_STANDALONE_SCENE.id
        ? PROJECT_TOUR_EPISODE_TWO_STANDALONE_SCENE
        : PROJECT_TOUR_GUIDE_SCENES.find((scene) => scene.id === sceneId);
    const handleControllerEvent = (event: ProjectTourEpisodeEvent) => {
      if (!active) return;
      setDisplayEpisode(event.episode);
      if (event.kind === 'guide') {
        const scene = event.sceneId ? sceneById(event.sceneId) : undefined;
        if (event.status === 'visible' && scene) setGuide(scene);
        if (event.status === 'dismissed') setGuide(null);
        return;
      }
      if (event.kind === 'project' && event.project) {
        setWorks([event.project.initialWork]);
        refreshFiles();
        record({
          title:
            event.project.status === 'resumed'
              ? 'Starter Project resumed'
              : 'Starter Project created',
          detail:
            'The Mock Agent is synthetic; the Project and complete Work lifecycle use the real Kungfu path.',
          tone: 'good',
        });
        return;
      }
      if (event.kind === 'artifact' && event.relativePath) {
        refreshFiles();
        setArtifactPreview(
          projectTourArtifactPreview(
            readFileSync(path.join(destination, event.relativePath), 'utf8'),
          ),
        );
        record({
          title: 'Fresh attempt produced evidence',
          detail:
            'Mock Agent completed deliverables/launch-brief.md; process exit still did not settle the Work.',
          tone: 'good',
        });
        return;
      }
      if (event.kind === 'inventory' && event.inventory) {
        setWorks(event.inventory.works);
        record({
          title: 'All Work inventory reconciled',
          detail: `${event.inventory.works.length} Works are visible from one final authoritative query.`,
          tone: 'info',
        });
      }
      if (event.kind === 'operation' && event.status === 'running') {
        beginStream(event.section, event.sectionTag, event.text);
        if (event.sectionTag === 'A1') setStep(1);
        if (event.sectionTag === 'A2') setStep(2);
        if (event.sectionTag === 'WORK' && event.episode === '1') setStep(3);
        if (event.sectionTag === 'REV') setStep(1);
        if (event.sectionTag === 'SET') setStep(2);
        return;
      }
      if (event.kind === 'native' && event.nativeEvent) {
        streamSequence += 1;
        const line = projectTourAudienceLine(
          event.nativeEvent,
          event.section,
          event.sectionTag,
          streamSequence,
        );
        if (line) {
          setStreamHeading(event.section);
          setStreamLines((current) =>
            updateProjectTourStream(current, line, 'append'),
          );
        }
        return;
      }
      if (event.kind === 'receipt') {
        appendStream(
          event.section,
          event.sectionTag,
          'receipt',
          event.status,
          event.receipt?.schema === 'kungfu.work-close.receipt/v1'
            ? projectTourReceiptText(event.receipt)
            : event.text,
        );
        if (event.sectionTag === 'A1') {
          record({
            title: 'Connection lost · exit 75',
            detail:
              'Kungfu retained the same Work, failed Attempt, and next action without a silent retry.',
            tone: 'bad',
          });
        }
        if (event.sectionTag === 'A2') {
          record({
            title: 'Agent process crashed · exit 23',
            detail:
              'The resumed process stopped; the original launch-brief Work remained intact.',
            tone: 'bad',
          });
        }
        if (event.sectionTag === 'SET') {
          setArtifactPreview([]);
          record({
            title: 'Independent review and native settlement',
            detail:
              'A fresh read-only Reviewer passed the checks; Kungfu retained the settlement receipt.',
            tone: 'good',
          });
        }
        return;
      }
      appendStream(
        event.section,
        event.sectionTag,
        'kungfu',
        event.status,
        event.text,
      );
    };
    const runController = async (
      chapter: '1' | '2',
      resume: boolean,
    ): Promise<ProjectTourEpisodeReport> => {
      const report = await lab.runProjectTourEpisode(
        {
          destination,
          episode: chapter,
          resume,
          guideDwellMs: pacing.guideDwellMs,
          guideGapMs: pacing.guideGapMs,
          episodeTwoGuideDwellMs: Math.round(
            pacing.guideDwellMs * PROJECT_TOUR_EPISODE_TWO_GUIDE_SCALE,
          ),
          episodeTwoFinalGuideDwellMs: Math.round(
            pacing.guideDwellMs * PROJECT_TOUR_EPISODE_TWO_FINAL_GUIDE_SCALE,
          ),
        },
        handleControllerEvent,
      );
      if (
        report.controller.processCount !== 1 ||
        report.controller.inventoryQueryCount !== 1
      ) {
        throw new Error(
          'Project Tour controller did not preserve the one-process, one-inventory-query contract',
        );
      }
      return report;
    };

    void (async () => {
      try {
        const first =
          episode === '2' ? undefined : await runController('1', false);
        if (episode === '1' && first) {
          completeTour(
            '1',
            {
              controllerReportRoot: first.reportRoot,
              requestRoot: first.project.initialWork.requestRoot,
              failedAttempts: first.attemptReceipts.map(
                (receipt) => receipt.agentReport?.reportRoot,
              ),
              inventoryRoot: first.finalInventory.inventoryRoot,
            },
            4,
            first.finalInventory.works.length,
          );
          return;
        }
        setDisplayEpisode('2');
        setStep(0);
        const second = await runController('2', episode === 'all');
        completeTour(
          episode,
          {
            firstControllerReportRoot: first?.reportRoot,
            secondControllerReportRoot: second.reportRoot,
            requestRoot: second.project.initialWork.requestRoot,
            failedAttempts:
              first?.attemptReceipts.map(
                (receipt) => receipt.agentReport?.reportRoot,
              ) ?? [],
            completedAttempt:
              second.attemptReceipts[0]?.agentReport?.reportRoot,
            reviewRoot: second.reviewReceipt?.receiptRoot,
            closeRoot: second.closeReceipt?.receiptRoot,
            inventoryRoot: second.finalInventory.inventoryRoot,
          },
          episode === 'all' ? 7 : 3,
          second.finalInventory.works.length,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({ title: 'Tour stopped', detail: message, tone: 'bad' });
        await wait(500);
        if (active) onSettled({ state: 'failed', message });
      }
    })();
    return () => {
      active = false;
    };
  }, [destination, episode, lab, onSettled, pacing, projects]);

  const layout = projectTourLayout(rows);
  const summaryMode = projectTourSummaryMode(columns);
  const summaryTitles = projectTourSummaryTitles(
    summaryMode,
    artifactPreview.length > 0,
  );
  const fileWidth =
    summaryMode === 'compact'
      ? Math.min(30, Math.max(24, Math.floor(columns * 0.34)))
      : Math.min(38, Math.max(24, Math.floor(columns * 0.26)));
  const workWidth = Math.min(48, Math.max(32, Math.floor(columns * 0.3)));
  const summaryContentRows = Math.max(1, layout.summaryRows - 2);
  const compactWorkRows = Math.min(2, works.length);
  const compactHistoryRows = Math.max(1, summaryContentRows - compactWorkRows);
  const fileRows = projectTourWindowRows(
    files.length === 0
      ? [
          <Text key="files-loading" dimColor>
            Creating Starter files…
          </Text>,
        ]
      : files.map((entry) => (
          <Text
            key={entry.relativePath}
            wrap="truncate-end"
            color={
              entry.relativePath === 'deliverables/launch-brief.md'
                ? 'green'
                : undefined
            }
          >
            {treeLabel(entry)}
          </Text>
        )),
    summaryContentRows,
  );
  const artifactRows = artifactPreview.map((line) => (
    <Text key={line} wrap="truncate-end">
      {line}
    </Text>
  ));
  const compactRows =
    artifactPreview.length > 0
      ? artifactRows
      : [
          ...(works.length === 0
            ? [
                <Text key="compact-work-loading" dimColor>
                  Loading captured Work…
                </Text>,
              ]
            : works.slice(0, compactWorkRows).map((work) => (
                <Text
                  key={`${work.initiativeId}:${work.assignmentId}`}
                  wrap="truncate-end"
                  color={
                    work.settled
                      ? 'green'
                      : work.phase === 'executing'
                        ? 'yellow'
                        : 'cyan'
                  }
                >
                  {work.settled ? '✓' : '●'} {shortWorkState(work)} ·{' '}
                  {work.title}
                </Text>
              ))),
          ...events.slice(-compactHistoryRows).map((event) => (
            <Text
              key={`${event.title}:${event.detail}`}
              wrap="truncate-end"
              color={
                event.tone === 'good'
                  ? 'green'
                  : event.tone === 'bad'
                    ? 'red'
                    : 'cyan'
              }
            >
              {event.tone === 'bad' ? '!' : '✓'} {event.title}
            </Text>
          )),
        ];
  const wideWorkRows =
    works.length === 0
      ? [
          <Text key="wide-work-loading" dimColor>
            Loading captured Work…
          </Text>,
        ]
      : works
          .slice(0, Math.max(1, Math.floor(summaryContentRows / 2)))
          .flatMap((work) => [
            <Text
              key={`${work.initiativeId}:${work.assignmentId}:title`}
              wrap="truncate-end"
              color={
                work.settled
                  ? 'green'
                  : work.phase === 'executing'
                    ? 'yellow'
                    : 'cyan'
              }
            >
              {work.settled ? '✓' : '●'} {work.title}
            </Text>,
            <Text
              key={`${work.initiativeId}:${work.assignmentId}:state`}
              dimColor
              wrap="truncate-end"
            >
              {shortWorkState(work)} · {work.assignmentId}
            </Text>,
          ]);
  const wideHistoryRows =
    artifactPreview.length > 0
      ? artifactRows
      : events.flatMap((event) => [
          <Text
            key={`${event.title}:${event.detail}:title`}
            wrap="truncate-end"
            color={
              event.tone === 'good'
                ? 'green'
                : event.tone === 'bad'
                  ? 'red'
                  : 'cyan'
            }
          >
            {event.tone === 'bad' ? '!' : '✓'} {event.title}
          </Text>,
          <Text
            key={`${event.title}:${event.detail}:detail`}
            dimColor
            wrap="truncate-end"
          >
            {event.detail}
          </Text>,
        ]);
  const visibleStreamLines = streamLines.slice(-layout.visibleStreamRows);
  const streamTitle = `AGENT EVENT STREAM · ${streamHeading}`;
  const activityWidth = projectTourActivityWidth(columns - 4, streamTitle);
  const guidePanelLines = guide
    ? projectTourGuidePanelLines(guide, Math.max(1, columns - 4))
    : [];
  return (
    <Box
      flexDirection="column"
      width={columns}
      height={layout.canvasRows}
      overflow="hidden"
    >
      <ProjectTourHeader
        columns={columns}
        episode={displayEpisode}
        step={step}
        projectName={path.basename(destination)}
        playbackSpeed={playbackSpeed}
      />
      <Box flexDirection="row" height={layout.summaryRows} overflow="hidden">
        <TitledBorderWindow
          columns={fileWidth}
          title={summaryTitles[0] ?? 'FILES'}
          borderColor="gray"
          rows={fileRows}
        />
        {summaryMode === 'compact' ? (
          <TitledBorderWindow
            columns={Math.max(4, columns - fileWidth)}
            title={summaryTitles[1] ?? 'PROJECT WORK · RETAINED HISTORY'}
            borderColor={artifactPreview.length > 0 ? 'green' : 'gray'}
            rows={projectTourWindowRows(compactRows, summaryContentRows)}
          />
        ) : (
          <>
            <TitledBorderWindow
              columns={workWidth}
              title={summaryTitles[1] ?? 'PROJECT WORK'}
              borderColor="gray"
              rows={projectTourWindowRows(wideWorkRows, summaryContentRows)}
            />
            <TitledBorderWindow
              columns={Math.max(4, columns - fileWidth - workWidth)}
              title={summaryTitles[2] ?? 'RETAINED WORK HISTORY'}
              borderColor={artifactPreview.length > 0 ? 'green' : 'gray'}
              rows={projectTourWindowRows(wideHistoryRows, summaryContentRows)}
            />
          </>
        )}
      </Box>
      <Box
        height={layout.streamRows}
        flexDirection="column"
        borderStyle={guide ? 'double' : 'round'}
        borderColor={guide ? 'magenta' : 'cyan'}
        paddingX={1}
        overflow="hidden"
      >
        {guide ? (
          guidePanelLines.map((line, index) => (
            <Text
              key={`${guide.id}:${index}`}
              bold={index < 2}
              color={index === 0 ? 'magenta' : index === 5 ? 'gray' : 'white'}
              backgroundColor="blue"
            >
              {line}
            </Text>
          ))
        ) : (
          <>
            <Box height={1} flexDirection="row" overflow="hidden">
              <Text bold color="cyan" wrap="truncate-end">
                {streamTitle}
              </Text>
              {activityWidth > 0 ? (
                <>
                  <Text> </Text>
                  <ProjectTourActivityNebula width={activityWidth} />
                </>
              ) : null}
            </Box>
            {visibleStreamLines.length === 0 ? (
              <Text dimColor>Waiting for the first Mock Agent event…</Text>
            ) : null}
            {visibleStreamLines.map((line) => (
              <Text
                key={line.id}
                wrap="truncate-end"
                color={
                  line.status === 'failed'
                    ? 'red'
                    : line.status === 'completed' || line.source === 'receipt'
                      ? 'green'
                      : line.source === 'agent'
                        ? 'cyan'
                        : line.source === 'tool'
                          ? 'yellow'
                          : undefined
                }
              >
                {line.sectionTag} · {line.source.toUpperCase()} · {line.text}
              </Text>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
