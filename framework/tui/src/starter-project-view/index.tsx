// SPDX-License-Identifier: Apache-2.0

import type {
  AgentRuntimeProfile,
  AgentWorkLab,
  ProjectTemplateCreationReceipt,
  ProjectTemplateWorkspaceSelection,
  ProjectWork,
  ProjectWorkReference,
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
import { ProjectFilesHost } from '../project-files-view/index.js';
import { decodeTerminalMouseInput } from '../terminal-lifecycle.js';

type DimensionSource = {
  get(): TerminalDimensions;
  subscribe(listener: (dimensions: TerminalDimensions) => void): () => void;
};

export type OpenedStarterProject = {
  receipt?: ProjectTemplateCreationReceipt;
  workspace: ProjectTemplateWorkspaceSelection;
  work?: ProjectWork;
  works?: ProjectWork[];
};

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

export function starterProjectOverviewEnterStage(
  workReceipt?: WorkStartReceipt,
  reviewReceipt?: WorkReviewReceipt,
  closeReceipt?: WorkCloseReceipt,
): 'detail' | 'result' | 'review' | 'review-result' | 'close-result' {
  if (closeReceipt) return 'close-result';
  if (reviewReceiptCanResume(reviewReceipt)) return 'review';
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
  origin: 'configured' | 'discovered',
  detail = '',
): string {
  if (origin === 'configured') return 'Configured · Kungfu config';
  const normalized = detail.replaceAll('_', ' ').trim();
  return normalized
    ? `Auto-discovered · ${normalized}`
    : 'Auto-discovered · local machine';
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
  dimensions,
  isInputCaptured,
  onOpenLab,
  onOpenProjects,
  onCreateNextWork,
  onWorkspacePointer,
  initialWorkReceipt,
  initialReviewReceipt,
  initialCloseReceipt,
}: {
  project: OpenedStarterProject;
  lab: AgentWorkLab;
  dimensions: DimensionSource;
  isInputCaptured: () => boolean;
  onOpenLab: () => void;
  onOpenProjects: () => void;
  onCreateNextWork: () => void;
  onWorkspacePointer: () => void;
  initialWorkReceipt?: WorkStartReceipt;
  initialReviewReceipt?: WorkReviewReceipt;
  initialCloseReceipt?: WorkCloseReceipt;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [projectSection, setProjectSection] = React.useState<'work' | 'files'>(
    'work',
  );
  const [activeRegion, setActiveRegion] = React.useState(1);
  const [stage, setStage] = React.useState<StarterProjectStage>('overview');
  const [profiles, setProfiles] = React.useState<AgentRuntimeProfile[]>([]);
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
      setBusy('discovering verified Agents');
      setError('');
      void lab
        .discoverAgents()
        .then((catalog) => {
          const available = new Map<string, AgentRuntimeProfile>();
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
    void lab
      .planStarterWork(workReference, profile.id)
      .then((value) => {
        setPlan(value);
        setStage('preview');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [lab, profiles, selectedProfile, workReference]);
  const start = React.useCallback(() => {
    if (!plan) return;
    setEvents([]);
    setWorkReceipt(undefined);
    setError('');
    setBusy('starting governed Work');
    setStage('running');
    void lab
      .startStarterWork(plan, (event) =>
        setEvents((current) => [...current, event]),
      )
      .then((receipt) => {
        setWorkReceipt(receipt);
        setStage('result');
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStage('result');
      })
      .finally(() => setBusy(''));
  }, [lab, plan]);
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
    if (projectSection === 'files') return;
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const input = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(input);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          if (event.kind !== 'press' || event.button !== 'left') continue;
          const section = projectSectionNavigationAtPoint({
            dimensions: size,
            column: event.column,
            row: event.row,
          });
          if (section === 'files') {
            onWorkspacePointer();
            setProjectSection('files');
          } else if (section === 'work') {
            onWorkspacePointer();
            setActiveRegion(1);
          }
        }
        return;
      }
      const key = decodeShellKey(input);
      const enter = input === '\r' || input === '\n';
      const back =
        input === '\u001b' ||
        input === '\u007f' ||
        input === '\b' ||
        input === 'b';
      if (stage === 'running' || stage === 'reviewing' || stage === 'closing')
        return;
      if (input === 'q' || input === '\u0003') return exit();
      if (stage === 'overview' && input === 't') {
        return setProjectSection('files');
      }
      if (stage === 'detail') {
        if (enter || input === 's') return openAgents();
        if (back) {
          setError('');
          return setStage('overview');
        }
        return;
      }
      if (stage === 'agents') {
        if (key === 'next-card') {
          setSelectedProfile((current) =>
            boundedIndex(current, 1, profiles.length),
          );
        } else if (key === 'previous-card') {
          setSelectedProfile((current) =>
            boundedIndex(current, -1, profiles.length),
          );
        } else if (enter) {
          preview();
        } else if (back) {
          setError('');
          setStage('detail');
        }
        return;
      }
      if (stage === 'preview') {
        if (enter && plan?.executable) return start();
        if (back) {
          setError('');
          return setStage('agents');
        }
        return;
      }
      if (stage === 'review') {
        if (enter || input === 'r') return openReviewAgents();
        if (back) {
          setError('');
          return setStage('overview');
        }
        return;
      }
      if (stage === 'review-agents') {
        if (key === 'next-card') {
          setSelectedProfile((current) =>
            boundedIndex(current, 1, profiles.length),
          );
        } else if (key === 'previous-card') {
          setSelectedProfile((current) =>
            boundedIndex(current, -1, profiles.length),
          );
        } else if (enter) {
          previewReview();
        } else if (back) {
          setError('');
          setStage('review');
        }
        return;
      }
      if (stage === 'review-preview') {
        if (enter && reviewPlan?.executable) return runReview();
        if (back) {
          setError('');
          return setStage('review-agents');
        }
        return;
      }
      if (stage === 'review-result') {
        if (enter && reviewReceiptCanResume(reviewReceipt)) {
          setError('');
          return setStage('review');
        }
        if (enter && reviewReceipt?.status === 'review-passed') {
          return previewClose();
        }
        if (enter || back) {
          setError('');
          return setStage('overview');
        }
        return;
      }
      if (stage === 'close-preview') {
        if (enter && closePlan?.executable) return closeWork();
        if (back) {
          setError('');
          return setStage('review-result');
        }
        return;
      }
      if (stage === 'close-result') {
        if (
          enter &&
          closeReceipt?.status === 'settlement-interrupted' &&
          closeReceipt.workPhase === 'continuation-decided'
        ) {
          return previewClose();
        }
        if (closeReceipt?.status === 'completed' && (enter || input === 'n')) {
          return onCreateNextWork();
        }
        if (back) {
          setError('');
          return setStage('overview');
        }
        return;
      }
      if (stage === 'result') {
        if (enter && workReceipt?.status === 'agent-finished') {
          setError('');
          return setStage('review');
        }
        if (enter || back) {
          setError('');
          return setStage('overview');
        }
        return;
      }
      if (enter) {
        setError('');
        return setStage(
          starterProjectOverviewEnterStage(
            workReceipt,
            reviewReceipt,
            closeReceipt,
          ),
        );
      }
      if (input === 'n' && closeReceipt?.status === 'completed') {
        return onCreateNextWork();
      }
      if (input === 'p') return onOpenProjects();
      if (key === 'agent-work-lab') return onOpenLab();
      if (key === 'next-card') {
        selectAdjacentWork(1);
      } else if (key === 'previous-card') {
        selectAdjacentWork(-1);
      } else if (key === 'next-region') {
        setActiveRegion((current) => boundedIndex(current, 1, 3));
      } else if (key === 'previous-region') {
        setActiveRegion((current) => boundedIndex(current, -1, 3));
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    exit,
    isInputCaptured,
    closePlan?.executable,
    closeReceipt,
    closeWork,
    onOpenLab,
    onOpenProjects,
    onCreateNextWork,
    onWorkspacePointer,
    openAgents,
    openReviewAgents,
    plan?.executable,
    preview,
    previewClose,
    previewReview,
    profiles.length,
    projectSection,
    reviewPlan?.executable,
    reviewReceipt,
    runReview,
    selectAdjacentWork,
    size,
    stage,
    start,
    workReceipt,
  ]);

  const spinner = ['◐', '◓', '◑', '◒'][activityFrame];
  if (projectSection === 'files') {
    return (
      <ProjectFilesHost
        root={project.workspace.selected.workspace_root}
        dimensions={dimensions}
        workCount={works.length}
        isInputCaptured={isInputCaptured}
        onOpenWork={() => {
          setProjectSection('work');
          setActiveRegion(1);
        }}
        onOpenProjects={onOpenProjects}
        onOpenLab={onOpenLab}
        onWorkspacePointer={onWorkspacePointer}
      />
    );
  }
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
                ? 'Review deliverables/launch-brief.md and the retained evidence before accepting completion.'
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
            ? '[Enter/r] verify retained reviewer · [Esc/b] project overview · [q] quit'
            : '[Enter/r] choose a fresh reviewer · [Esc/b] project overview · [q] quit'
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
            Deliverable · {reviewPlan.deliverable.path} ·{' '}
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
    <ProfileShell
      model={model}
      dimensions={size}
      selectedCard={selectedCard}
      activeRegion={activeRegion}
      busy={Boolean(busy)}
    />
  );
}
