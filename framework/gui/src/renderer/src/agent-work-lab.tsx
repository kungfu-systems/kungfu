// SPDX-License-Identifier: Apache-2.0

import type {
  AgentRuntimeCatalog,
  AgentWorkLab,
  AgentWorkLabAgentPlan,
  AgentWorkLabEvent,
  AgentWorkLabReport,
  AgentWorkLabStartupRoute,
  ProjectTemplateCreationReceipt,
  ProjectTemplatePlan,
} from '@kungfu-tech/api/capability';
import { agentWorkLabRunProgressLabel } from '@kungfu-tech/api/capability';
import {
  controlButtonStyle,
  controlSelectStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import {
  AGENT_WORK_LAB_CHECKS,
  AGENT_WORK_LAB_SUITE,
  type AgentWorkLabCaseId,
  agentWorkLabRecommendation,
} from '@kungfu-tech/kfx-agent-work-lab-experience';
import React from 'react';
import { createPortal } from 'react-dom';

export function shouldOpenAgentWorkLab(
  startupSurface: string,
  availableKfxCount: number,
): boolean {
  return startupSurface === 'agent-work-lab' || availableKfxCount === 0;
}

export function unavailableKfxMessage(discoveredKfxCount: number): string {
  return discoveredKfxCount === 0
    ? 'no extensions found on the extension path'
    : `${discoveredKfxCount} extensions discovered, but none admitted for GUI execution`;
}

export type AgentWorkLabMode = AgentWorkLabCaseId;

type VisualStatus =
  | 'ready'
  | 'waiting'
  | 'running'
  | 'correct'
  | 'warning'
  | 'undesirable';

type Milestone = {
  status: VisualStatus;
  title: string;
  detail: string;
};

type SessionStory = {
  title: string;
  subtitle: string;
  milestones: Milestone[];
};

type BehaviorFinding = {
  status: 'correct' | 'warning' | 'undesirable';
  title: string;
  detail: string;
};

type PlaybackLine = {
  session: 1 | 2;
  kind: 'system' | 'user' | 'agent' | 'tool' | 'output';
  origin: 'canonical-projection' | 'provider-observation';
  status: VisualStatus;
  command: string;
  detail: string;
};

export const AGENT_WORK_LAB_PLAYBACK_TIMING = {
  eventDelayMs: AGENT_WORK_LAB_SUITE.timing.eventIntervalMs,
  verdictDelayMs: AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs,
  reducedMotionDelayMs: AGENT_WORK_LAB_SUITE.timing.reducedMotionIntervalMs,
} as const;

export const AGENT_WORK_LAB_MODES: Array<{
  id: AgentWorkLabMode;
  label: string;
  description: string;
}> = AGENT_WORK_LAB_SUITE.cases.map((entry) => ({
  id: entry.id,
  label: entry.title,
  description: entry.description,
}));

const STATUS_META: Record<
  VisualStatus,
  { icon: string; label: string; color: string; background: string }
> = {
  ready: {
    icon: '◆',
    label: 'Ready',
    color: '#9cdcfe',
    background: '#102c3c',
  },
  waiting: {
    icon: '○',
    label: 'Waiting',
    color: '#cccccc',
    background: '#292929',
  },
  running: {
    icon: '↻',
    label: 'Running',
    color: '#dcdcaa',
    background: '#3b3215',
  },
  correct: {
    icon: '✓',
    label: 'Correct',
    color: '#4ec9b0',
    background: '#12352f',
  },
  warning: {
    icon: '!',
    label: 'Warning',
    color: '#d7ba7d',
    background: '#3b3018',
  },
  undesirable: {
    icon: '×',
    label: 'Undesirable',
    color: '#f48771',
    background: '#421f1b',
  },
};

const PLAYBACK_KIND_META: Record<
  PlaybackLine['kind'],
  { label: string; color: string; prompt: string }
> = {
  system: { label: 'system', color: '#9cdcfe', prompt: '◆' },
  user: { label: 'user', color: '#ce9178', prompt: '❯' },
  agent: { label: 'agent', color: '#4ec9b0', prompt: '▸' },
  tool: { label: 'tool', color: '#dcdcaa', prompt: '⚙' },
  output: { label: 'output', color: '#b5cea8', prompt: '←' },
};

function playbackSourceLabel(line: PlaybackLine): string {
  if (line.origin === 'provider-observation') {
    return `${PLAYBACK_KIND_META[line.kind].label}/live`;
  }
  return {
    system: 'kungfu',
    user: 'task',
    agent: 'agent/guide',
    tool: 'kungfu/tool',
    output: 'evidence',
  }[line.kind];
}

const CHECK_COPY: Record<string, { title: string; detail: string }> =
  Object.fromEntries(
    Object.entries(AGENT_WORK_LAB_CHECKS).map(([id, copy]) => [
      id,
      { title: copy.title, detail: copy.meaning },
    ]),
  );

function shortRoot(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

function waitForPlayback(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function eventStatus(
  events: AgentWorkLabEvent[],
  session: 1 | 2,
): VisualStatus {
  const event = [...events]
    .reverse()
    .find((row) => row.step === `session-${session}`);
  const status = event?.status ?? '';
  if (status === 'failed') return 'undesirable';
  if (
    (session === 1 &&
      ['ended-partial', 'partial', 'partial-first-attempt'].includes(status)) ||
    (session === 2 &&
      ['ended-complete', 'complete', 'continuation-completed'].includes(status))
  ) {
    return 'correct';
  }
  return event ? 'warning' : 'waiting';
}

export function agentWorkLabPlaybackLines(
  event: AgentWorkLabEvent,
): PlaybackLine[] {
  if (event.publicActivity) {
    const session = event.step.includes('session-1') ? 1 : 2;
    return [
      {
        session,
        kind: event.publicActivity.kind,
        origin: 'provider-observation',
        status:
          event.publicActivity.phase === 'completed' ? 'correct' : 'running',
        command: event.publicActivity.text,
        detail:
          event.publicActivity.kind === 'agent'
            ? 'A live public status message emitted by the selected Agent. It is not private reasoning.'
            : 'A live provider tool boundary. Command text and raw tool output remain redacted.',
      },
    ];
  }
  if (event.step === 'plan') {
    return [
      {
        session: 1,
        kind: 'system',
        origin: 'canonical-projection',
        status: 'ready',
        command: 'governed two-session plan ready',
        detail: `One task identity was sealed before either provider started · ${shortRoot(event.root)}`,
      },
    ];
  }
  if (event.step.endsWith('-start')) {
    const session = event.step.includes('session-1') ? 1 : 2;
    return [
      {
        session,
        kind: 'user',
        origin: 'canonical-projection',
        status: 'ready',
        command:
          session === 1
            ? 'Start one bounded task; stop after a provable partial result.'
            : 'Continue the same Work from governed state; prior chat is unavailable.',
        detail:
          session === 1
            ? 'The first process receives the Agent Work Lab task.'
            : 'The fresh process receives the same task identity, not Session 1 conversation.',
      },
      {
        session,
        kind: 'agent',
        origin: 'canonical-projection',
        status: 'running',
        command:
          session === 1
            ? 'I’m starting fresh. I’ll inspect the task state before I change anything.'
            : 'I’m a fresh process, so I’ll recover the task state instead of guessing.',
        detail:
          'A Kungfu preview of the expected safe working posture. Live Agent messages are labeled agent/live.',
      },
      {
        session,
        kind: 'tool',
        origin: 'canonical-projection',
        status: 'running',
        command: `Starting fresh provider process ${session} in the isolated workspace…`,
        detail:
          'The provider process is active. Kungfu waits for governed state evidence instead of treating terminal text as proof.',
      },
    ];
  }
  if (event.step === 'session-1') {
    const status = eventStatus([event], 1);
    return [
      ...(event.publicOutput?.lines ?? []).map((line) => ({
        session: 1 as const,
        kind: 'agent' as const,
        origin: 'provider-observation' as const,
        status,
        command: line,
        detail:
          'Actual provider stdout admitted through the exact Agent Work Lab marker; all other raw output remains redacted.',
      })),
      {
        session: 1,
        kind: 'tool',
        origin: 'canonical-projection',
        status,
        command: 'read_governed_state(session=1)',
        detail: 'Kungfu observes the fixture state after the provider exits.',
      },
      {
        session: 1,
        kind: 'output',
        origin: 'canonical-projection',
        status,
        command: `status=${event.status}`,
        detail: `Bounded state evidence · ${shortRoot(event.root)}`,
      },
      {
        session: 1,
        kind: 'system',
        origin: 'canonical-projection',
        status,
        command:
          status === 'correct'
            ? 'Kungfu verified the expected partial handoff state.'
            : 'Kungfu could not verify the expected partial handoff state.',
        detail:
          'This statement comes from the continuity oracle, not from Agent self-report.',
      },
    ];
  }
  if (event.step === 'session-2') {
    const status = eventStatus([event], 2);
    return [
      ...(event.publicOutput?.lines ?? []).map((line) => ({
        session: 2 as const,
        kind: 'agent' as const,
        origin: 'provider-observation' as const,
        status,
        command: line,
        detail:
          'Actual provider stdout admitted through the exact Agent Work Lab marker; all other raw output remains redacted.',
      })),
      {
        session: 2,
        kind: 'tool',
        origin: 'canonical-projection',
        status,
        command: 'read_governed_state(session=2)',
        detail:
          'Kungfu checks the same Work identity and the final ordered state.',
      },
      {
        session: 2,
        kind: 'output',
        origin: 'canonical-projection',
        status,
        command: `status=${event.status}`,
        detail: `Fresh-process continuation evidence · ${shortRoot(event.root)}`,
      },
      {
        session: 2,
        kind: 'system',
        origin: 'canonical-projection',
        status,
        command:
          status === 'correct'
            ? 'Kungfu verified continuation from the recorded partial state.'
            : 'Kungfu could not verify a correct continuation from recorded state.',
        detail:
          'This statement comes from the continuity oracle, not from Agent self-report.',
      },
    ];
  }
  const status =
    event.status === 'failed'
      ? 'undesirable'
      : event.step === 'assessment'
        ? event.status === 'qualified-with-residuals'
          ? 'warning'
          : 'correct'
        : 'ready';
  if (event.step === 'assessment') {
    return [
      {
        session: 2,
        kind: 'tool',
        origin: 'canonical-projection',
        status,
        command: 'run_continuity_oracle()',
        detail:
          'The canonical checks compare process identity, governed state, and expected completion.',
      },
      {
        session: 2,
        kind: 'output',
        origin: 'canonical-projection',
        status,
        command: `assessment=${event.status}`,
        detail: `Assessment proof · ${shortRoot(event.root)}`,
      },
    ];
  }
  return [
    {
      session: 1,
      kind: 'system',
      origin: 'canonical-projection',
      status,
      command: event.step,
      detail: `${event.status} · ${shortRoot(event.root)}`,
    },
  ];
}

export function agentWorkLabModeNeeds(mode: AgentWorkLabMode): {
  source: boolean;
  target: boolean;
} {
  return {
    source: mode !== 'offline-demo',
    target: mode === 'cross-agent',
  };
}

export function agentWorkLabSessionStories(
  mode: AgentWorkLabMode,
  running: boolean,
  report: AgentWorkLabReport | null,
  visibleEvents: AgentWorkLabEvent[] = [],
): [SessionStory, SessionStory] {
  const events = report?.events ?? visibleEvents;
  const firstObserved = events.some((row) => row.step === 'session-1');
  const secondObserved = events.some((row) => row.step === 'session-2');
  const secondStarted = events.some((row) => row.step === 'session-2-start');
  const firstStatus = firstObserved
    ? eventStatus(events, 1)
    : running
      ? 'running'
      : 'ready';
  const secondStatus = secondObserved
    ? eventStatus(events, 2)
    : running && secondStarted
      ? 'running'
      : 'waiting';
  const firstAgent =
    mode === 'offline-demo'
      ? 'Bundled Demo Agent'
      : mode === 'same-agent'
        ? 'Selected local agent'
        : 'Source local agent';
  const secondAgent =
    mode === 'offline-demo'
      ? 'Fresh Demo Agent process'
      : mode === 'same-agent'
        ? 'Same agent, fresh process'
        : 'Target local agent';

  return [
    {
      title: 'Session 1',
      subtitle: firstAgent,
      milestones: [
        {
          status: firstStatus,
          title: firstObserved
            ? 'Partial result saved'
            : running
              ? 'Task running'
              : 'Governed task',
          detail: firstObserved
            ? 'The first process stopped after leaving evidence that a fresh session can inspect.'
            : running
              ? 'Kungfu is waiting for Core evidence before declaring what this session actually did.'
              : 'It should claim the work, make bounded progress, record evidence, and end before completion.',
        },
        {
          status: firstObserved ? firstStatus : 'waiting',
          title: 'Stops at boundary',
          detail:
            'This creates a real continuity question for Session 2 instead of two unrelated successful runs.',
        },
      ],
    },
    {
      title: 'Session 2',
      subtitle: secondAgent,
      milestones: [
        {
          status: secondStatus,
          title: secondObserved
            ? 'Fresh process'
            : running
              ? 'Waiting for evidence'
              : 'Fresh start',
          detail: secondObserved
            ? 'The second process had to identify the task and prior state from Kungfu evidence.'
            : running
              ? 'Core returns one canonical report for the complete sequence, so the UI waits rather than guessing whether the handoff has occurred.'
              : 'No copied chat and no human re-explanation should be available.',
        },
        {
          status: secondObserved ? secondStatus : 'waiting',
          title: secondObserved
            ? 'Continued correctly'
            : 'Continue, not restart',
          detail:
            'Correct behavior is to recognize what Session 1 already did, perform only the remaining work, and preserve the same task identity.',
        },
      ],
    },
  ];
}

export function agentWorkLabBehaviorFindings(
  report: AgentWorkLabReport | null,
): BehaviorFinding[] {
  if (!report) {
    return [
      {
        status: 'correct',
        title: 'What good behavior looks like',
        detail:
          'Session 2 identifies the same task, uses the partial result, and continues without asking you to restate everything.',
      },
      {
        status: 'undesirable',
        title: 'What bad behavior looks like',
        detail:
          'The second session repeats finished work, loses task identity, relies on hidden context, or touches a real project.',
      },
      {
        status: 'warning',
        title: 'What remains a warning',
        detail:
          'Incomplete evidence, an unavailable agent, ambiguous state, or a provider confinement residual stays visible instead of becoming a pass.',
      },
    ];
  }
  const assessment = report.assessment as {
    oracleChecks?: Array<{ id: string; passed: boolean }>;
    residualRisks?: string[];
  };
  const checks = (assessment.oracleChecks ?? []).map((check) => {
    const copy = CHECK_COPY[check.id] ?? {
      title: check.id,
      detail: 'This canonical oracle check is included in the report.',
    };
    return {
      status: check.passed ? ('correct' as const) : ('undesirable' as const),
      ...copy,
    };
  });
  const residuals = (assessment.residualRisks ?? []).map((detail) => ({
    status: 'warning' as const,
    title: 'Qualified with a visible residual',
    detail,
  }));
  return [...checks, ...residuals];
}

function StatusBadge({ status }: { status: VisualStatus }) {
  const meta = STATUS_META[status];
  return (
    <output
      aria-label={meta.label}
      className={status === 'running' ? 'kf-lab-running-badge' : undefined}
      style={{
        ...mono,
        display: 'inline-flex',
        gap: 5,
        alignItems: 'center',
        padding: '3px 7px',
        borderRadius: 999,
        color: meta.color,
        background: meta.background,
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </output>
  );
}

function InfoTip({
  label,
  text,
  placement = 'bottom',
}: {
  label: string;
  text: string;
  placement?: 'top' | 'bottom';
}) {
  const tooltipId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const tooltipRef = React.useRef<HTMLSpanElement>(null);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const margin = 12;
    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(180, Math.min(320, window.innerWidth - margin * 2));
    const height = tooltipRef.current?.getBoundingClientRect().height ?? 80;
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const useBottom =
      placement === 'bottom'
        ? below >= height || below >= above
        : !(above >= height || above >= below);
    const preferredTop = useBottom
      ? rect.bottom + gap
      : rect.top - height - gap;
    const top = Math.max(
      margin,
      Math.min(preferredTop, window.innerHeight - height - margin),
    );
    const centeredLeft = rect.left + rect.width / 2;
    const left = Math.max(
      margin + width / 2,
      Math.min(centeredLeft, window.innerWidth - margin - width / 2),
    );
    setPosition({ left, top, width });
  }, [placement]);
  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);
  return (
    <>
      <span
        className="kf-lab-tip"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          ref={triggerRef}
          type="button"
          className="kf-lab-tip-trigger"
          aria-label={label}
          aria-describedby={open ? tooltipId : undefined}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          ?
        </button>
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="kf-lab-tip-content"
              style={{
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                width: position?.width ?? 240,
                opacity: position ? 1 : 0,
              }}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function SessionColumn({
  story,
  session,
  lines,
  running,
}: {
  story: SessionStory;
  session: 1 | 2;
  lines: PlaybackLine[];
  running: boolean;
}) {
  const sessionLines = lines.filter((line) => line.session === session);
  const lineCount = sessionLines.length;
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && lineCount > 0) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [lineCount]);
  return (
    <article
      className="kf-lab-session-column"
      style={{
        ...panelStyle,
        minWidth: 0,
        minHeight: 0,
        padding: 12,
        background: '#181818',
        border: '1px solid #3c3c3c',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, color: '#9cdcfe', fontSize: 11 }}>
            {story.title.toUpperCase()}
          </div>
          <h2
            style={{
              margin: '2px 0 0',
              fontSize: 16,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {story.subtitle}
          </h2>
        </div>
        <StatusBadge status={story.milestones[0]?.status ?? 'waiting'} />
      </header>
      <div
        aria-label={`${story.title} milestones`}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 7,
          marginBottom: 8,
          paddingBottom: 2,
        }}
      >
        {story.milestones.map((milestone) => (
          <span
            key={milestone.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              padding: '4px 7px',
              borderRadius: 5,
              color: STATUS_META[milestone.status].color,
              background: STATUS_META[milestone.status].background,
              fontSize: 11,
              overflow: 'visible',
            }}
          >
            <span aria-hidden="true">{STATUS_META[milestone.status].icon}</span>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {milestone.title}
            </span>
            <InfoTip
              label={`Explain ${milestone.title}`}
              text={milestone.detail}
            />
          </span>
        ))}
      </div>
      <div
        aria-live="polite"
        aria-label={`${story.title} public activity transcript`}
        className="kf-lab-terminal"
        style={{
          ...mono,
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: 6,
          background: '#090b0c',
          border: '1px solid #343a3d',
          fontSize: 11,
          lineHeight: 1.45,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '8px 10px',
            color: '#858585',
            background: '#17191a',
            borderBottom: '1px solid #2b3032',
          }}
        >
          <span style={{ color: '#f48771' }}>●</span>
          <span style={{ color: '#d7ba7d' }}>●</span>
          <span style={{ color: '#4ec9b0' }}>●</span>
          <span style={{ marginLeft: 5 }}>
            agent@work-lab · session-{session}
          </span>
          {running ? (
            <span className="kf-lab-live-dots" style={{ marginLeft: 'auto' }}>
              live
            </span>
          ) : null}
        </div>
        <div
          ref={transcriptRef}
          className="kf-lab-terminal-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: 12,
          }}
        >
          <div style={{ color: '#6fa8bd', marginBottom: 10 }}>
            PUBLIC ACTIVITY TRANSCRIPT
          </div>
          {sessionLines.length ? (
            sessionLines.map((line, index) => {
              const kind = PLAYBACK_KIND_META[line.kind];
              return (
                <div
                  className="kf-lab-event-line"
                  key={`${line.kind}-${line.command}-${index}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 86px minmax(0, 1fr) auto',
                    gap: 7,
                    marginTop: index ? 8 : 0,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: '#555' }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span style={{ color: kind.color }}>
                    {kind.prompt} {playbackSourceLabel(line)}
                  </span>
                  <span style={{ color: STATUS_META[line.status].color }}>
                    {line.command}
                  </span>
                  <span
                    aria-label={line.detail}
                    title={line.detail}
                    style={{ color: '#666', cursor: 'help' }}
                  >
                    ⓘ
                  </span>
                </div>
              );
            })
          ) : (
            <div style={{ color: '#666' }}>
              {running
                ? 'Waiting for the first canonical activity boundary…'
                : 'Agent activity will appear here one line at a time.'}
            </div>
          )}
          {running ? (
            <div style={{ marginTop: 10, color: '#4ec9b0' }}>
              <span className="kf-lab-terminal-cursor">▌</span>
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: '6px 10px',
            color: '#626262',
            borderTop: '1px solid #1f2324',
            fontSize: 10,
          }}
        >
          PRIVATE REASONING HIDDEN · COMMANDS + RAW OUTPUT REDACTED · PUBLIC
          STATUS + TOOL BOUNDARIES ONLY
        </div>
      </div>
    </article>
  );
}

function HandoffBridge({
  report,
  events,
  running,
}: {
  report: AgentWorkLabReport | null;
  events: AgentWorkLabEvent[];
  running: boolean;
}) {
  const firstComplete = events.some((event) => event.step === 'session-1');
  const secondComplete = events.some((event) => event.step === 'session-2');
  const proven = Boolean(report && report.status !== 'failed');
  const active = running && firstComplete && !secondComplete;
  return (
    <section
      aria-label="Kungfu handoff bridge"
      className="kf-lab-handoff"
      style={{
        padding: '7px 12px',
        border: `1px solid ${proven ? '#287f70' : active ? '#9b7a31' : '#3c3c3c'}`,
        borderRadius: 8,
        background: proven ? '#102c28' : active ? '#332b18' : '#202020',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          textAlign: 'center',
        }}
      >
        <strong>Session 1</strong>
        <span aria-hidden="true">──▶</span>
        <strong
          className={active ? 'kf-lab-handoff-active' : undefined}
          style={{ color: proven ? '#4ec9b0' : active ? '#d7ba7d' : '#b8b8b8' }}
        >
          {proven
            ? 'Handoff proved'
            : active
              ? 'Evidence sealed · fresh continuation starting'
              : secondComplete
                ? 'Both sessions observed · assessment pending'
                : 'Governed handoff'}
        </strong>
        <InfoTip
          label="Explain the governed handoff"
          text="Retained: task identity, Work reference, partial state, evidence, and next action. Excluded: prior transcript, credentials, private reasoning, and unadmitted provider output."
        />
        <span aria-hidden="true">──▶</span>
        <strong>Session 2</strong>
      </div>
    </section>
  );
}

function ReportDock({
  report,
  visibleFindingCount,
  activeFindingIndex,
  running,
  progress,
  agentPlan,
  targetPlan,
  error,
  onCreateStarter,
  onOpenExisting,
}: {
  report: AgentWorkLabReport | null;
  visibleFindingCount: number;
  activeFindingIndex: number;
  running: boolean;
  progress: string;
  agentPlan: AgentWorkLabAgentPlan | null;
  targetPlan: AgentWorkLabAgentPlan | null;
  error: string;
  onCreateStarter: () => void;
  onOpenExisting?: () => void;
}) {
  const passed = Boolean(report && report.status !== 'failed');
  const findings = agentWorkLabBehaviorFindings(report);
  const visibleFindings = report
    ? findings.slice(0, visibleFindingCount)
    : findings;
  const technicalDetail = report
    ? `report ${shortRoot(report.reportRoot)} · plan ${shortRoot(
        report.planRoot,
      )} · identity ${shortRoot(report.identityRoot)} · attempts ${
        report.sessionAttempts.length
      } · credential contents read: no`
    : agentPlan
      ? `source plan ${shortRoot(agentPlan.planRoot)} · continuation plan ${
          targetPlan ? shortRoot(targetPlan.planRoot) : 'same selected agent'
        } · credential contents read: no`
      : 'No local-agent plan prepared. The offline demo needs no provider credentials.';
  return (
    <section
      aria-label={report ? 'Agent Work Lab result' : 'Behavior guide'}
      aria-live="polite"
      className={`kf-lab-report-dock${report ? ' kf-lab-result-enter' : ''}`}
      style={{
        ...panelStyle,
        minHeight: 0,
        padding: 10,
        border: `1px solid ${
          report ? (passed ? '#287f70' : '#a14a3a') : '#3c3c3c'
        }`,
        background: report ? (passed ? '#102a26' : '#351b18') : '#202020',
        display: 'grid',
        gridTemplateColumns: 'minmax(250px, 0.9fr) minmax(0, 2fr)',
        gap: 10,
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusBadge
            status={
              report
                ? passed
                  ? 'correct'
                  : 'undesirable'
                : running
                  ? 'running'
                  : 'ready'
            }
          />
          <strong>
            {report
              ? passed
                ? 'Continuity proved'
                : 'Continuity not proved'
              : running
                ? 'Observing both sessions'
                : 'What this test judges'}
          </strong>
          <InfoTip
            placement="top"
            label="Explain the Agent Work Lab result"
            text={
              report
                ? report.meaning
                : 'Good: Session 2 continues the same governed work. Bad: it restarts, loses identity, relies on copied chat, or cannot prove the exact final state.'
            }
          />
        </div>
        <div
          style={{
            marginTop: 5,
            color: report ? '#d4f2eb' : '#b8b8b8',
            fontSize: 12,
          }}
        >
          {running && progress
            ? progress
            : 'Kungfu makes cross-session work continuable and provable.'}
          <InfoTip
            placement="top"
            label="Explain Kungfu value"
            text="Kungfu does not answer the task for the agent. It preserves governed identity, state, evidence, and next action so another session or agent can continue without guesswork."
          />
          <InfoTip
            placement="top"
            label="Show technical evidence"
            text={technicalDetail}
          />
        </div>
        {error ? (
          <div role="alert" style={{ ...mono, color: '#f48771', marginTop: 5 }}>
            {error}
          </div>
        ) : null}
        {report ? (
          <div
            aria-label="Continue with your own work"
            style={{
              display: 'flex',
              gap: 7,
              flexWrap: 'wrap',
              marginTop: 8,
            }}
          >
            <button type="button" onClick={onCreateStarter}>
              Create Starter Project
            </button>
            {onOpenExisting ? (
              <button type="button" onClick={onOpenExisting}>
                Open Existing Project
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        className="kf-lab-finding-strip"
        style={{
          display: 'flex',
          gap: 7,
          minWidth: 0,
          overflowX: 'auto',
          padding: 2,
        }}
      >
        {visibleFindings.map((finding, index) => (
          <div
            key={`${finding.status}-${finding.title}`}
            className={`kf-lab-verdict-card${
              index === activeFindingIndex ? ' kf-lab-verdict-focus' : ''
            }`}
            title={finding.detail}
            style={{
              minWidth: 190,
              maxWidth: 260,
              padding: '7px 9px',
              borderRadius: 6,
              background: '#181818',
              border: '1px solid #3c3c3c',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <StatusBadge status={finding.status} />
            <strong
              style={{
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {finding.title}
            </strong>
            <span
              aria-label={finding.detail}
              style={{ marginLeft: 'auto', color: '#777', cursor: 'help' }}
            >
              ⓘ
            </span>
          </div>
        ))}
        {report && visibleFindings.length === 0 ? (
          <span style={{ color: '#858585', fontSize: 12 }}>
            Verdict checks will appear one by one…
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function AgentWorkLabPanel({
  lab,
  startup,
  onOpenWork,
  onOpenExistingProject,
  onOpenStarterProject,
  onComplete,
}: {
  lab: AgentWorkLab;
  startup: AgentWorkLabStartupRoute;
  onOpenWork?: () => void;
  onOpenExistingProject?: () => void;
  onOpenStarterProject?: (destination: string) => void;
  onComplete?: () => void;
}) {
  const [mode, setMode] = React.useState<AgentWorkLabMode>('offline-demo');
  const [agents, setAgents] = React.useState<AgentRuntimeCatalog | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState('');
  const [targetAgent, setTargetAgent] = React.useState('');
  const [agentPlan, setAgentPlan] =
    React.useState<AgentWorkLabAgentPlan | null>(null);
  const [targetPlan, setTargetPlan] =
    React.useState<AgentWorkLabAgentPlan | null>(null);
  const [report, setReport] = React.useState<AgentWorkLabReport | null>(null);
  const [visibleEvents, setVisibleEvents] = React.useState<AgentWorkLabEvent[]>(
    [],
  );
  const [visiblePlaybackLines, setVisiblePlaybackLines] = React.useState<
    PlaybackLine[]
  >([]);
  const [visibleFindingCount, setVisibleFindingCount] = React.useState(0);
  const [activeFindingIndex, setActiveFindingIndex] = React.useState(-1);
  const [showNextRecommendation, setShowNextRecommendation] =
    React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [starterPlan, setStarterPlan] =
    React.useState<ProjectTemplatePlan | null>(null);
  const [starterReceipt, setStarterReceipt] =
    React.useState<ProjectTemplateCreationReceipt | null>(null);
  const [starterBusy, setStarterBusy] = React.useState(false);
  const [runProgress, setRunProgress] = React.useState<{
    startedAt: number;
    lastEventAt: number;
    eventCount: number;
    phase: 'running' | 'assessing';
  } | null>(null);
  const [progressNow, setProgressNow] = React.useState(() => Date.now());
  const playbackRunRef = React.useRef(0);

  React.useEffect(() => {
    if (!runProgress) return undefined;
    setProgressNow(Date.now());
    const timer = window.setInterval(
      () => setProgressNow(Date.now()),
      AGENT_WORK_LAB_SUITE.timing.quietProgressIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [runProgress]);
  React.useEffect(() => {
    if (!showNextRecommendation) return undefined;
    const timer = window.setTimeout(
      () => setShowNextRecommendation(false),
      AGENT_WORK_LAB_SUITE.timing.recommendationDurationMs,
    );
    return () => window.clearTimeout(timer);
  }, [showNextRecommendation]);

  const discover = React.useCallback(async () => {
    setBusy('discover');
    try {
      const catalog = await lab.discoverAgents();
      setAgents(catalog);
      const recommended =
        catalog.defaultProfileId ||
        catalog.recommendedProfileId ||
        catalog.discovered[0]?.profile.id ||
        catalog.configured[0]?.id ||
        '';
      setSelectedAgent(recommended);
      setTargetAgent(
        catalog.discovered
          .map((row) => row.profile.id)
          .find((id) => id !== recommended) || recommended,
      );
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }, [lab]);

  const previewStarterProject = React.useCallback(async () => {
    setStarterBusy(true);
    setStarterReceipt(null);
    try {
      setStarterPlan(await lab.planStarterProject());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarterBusy(false);
    }
  }, [lab]);

  const createStarterProject = React.useCallback(async () => {
    if (!starterPlan) return;
    setStarterBusy(true);
    try {
      const receipt = await lab.createStarterProject(starterPlan, 'local-user');
      setStarterReceipt(receipt);
      setStarterPlan(null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarterBusy(false);
    }
  }, [lab, starterPlan]);

  React.useEffect(() => {
    void discover();
  }, [discover]);

  const resetRun = (nextMode: AgentWorkLabMode) => {
    playbackRunRef.current += 1;
    setMode(nextMode);
    setAgentPlan(null);
    setTargetPlan(null);
    setReport(null);
    setVisibleEvents([]);
    setVisiblePlaybackLines([]);
    setVisibleFindingCount(0);
    setActiveFindingIndex(-1);
    setShowNextRecommendation(false);
    setRunProgress(null);
    setError('');
  };

  const prepareAgent = async () => {
    if (!selectedAgent) return;
    setBusy('prepare');
    try {
      const target = mode === 'cross-agent' ? targetAgent : selectedAgent;
      const [sourcePlan, continuationPlan] = await Promise.all([
        lab.planAgent(selectedAgent),
        lab.planAgent(target),
      ]);
      setAgentPlan(sourcePlan);
      setTargetPlan(continuationPlan);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };

  const run = async () => {
    const runId = playbackRunRef.current + 1;
    playbackRunRef.current = runId;
    setBusy('run');
    setReport(null);
    setVisibleEvents([]);
    setVisiblePlaybackLines([]);
    setVisibleFindingCount(0);
    setActiveFindingIndex(-1);
    setShowNextRecommendation(false);
    const startedAt = Date.now();
    setProgressNow(startedAt);
    setRunProgress({
      startedAt,
      lastEventAt: startedAt,
      eventCount: 0,
      phase: 'running',
    });
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const eventDelay = reducedMotion
      ? AGENT_WORK_LAB_PLAYBACK_TIMING.reducedMotionDelayMs
      : AGENT_WORK_LAB_PLAYBACK_TIMING.eventDelayMs;
    const verdictDelay = reducedMotion
      ? AGENT_WORK_LAB_PLAYBACK_TIMING.reducedMotionDelayMs
      : AGENT_WORK_LAB_PLAYBACK_TIMING.verdictDelayMs;
    let playbackQueue = Promise.resolve();
    const receiveEvent = (event: AgentWorkLabEvent) => {
      const lines = agentWorkLabPlaybackLines(event);
      playbackQueue = playbackQueue.then(async () => {
        for (const line of lines) {
          await waitForPlayback(eventDelay);
          if (playbackRunRef.current !== runId) return;
          setVisiblePlaybackLines((current) => [...current, line]);
        }
        if (playbackRunRef.current !== runId) return;
        setVisibleEvents((current) => [...current, event]);
        setRunProgress((current) =>
          current
            ? {
                ...current,
                lastEventAt: Date.now(),
                eventCount: current.eventCount + 1,
              }
            : current,
        );
      });
    };
    try {
      const nextReport =
        mode === 'offline-demo'
          ? await lab.runDemo(receiveEvent)
          : mode === 'cross-agent'
            ? await lab.runMigration(selectedAgent, targetAgent, receiveEvent)
            : await lab.runAgent(selectedAgent, receiveEvent);
      await playbackQueue;
      if (playbackRunRef.current !== runId) return;
      setReport(nextReport);
      setRunProgress((current) =>
        current ? { ...current, phase: 'assessing' } : current,
      );
      const findings = agentWorkLabBehaviorFindings(nextReport);
      await waitForPlayback(verdictDelay);
      for (let index = 0; index < findings.length; index += 1) {
        if (playbackRunRef.current !== runId) return;
        setVisibleFindingCount(index + 1);
        setActiveFindingIndex(index);
        await waitForPlayback(verdictDelay);
      }
      if (playbackRunRef.current !== runId) return;
      setActiveFindingIndex(-1);
      setShowNextRecommendation(true);
      setError('');
      if (nextReport.status !== 'failed') onComplete?.();
    } catch (reason) {
      if (playbackRunRef.current === runId) {
        setError((reason as Error).message);
      }
    } finally {
      if (playbackRunRef.current === runId) {
        setBusy('');
        setRunProgress(null);
      }
    }
  };

  const options = Array.from(
    new Map(
      [
        ...(agents?.configured ?? []),
        ...(agents?.discovered.map((row) => row.profile) ?? []),
      ].map((profile) => [profile.id, profile]),
    ).values(),
  );
  const needs = agentWorkLabModeNeeds(mode);
  const running = busy === 'run';
  const prepared =
    mode === 'offline-demo' ||
    (Boolean(agentPlan) && (mode !== 'cross-agent' || Boolean(targetPlan)));
  const canRun =
    prepared &&
    !busy &&
    (!needs.source || Boolean(selectedAgent)) &&
    (!needs.target || (Boolean(targetAgent) && selectedAgent !== targetAgent));
  const [sessionOne, sessionTwo] = agentWorkLabSessionStories(
    mode,
    running,
    report,
    visibleEvents,
  );
  const selectedMode = AGENT_WORK_LAB_MODES.find((row) => row.id === mode) ?? {
    id: mode,
    label: 'Unknown test mode',
    description: 'Choose a supported Agent Work Lab mode.',
  };
  const nextRecommendation = agentWorkLabRecommendation(mode);
  const progress = runProgress
    ? agentWorkLabRunProgressLabel({
        elapsedMs: progressNow - runProgress.startedAt,
        quietMs: progressNow - runProgress.lastEventAt,
        eventCount: runProgress.eventCount,
        phase: runProgress.phase,
      })
    : '';

  return (
    <section
      className="kf-lab-frame"
      style={{
        ...panelStyle,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
        padding: 14,
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
        gap: 10,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, color: '#9cdcfe', fontSize: 11 }}>
            AGENT WORK LAB ·{' '}
            {AGENT_WORK_LAB_SUITE.collection.title.toUpperCase()}
          </div>
          <h1
            style={{
              margin: '2px 0 0',
              fontSize: 20,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Can a fresh agent session continue the same work?
            <InfoTip
              label="Explain this Lab"
              text="This Lab runs one bounded task across two independent sessions. Session 1 begins and leaves governed evidence. Session 2 receives no prior chat and must discover the same work, then continue from the correct point."
            />
          </h1>
        </div>
        {onOpenWork ? (
          <button
            type="button"
            onClick={onOpenWork}
            style={controlButtonStyle()}
          >
            Back to Work
          </button>
        ) : null}
      </header>

      <section
        aria-label="Test configuration"
        className="kf-lab-controls"
        style={{
          ...panelStyle,
          padding: 10,
          background: '#202020',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 9,
            alignItems: 'end',
          }}
        >
          <label>
            <strong style={{ display: 'block', marginBottom: 4 }}>
              Test mode
              <InfoTip
                label={`Explain ${selectedMode.label}`}
                text={selectedMode.description}
              />
            </strong>
            <select
              aria-label="Test mode"
              value={mode}
              disabled={Boolean(busy)}
              onChange={(event) =>
                resetRun(event.target.value as AgentWorkLabMode)
              }
              style={{ ...controlSelectStyle, width: '100%' }}
            >
              {AGENT_WORK_LAB_MODES.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>
          {needs.source ? (
            <label>
              <strong style={{ display: 'block', marginBottom: 4 }}>
                Session 1 agent
              </strong>
              <select
                aria-label="Session 1 agent"
                value={selectedAgent}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setSelectedAgent(event.target.value);
                  setAgentPlan(null);
                  setTargetPlan(null);
                  setReport(null);
                  setVisibleEvents([]);
                  setVisiblePlaybackLines([]);
                  setVisibleFindingCount(0);
                  setActiveFindingIndex(-1);
                }}
                style={{ ...controlSelectStyle, width: '100%' }}
              >
                <option value="">No local agent discovered</option>
                {options.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} · {profile.launch.executable}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {needs.target ? (
            <label>
              <strong style={{ display: 'block', marginBottom: 4 }}>
                Session 2 agent
              </strong>
              <select
                aria-label="Session 2 agent"
                value={targetAgent}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setTargetAgent(event.target.value);
                  setTargetPlan(null);
                  setReport(null);
                  setVisibleEvents([]);
                  setVisiblePlaybackLines([]);
                  setVisibleFindingCount(0);
                  setActiveFindingIndex(-1);
                }}
                style={{ ...controlSelectStyle, width: '100%' }}
              >
                <option value="">No continuation agent discovered</option>
                {options.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} · {profile.launch.executable}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {needs.source ? (
              <button
                type="button"
                disabled={
                  !selectedAgent ||
                  (needs.target &&
                    (!targetAgent || selectedAgent === targetAgent)) ||
                  Boolean(busy)
                }
                onClick={prepareAgent}
                style={controlButtonStyle({
                  disabled:
                    !selectedAgent ||
                    (needs.target &&
                      (!targetAgent || selectedAgent === targetAgent)) ||
                    Boolean(busy),
                })}
              >
                {busy === 'prepare' ? 'Preparing…' : '1 · Prepare exact test'}
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canRun}
              onClick={run}
              style={controlButtonStyle({
                tone: 'primary',
                disabled: !canRun,
              })}
            >
              {running
                ? 'Running canonical test…'
                : needs.source
                  ? '2 · Start test'
                  : 'Start offline demo'}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={discover}
              style={controlButtonStyle({ disabled: Boolean(busy) })}
            >
              Refresh agents
            </button>
            <InfoTip
              label="Show startup safety status"
              text={`startup ${startup.state} · ${startup.reasonCode} · no real workspace write${
                startup.route === 'diagnostic' ? ` · ${startup.message}` : ''
              }`}
            />
          </div>
        </div>
      </section>

      <section
        aria-label="Two-session experiment"
        className="kf-lab-session-stage"
        style={{
          minHeight: 0,
          display: 'grid',
          gridTemplateRows: 'minmax(0, 1fr) auto',
          gap: 8,
        }}
      >
        <div
          className="kf-lab-session-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(320px, 1fr))',
            gap: 12,
            minHeight: 0,
            overflowX: 'auto',
          }}
        >
          <SessionColumn
            story={sessionOne}
            session={1}
            lines={visiblePlaybackLines}
            running={running}
          />
          <SessionColumn
            story={sessionTwo}
            session={2}
            lines={visiblePlaybackLines}
            running={running}
          />
        </div>
        <HandoffBridge
          report={report}
          events={visibleEvents}
          running={running}
        />
      </section>

      <ReportDock
        report={report}
        visibleFindingCount={visibleFindingCount}
        activeFindingIndex={activeFindingIndex}
        running={running}
        progress={progress}
        agentPlan={agentPlan}
        targetPlan={targetPlan}
        error={error}
        onCreateStarter={() => void previewStarterProject()}
        onOpenExisting={onOpenExistingProject}
      />
      {(starterPlan || starterReceipt) && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !starterBusy) {
                  setStarterPlan(null);
                  setStarterReceipt(null);
                }
              }}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 11000,
                display: 'grid',
                placeItems: 'center',
                padding: 24,
                background: 'rgba(4, 7, 9, 0.82)',
              }}
            >
              <dialog
                open
                aria-label={
                  starterReceipt
                    ? 'Starter project created'
                    : 'Create starter project'
                }
                style={{
                  ...panelStyle,
                  width: 'min(620px, calc(100vw - 48px))',
                  padding: 20,
                  border: '2px solid #4ec9b0',
                  color: '#f0f0f0',
                  background: '#101820',
                  boxShadow: '0 18px 64px rgba(0, 0, 0, 0.75)',
                }}
              >
                <div style={{ ...mono, color: '#4ec9b0', fontSize: 11 }}>
                  {starterReceipt
                    ? 'YOUR FIRST REAL AGENT WORK PROJECT'
                    : 'PREVIEW BEFORE CREATE'}
                </div>
                <h2 style={{ margin: '8px 0', fontSize: 20 }}>
                  {starterReceipt
                    ? 'Starter Project created'
                    : 'Create Agent Work Starter?'}
                </h2>
                <p style={{ color: '#d4d4d4', lineHeight: 1.5 }}>
                  {starterReceipt
                    ? `${starterReceipt.files.length} reference files were written and verified. The initial Work request is captured and remains pending explicit admission.`
                    : `${starterPlan?.files.length ?? 0} editable files will be created. Kungfu will capture the first Work request, but it will not run an Agent, claim completion, overwrite a folder, or change Git.`}
                </p>
                <div
                  style={{
                    ...mono,
                    padding: 10,
                    border: '1px solid #3c3c3c',
                    borderRadius: 5,
                    color: '#9cdcfe',
                    background: '#181818',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {starterReceipt?.destination ?? starterPlan?.destination}
                </div>
                {!starterReceipt && starterPlan ? (
                  <ul style={{ color: '#cfcfcf', lineHeight: 1.55 }}>
                    <li>First Work: {starterPlan.initialWork.title}</li>
                    <li>Existing destinations are refused, never merged.</li>
                    <li>Admission and execution remain explicit next steps.</li>
                  </ul>
                ) : null}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 8,
                    marginTop: 16,
                  }}
                >
                  <button
                    type="button"
                    disabled={starterBusy}
                    onClick={() => {
                      setStarterPlan(null);
                      setStarterReceipt(null);
                    }}
                  >
                    {starterReceipt ? 'Close' : 'Cancel'}
                  </button>
                  {starterReceipt ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenStarterProject?.(starterReceipt.destination)
                      }
                    >
                      Open Starter Project
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={starterBusy}
                      onClick={() => void createStarterProject()}
                    >
                      {starterBusy ? 'Creating…' : 'Create Project'}
                    </button>
                  )}
                </div>
              </dialog>
            </div>,
            document.body,
          )
        : null}
      {showNextRecommendation && typeof document !== 'undefined'
        ? createPortal(
            <output
              aria-live="polite"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10000,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(6, 8, 10, 0.78)',
              }}
            >
              <div
                style={{
                  ...panelStyle,
                  width: 'min(520px, calc(100vw - 48px))',
                  padding: 20,
                  border: '2px solid #d7ba7d',
                  background: '#101820',
                  boxShadow: '0 18px 64px rgba(0, 0, 0, 0.72)',
                }}
              >
                <div style={{ ...mono, color: '#d7ba7d', fontSize: 11 }}>
                  WHAT TO TRY NEXT
                </div>
                <h2 style={{ margin: '8px 0', fontSize: 19 }}>
                  {nextRecommendation.title}
                </h2>
                <p style={{ margin: 0, color: '#d4d4d4', lineHeight: 1.5 }}>
                  {nextRecommendation.instruction}
                </p>
                <div
                  style={{
                    marginTop: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span style={{ ...mono, color: '#858585', fontSize: 11 }}>
                    Closes automatically in 5 seconds
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowNextRecommendation(false)}
                    style={{
                      ...mono,
                      border: '1px solid #666',
                      borderRadius: 4,
                      padding: '5px 9px',
                      color: '#f3f3f3',
                      background: '#292929',
                      cursor: 'pointer',
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </output>,
            document.body,
          )
        : null}
      <style>{`
        .kf-lab-tip {
          position: relative;
          display: inline-flex;
          align-items: center;
          margin-left: 5px;
          vertical-align: middle;
        }
        .kf-lab-tip-trigger {
          width: 17px;
          height: 17px;
          padding: 0;
          border: 1px solid #555;
          border-radius: 999px;
          color: #9cdcfe;
          background: #242424;
          font: 11px/15px ui-monospace, SFMono-Regular, Menlo, monospace;
          cursor: help;
        }
        .kf-lab-tip-content {
          position: fixed;
          z-index: 9999;
          display: block;
          padding: 9px 10px;
          border: 1px solid #555;
          border-radius: 6px;
          color: #e4e4e4;
          background: #101112;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          font-size: 12px;
          font-weight: 400;
          line-height: 1.45;
          text-align: left;
          white-space: normal;
          transform: translateX(-50%);
          pointer-events: none;
        }
        .kf-lab-terminal-scroll,
        .kf-lab-finding-strip,
        .kf-lab-session-grid {
          scrollbar-gutter: stable;
        }
        @keyframes kf-lab-line-enter {
          from { opacity: 0; transform: translateY(7px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes kf-lab-pulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        @keyframes kf-lab-verdict-emphasis {
          0% { transform: scale(0.985); box-shadow: 0 0 0 rgba(78, 201, 176, 0); }
          45% { transform: scale(1.015); box-shadow: 0 0 22px rgba(78, 201, 176, 0.28); }
          100% { transform: scale(1); box-shadow: 0 0 0 rgba(78, 201, 176, 0); }
        }
        .kf-lab-event-line,
        .kf-lab-result-enter,
        .kf-lab-verdict-card {
          animation: kf-lab-line-enter 280ms ease-out both;
        }
        .kf-lab-running-badge,
        .kf-lab-live-dots,
        .kf-lab-handoff-active,
        .kf-lab-terminal-cursor {
          animation: kf-lab-pulse 1.15s ease-in-out infinite;
        }
        .kf-lab-verdict-focus {
          border-color: #4ec9b0 !important;
          animation: kf-lab-verdict-emphasis ${AGENT_WORK_LAB_SUITE.timing.verdictIntervalMs}ms ease-out both;
        }
        @media (prefers-reduced-motion: reduce) {
          .kf-lab-event-line,
          .kf-lab-result-enter,
          .kf-lab-verdict-card,
          .kf-lab-running-badge,
          .kf-lab-live-dots,
          .kf-lab-handoff-active,
          .kf-lab-terminal-cursor,
          .kf-lab-verdict-focus {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>
    </section>
  );
}
