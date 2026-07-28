// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  AgentWorkLabEvent,
  AgentWorkLabReport,
} from '@kungfu-tech/api/capability';
import {
  AGENT_WORK_LAB_SUITE,
  agentWorkLabRecommendation,
} from '@kungfu-tech/kfx-agent-work-lab-experience';
import {
  AGENT_WORK_LAB_MODES,
  AGENT_WORK_LAB_PLAYBACK_TIMING,
  agentWorkLabBehaviorFindings,
  agentWorkLabModeNeeds,
  agentWorkLabPlaybackLines,
  agentWorkLabSessionStories,
} from './renderer/src/agent-work-lab';

const qualifiedReport = {
  status: 'qualified',
  events: [
    { step: 'session-1', status: 'ended-partial' },
    { step: 'session-2', status: 'ended-complete' },
  ],
  assessment: {
    oracleChecks: [
      {
        id: 'second-attempt-recognized-partial-state',
        passed: true,
      },
    ],
    residualRisks: [],
  },
} as unknown as AgentWorkLabReport;

test('the Lab exposes one explicit selector for all three experiment modes', () => {
  assert.deepEqual(
    AGENT_WORK_LAB_MODES.map(({ id }) => id),
    ['offline-demo', 'same-agent', 'cross-agent'],
  );
  assert.deepEqual(agentWorkLabModeNeeds('offline-demo'), {
    source: false,
    target: false,
  });
  assert.deepEqual(agentWorkLabModeNeeds('same-agent'), {
    source: true,
    target: false,
  });
  assert.deepEqual(agentWorkLabModeNeeds('cross-agent'), {
    source: true,
    target: true,
  });
  assert.equal(AGENT_WORK_LAB_SUITE.title, 'Agent Work Lab');
  assert.equal(AGENT_WORK_LAB_SUITE.collection.title, 'Work Continuity');
  assert.deepEqual(
    AGENT_WORK_LAB_MODES.map(({ id, label }) => ({ id, label })),
    AGENT_WORK_LAB_SUITE.cases.map(({ id, title }) => ({
      id,
      label: title,
    })),
  );
  assert.equal(
    agentWorkLabRecommendation('offline-demo').nextCase,
    'same-agent',
  );
});

test('the two session stories distinguish bounded progress from continuation', () => {
  const [first, second] = agentWorkLabSessionStories(
    'cross-agent',
    false,
    qualifiedReport,
  );

  assert.equal(first.title, 'Session 1');
  assert.equal(first.subtitle, 'Source local agent');
  assert.equal(first.milestones[0]?.status, 'correct');
  assert.equal(first.milestones[0]?.title, 'Partial result saved');

  assert.equal(second.title, 'Session 2');
  assert.equal(second.subtitle, 'Target local agent');
  assert.equal(second.milestones[0]?.status, 'correct');
  assert.equal(second.milestones[1]?.title, 'Continued correctly');
  assert.match(
    second.milestones[1]?.detail ?? '',
    /remaining work.*same task identity/,
  );
});

test('an in-flight atomic report never fabricates Session 2 progress', () => {
  const [first, second] = agentWorkLabSessionStories('same-agent', true, null);

  assert.equal(first.milestones[0]?.status, 'running');
  assert.equal(second.milestones[0]?.status, 'waiting');
  assert.match(
    second.milestones[0]?.detail ?? '',
    /waits rather than guessing/,
  );
});

test('canonical oracle failures and residuals stay visually distinct', () => {
  const report = {
    ...qualifiedReport,
    status: 'qualified-with-residuals',
    assessment: {
      oracleChecks: [
        {
          id: 'second-attempt-recognized-partial-state',
          passed: false,
        },
      ],
      residualRisks: [
        'Provider confinement remains to be independently proven.',
      ],
    },
  } as AgentWorkLabReport;
  const findings = agentWorkLabBehaviorFindings(report);

  assert.deepEqual(
    findings.map(({ status }) => status),
    ['undesirable', 'warning'],
  );
});

test('canonical runtime events expand into public terminal activity', () => {
  const event = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-2-start',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
  } as const;
  const lines = agentWorkLabPlaybackLines(event);

  assert.deepEqual(
    lines.map(({ session, kind }) => ({ session, kind })),
    [
      { session: 2, kind: 'user' },
      { session: 2, kind: 'agent' },
      { session: 2, kind: 'tool' },
    ],
  );
  assert.equal(lines[0]?.kind, 'user');
  assert.match(lines[1]?.command ?? '', /recover the task state/);
  assert.match(lines[1]?.detail ?? '', /agent\/live/);
  assert.match(lines[2]?.command ?? '', /fresh provider process 2/);
  assert.match(
    lines[2]?.detail ?? '',
    /instead of treating terminal text as proof/,
  );
  assert.equal(AGENT_WORK_LAB_PLAYBACK_TIMING.eventDelayMs, 1000);
  assert.equal(AGENT_WORK_LAB_PLAYBACK_TIMING.verdictDelayMs, 520);
  assert.equal(
    AGENT_WORK_LAB_PLAYBACK_TIMING.eventDelayMs,
    AGENT_WORK_LAB_SUITE.timing.eventIntervalMs,
  );
});

test('live provider activity becomes safe agent and tool narration', () => {
  const agentEvent = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-1-activity',
    status: 'running',
    root: `sha256:${'c'.repeat(64)}`,
    publicActivity: {
      schema: 'kungfu.agent-work-lab.public-activity/v1',
      source: 'provider-jsonl',
      kind: 'agent',
      phase: 'progress',
      text: 'I’m starting fresh, so I’ll inspect the governed task state first.',
      rawOutputRedacted: true,
    },
  } as const;
  const toolEvent = {
    ...agentEvent,
    publicActivity: {
      ...agentEvent.publicActivity,
      kind: 'tool',
      phase: 'started',
      text: 'Using a bounded tool inside the isolated test workspace.',
    },
  } as const;

  assert.deepEqual(agentWorkLabPlaybackLines(agentEvent)[0], {
    session: 1,
    kind: 'agent',
    origin: 'provider-observation',
    status: 'running',
    command:
      'I’m starting fresh, so I’ll inspect the governed task state first.',
    detail:
      'A live public status message emitted by the selected Agent. It is not private reasoning.',
  });
  assert.equal(agentWorkLabPlaybackLines(toolEvent)[0]?.kind, 'tool');
  assert.match(
    agentWorkLabPlaybackLines(toolEvent)[0]?.detail ?? '',
    /raw tool output remain redacted/,
  );
});

test('only admitted provider output is identified as actual agent output', () => {
  const event: AgentWorkLabEvent = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-2',
    status: 'complete',
    root: `sha256:${'b'.repeat(64)}`,
    publicOutput: {
      schema: 'kungfu.agent-work-lab.public-output/v1',
      source: 'provider-stdout',
      admission: 'exact-agent-work-lab-marker',
      lines: [
        'Found the prior governed state and completed only the remaining step.',
      ],
      rawOutputRedacted: true,
    },
  };
  const lines = agentWorkLabPlaybackLines(event);

  assert.equal(lines[0]?.origin, 'provider-observation');
  assert.equal(lines[0]?.kind, 'agent');
  assert.match(lines[0]?.command ?? '', /completed only the remaining step/);
  assert.ok(
    lines.slice(1).every(({ origin }) => origin === 'canonical-projection'),
  );
});

test('the shell keeps navigation outside the Lab content branch', () => {
  const source = readFileSync(
    new URL('./renderer/src/main.tsx', import.meta.url),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('<div style={chromeBodyStyle}>'),
    source.indexOf('{notificationToasts}'),
  );

  assert.ok(body.indexOf('<nav') >= 0);
  assert.ok(body.indexOf('{labOpen ?') >= 0);
  assert.ok(body.indexOf('<nav') < body.indexOf('{labOpen ?'));
});

test('the visual contract keeps a fixed frame with independently scrolling sessions', () => {
  const source = readFileSync(
    new URL('./renderer/src/agent-work-lab.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /aria-label="Test mode"/);
  assert.match(source, /aria-label="Session 1 agent"/);
  assert.match(source, /aria-label="Session 2 agent"/);
  assert.match(source, /<output[\s\S]*aria-label=\{meta\.label\}/);
  assert.match(source, /className="kf-lab-frame"/);
  assert.match(source, /gridTemplateRows: 'auto auto minmax\(0, 1fr\) auto'/);
  assert.match(source, /overflow: 'hidden'/);
  assert.match(source, /className="kf-lab-terminal-scroll"/);
  assert.match(source, /overflowY: 'auto'/);
  assert.match(
    source,
    /gridTemplateColumns: 'repeat\(2, minmax\(320px, 1fr\)\)'/,
  );
  assert.match(source, /kf-lab-report-dock/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /WHAT TO TRY NEXT/);
  assert.match(source, /recommendationDurationMs/);
  assert.match(source, /createPortal/);
  assert.match(source, /position: fixed/);
  assert.match(source, /window\.innerWidth/);
  assert.match(source, /PUBLIC ACTIVITY TRANSCRIPT/);
  assert.match(source, /PRIVATE REASONING HIDDEN/);
  assert.match(source, /COMMANDS \+ RAW OUTPUT REDACTED/);
  assert.match(source, /agent\/live/);
  assert.match(source, /lab\.runDemo\(receiveEvent\)/);
  assert.match(source, /lab\.runAgent\(selectedAgent, receiveEvent\)/);
  assert.match(source, /setVisiblePlaybackLines/);
  assert.match(source, /agentWorkLabRunProgressLabel/);
  assert.match(source, /progress=\{progress\}/);
  assert.match(source, /kf-lab-verdict-focus/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test('the GUI shell uses the shared startup surface policy', () => {
  const source = readFileSync(
    new URL('./renderer/src/main.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /agentWorkLabStartupSurface\(startup\)/);
  assert.match(source, /startupSurface === 'work-graph'/);
  assert.match(source, /startupSurface === 'agent-work-lab'/);
});
