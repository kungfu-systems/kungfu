// SPDX-License-Identifier: Apache-2.0

import type {
  QualificationLab,
  QualificationLabEvent,
  QualificationLabReport,
  QualificationLabStartupRoute,
} from '@kungfu-tech/api/capability';
import { qualificationRunProgressLabel } from '@kungfu-tech/api/capability';
import {
  AGENT_WORK_LAB_CHECKS,
  AGENT_WORK_LAB_SUITE,
  type AgentWorkLabCaseId,
  agentWorkLabCase,
  agentWorkLabRecommendation,
} from '@kungfu-tech/kfx';
import { useApp } from 'ink';
import React from 'react';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  SessionWorkbench,
  type TerminalDimensions,
  type WorkbenchCheck,
  type WorkbenchFocus,
  type WorkbenchLine,
  type WorkbenchNextPrompt,
  type WorkbenchReportDetail,
  boundedPromptRows,
  createIncrementalPlayback,
  isWorkbenchReturnInput,
  nextWorkbenchFocus,
  sessionTitleBar,
} from './profile-shell.js';

export type TuiQualificationMode = AgentWorkLabCaseId;
export type TuiQualificationFocus = WorkbenchFocus;
export type TuiQualificationReportDetail = WorkbenchReportDetail;
export type TuiQualificationNextPrompt = WorkbenchNextPrompt;
export type TuiQualificationLine = WorkbenchLine;

export const nextQualificationFocus = nextWorkbenchFocus;
export const isQualificationReportReturnInput = isWorkbenchReturnInput;
export const qualificationSessionTitleBar = sessionTitleBar;
export const qualificationPromptRows = boundedPromptRows;

export function qualificationNextModePrompt(
  mode: TuiQualificationMode,
): TuiQualificationNextPrompt {
  const recommendation = agentWorkLabRecommendation(mode);
  const shortcut =
    recommendation.nextCase === 'same-agent'
      ? ' Press x to start it.'
      : recommendation.nextCase === 'cross-agent'
        ? ' Choose a different target with [ or ], then press m.'
        : '';
  return {
    title: recommendation.title,
    instruction: `${recommendation.instruction}${shortcut}`,
  };
}

export function qualificationEventRunningSession(
  event: QualificationLabEvent,
): 1 | 2 | undefined {
  if (event.step.includes('session-1')) return 1;
  if (event.step.includes('session-2')) return 2;
  return undefined;
}

function eventSession(event: QualificationLabEvent): 1 | 2 {
  return event.step.includes('session-1') ? 1 : 2;
}

export function qualificationEventLines(
  event: QualificationLabEvent,
): TuiQualificationLine[] {
  if (event.publicActivity) {
    return [
      {
        session: eventSession(event),
        source:
          event.publicActivity.kind === 'agent' ? 'agent/live' : 'tool/live',
        text: event.publicActivity.text,
        tone: event.publicActivity.phase === 'completed' ? 'good' : 'running',
      },
    ];
  }
  if (event.step === 'plan') {
    return [
      {
        session: 1,
        source: 'kungfu',
        text: 'One governed task identity was sealed before either process started.',
        tone: 'normal',
      },
    ];
  }
  if (event.step.endsWith('-start')) {
    const session = eventSession(event);
    return [
      {
        session,
        source: 'task',
        text:
          session === 1
            ? 'Start bounded work and stop after a provable partial result.'
            : 'Continue the same Work without Session 1 chat.',
        tone: 'normal',
      },
      {
        session,
        source: 'agent/guide',
        text:
          session === 1
            ? 'I’m starting fresh. I’ll inspect governed state before changing it.'
            : 'I’m a fresh process. I’ll recover state instead of guessing.',
        tone: 'running',
      },
      {
        session,
        source: 'kungfu',
        text: `Fresh provider process ${session} started in the isolated workspace.`,
        tone: 'running',
      },
    ];
  }
  if (event.step === 'session-1' || event.step === 'session-2') {
    const session = eventSession(event);
    const good =
      session === 1
        ? ['partial', 'ended-partial', 'partial-first-attempt'].includes(
            event.status,
          )
        : ['complete', 'ended-complete', 'continuation-completed'].includes(
            event.status,
          );
    return [
      ...(event.publicOutput?.lines ?? []).map((text) => ({
        session,
        source: 'agent/live',
        text,
        tone: good ? ('good' as const) : ('bad' as const),
      })),
      {
        session,
        source: 'evidence',
        text: `Governed state observed: ${event.status}.`,
        tone: good ? 'good' : 'bad',
      },
      {
        session,
        source: 'kungfu',
        text:
          session === 1
            ? 'Verified the expected partial handoff state.'
            : 'Verified continuation from the recorded partial state.',
        tone: good ? 'good' : 'bad',
      },
    ];
  }
  if (event.step === 'assessment') {
    return [
      {
        session: 2,
        source: 'kungfu',
        text: 'Continuity checks compared process identity and governed state.',
        tone: 'normal',
      },
      {
        session: 2,
        source: 'evidence',
        text: `Assessment: ${event.status}.`,
        tone: event.status === 'failed' ? 'bad' : 'good',
      },
    ];
  }
  return [];
}

function reportChecks(
  report: QualificationLabReport | undefined,
): WorkbenchCheck[] {
  const checks = Array.isArray(report?.assessment?.oracleChecks)
    ? report.assessment.oracleChecks
    : [];
  return checks.flatMap((check) => {
    if (!check || typeof check !== 'object') return [];
    const row = check as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.passed !== 'boolean')
      return [];
    const copy = AGENT_WORK_LAB_CHECKS[row.id] ?? {
      title: row.id.replaceAll('-', ' '),
      meaning: 'This check came from the canonical Work assessment.',
    };
    return [{ id: row.id, passed: row.passed, ...copy }];
  });
}

export function QualificationLabView({
  dimensions,
  mode,
  sourceLabel,
  targetLabel,
  lines,
  report,
  busy,
  progress,
  error,
  activeFocus,
  scrollBack,
  showHelp,
  activityFrame,
  runningSession,
  nextPrompt,
  reportDetail,
  emphasizedResult,
}: {
  dimensions: TerminalDimensions;
  mode: TuiQualificationMode;
  sourceLabel: string;
  targetLabel: string;
  lines: TuiQualificationLine[];
  report?: QualificationLabReport;
  busy: string;
  progress: string;
  error: string;
  activeFocus: TuiQualificationFocus;
  scrollBack: Record<1 | 2, number>;
  showHelp: boolean;
  activityFrame: number;
  runningSession?: 1 | 2;
  nextPrompt?: TuiQualificationNextPrompt;
  reportDetail?: TuiQualificationReportDetail;
  emphasizedResult?: TuiQualificationReportDetail;
}) {
  const selectedCase = agentWorkLabCase(mode);
  return (
    <SessionWorkbench
      dimensions={dimensions}
      heading={AGENT_WORK_LAB_SUITE.title}
      collectionLabel={AGENT_WORK_LAB_SUITE.collection.title}
      caseLabel={selectedCase.title}
      relationship="→ governed Work →"
      controls="[d] demo [j/k] source [brackets] target [x] same [m] handoff [Tab] focus [?] explain [w] Work [q] quit"
      help={`${selectedCase.description} Good: a fresh Session 2 finds the same Work and continues. Bad: restart, copied chat, or lost identity.`}
      sourceLabel={sourceLabel || 'Bundled Demo Agent'}
      targetLabel={targetLabel || 'Fresh Demo Agent'}
      lines={lines}
      checks={reportChecks(report)}
      reportAvailable={Boolean(report)}
      reportPassed={Boolean(report && report.status !== 'failed')}
      verdictSuccess="WORK CONTINUITY PROVED"
      verdictFailure="WORK CONTINUITY NOT PROVED"
      detailCaption="Canonical Work continuity checks · sensitive internals remain hidden"
      busy={busy}
      progress={progress}
      error={error}
      activeFocus={activeFocus}
      scrollBack={scrollBack}
      showHelp={showHelp}
      activityFrame={activityFrame}
      runningSession={runningSession}
      nextPrompt={nextPrompt}
      reportDetail={reportDetail}
      emphasizedResult={emphasizedResult}
    />
  );
}

type DimensionSource = {
  get(): TerminalDimensions;
  subscribe(listener: (dimensions: TerminalDimensions) => void): () => void;
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export function AgentWorkLabHost({
  lab,
  startup,
  dimensions,
  onOpenWork,
  isInputCaptured = () => false,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  dimensions: DimensionSource;
  onOpenWork?: () => void;
  isInputCaptured?: () => boolean;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [agents, setAgents] = React.useState<
    Awaited<ReturnType<QualificationLab['discoverAgents']>> | undefined
  >();
  const [mode, setMode] = React.useState<TuiQualificationMode>('offline-demo');
  const [selected, setSelected] = React.useState(0);
  const [target, setTarget] = React.useState(0);
  const [report, setReport] = React.useState<QualificationLabReport>();
  const [lines, setLines] = React.useState<
    ReturnType<typeof qualificationEventLines>
  >([]);
  const [activeFocus, setActiveFocus] =
    React.useState<TuiQualificationFocus>('session-1');
  const [reportDetail, setReportDetail] =
    React.useState<TuiQualificationReportDetail>();
  const [emphasizedResult, setEmphasizedResult] =
    React.useState<TuiQualificationReportDetail>();
  const [nextPrompt, setNextPrompt] =
    React.useState<TuiQualificationNextPrompt>();
  const [scrollBack, setScrollBack] = React.useState<Record<1 | 2, number>>({
    1: 0,
    2: 0,
  });
  const [showHelp, setShowHelp] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [runProgress, setRunProgress] = React.useState<{
    startedAt: number;
    lastEventAt: number;
    eventCount: number;
    phase: 'running' | 'assessing';
  }>();
  const [runningSession, setRunningSession] = React.useState<1 | 2>();
  const [progressNow, setProgressNow] = React.useState(() => Date.now());
  const playbackGeneration = React.useRef(0);
  const profiles = React.useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(agents?.configured ?? []),
            ...(agents?.discovered.map((row) => row.profile) ?? []),
          ].map((profile) => [profile.id, profile]),
        ).values(),
      ),
    [agents],
  );
  const discover = React.useCallback(async () => {
    setBusy('discovering agents');
    try {
      setAgents(await lab.discoverAgents());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  }, [lab]);
  React.useEffect(() => {
    void discover();
  }, [discover]);
  React.useEffect(
    () => dimensions.subscribe((next) => setSize(next)),
    [dimensions],
  );
  React.useEffect(() => {
    if (!runProgress) return undefined;
    setProgressNow(Date.now());
    const timer = setInterval(
      () => setProgressNow(Date.now()),
      AGENT_WORK_LAB_SUITE.timing.quietProgressIntervalMs,
    );
    return () => clearInterval(timer);
  }, [runProgress]);
  React.useEffect(() => {
    if (!nextPrompt) return undefined;
    const timer = setTimeout(
      () => setNextPrompt(undefined),
      AGENT_WORK_LAB_SUITE.timing.recommendationDurationMs,
    );
    return () => clearTimeout(timer);
  }, [nextPrompt]);
  const runQualification = React.useCallback(
    (
      nextMode: TuiQualificationMode,
      execute: (
        onEvent: Parameters<QualificationLab['runDemo']>[0],
      ) => Promise<QualificationLabReport>,
    ) => {
      const generation = playbackGeneration.current + 1;
      playbackGeneration.current = generation;
      const selectedCase = agentWorkLabCase(nextMode);
      setMode(nextMode);
      setBusy(selectedCase.runLabel);
      setReport(undefined);
      setLines([]);
      setActiveFocus('session-1');
      setReportDetail(undefined);
      setEmphasizedResult(undefined);
      setNextPrompt(undefined);
      setScrollBack({ 1: 0, 2: 0 });
      setError('');
      const startedAt = Date.now();
      setProgressNow(startedAt);
      setRunProgress({
        startedAt,
        lastEventAt: startedAt,
        eventCount: 0,
        phase: 'running',
      });
      setRunningSession(1);
      const playback = createIncrementalPlayback<QualificationLabEvent>({
        timing: AGENT_WORK_LAB_SUITE.timing,
        isCurrent: () => playbackGeneration.current === generation,
        onEvent: (event) => {
          setRunningSession(qualificationEventRunningSession(event));
          setLines((current) => [
            ...current,
            ...qualificationEventLines(event),
          ]);
          setRunProgress((current) =>
            current
              ? {
                  ...current,
                  lastEventAt: Date.now(),
                  eventCount: current.eventCount + 1,
                }
              : current,
          );
        },
        onAssessing: () => {
          setRunningSession(undefined);
          setRunProgress((current) =>
            current ? { ...current, phase: 'assessing' } : current,
          );
        },
      });
      void execute((event) => playback.enqueue(event))
        .then(async (value) => {
          if (!(await playback.finish())) return;
          setReport(value);
          setActiveFocus('correct');
          setEmphasizedResult('correct');
          await wait(AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs);
          if (playbackGeneration.current !== generation) return;
          setEmphasizedResult('failed');
          await wait(AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs);
          if (playbackGeneration.current !== generation) return;
          setEmphasizedResult(undefined);
          setNextPrompt(qualificationNextModePrompt(nextMode));
          setError('');
        })
        .catch((reason) => {
          playback.cancel();
          if (playbackGeneration.current !== generation) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (playbackGeneration.current === generation) {
            setBusy('');
            setRunProgress(undefined);
            setRunningSession(undefined);
          }
        });
    },
    [],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const input = String(chunk);
      if (reportDetail && isQualificationReportReturnInput(input)) {
        return setReportDetail(undefined);
      }
      const key = decodeShellKey(input);
      if (key === 'quit') return exit();
      if (input === '\t')
        return setActiveFocus((current) =>
          nextQualificationFocus(current, Boolean(report)),
        );
      if (
        report &&
        (input === '\r' || input === '\n') &&
        (activeFocus === 'correct' || activeFocus === 'failed')
      ) {
        return setReportDetail(activeFocus);
      }
      const focusedSession =
        activeFocus === 'session-1'
          ? 1
          : activeFocus === 'session-2'
            ? 2
            : undefined;
      if (input === '\u001b[A' && focusedSession)
        return setScrollBack((current) => ({
          ...current,
          [focusedSession]: current[focusedSession] + 1,
        }));
      if (input === '\u001b[B' && focusedSession)
        return setScrollBack((current) => ({
          ...current,
          [focusedSession]: Math.max(0, current[focusedSession] - 1),
        }));
      if (input === '?') return setShowHelp((current) => !current);
      if (key === 'next-card')
        return setSelected((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (key === 'previous-card')
        return setSelected((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (input === ']')
        return setTarget((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (input === '[')
        return setTarget((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (input === 'w' && onOpenWork) return onOpenWork();
      if (input === 'd' && !busy) {
        return runQualification('offline-demo', (onEvent) =>
          lab.runDemo(onEvent),
        );
      }
      if (input === 'x' && !busy && profiles[selected]) {
        return runQualification('same-agent', (onEvent) =>
          lab.runAgent(profiles[selected].id, onEvent),
        );
      }
      if (
        input === 'm' &&
        !busy &&
        profiles[selected] &&
        profiles[target] &&
        selected !== target
      ) {
        return runQualification('cross-agent', (onEvent) =>
          lab.runMigration(profiles[selected].id, profiles[target].id, onEvent),
        );
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    busy,
    activeFocus,
    exit,
    isInputCaptured,
    lab,
    onOpenWork,
    profiles,
    report,
    reportDetail,
    selected,
    target,
    runQualification,
  ]);
  const sourceLabel =
    mode === 'offline-demo' ? '' : profiles[selected]?.label || '';
  const targetLabel =
    mode === 'offline-demo'
      ? ''
      : mode === 'same-agent'
        ? sourceLabel
        : profiles[target]?.label || '';
  const progress = runProgress
    ? qualificationRunProgressLabel({
        elapsedMs: progressNow - runProgress.startedAt,
        quietMs: progressNow - runProgress.lastEventAt,
        eventCount: runProgress.eventCount,
        phase: runProgress.phase,
      })
    : '';
  return (
    <QualificationLabView
      dimensions={size}
      mode={mode}
      sourceLabel={sourceLabel}
      targetLabel={targetLabel}
      lines={lines}
      report={report}
      busy={busy}
      progress={progress}
      error={
        error ||
        (startup.route === 'diagnostic'
          ? `${startup.state} · ${startup.reasonCode}`
          : '')
      }
      activeFocus={activeFocus}
      scrollBack={scrollBack}
      showHelp={showHelp}
      activityFrame={
        runProgress
          ? Math.floor(
              (progressNow - runProgress.startedAt) /
                AGENT_WORK_LAB_SUITE.timing.quietProgressIntervalMs,
            )
          : 0
      }
      runningSession={runningSession}
      nextPrompt={nextPrompt}
      reportDetail={reportDetail}
      emphasizedResult={emphasizedResult}
    />
  );
}
