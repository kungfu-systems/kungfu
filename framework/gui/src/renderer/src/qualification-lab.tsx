// SPDX-License-Identifier: Apache-2.0

import type {
  AgentRuntimeCatalog,
  QualificationLab,
  QualificationLabAgentPlan,
  QualificationLabEvent,
  QualificationLabReport,
  QualificationLabStartupRoute,
} from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

export type QualificationMode = 'offline-demo' | 'same-agent' | 'cross-agent';

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
  status: VisualStatus;
  command: string;
  detail: string;
};

export const QUALIFICATION_PLAYBACK_TIMING = {
  eventDelayMs: 1000,
  verdictDelayMs: 520,
  reducedMotionDelayMs: 24,
} as const;

export const QUALIFICATION_MODES: Array<{
  id: QualificationMode;
  label: string;
  description: string;
}> = [
  {
    id: 'offline-demo',
    label: 'Offline demo',
    description:
      'Start here. A bundled deterministic agent proves the continuity mechanism without accounts or configuration.',
  },
  {
    id: 'same-agent',
    label: 'Same-agent continuity',
    description:
      'Run one selected local agent in two fresh processes and check whether the second process continues the first.',
  },
  {
    id: 'cross-agent',
    label: 'Cross-agent handoff',
    description:
      'Let one local agent begin the task and a different local agent continue from the same governed evidence.',
  },
];

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
  agent: { label: 'agent/public', color: '#4ec9b0', prompt: '▸' },
  tool: { label: 'tool', color: '#dcdcaa', prompt: '⚙' },
  output: { label: 'output', color: '#b5cea8', prompt: '←' },
};

const CHECK_COPY: Record<string, { title: string; detail: string }> = {
  'two-distinct-fresh-processes': {
    title: 'The two sessions were genuinely fresh',
    detail:
      'Kungfu observed two different process identities instead of reusing one hidden session.',
  },
  'second-attempt-no-transcript-or-explanation': {
    title: 'No transcript or human re-explanation was injected',
    detail:
      'Session 2 had to recover the work from governed state, not from copied conversation context.',
  },
  'second-attempt-recognized-partial-state': {
    title: 'Session 2 recognized the partial result',
    detail:
      'The continuation found the exact state left by Session 1 before deciding what to do next.',
  },
  'fixture-completed': {
    title: 'The task reached the expected final state',
    detail:
      'The deterministic oracle found both the first claim and the continuation result.',
  },
  'both-processes-exited-cleanly': {
    title: 'Both agent processes exited cleanly',
    detail:
      'Process completion was observed for both sessions without treating exit alone as task proof.',
  },
  'fresh-session-completed-exact-state': {
    title: 'The fresh session completed the exact governed task',
    detail:
      'The final state retained the same Work identity and the expected ordered steps.',
  },
};

function shortRoot(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

function waitForPlayback(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function eventStatus(
  events: QualificationLabEvent[],
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

export function qualificationPlaybackLines(
  event: QualificationLabEvent,
): PlaybackLine[] {
  if (event.step === 'plan') {
    return [
      {
        session: 1,
        kind: 'system',
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
        status: 'ready',
        command:
          session === 1
            ? 'Begin the bounded task. Leave a governed partial result, then stop.'
            : 'Continue this task from Kungfu state. No prior chat is available.',
        detail:
          session === 1
            ? 'The first process receives the qualification task.'
            : 'The fresh process receives the same task identity, not Session 1 conversation.',
      },
      {
        session,
        kind: 'agent',
        status: 'running',
        command:
          session === 1
            ? 'I’ll make bounded progress and leave evidence for a fresh session.'
            : 'I’ll inspect governed state first, then continue only unfinished work.',
        detail:
          'Public progress narration projected from the canonical action boundary; private reasoning remains hidden.',
      },
      {
        session,
        kind: 'tool',
        status: 'running',
        command: `spawn_provider(session=${session}, fresh_process=true)`,
        detail:
          'The provider process is active. Kungfu waits for governed state evidence instead of treating terminal text as proof.',
      },
    ];
  }
  if (event.step === 'session-1') {
    const status = eventStatus([event], 1);
    return [
      {
        session: 1,
        kind: 'tool',
        status,
        command: 'read_governed_state(session=1)',
        detail: 'Kungfu observes the fixture state after the provider exits.',
      },
      {
        session: 1,
        kind: 'output',
        status,
        command: `status=${event.status}`,
        detail: `Bounded state evidence · ${shortRoot(event.root)}`,
      },
      {
        session: 1,
        kind: 'agent',
        status,
        command:
          status === 'correct'
            ? 'Partial work is recorded. I’m stopping so a fresh session must continue.'
            : 'The expected partial handoff state was not proved.',
        detail:
          'This is the public completion summary for Session 1, not hidden model reasoning.',
      },
    ];
  }
  if (event.step === 'session-2') {
    const status = eventStatus([event], 2);
    return [
      {
        session: 2,
        kind: 'tool',
        status,
        command: 'read_governed_state(session=2)',
        detail:
          'Kungfu checks the same Work identity and the final ordered state.',
      },
      {
        session: 2,
        kind: 'output',
        status,
        command: `status=${event.status}`,
        detail: `Fresh-process continuation evidence · ${shortRoot(event.root)}`,
      },
      {
        session: 2,
        kind: 'agent',
        status,
        command:
          status === 'correct'
            ? 'I found the prior partial result and completed only the remaining work.'
            : 'I could not prove a correct continuation from the recorded state.',
        detail:
          'This is the public completion summary for Session 2, not hidden model reasoning.',
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
        status,
        command: 'run_continuity_oracle()',
        detail:
          'The canonical checks compare process identity, governed state, and expected completion.',
      },
      {
        session: 2,
        kind: 'output',
        status,
        command: `qualification=${event.status}`,
        detail: `Assessment proof · ${shortRoot(event.root)}`,
      },
    ];
  }
  return [
    {
      session: 1,
      kind: 'system',
      status,
      command: event.step,
      detail: `${event.status} · ${shortRoot(event.root)}`,
    },
  ];
}

export function qualificationModeNeeds(mode: QualificationMode): {
  source: boolean;
  target: boolean;
} {
  return {
    source: mode !== 'offline-demo',
    target: mode === 'cross-agent',
  };
}

export function qualificationSessionStories(
  mode: QualificationMode,
  running: boolean,
  report: QualificationLabReport | null,
  visibleEvents: QualificationLabEvent[] = [],
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
            ? 'Created a bounded partial result'
            : running
              ? 'Canonical two-session action is running'
              : 'Will receive the governed test task',
          detail: firstObserved
            ? 'The first process stopped after leaving evidence that a fresh session can inspect.'
            : running
              ? 'Kungfu is waiting for Core evidence before declaring what this session actually did.'
              : 'It should claim the work, make bounded progress, record evidence, and end before completion.',
        },
        {
          status: firstObserved ? firstStatus : 'waiting',
          title: 'Ends without completing the whole task',
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
            ? 'Started without the prior transcript'
            : running
              ? 'Will start after Session 1 leaves evidence'
              : 'Will start as a genuinely fresh process',
          detail: secondObserved
            ? 'The second process had to identify the task and prior state from Kungfu evidence.'
            : running
              ? 'Core returns one canonical report for the complete sequence, so the UI waits rather than guessing whether the handoff has occurred.'
              : 'No copied chat and no human re-explanation should be available.',
        },
        {
          status: secondObserved ? secondStatus : 'waiting',
          title: secondObserved
            ? 'Continued from the recorded state'
            : 'Must continue instead of restart',
          detail:
            'Correct behavior is to recognize what Session 1 already did, perform only the remaining work, and preserve the same task identity.',
        },
      ],
    },
  ];
}

export function qualificationBehaviorFindings(
  report: QualificationLabReport | null,
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
  return (
    <article
      style={{
        ...panelStyle,
        minWidth: 0,
        padding: 18,
        background: '#181818',
        border: '1px solid #3c3c3c',
      }}
    >
      <div style={{ ...mono, color: '#9cdcfe', fontSize: 12 }}>
        {story.title.toUpperCase()}
      </div>
      <h2 style={{ margin: '6px 0 16px', fontSize: 19 }}>{story.subtitle}</h2>
      <div
        aria-live="polite"
        aria-label={`${story.title} public activity transcript`}
        style={{
          ...mono,
          minHeight: 260,
          marginBottom: 16,
          overflow: 'hidden',
          borderRadius: 6,
          background: '#090b0c',
          border: '1px solid #343a3d',
          fontSize: 11,
          lineHeight: 1.45,
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
            agent@qualification-lab · session-{session}
          </span>
          {running ? (
            <span className="kf-lab-live-dots" style={{ marginLeft: 'auto' }}>
              live
            </span>
          ) : null}
        </div>
        <div style={{ padding: 12 }}>
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
                    gridTemplateColumns: '24px 72px minmax(0, 1fr)',
                    gap: 7,
                    marginTop: index ? 10 : 0,
                    alignItems: 'start',
                  }}
                >
                  <span style={{ color: '#555' }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span style={{ color: kind.color }}>
                    {kind.prompt} {kind.label}
                  </span>
                  <div>
                    <div style={{ color: STATUS_META[line.status].color }}>
                      {line.command}
                    </div>
                    <div style={{ color: '#858585', marginTop: 2 }}>
                      {line.detail}
                    </div>
                  </div>
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
          <div
            style={{
              marginTop: 12,
              paddingTop: 8,
              color: '#626262',
              borderTop: '1px solid #1f2324',
            }}
          >
            PRIVATE REASONING HIDDEN · RAW PROVIDER OUTPUT REDACTED
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 14 }}>
        {story.milestones.map((milestone) => (
          <div
            key={milestone.title}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              alignItems: 'start',
              gap: 10,
            }}
          >
            <StatusBadge status={milestone.status} />
            <div>
              <strong>{milestone.title}</strong>
              <div
                style={{
                  marginTop: 4,
                  color: '#a9a9a9',
                  lineHeight: 1.45,
                }}
              >
                {milestone.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function HandoffBridge({
  report,
  events,
  running,
}: {
  report: QualificationLabReport | null;
  events: QualificationLabEvent[];
  running: boolean;
}) {
  const firstComplete = events.some((event) => event.step === 'session-1');
  const secondComplete = events.some((event) => event.step === 'session-2');
  const proven = Boolean(report && report.status !== 'failed');
  const active = running && firstComplete && !secondComplete;
  return (
    <section
      aria-label="Kungfu handoff bridge"
      style={{
        margin: '12px 0',
        padding: '12px 16px',
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
            ? 'Kungfu evidence proved the handoff'
            : active
              ? 'Partial evidence sealed · starting the fresh continuation'
              : secondComplete
                ? 'Both session observations received · assessment pending'
                : 'Kungfu handoff evidence'}
        </strong>
        <span aria-hidden="true">──▶</span>
        <strong>Session 2</strong>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 8,
          marginTop: 10,
          color: '#b8b8b8',
          fontSize: 12,
        }}
      >
        <span>Retained: task identity and Work reference</span>
        <span>Retained: partial state, evidence, and next action</span>
        <span>Excluded: prior transcript and credentials</span>
      </div>
    </section>
  );
}

function ResultPanel({
  report,
  visibleFindingCount,
  activeFindingIndex,
}: {
  report: QualificationLabReport;
  visibleFindingCount: number;
  activeFindingIndex: number;
}) {
  const passed = report.status !== 'failed';
  const findings = qualificationBehaviorFindings(report);
  return (
    <section
      aria-label="Qualification result"
      aria-live="polite"
      className="kf-lab-result-enter"
      style={{
        ...panelStyle,
        marginTop: 18,
        padding: 18,
        border: `1px solid ${passed ? '#287f70' : '#a14a3a'}`,
        background: passed ? '#102a26' : '#351b18',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusBadge status={passed ? 'correct' : 'undesirable'} />
        <h2 style={{ margin: 0 }}>
          {passed
            ? 'Continuity proved: the session changed, but the work did not disappear.'
            : 'Continuity was not proved.'}
        </h2>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.5 }}>
        {passed
          ? 'Kungfu made the handoff evidenced rather than guessed: Session 2 used the same governed work identity and state to continue.'
          : 'The report found at least one behavior that breaks trustworthy continuation. Review the evidence below before relying on this agent path.'}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 10,
          marginTop: 16,
        }}
      >
        {findings.slice(0, visibleFindingCount).map((finding, index) => (
          <div
            key={`${finding.status}-${finding.title}`}
            className={`kf-lab-verdict-card${
              index === activeFindingIndex ? ' kf-lab-verdict-focus' : ''
            }`}
            style={{
              padding: 12,
              borderRadius: 6,
              background: '#181818',
              border: '1px solid #3c3c3c',
            }}
          >
            <StatusBadge status={finding.status} />
            <strong style={{ display: 'block', marginTop: 8 }}>
              {finding.title}
            </strong>
            <div style={{ marginTop: 4, color: '#a9a9a9', lineHeight: 1.45 }}>
              {finding.detail}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function QualificationLabPanel({
  lab,
  startup,
  onOpenWork,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  onOpenWork?: () => void;
}) {
  const [mode, setMode] = React.useState<QualificationMode>('offline-demo');
  const [agents, setAgents] = React.useState<AgentRuntimeCatalog | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState('');
  const [targetAgent, setTargetAgent] = React.useState('');
  const [agentPlan, setAgentPlan] =
    React.useState<QualificationLabAgentPlan | null>(null);
  const [targetPlan, setTargetPlan] =
    React.useState<QualificationLabAgentPlan | null>(null);
  const [report, setReport] = React.useState<QualificationLabReport | null>(
    null,
  );
  const [visibleEvents, setVisibleEvents] = React.useState<
    QualificationLabEvent[]
  >([]);
  const [visiblePlaybackLines, setVisiblePlaybackLines] = React.useState<
    PlaybackLine[]
  >([]);
  const [visibleFindingCount, setVisibleFindingCount] = React.useState(0);
  const [activeFindingIndex, setActiveFindingIndex] = React.useState(-1);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const playbackRunRef = React.useRef(0);

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

  React.useEffect(() => {
    void discover();
  }, [discover]);

  const resetRun = (nextMode: QualificationMode) => {
    playbackRunRef.current += 1;
    setMode(nextMode);
    setAgentPlan(null);
    setTargetPlan(null);
    setReport(null);
    setVisibleEvents([]);
    setVisiblePlaybackLines([]);
    setVisibleFindingCount(0);
    setActiveFindingIndex(-1);
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
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const eventDelay = reducedMotion
      ? QUALIFICATION_PLAYBACK_TIMING.reducedMotionDelayMs
      : QUALIFICATION_PLAYBACK_TIMING.eventDelayMs;
    const verdictDelay = reducedMotion
      ? QUALIFICATION_PLAYBACK_TIMING.reducedMotionDelayMs
      : QUALIFICATION_PLAYBACK_TIMING.verdictDelayMs;
    let playbackQueue = Promise.resolve();
    const receiveEvent = (event: QualificationLabEvent) => {
      const lines = qualificationPlaybackLines(event);
      playbackQueue = playbackQueue.then(async () => {
        for (const line of lines) {
          await waitForPlayback(eventDelay);
          if (playbackRunRef.current !== runId) return;
          setVisiblePlaybackLines((current) => [...current, line]);
        }
        if (playbackRunRef.current !== runId) return;
        setVisibleEvents((current) => [...current, event]);
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
      const findings = qualificationBehaviorFindings(nextReport);
      await waitForPlayback(verdictDelay);
      for (let index = 0; index < findings.length; index += 1) {
        if (playbackRunRef.current !== runId) return;
        setVisibleFindingCount(index + 1);
        setActiveFindingIndex(index);
        await waitForPlayback(verdictDelay);
      }
      if (playbackRunRef.current !== runId) return;
      setActiveFindingIndex(-1);
      setError('');
    } catch (reason) {
      if (playbackRunRef.current === runId) {
        setError((reason as Error).message);
      }
    } finally {
      if (playbackRunRef.current === runId) {
        setBusy('');
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
  const needs = qualificationModeNeeds(mode);
  const running = busy === 'run';
  const prepared =
    mode === 'offline-demo' ||
    (Boolean(agentPlan) && (mode !== 'cross-agent' || Boolean(targetPlan)));
  const canRun =
    prepared &&
    !busy &&
    (!needs.source || Boolean(selectedAgent)) &&
    (!needs.target || (Boolean(targetAgent) && selectedAgent !== targetAgent));
  const [sessionOne, sessionTwo] = qualificationSessionStories(
    mode,
    running,
    report,
    visibleEvents,
  );
  const selectedMode = QUALIFICATION_MODES.find((row) => row.id === mode) ?? {
    id: mode,
    label: 'Unknown test mode',
    description: 'Choose a supported qualification mode.',
  };

  return (
    <section
      style={{
        ...panelStyle,
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        padding: 20,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 20,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ ...mono, color: '#9cdcfe' }}>
            AGENT QUALIFICATION LAB
          </div>
          <h1 style={{ margin: '7px 0' }}>
            Can a fresh agent session continue the same work?
          </h1>
          <p style={{ maxWidth: 820, margin: 0, lineHeight: 1.55 }}>
            This Lab runs one bounded task across two independent sessions.
            Session 1 begins and leaves evidence. Session 2 gets no prior chat
            and must discover what happened, then continue from the correct
            point.
          </p>
        </div>
        {onOpenWork ? (
          <button type="button" onClick={onOpenWork}>
            Back to Work
          </button>
        ) : null}
      </header>

      <div
        style={{
          ...mono,
          color: '#858585',
          marginTop: 10,
          fontSize: 11,
        }}
      >
        startup {startup.state} · {startup.reasonCode} · no real workspace write
      </div>
      {startup.route === 'diagnostic' ? (
        <div style={{ ...mono, color: '#f48771', marginTop: 12 }}>
          {startup.message}
        </div>
      ) : null}

      <section
        aria-label="Test configuration"
        style={{
          ...panelStyle,
          marginTop: 18,
          padding: 16,
          background: '#202020',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label>
            <strong style={{ display: 'block', marginBottom: 6 }}>
              Test mode
            </strong>
            <select
              aria-label="Test mode"
              value={mode}
              disabled={Boolean(busy)}
              onChange={(event) =>
                resetRun(event.target.value as QualificationMode)
              }
              style={{ width: '100%', minHeight: 34 }}
            >
              {QUALIFICATION_MODES.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>
          {needs.source ? (
            <label>
              <strong style={{ display: 'block', marginBottom: 6 }}>
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
                style={{ width: '100%', minHeight: 34 }}
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
              <strong style={{ display: 'block', marginBottom: 6 }}>
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
                style={{ width: '100%', minHeight: 34 }}
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
              >
                {busy === 'prepare' ? 'Preparing…' : '1 · Prepare exact test'}
              </button>
            ) : null}
            <button type="button" disabled={!canRun} onClick={run}>
              {running
                ? 'Running canonical test…'
                : needs.source
                  ? '2 · Start test'
                  : 'Start offline demo'}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={discover}>
              Refresh agents
            </button>
          </div>
        </div>
        <p style={{ margin: '12px 0 0', color: '#b8b8b8' }}>
          <strong>{selectedMode.label}:</strong> {selectedMode.description}
        </p>
      </section>

      <section aria-label="Two-session experiment" style={{ marginTop: 18 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
            gap: 12,
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

      {!report ? (
        <section
          aria-label="Behavior guide"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 10,
            marginTop: 16,
          }}
        >
          {qualificationBehaviorFindings(null).map((finding) => (
            <div
              key={finding.status}
              style={{
                ...panelStyle,
                padding: 12,
                background: '#181818',
                border: '1px solid #3c3c3c',
              }}
            >
              <StatusBadge status={finding.status} />
              <strong style={{ display: 'block', marginTop: 8 }}>
                {finding.title}
              </strong>
              <div style={{ marginTop: 4, color: '#a9a9a9', lineHeight: 1.45 }}>
                {finding.detail}
              </div>
            </div>
          ))}
        </section>
      ) : (
        <ResultPanel
          report={report}
          visibleFindingCount={visibleFindingCount}
          activeFindingIndex={activeFindingIndex}
        />
      )}

      <section
        style={{
          marginTop: 18,
          padding: 14,
          borderLeft: '3px solid #4ec9b0',
          background: '#182522',
        }}
      >
        <strong>What Kungfu changes</strong>
        <div style={{ marginTop: 5, lineHeight: 1.5 }}>
          Kungfu does not answer the task for the agent. It makes work
          continuable, handoff-ready, and provable across sessions, agents, and
          time.
        </div>
      </section>

      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer' }}>Technical details</summary>
        <pre
          style={{
            ...mono,
            whiteSpace: 'pre-wrap',
            padding: 12,
            background: '#111',
            overflow: 'auto',
          }}
        >
          {agentPlan
            ? `source command ${JSON.stringify(agentPlan.commandPreview)}
source identity ${agentPlan.identityRoot}
source plan ${agentPlan.planRoot}
continuation command ${JSON.stringify(targetPlan?.commandPreview)}
continuation identity ${targetPlan?.identityRoot}
credential contents read: no`
            : 'No local-agent plan prepared.'}
          {report
            ? `
report ${shortRoot(report.reportRoot)}
plan ${shortRoot(report.planRoot)}
identity ${shortRoot(report.identityRoot)}
attempts ${report.sessionAttempts.length}
meaning ${report.meaning}
evidence ${report.evidenceDirectory}`
            : ''}
        </pre>
      </details>
      {error ? (
        <div role="alert" style={{ ...mono, color: '#f48771', marginTop: 12 }}>
          {error}
        </div>
      ) : null}
      <style>{`
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
          animation: kf-lab-verdict-emphasis 520ms ease-out both;
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
