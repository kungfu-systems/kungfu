// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentWorkLab,
  AgentWorkLabEvent,
  AgentWorkLabReport,
  AgentWorkLabStartupRoute,
  KungfuOnboardingState,
  ProjectTemplateCreationReceipt,
  ProjectTemplatePlan,
  ProjectTemplateWorkspaceSelection,
} from '@kungfu-tech/api/capability';
import {
  DEFAULT_KUNGFU_ONBOARDING_STATE,
  agentWorkLabRunProgressLabel,
  parseKungfuOnboardingState,
} from '@kungfu-tech/api/capability';
import {
  AGENT_WORK_LAB_CHECKS,
  AGENT_WORK_LAB_SUITE,
  type AgentWorkLabCaseId,
  agentWorkLabCase,
  agentWorkLabRecommendation,
} from '@kungfu-tech/kfx-agent-work-lab-experience';
import { Box, Text, useApp } from 'ink';
import React from 'react';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  type QuickCommand,
  SessionWorkbench,
  type TerminalDimensions,
  TitledBorderWindow,
  type WorkbenchActionButton,
  type WorkbenchCheck,
  type WorkbenchFocus,
  type WorkbenchGuideOverlay,
  type WorkbenchLine,
  type WorkbenchNextPrompt,
  type WorkbenchReportDetail,
  type WorkbenchScrollBack,
  type WorkbenchSessionBuffers,
  appendWorkbenchSessionLines,
  boundedPromptRows,
  createIncrementalPlayback,
  emptyWorkbenchSessionBuffers,
  isWorkbenchReturnInput,
  nextWorkbenchFocus,
  scrollWorkbenchSession,
  sessionTitleBar,
  workbenchActionAtPoint,
  workbenchReportAtPoint,
  workbenchReportReturnAtPoint,
  workbenchSessionAtPoint,
  workbenchViewportRows,
} from './profile-shell.js';
import { decodeTerminalMouseInput } from './terminal-lifecycle.js';

export function readTuiOnboardingState(
  configHome: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): KungfuOnboardingState {
  try {
    const value = JSON.parse(
      readFile(path.join(configHome, 'config.json')),
    ) as { ui?: { onboarding?: unknown } };
    return parseKungfuOnboardingState(value.ui?.onboarding);
  } catch {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
}

function wrapOnboardingText(value: string, width: number): string[] {
  const words = value
    .split(/\s+/u)
    .flatMap((word) =>
      word.length <= width
        ? [word]
        : Array.from({ length: Math.ceil(word.length / width) }, (_, index) =>
            word.slice(index * width, (index + 1) * width),
          ),
    );
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const AGENT_SHELL_ENTRY = 'kungfu run codex|claude|opencode|amp';

export type TuiOnboardingAction =
  | 'copy'
  | 'lab'
  | 'tour'
  | 'continue'
  | 'dismiss';

export type TuiOnboardingNotice = {
  ok: boolean;
  title: string;
  detail: string;
  next: string;
};

export function useTransientOnboardingNotice(): [
  TuiOnboardingNotice | undefined,
  React.Dispatch<React.SetStateAction<TuiOnboardingNotice | undefined>>,
] {
  const [notice, setNotice] = React.useState<TuiOnboardingNotice>();
  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

export function tuiOnboardingActionFromInput(
  value: string,
): TuiOnboardingAction | 'quit' | null {
  if (value === 'q' || value === 'Q' || value === '\u0003') return 'quit';
  if (value === 'c' || value === 'C') return 'copy';
  if (value === '\r' || value === '\n') return 'continue';
  if (value === 'l' || value === 'L') return 'lab';
  if (value === 't' || value === 'T') return 'tour';
  if (value === 's' || value === 'S') return 'dismiss';
  return null;
}

function OnboardingShortcutLine({
  value,
  opaqueWidth,
}: {
  value: string;
  opaqueWidth?: number;
}) {
  const content =
    opaqueWidth === undefined
      ? value
      : ` ${value}`.slice(0, opaqueWidth).padEnd(opaqueWidth);
  return (
    <Text
      color={opaqueWidth === undefined ? undefined : 'white'}
      backgroundColor={opaqueWidth === undefined ? undefined : 'blue'}
      wrap="truncate-end"
    >
      {content.split(/(\[[^\]]+\])/u).map((part, index) =>
        /^\[[^\]]+\]$/u.test(part) ? (
          <Text
            key={`${index}:${part}`}
            bold
            color="black"
            backgroundColor="yellow"
          >
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export function AgentFirstOnboardingView({
  dimensions,
  state,
  command,
  prompt,
  notice,
  onAction,
}: {
  dimensions: TerminalDimensions;
  state: KungfuOnboardingState;
  command: string;
  prompt: string;
  notice?: TuiOnboardingNotice;
  onAction: (action: TuiOnboardingAction) => void;
}) {
  const { exit } = useApp();
  const noticePanelWidth = Math.max(24, Math.min(72, dimensions.columns - 4));
  const noticeColumns = Math.max(1, noticePanelWidth - 2);
  const noticeLine = (value: string) =>
    ` ${value}`.slice(0, noticeColumns).padEnd(noticeColumns);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const action = tuiOnboardingActionFromInput(String(chunk));
      if (action === 'quit') exit();
      else if (action) onAction(action);
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, onAction]);

  return (
    <Box
      width={dimensions.columns}
      height={dimensions.rows}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Text color="green" bold>
        KUNGFU · AGENT-FIRST ENTRY
      </Text>
      <Text bold>Keep your agent. Give it durable Work.</Text>
      <Text wrap="wrap">
        Start in either place. Copy Kungfu into the Agent you already use,
        continue directly into the Kungfu UI, or explore first. Copying is
        helpful, never required.
      </Text>
      <TitledBorderWindow
        columns={Math.max(20, dimensions.columns - 2)}
        title="OPTION A · BRING KUNGFU TO YOUR AGENT"
        borderColor="green"
        paddingX={1}
        rows={[
          ...wrapOnboardingText(
            prompt,
            Math.max(16, dimensions.columns - 8),
          ).map((row) => (
            <Text key={`prompt:${row}`} color="cyan" bold>
              {row}
            </Text>
          )),
          <Text key="prompt-command-gap"> </Text>,
          ...wrapOnboardingText(
            `Exact local command: ${command}`,
            Math.max(16, dimensions.columns - 8),
          ).map((row) => (
            <Text key={`command:${row}`} dimColor>
              {row}
            </Text>
          )),
          <OnboardingShortcutLine
            key="copy-shortcut"
            value="[C/c] Copy this one-line Agent prompt"
          />,
        ]}
      />
      <TitledBorderWindow
        columns={Math.max(20, dimensions.columns - 2)}
        title="OPTION B · START IN KUNGFU"
        borderColor="cyan"
        paddingX={1}
        rows={[
          <Text key="continue-copy">
            Open the local Work control plane. No copy or paste is required.
          </Text>,
          <Text key="shell-entry" dimColor>
            Keep your normal Agent workflow: {AGENT_SHELL_ENTRY}
          </Text>,
          <OnboardingShortcutLine
            key="continue-shortcut"
            value="[Enter] Continue to Kungfu"
          />,
        ]}
      />
      <OnboardingShortcutLine value="Explore first: [L/l] Agent Work Lab · [T/t] Guided Project Tour" />
      <OnboardingShortcutLine
        value={`Return any time with /onboarding · [S/s] Don’t show again · Current route: ${state.route}`}
      />
      {notice ? (
        <Box
          position="absolute"
          width={noticePanelWidth}
          height={6}
          marginTop={Math.max(2, Math.floor((dimensions.rows - 6) / 2))}
          marginLeft={Math.max(
            2,
            Math.floor((dimensions.columns - noticePanelWidth) / 2),
          )}
          borderStyle="double"
          borderColor={notice.ok ? 'green' : 'red'}
          flexDirection="column"
          overflow="hidden"
        >
          <Text
            bold
            color={notice.ok ? 'black' : 'white'}
            backgroundColor={notice.ok ? 'green' : 'red'}
          >
            {noticeLine(notice.title)}
          </Text>
          <Text color="white" backgroundColor="blue">
            {noticeLine(notice.detail)}
          </Text>
          <OnboardingShortcutLine
            value={notice.next}
            opaqueWidth={noticeColumns}
          />
          <Text color="white" backgroundColor="blue" dimColor>
            {noticeLine('Closes automatically in 4 seconds.')}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

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
  | 'lab-starter'
  | 'lab-focus-next';

export type AgentWorkLabActionRequest = {
  id: number;
  action: AgentWorkLabSuiteAction;
};

export const AGENT_WORK_LAB_POINTER_ACTIONS: WorkbenchActionButton<AgentWorkLabSuiteAction>[] =
  [
    { action: 'lab-demo', label: 'Run demo' },
    { action: 'lab-same', label: 'Run same' },
    { action: 'lab-handoff', label: 'Run handoff' },
    { action: 'lab-starter', label: 'New project' },
  ];

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

type StarterProjectFailure = {
  stage: 'create' | 'open';
  message: string;
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
      id: 'lab-starter',
      command: '/new',
      title: 'Create Starter Project',
      summary: 'Preview a real project and its first governed Work request.',
      action: 'lab-starter',
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
  return action === 'lab-report' || action === 'lab-starter';
}

export const nextAgentWorkLabFocus = nextWorkbenchFocus;
export const isAgentWorkLabReportReturnInput = isWorkbenchReturnInput;
export const agentWorkLabSessionTitleBar = sessionTitleBar;
export const agentWorkLabPromptRows = boundedPromptRows;

export function agentWorkLabStarterReceiptInput(
  input: string,
  canOpen: boolean,
  busy: boolean,
): 'open' | 'close' | 'none' {
  if (input === '\r' || input === '\n') {
    if (!canOpen) return 'close';
    return busy ? 'none' : 'open';
  }
  if (isAgentWorkLabReportReturnInput(input)) return 'close';
  return 'none';
}

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
    instruction: `${recommendation.instruction}${shortcut} When you are ready, run /new or press n to create your first real project.`,
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
  buffers,
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
  guideOverlay,
}: {
  dimensions: TerminalDimensions;
  mode: TuiAgentWorkLabMode;
  sourceLabel: string;
  targetLabel: string;
  buffers: WorkbenchSessionBuffers;
  report?: AgentWorkLabReport;
  busy: string;
  progress: string;
  error: string;
  activeFocus: TuiAgentWorkLabFocus;
  scrollBack: WorkbenchScrollBack;
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
  guideOverlay?: WorkbenchGuideOverlay;
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
          : 'keyboard [d/x/m/n] run · [w] Work · [j/k] source · [brackets] target · [Tab] focus · [?] explain'
      }
      controlActions={autoplay ? undefined : AGENT_WORK_LAB_POINTER_ACTIONS}
      help={
        autoplay
          ? autoplayQuestion
          : `${selectedCase.description} Good: a fresh Session 2 finds the same Work and continues. Bad: restart, copied chat, or lost identity. Mouse clicks require terminal click reporting.`
      }
      sourceLabel={sourceLabel || 'Bundled Demo Agent'}
      targetLabel={targetLabel || 'Fresh Demo Agent'}
      buffers={buffers}
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
        guideOverlay ??
        (autoplay && autoplay.introCountdown > 0
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
          : undefined)
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
  onOpenStarterProject,
  onWorkspacePointer,
  isInputCaptured = () => false,
  actionRequest,
  onActionHandled,
  autoplay,
}: {
  lab: AgentWorkLab;
  startup: AgentWorkLabStartupRoute;
  dimensions: DimensionSource;
  onOpenWork?: () => void;
  onOpenStarterProject?: (
    receipt: ProjectTemplateCreationReceipt,
    workspace: ProjectTemplateWorkspaceSelection,
  ) => void;
  onWorkspacePointer?: () => void;
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
  const [sessionState, setSessionState] = React.useState<{
    buffers: WorkbenchSessionBuffers;
    scrollBack: WorkbenchScrollBack;
  }>(() => ({
    buffers: emptyWorkbenchSessionBuffers(),
    scrollBack: { 1: 0, 2: 0 },
  }));
  const { buffers, scrollBack } = sessionState;
  const [activeFocus, setActiveFocus] =
    React.useState<TuiAgentWorkLabFocus>('session-1');
  const [reportDetail, setReportDetail] =
    React.useState<TuiAgentWorkLabReportDetail>();
  const [emphasizedResult, setEmphasizedResult] =
    React.useState<TuiAgentWorkLabReportDetail>();
  const [nextPrompt, setNextPrompt] =
    React.useState<TuiAgentWorkLabNextPrompt>();
  const [showHelp, setShowHelp] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [starterPlan, setStarterPlan] = React.useState<ProjectTemplatePlan>();
  const [starterReceipt, setStarterReceipt] =
    React.useState<ProjectTemplateCreationReceipt>();
  const [starterFailure, setStarterFailure] =
    React.useState<StarterProjectFailure>();
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
      setSessionState({
        buffers: emptyWorkbenchSessionBuffers(),
        scrollBack: { 1: 0, 2: 0 },
      });
      setActiveFocus('session-1');
      setReportDetail(undefined);
      setEmphasizedResult(undefined);
      setNextPrompt(undefined);
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
          const eventLines = agentWorkLabEventLines(event);
          setSessionState((current) =>
            appendWorkbenchSessionLines({
              ...current,
              lines: eventLines,
            }),
          );
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
  const previewStarterProject = React.useCallback(() => {
    if (busy) {
      setError('Wait for the current Lab action to finish.');
      return;
    }
    setBusy('planning starter project');
    setStarterReceipt(undefined);
    setStarterFailure(undefined);
    void lab
      .planStarterProject()
      .then((plan) => {
        setStarterPlan(plan);
        setNextPrompt(undefined);
        setError('');
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setBusy(''));
  }, [busy, lab]);
  const confirmStarterProject = React.useCallback(() => {
    if (!starterPlan || busy) return;
    let createdReceipt: ProjectTemplateCreationReceipt | undefined;
    setBusy('creating starter project');
    setStarterFailure(undefined);
    void lab
      .createStarterProject(starterPlan, 'local-user')
      .then(async (receipt) => {
        createdReceipt = receipt;
        setStarterReceipt(receipt);
        setStarterPlan(undefined);
        if (!onOpenStarterProject) return;
        setBusy('opening starter project');
        const workspace = await lab.openStarterProject(receipt);
        onOpenStarterProject(receipt, workspace);
        setStarterReceipt(undefined);
        setError('');
      })
      .catch((reason) => {
        setStarterFailure({
          stage: createdReceipt ? 'open' : 'create',
          message: reason instanceof Error ? reason.message : String(reason),
        });
        setError('');
      })
      .finally(() => setBusy(''));
  }, [busy, lab, onOpenStarterProject, starterPlan]);
  const openStarterProject = React.useCallback(() => {
    if (!starterReceipt || busy || !onOpenStarterProject) return;
    setBusy('opening starter project');
    setStarterFailure(undefined);
    void lab
      .openStarterProject(starterReceipt)
      .then((workspace) => {
        onOpenStarterProject(starterReceipt, workspace);
        setStarterReceipt(undefined);
        setStarterFailure(undefined);
        setError('');
      })
      .catch((reason) => {
        setStarterFailure({
          stage: 'open',
          message: reason instanceof Error ? reason.message : String(reason),
        });
        setError('');
      })
      .finally(() => setBusy(''));
  }, [busy, lab, onOpenStarterProject, starterReceipt]);
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
      if (action === 'lab-starter') {
        previewStarterProject();
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
    [
      busy,
      lab,
      previewStarterProject,
      profiles,
      report,
      runAgentWorkLabCase,
      selected,
      target,
    ],
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
  const handleAgentWorkLabMouse = React.useCallback(
    (mouseEvents: ReturnType<typeof decodeTerminalMouseInput>) => {
      const topOffset = autoplay ? 0 : 1;
      const viewportRows = workbenchViewportRows({
        dimensions: size,
        showHelp: showHelp || Boolean(autoplay),
        verdictDetail: autoplay
          ? 'THE CHAT ENDED. THE WORK DID NOT.'
          : undefined,
      });
      for (const event of mouseEvents) {
        const session = workbenchSessionAtPoint({
          dimensions: size,
          showHelp: showHelp || Boolean(autoplay),
          verdictDetail: autoplay
            ? 'THE CHAT ENDED. THE WORK DID NOT.'
            : undefined,
          column: event.column,
          row: event.row,
          topOffset,
        });
        if (event.kind === 'wheel') {
          if (!session) continue;
          const delta = event.button === 'wheel-up' ? 3 : -3;
          setSessionState((current) => ({
            ...current,
            scrollBack: {
              ...current.scrollBack,
              [session]: scrollWorkbenchSession({
                current: current.scrollBack[session],
                lineCount: current.buffers[session].length,
                viewportRows,
                delta,
              }),
            },
          }));
          setActiveFocus(`session-${session}`);
          onWorkspacePointer?.();
          continue;
        }
        if (event.kind !== 'press' || event.button !== 'left') continue;
        onWorkspacePointer?.();
        if (reportDetail) {
          if (
            workbenchReportReturnAtPoint({
              dimensions: size,
              column: event.column,
              row: event.row,
              topOffset,
            })
          ) {
            setReportDetail(undefined);
          }
          continue;
        }
        if (starterReceipt || starterPlan) continue;
        const action = workbenchActionAtPoint({
          actions: AGENT_WORK_LAB_POINTER_ACTIONS,
          column: event.column,
          row: event.row,
          topOffset,
        });
        if (action) {
          performSuiteActionRef.current(action);
          continue;
        }
        const result = workbenchReportAtPoint({
          dimensions: size,
          column: event.column,
          row: event.row,
          topOffset,
        });
        if (result && report) {
          setActiveFocus(result);
          setReportDetail(result);
          continue;
        }
        if (session) setActiveFocus(`session-${session}`);
      }
    },
    [
      autoplay,
      onWorkspacePointer,
      report,
      reportDetail,
      showHelp,
      size,
      starterPlan,
      starterReceipt,
    ],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const input = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(input);
      if (mouseEvents.length > 0) {
        handleAgentWorkLabMouse(mouseEvents);
        return;
      }
      if (isInputCaptured()) return;
      if (busy && (starterReceipt || starterPlan)) return;
      if (starterReceipt) {
        const action = agentWorkLabStarterReceiptInput(
          input,
          Boolean(onOpenStarterProject),
          Boolean(busy),
        );
        if (action === 'open') {
          openStarterProject();
        } else if (action === 'close') {
          setStarterReceipt(undefined);
          setStarterFailure(undefined);
        }
        return;
      }
      if (starterPlan) {
        if (input === '\r' || input === '\n') {
          confirmStarterProject();
          return;
        }
        if (isAgentWorkLabReportReturnInput(input)) {
          setStarterPlan(undefined);
          setStarterFailure(undefined);
          setError('');
        }
        return;
      }
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
        return setSessionState((current) => ({
          ...current,
          scrollBack: {
            ...current.scrollBack,
            [focusedSession]: scrollWorkbenchSession({
              current: current.scrollBack[focusedSession],
              lineCount: current.buffers[focusedSession].length,
              viewportRows: workbenchViewportRows({
                dimensions: size,
                showHelp,
              }),
              delta: 1,
            }),
          },
        }));
      if (input === '\u001b[B' && focusedSession)
        return setSessionState((current) => ({
          ...current,
          scrollBack: {
            ...current.scrollBack,
            [focusedSession]: scrollWorkbenchSession({
              current: current.scrollBack[focusedSession],
              lineCount: current.buffers[focusedSession].length,
              viewportRows: workbenchViewportRows({
                dimensions: size,
                showHelp,
              }),
              delta: -1,
            }),
          },
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
      if (input === 'n') return performSuiteAction('lab-starter');
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    activeFocus,
    busy,
    confirmStarterProject,
    exit,
    handleAgentWorkLabMouse,
    isInputCaptured,
    onOpenWork,
    onOpenStarterProject,
    openStarterProject,
    performSuiteAction,
    profiles,
    report,
    reportDetail,
    showHelp,
    size,
    starterPlan,
    starterReceipt,
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
      buffers={buffers}
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
      guideOverlay={
        starterFailure?.stage === 'create' && starterPlan
          ? {
              heading: 'STARTER PROJECT NOT CREATED',
              title: 'CREATION STOPPED SAFELY',
              lines: [
                starterFailure.message,
                `Destination: ${starterPlan.destination}`,
                'Kungfu rolled back the incomplete folder and captured no Work.',
                'Check folder access, then retry without leaving the Lab.',
              ],
              footer: 'Enter retries · Esc returns to Lab.',
            }
          : starterFailure?.stage === 'open' && starterReceipt
            ? {
                heading: 'PROJECT CREATED · OPEN FAILED',
                title: starterReceipt.destination,
                lines: [
                  starterFailure.message,
                  `${starterReceipt.files.length} files remain safely written and verified.`,
                  'Initial Work remains captured and pending explicit admission.',
                  'Retry opening this exact project workspace.',
                ],
                footer: 'Enter retries opening · Esc closes.',
              }
            : starterReceipt
              ? {
                  heading: 'STARTER PROJECT CREATED',
                  title: starterReceipt.destination,
                  lines: [
                    `${starterReceipt.files.length} reference files written and verified.`,
                    'Initial Work request captured with canonical Work authority.',
                    'Its state is pending admission: no Agent run or completion is claimed.',
                    busy
                      ? 'Selecting this folder as the active Kungfu project…'
                      : 'Open this folder as a Kungfu project to begin the real Work.',
                  ],
                  footer: busy
                    ? 'Opening project workspace · please wait.'
                    : onOpenStarterProject
                      ? 'Enter retries opening · Esc closes.'
                      : 'Press Esc or Enter to close.',
                }
              : starterPlan
                ? {
                    heading: 'START YOUR OWN WORK',
                    title: 'CREATE AGENT WORK STARTER?',
                    lines: [
                      `Destination: ${starterPlan.destination}`,
                      `${starterPlan.files.length} files · first Work: ${starterPlan.initialWork.title}`,
                      'Existing folders are never overwritten. Git is not changed.',
                      'The Work request is captured now; admission remains explicit.',
                    ],
                    footer: busy
                      ? 'Creating files and capturing Work · please wait.'
                      : 'Enter creates and opens · Esc cancels.',
                  }
                : undefined
      }
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
