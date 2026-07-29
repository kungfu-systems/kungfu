// SPDX-License-Identifier: Apache-2.0

import type {
  AgentWorkLab,
  AgentWorkLabEvent,
  AgentWorkLabReport,
  AgentWorkLabStartupRoute,
} from '@kungfu-tech/api/capability';
import { agentWorkLabRunProgressLabel } from '@kungfu-tech/api/capability';
import { useApp } from 'ink';
import React from 'react';
import {
  AGENT_WORK_LAB_CHECKS,
  AGENT_WORK_LAB_SUITE,
  type AgentWorkLabCaseId,
  agentWorkLabCase,
  agentWorkLabRecommendation,
} from '../../../extensions/agent-work-lab/experience/src/index.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  type QuickCommand,
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

export type TuiAgentWorkLabMode = AgentWorkLabCaseId;
export type TuiAgentWorkLabFocus = WorkbenchFocus;
export type TuiAgentWorkLabReportDetail = WorkbenchReportDetail;
export type TuiAgentWorkLabNextPrompt = WorkbenchNextPrompt;
export type TuiAgentWorkLabLine = WorkbenchLine;
export type TuiAgentWorkLabAutoplayPhase = 1 | 2 | 3 | 4;

export type AgentWorkLabSuiteAction =
  | 'lab-demo'
  | 'lab-same'
  | 'lab-handoff'
  | 'lab-report'
  | 'lab-focus-next';

export type AgentWorkLabActionRequest = {
  id: number;
  action: AgentWorkLabSuiteAction;
};

export type AgentWorkLabAutoplayResult =
  | {
      state: 'completed';
      report: AgentWorkLabReport;
    }
  | {
      state: 'failed';
      message: string;
    };

export type AgentWorkLabAutoplay = {
  onSettled: (result: AgentWorkLabAutoplayResult) => void;
  wait?: (milliseconds: number) => Promise<void>;
};

export const AGENT_WORK_LAB_QUICK_COMMANDS: QuickCommand<AgentWorkLabSuiteAction>[] =
  [
    {
      id: 'lab-demo',
      command: '/demo',
      title: 'Run Offline Demo',
      summary: 'Show the two-Session continuity experiment without an Agent.',
      action: 'lab-demo',
    },
    {
      id: 'lab-same',
      command: '/same',
      title: 'Test Same Agent',
      summary: 'Run two fresh Sessions with the selected Agent provider.',
      action: 'lab-same',
    },
    {
      id: 'lab-handoff',
      command: '/handoff',
      title: 'Test Agent Handoff',
      summary: 'Continue the same Work with a different Agent provider.',
      action: 'lab-handoff',
    },
    {
      id: 'lab-report',
      command: '/report',
      title: 'Open Latest Report',
      summary: 'Open the strongest result detail from the completed test.',
      action: 'lab-report',
    },
    {
      id: 'lab-focus-next',
      command: '/focus',
      title: 'Move Lab Focus',
      summary: 'Move focus across Session windows and available result cards.',
      action: 'lab-focus-next',
    },
  ];

export function agentWorkLabActionReturnsToControls(
  action: AgentWorkLabSuiteAction,
): boolean {
  return action === 'lab-report';
}

export const nextAgentWorkLabFocus = nextWorkbenchFocus;
export const isAgentWorkLabReportReturnInput = isWorkbenchReturnInput;
export const agentWorkLabSessionTitleBar = sessionTitleBar;
export const agentWorkLabPromptRows = boundedPromptRows;

export function agentWorkLabNextModePrompt(
  mode: TuiAgentWorkLabMode,
): TuiAgentWorkLabNextPrompt {
  const recommendation = agentWorkLabRecommendation(mode);
  const shortcut =
    recommendation.nextCase === 'same-agent'
      ? ' Run /same, or press Esc then x.'
      : recommendation.nextCase === 'cross-agent'
        ? ' Run /handoff, or press Esc, choose a target with [ or ], then press m.'
        : '';
  return {
    title: recommendation.title,
    instruction: `${recommendation.instruction}${shortcut}`,
  };
}

export function agentWorkLabEventRunningSession(
  event: AgentWorkLabEvent,
): 1 | 2 | undefined {
  if (event.step.includes('session-1')) return 1;
  if (event.step.includes('session-2')) return 2;
  return undefined;
}

export function agentWorkLabAutoplayPhase(
  event: AgentWorkLabEvent,
): TuiAgentWorkLabAutoplayPhase {
  if (event.step === 'assessment') return 4;
  if (event.step.includes('session-2')) return 3;
  if (event.step.includes('session-1')) return 2;
  return 1;
}

export function agentWorkLabAutoplayPhaseLabel(
  phase: TuiAgentWorkLabAutoplayPhase,
): string {
  if (phase === 1) return 'Seal one exact Work identity';
  if (phase === 2) return 'Session 1 makes bounded progress and exits';
  if (phase === 3) return 'Fresh Session 2 recovers and completes the Work';
  return 'Kungfu verifies continuity from evidence';
}

function eventSession(event: AgentWorkLabEvent): 1 | 2 {
  return event.step.includes('session-1') ? 1 : 2;
}

export function agentWorkLabEventLines(
  event: AgentWorkLabEvent,
): TuiAgentWorkLabLine[] {
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
  report: AgentWorkLabReport | undefined,
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

export function AgentWorkLabView({
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
  autoplay,
}: {
  dimensions: TerminalDimensions;
  mode: TuiAgentWorkLabMode;
  sourceLabel: string;
  targetLabel: string;
  lines: TuiAgentWorkLabLine[];
  report?: AgentWorkLabReport;
  busy: string;
  progress: string;
  error: string;
  activeFocus: TuiAgentWorkLabFocus;
  scrollBack: Record<1 | 2, number>;
  showHelp: boolean;
  activityFrame: number;
  runningSession?: 1 | 2;
  nextPrompt?: TuiAgentWorkLabNextPrompt;
  reportDetail?: TuiAgentWorkLabReportDetail;
  emphasizedResult?: TuiAgentWorkLabReportDetail;
  autoplay?: {
    introCountdown: number;
    phase: TuiAgentWorkLabAutoplayPhase;
  };
}) {
  const selectedCase = agentWorkLabCase(mode);
  const autoplayQuestion =
    'QUESTION · Can a fresh Session continue the same Work without the old chat?';
  return (
    <SessionWorkbench
      dimensions={dimensions}
      heading={AGENT_WORK_LAB_SUITE.title}
      collectionLabel={AGENT_WORK_LAB_SUITE.collection.title}
      caseLabel={selectedCase.title}
      relationship="→ governed Work →"
      controls={
        autoplay
          ? `STEP ${autoplay.phase}/4 · ${agentWorkLabAutoplayPhaseLabel(autoplay.phase)}`
          : '[d] demo [j/k] source [brackets] target [x] same [m] handoff [Tab] focus [?] explain [w] Work [q] quit'
      }
      help={
        autoplay
          ? autoplayQuestion
          : `${selectedCase.description} Good: a fresh Session 2 finds the same Work and continues. Bad: restart, copied chat, or lost identity.`
      }
      sourceLabel={sourceLabel || 'Bundled Demo Agent'}
      targetLabel={targetLabel || 'Fresh Demo Agent'}
      lines={lines}
      checks={reportChecks(report)}
      reportAvailable={Boolean(report)}
      reportPassed={Boolean(report && report.status !== 'failed')}
      verdictSuccess="WORK CONTINUITY PROVED"
      verdictFailure="WORK CONTINUITY NOT PROVED"
      verdictDetail={autoplay ? 'THE CHAT ENDED. THE WORK DID NOT.' : undefined}
      detailCaption="Canonical Work continuity checks · sensitive internals remain hidden"
      busy={busy}
      progress={progress}
      error={error}
      activeFocus={activeFocus}
      scrollBack={scrollBack}
      showHelp={showHelp || Boolean(autoplay)}
      activityFrame={activityFrame}
      runningSession={runningSession}
      nextPrompt={autoplay ? undefined : nextPrompt}
      guideOverlay={
        autoplay && autoplay.introCountdown > 0
          ? {
              heading: 'WHAT THIS DEMO PROVES',
              title: 'ONE WORK. TWO FRESH SESSIONS.',
              lines: [
                'Can a brand-new Agent Session continue the same Work',
                'without receiving the previous chat?',
                'S1 saves progress → KUNGFU WORK restores it → S2',
                'Session 1 does part of the task, records progress, and exits.',
                'Session 2 starts fresh and finishes without copied chat.',
              ],
              footer: `No action needed · starts automatically in ${autoplay.introCountdown} seconds.`,
            }
          : undefined
      }
      reportDetail={reportDetail}
      emphasizedResult={emphasizedResult}
      interactive={!autoplay}
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
  actionRequest,
  onActionHandled,
  autoplay,
}: {
  lab: AgentWorkLab;
  startup: AgentWorkLabStartupRoute;
  dimensions: DimensionSource;
  onOpenWork?: () => void;
  isInputCaptured?: () => boolean;
  actionRequest?: AgentWorkLabActionRequest;
  onActionHandled?: (id: number) => void;
  autoplay?: AgentWorkLabAutoplay;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [agents, setAgents] = React.useState<
    Awaited<ReturnType<AgentWorkLab['discoverAgents']>> | undefined
  >();
  const [mode, setMode] = React.useState<TuiAgentWorkLabMode>('offline-demo');
  const [selected, setSelected] = React.useState(0);
  const [target, setTarget] = React.useState(0);
  const [report, setReport] = React.useState<AgentWorkLabReport>();
  const [lines, setLines] = React.useState<
    ReturnType<typeof agentWorkLabEventLines>
  >([]);
  const [activeFocus, setActiveFocus] =
    React.useState<TuiAgentWorkLabFocus>('session-1');
  const [reportDetail, setReportDetail] =
    React.useState<TuiAgentWorkLabReportDetail>();
  const [emphasizedResult, setEmphasizedResult] =
    React.useState<TuiAgentWorkLabReportDetail>();
  const [nextPrompt, setNextPrompt] =
    React.useState<TuiAgentWorkLabNextPrompt>();
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
  const [autoplayIntroCountdown, setAutoplayIntroCountdown] = React.useState(
    () =>
      autoplay
        ? Math.ceil(
            AGENT_WORK_LAB_SUITE.timing.autoplayIntroDurationMs /
              AGENT_WORK_LAB_SUITE.timing.quietProgressIntervalMs,
          )
        : 0,
  );
  const [autoplayPhase, setAutoplayPhase] =
    React.useState<TuiAgentWorkLabAutoplayPhase>(1);
  const playbackGeneration = React.useRef(0);
  const handledActionRequest = React.useRef(0);
  const autoplayStarted = React.useRef(false);
  const autoplaySettled = React.useRef(false);
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
    if (autoplay) return;
    void discover();
  }, [autoplay, discover]);
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
  const runAgentWorkLabCase = React.useCallback(
    (
      nextMode: TuiAgentWorkLabMode,
      execute: (
        onEvent: Parameters<AgentWorkLab['runDemo']>[0],
      ) => Promise<AgentWorkLabReport>,
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
      const playback = createIncrementalPlayback<AgentWorkLabEvent>({
        timing: AGENT_WORK_LAB_SUITE.timing,
        isCurrent: () => playbackGeneration.current === generation,
        wait: autoplay?.wait,
        onEvent: (event) => {
          const session = agentWorkLabEventRunningSession(event);
          setRunningSession(session);
          if (autoplay) {
            setAutoplayPhase(agentWorkLabAutoplayPhase(event));
            if (session) setActiveFocus(`session-${session}`);
          }
          setLines((current) => [...current, ...agentWorkLabEventLines(event)]);
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
          if (autoplay) setAutoplayPhase(4);
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
          await (autoplay?.wait ?? wait)(
            AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs,
          );
          if (playbackGeneration.current !== generation) return;
          setEmphasizedResult('failed');
          await (autoplay?.wait ?? wait)(
            AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs,
          );
          if (playbackGeneration.current !== generation) return;
          setEmphasizedResult(undefined);
          if (autoplay) {
            setReportDetail(value.status === 'failed' ? 'failed' : 'correct');
          } else {
            setNextPrompt(agentWorkLabNextModePrompt(nextMode));
          }
          setError('');
          if (autoplay && !autoplaySettled.current) {
            void (autoplay.wait ?? wait)(
              AGENT_WORK_LAB_SUITE.timing.recommendationDurationMs,
            ).then(() => {
              if (
                playbackGeneration.current === generation &&
                !autoplaySettled.current
              ) {
                autoplaySettled.current = true;
                autoplay.onSettled({ state: 'completed', report: value });
              }
            });
          }
        })
        .catch((reason) => {
          playback.cancel();
          if (playbackGeneration.current !== generation) return;
          const message =
            reason instanceof Error ? reason.message : String(reason);
          setError(message);
          if (autoplay && !autoplaySettled.current) {
            void (autoplay.wait ?? wait)(
              AGENT_WORK_LAB_SUITE.timing.recommendationDurationMs,
            ).then(() => {
              if (
                playbackGeneration.current === generation &&
                !autoplaySettled.current
              ) {
                autoplaySettled.current = true;
                autoplay.onSettled({ state: 'failed', message });
              }
            });
          }
        })
        .finally(() => {
          if (playbackGeneration.current === generation) {
            setBusy('');
            setRunProgress(undefined);
            setRunningSession(undefined);
          }
        });
    },
    [autoplay],
  );
  const performSuiteAction = React.useCallback(
    (action: AgentWorkLabSuiteAction) => {
      if (action === 'lab-focus-next') {
        setActiveFocus((current) =>
          nextAgentWorkLabFocus(current, Boolean(report)),
        );
        return;
      }
      if (action === 'lab-report') {
        if (!report) {
          setError('No report yet. Run /demo, /same, or /handoff first.');
          return;
        }
        const detail = reportChecks(report).some((check) => !check.passed)
          ? 'failed'
          : 'correct';
        setActiveFocus(detail);
        setReportDetail(detail);
        setError('');
        return;
      }
      if (busy) {
        setError('A Lab test is already running.');
        return;
      }
      if (action === 'lab-demo') {
        runAgentWorkLabCase('offline-demo', (onEvent) => lab.runDemo(onEvent));
        return;
      }
      const source = profiles[selected];
      if (!source) {
        setError('No configured Agent is available for this test.');
        return;
      }
      if (action === 'lab-same') {
        runAgentWorkLabCase('same-agent', (onEvent) =>
          lab.runAgent(source.id, onEvent),
        );
        return;
      }
      const destination = profiles[target];
      if (!destination) {
        setError('Choose an available handoff target first.');
        return;
      }
      if (source.id === destination.id) {
        setError(
          'Handoff needs two different Agents. Choose the target in LAB CONTROLS.',
        );
        return;
      }
      runAgentWorkLabCase('cross-agent', (onEvent) =>
        lab.runMigration(source.id, destination.id, onEvent),
      );
    },
    [busy, lab, profiles, report, runAgentWorkLabCase, selected, target],
  );
  React.useEffect(() => {
    if (!actionRequest || actionRequest.id <= handledActionRequest.current)
      return;
    handledActionRequest.current = actionRequest.id;
    performSuiteAction(actionRequest.action);
    onActionHandled?.(actionRequest.id);
  }, [actionRequest, onActionHandled, performSuiteAction]);
  const performSuiteActionRef = React.useRef(performSuiteAction);
  performSuiteActionRef.current = performSuiteAction;
  React.useEffect(() => {
    if (!autoplay || autoplayStarted.current) return;
    autoplayStarted.current = true;
    let active = true;
    const interval = AGENT_WORK_LAB_SUITE.timing.quietProgressIntervalMs;
    const total = Math.ceil(
      AGENT_WORK_LAB_SUITE.timing.autoplayIntroDurationMs / interval,
    );
    setAutoplayIntroCountdown(total);
    void (async () => {
      for (let remaining = total; remaining > 0; remaining -= 1) {
        await (autoplay.wait ?? wait)(interval);
        if (!active) return;
        setAutoplayIntroCountdown(remaining - 1);
      }
      performSuiteActionRef.current('lab-demo');
    })();
    return () => {
      active = false;
    };
  }, [autoplay]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const input = String(chunk);
      if (reportDetail && isAgentWorkLabReportReturnInput(input)) {
        return setReportDetail(undefined);
      }
      const key = decodeShellKey(input);
      if (key === 'quit') return exit();
      if (input === '\t') return performSuiteAction('lab-focus-next');
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
      if (input === 'd') return performSuiteAction('lab-demo');
      if (input === 'x') return performSuiteAction('lab-same');
      if (input === 'm') return performSuiteAction('lab-handoff');
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    activeFocus,
    exit,
    isInputCaptured,
    onOpenWork,
    performSuiteAction,
    profiles,
    report,
    reportDetail,
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
    ? agentWorkLabRunProgressLabel({
        elapsedMs: progressNow - runProgress.startedAt,
        quietMs: progressNow - runProgress.lastEventAt,
        eventCount: runProgress.eventCount,
        phase: runProgress.phase,
      })
    : '';
  return (
    <AgentWorkLabView
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
      autoplay={
        autoplay
          ? {
              introCountdown: autoplayIntroCountdown,
              phase: autoplayPhase,
            }
          : undefined
      }
    />
  );
}
