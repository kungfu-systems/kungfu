// SPDX-License-Identifier: Apache-2.0

import type {
  AgentRuntimeCatalog,
  QualificationLab,
  QualificationLabAgentPlan,
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

function eventStatus(
  report: QualificationLabReport | null,
  session: 1 | 2,
): VisualStatus {
  if (!report) return 'waiting';
  const event = report.events.find((row) => row.step === `session-${session}`);
  const status = event?.status ?? '';
  if (status === 'failed' || report.status === 'failed') return 'undesirable';
  if (
    (session === 1 &&
      ['ended-partial', 'partial', 'partial-first-attempt'].includes(status)) ||
    (session === 2 &&
      ['ended-complete', 'complete', 'continuation-completed'].includes(status))
  ) {
    return 'correct';
  }
  return 'warning';
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
): [SessionStory, SessionStory] {
  const firstStatus = running
    ? 'running'
    : report
      ? eventStatus(report, 1)
      : 'ready';
  const secondStatus = running
    ? 'waiting'
    : report
      ? eventStatus(report, 2)
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
          title: report
            ? 'Created a bounded partial result'
            : running
              ? 'Canonical two-session action is running'
              : 'Will receive the governed test task',
          detail: report
            ? 'The first process stopped after leaving evidence that a fresh session can inspect.'
            : running
              ? 'Kungfu is waiting for Core evidence before declaring what this session actually did.'
              : 'It should claim the work, make bounded progress, record evidence, and end before completion.',
        },
        {
          status: report ? firstStatus : 'waiting',
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
          title: report
            ? 'Started without the prior transcript'
            : running
              ? 'Will start after Session 1 leaves evidence'
              : 'Will start as a genuinely fresh process',
          detail: report
            ? 'The second process had to identify the task and prior state from Kungfu evidence.'
            : running
              ? 'Core returns one canonical report for the complete sequence, so the UI waits rather than guessing whether the handoff has occurred.'
              : 'No copied chat and no human re-explanation should be available.',
        },
        {
          status: report ? secondStatus : 'waiting',
          title: report
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

function SessionColumn({ story }: { story: SessionStory }) {
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
}: {
  report: QualificationLabReport | null;
}) {
  const proven = report && report.status !== 'failed';
  return (
    <section
      aria-label="Kungfu handoff bridge"
      style={{
        margin: '12px 0',
        padding: '12px 16px',
        border: `1px solid ${proven ? '#287f70' : '#3c3c3c'}`,
        borderRadius: 8,
        background: proven ? '#102c28' : '#202020',
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
        <strong style={{ color: '#4ec9b0' }}>
          {proven
            ? 'Kungfu evidence proved the handoff'
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

function ResultPanel({ report }: { report: QualificationLabReport }) {
  const passed = report.status !== 'failed';
  const findings = qualificationBehaviorFindings(report);
  return (
    <section
      aria-label="Qualification result"
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
        {findings.map((finding) => (
          <div
            key={`${finding.status}-${finding.title}`}
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
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');

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
    setMode(nextMode);
    setAgentPlan(null);
    setTargetPlan(null);
    setReport(null);
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
    setBusy('run');
    setReport(null);
    try {
      const nextReport =
        mode === 'offline-demo'
          ? await lab.runDemo()
          : mode === 'cross-agent'
            ? await lab.runMigration(selectedAgent, targetAgent)
            : await lab.runAgent(selectedAgent);
      setReport(nextReport);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
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
          <SessionColumn story={sessionOne} />
          <SessionColumn story={sessionTwo} />
        </div>
        <HandoffBridge report={report} />
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
        <ResultPanel report={report} />
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
    </section>
  );
}
