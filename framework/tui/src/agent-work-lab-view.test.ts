// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  AgentWorkLab,
  AgentWorkLabEvent,
  AgentWorkLabReport,
  ProjectTemplateCreationReceipt,
  ProjectTemplatePlan,
  ProjectTemplateWorkspaceSelection,
} from '@kungfu-tech/api/capability';
import { render } from 'ink';
import React from 'react';
import {
  AGENT_WORK_LAB_POINTER_ACTIONS,
  AGENT_WORK_LAB_QUICK_COMMANDS,
  AgentWorkLabHost,
  AgentWorkLabView,
  agentWorkLabActionReturnsToControls,
  agentWorkLabAutoplayPhase,
  agentWorkLabAutoplayPhaseLabel,
  agentWorkLabEventLines,
  agentWorkLabEventRunningSession,
  agentWorkLabNextModePrompt,
  agentWorkLabPromptRows,
  agentWorkLabSessionTitleBar,
  agentWorkLabStarterReceiptInput,
  isAgentWorkLabReportReturnInput,
  nextAgentWorkLabFocus,
} from './agent-work-lab-view.js';
import {
  appendWorkbenchSessionLines,
  createIncrementalPlayback,
  emptyWorkbenchSessionBuffers,
  horizontalPointerActionAtPoint,
  nextWorkbenchFocus,
  scrollWorkbenchSession,
  sessionTitleBar,
  workbenchActionAtPoint,
  workbenchReportAtPoint,
  workbenchReportReturnAtPoint,
  workbenchSessionAtPoint,
} from './profile-shell.js';
import { IncrementalTerminalOutput } from './terminal-canvas.js';

test('generic workbench has no product-specific test or oracle vocabulary', () => {
  const moduleSource = readFileSync(
    new URL('./profile-shell.tsx', import.meta.url),
    'utf8',
  );
  const source = moduleSource.slice(
    moduleSource.indexOf('// Generic two-session workbench'),
  );
  assert.doesNotMatch(
    source,
    /Agent Work Lab|offline-demo|same-agent|cross-agent|agent-work-lab|oracle/i,
  );
});

test('TUI help advertises the public Kungfu autoplay command', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  assert.match(source, /kungfu agent-work-lab autoplay/);
  assert.doesNotMatch(source, /Offline animation demo: `\.\/shifu/);
});

test('generic playback serializes events before the verdict boundary', async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const playback = createIncrementalPlayback<string>({
    timing: { eventIntervalMs: 1000, verdictIntervalMs: 520 },
    onEvent: (event) => calls.push(event),
    onAssessing: () => calls.push('assessing'),
    wait: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  playback.enqueue('first');
  playback.enqueue('second');
  assert.equal(await playback.finish(), true);
  assert.deepEqual(calls, ['first', 'second', 'assessing']);
  assert.deepEqual(delays, [1000, 1000, 520]);
});

test('title-bar focus changes style without changing geometry', () => {
  const active = sessionTitleBar({
    session: 1,
    title: 'Local provider',
    active: true,
    running: true,
    columns: 40,
    activityFrame: 1,
  });
  const inactive = sessionTitleBar({
    session: 1,
    title: 'Local provider',
    active: false,
    running: true,
    columns: 40,
    activityFrame: 1,
  });
  assert.equal(active.length, 40);
  assert.equal(inactive.length, 40);
  assert.equal(active.slice(1), inactive.slice(1));
  assert.equal(nextWorkbenchFocus('session-2', true), 'correct');
});

class CaptureOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  write = (value: string) => {
    this.chunks.push(String(value));
    return true;
  };
}

async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= expiresAt) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const viewProps = {
  dimensions: { columns: 80, rows: 24 },
  mode: 'offline-demo' as const,
  sourceLabel: '',
  targetLabel: '',
  buffers: emptyWorkbenchSessionBuffers(),
  report: undefined,
  busy: '',
  progress: '',
  error: '',
  activeFocus: 'session-1' as const,
  scrollBack: { 1: 0, 2: 0 } as Record<1 | 2, number>,
  showHelp: false,
  activityFrame: 0,
  runningSession: undefined,
};

const qualifiedReport: AgentWorkLabReport = {
  schema: 'kungfu.agent-work-lab.report/v1',
  status: 'qualified',
  suite: 'kungfu.agent-work-lab',
  fixture: 'partial-claim-fresh-session',
  planRoot: `sha256:${'1'.repeat(64)}`,
  reportRoot: `sha256:${'2'.repeat(64)}`,
  identityRoot: `sha256:${'3'.repeat(64)}`,
  workRef: {},
  sessionAttempts: [],
  assessment: {
    oracleChecks: [
      { id: 'distinct-fresh-processes', passed: true },
      { id: 'first-attempt-ended-partial', passed: true },
      { id: 'second-attempt-no-transcript-or-explanation', passed: true },
      { id: 'fixture-completed', passed: false },
    ],
  },
  events: [],
  meaning: 'Continuity was assessed.',
  nonClaims: [],
  receiptDependencies: [],
  recoveryGuidance: {},
  evidenceDirectory: '/tmp/evidence',
  writeOccurred: true,
};

test('TUI renders admitted provider narration without raw commands', () => {
  const event: AgentWorkLabEvent = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-2-activity',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
    publicActivity: {
      schema: 'kungfu.agent-work-lab.public-activity/v1',
      source: 'provider-jsonl',
      kind: 'agent',
      phase: 'progress',
      text: 'I found Session 1’s partial result and the same Work identity.',
      rawOutputRedacted: true,
    },
  };

  assert.deepEqual(agentWorkLabEventLines(event), [
    {
      session: 2,
      source: 'agent/live',
      text: 'I found Session 1’s partial result and the same Work identity.',
      tone: 'running',
    },
  ]);
});

test('Session buffers retain independent history and keep a scrolled anchor', () => {
  const initial = appendWorkbenchSessionLines({
    buffers: emptyWorkbenchSessionBuffers(),
    scrollBack: { 1: 0, 2: 0 },
    lines: [
      { session: 1, source: 's1', text: 'one', tone: 'normal' },
      { session: 2, source: 's2', text: 'two', tone: 'normal' },
    ],
    limit: 3,
  });
  const scrolled = appendWorkbenchSessionLines({
    buffers: initial.buffers,
    scrollBack: { 1: 1, 2: 0 },
    lines: [
      { session: 1, source: 's1', text: 'three', tone: 'running' },
      { session: 1, source: 's1', text: 'four', tone: 'running' },
    ],
    limit: 3,
  });

  assert.deepEqual(
    scrolled.buffers[1].map((line) => line.text),
    ['one', 'three', 'four'],
  );
  assert.deepEqual(
    scrolled.buffers[2].map((line) => line.text),
    ['two'],
  );
  assert.equal(scrolled.scrollBack[1], 2);
  assert.equal(scrolled.scrollBack[2], 0);
  assert.equal(
    scrollWorkbenchSession({
      current: 0,
      lineCount: 20,
      viewportRows: 5,
      delta: 99,
    }),
    15,
  );
});

test('mouse coordinates select only the Session pane under the pointer', () => {
  const dimensions = { columns: 100, rows: 30 };
  assert.equal(
    workbenchSessionAtPoint({
      dimensions,
      showHelp: false,
      column: 10,
      row: 8,
      topOffset: 1,
    }),
    1,
  );
  assert.equal(
    workbenchSessionAtPoint({
      dimensions,
      showHelp: false,
      column: 80,
      row: 8,
      topOffset: 1,
    }),
    2,
  );
  assert.equal(
    workbenchSessionAtPoint({
      dimensions,
      showHelp: false,
      column: 80,
      row: 30,
      topOffset: 1,
    }),
    undefined,
  );
});

test('mouse coordinates resolve visible workbench actions and report cards', () => {
  assert.equal(
    workbenchActionAtPoint({
      actions: AGENT_WORK_LAB_POINTER_ACTIONS,
      column: 5,
      row: 4,
      topOffset: 1,
    }),
    'lab-demo',
  );
  assert.equal(
    workbenchActionAtPoint({
      actions: AGENT_WORK_LAB_POINTER_ACTIONS,
      column: 30,
      row: 4,
      topOffset: 1,
    }),
    'lab-handoff',
  );
  assert.equal(
    workbenchActionAtPoint({
      actions: AGENT_WORK_LAB_POINTER_ACTIONS,
      column: 13,
      row: 4,
      topOffset: 1,
    }),
    undefined,
  );
  const dimensions = { columns: 80, rows: 20 };
  assert.equal(
    workbenchReportAtPoint({
      dimensions,
      column: 20,
      row: 17,
      topOffset: 1,
    }),
    'correct',
  );
  assert.equal(
    workbenchReportAtPoint({
      dimensions,
      column: 60,
      row: 17,
      topOffset: 1,
    }),
    'failed',
  );
  assert.equal(
    workbenchReportReturnAtPoint({
      dimensions,
      column: 40,
      row: 19,
      topOffset: 1,
    }),
    true,
  );
  assert.equal(
    horizontalPointerActionAtPoint({
      actions: [
        { action: 'work', label: '[1] All Work' },
        { action: 'projects', label: '[2] Projects' },
      ],
      column: 18,
      row: 1,
      targetRow: 1,
      startColumn: 2,
      gap: 2,
    }),
    'projects',
  );
});

test('TUI Agent Work Lab layout keeps two Sessions and the verdict dock fixed', () => {
  const adapterSource = readFileSync(
    new URL('./agent-work-lab-view.tsx', import.meta.url),
    'utf8',
  );
  const frameworkSource = readFileSync(
    new URL('./profile-shell.tsx', import.meta.url),
    'utf8',
  );

  assert.match(frameworkSource, /width="50%"/);
  assert.match(frameworkSource, /PUBLIC ACTIVITY/);
  assert.match(frameworkSource, /SENSITIVE INTERNALS HIDDEN/);
  assert.match(adapterSource, /WORK CONTINUITY PROVED/);
  assert.match(frameworkSource, /height=\{6\}/);
  assert.match(frameworkSource, /wheel here \/ ↑↓ scroll/);
  assert.match(frameworkSource, /borderColor=\{active \? 'cyan' : 'gray'\}/);
  assert.match(frameworkSource, /color=\{active \? 'black' : 'white'\}/);
  assert.match(
    frameworkSource,
    /backgroundColor=\{active \? 'cyan' : 'gray'\}/,
  );
  assert.match(frameworkSource, /sessionTitleBar/);
  assert.match(
    frameworkSource,
    /running=\{Boolean\(progress\) && runningSession === 1\}/,
  );
  assert.match(
    frameworkSource,
    /running=\{Boolean\(progress\) && runningSession === 2\}/,
  );
  assert.match(frameworkSource, /Enter details/);
  assert.match(frameworkSource, /WHAT TO TRY NEXT/);
  assert.match(frameworkSource, /backgroundColor="blue"/);
  assert.match(frameworkSource, /opaqueWorkbenchLine/);
  assert.doesNotMatch(adapterSource, /\[p\] prepare/);
  assert.match(adapterSource, /\[Tab\]\s*focus/);
  assert.match(adapterSource, /\[\?\]\s*explain/);
});

test('Session title bars keep focus and running state visible at fixed width', () => {
  const running = agentWorkLabSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 0,
  });
  const quarter = agentWorkLabSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 1,
  });
  const half = agentWorkLabSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 2,
  });
  const threeQuarter = agentWorkLabSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 3,
  });
  const ready = agentWorkLabSessionTitleBar({
    session: 2,
    title: 'Fresh Demo Agent',
    active: false,
    running: false,
    columns: 38,
  });

  assert.equal(running.length, 38);
  assert.equal(quarter.length, 38);
  assert.equal(half.length, 38);
  assert.equal(threeQuarter.length, 38);
  assert.equal(ready.length, 38);
  assert.match(running, /^> S1 · Bundled Demo Agent\s+◐ RUNNING$/);
  assert.match(quarter, /^> S1 · Bundled Demo Agent\s+◓ RUNNING$/);
  assert.match(half, /^> S1 · Bundled Demo Agent\s+◑ RUNNING$/);
  assert.match(threeQuarter, /^> S1 · Bundled Demo Agent\s+◒ RUNNING$/);
  assert.match(ready, /^ {2}S2 · Fresh Demo Agent\s+READY$/);
  assert.doesNotMatch(running, /FOCUS/);
});

test('running state follows only the Session named by an event', () => {
  assert.equal(
    agentWorkLabEventRunningSession({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'session-1-activity',
      status: 'running',
      root: `sha256:${'a'.repeat(64)}`,
    }),
    1,
  );
  assert.equal(
    agentWorkLabEventRunningSession({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'session-2-start',
      status: 'running',
      root: `sha256:${'b'.repeat(64)}`,
    }),
    2,
  );
  assert.equal(
    agentWorkLabEventRunningSession({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'assessment',
      status: 'qualified',
      root: `sha256:${'c'.repeat(64)}`,
    }),
    undefined,
  );
});

test('autoplay maps admitted events onto a four-step viewer narrative', () => {
  assert.equal(
    agentWorkLabAutoplayPhase({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'plan',
      status: 'ready',
      root: `sha256:${'1'.repeat(64)}`,
    }),
    1,
  );
  assert.equal(
    agentWorkLabAutoplayPhase({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'session-1-activity',
      status: 'running',
      root: `sha256:${'2'.repeat(64)}`,
    }),
    2,
  );
  assert.equal(
    agentWorkLabAutoplayPhase({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'session-2-start',
      status: 'running',
      root: `sha256:${'3'.repeat(64)}`,
    }),
    3,
  );
  assert.equal(
    agentWorkLabAutoplayPhase({
      schema: 'kungfu.agent-work-lab.event/v1',
      step: 'assessment',
      status: 'qualified',
      root: `sha256:${'4'.repeat(64)}`,
    }),
    4,
  );
  assert.match(agentWorkLabAutoplayPhaseLabel(2), /Session 1.*exits/i);
  assert.match(agentWorkLabAutoplayPhaseLabel(4), /verifies continuity/i);
});

test('coaching popup rows are bounded and fully paintable', () => {
  const rows = agentWorkLabPromptRows(
    'Offline complete · now test your real agent · Press x to test same-agent continuity.',
    28,
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows.every((row) => row.length <= 28),
    true,
  );
  assert.match(rows[1], /…$/);
});

test('Tab focus includes result cards only after a report exists', () => {
  assert.equal(nextAgentWorkLabFocus('session-1', false), 'session-2');
  assert.equal(nextAgentWorkLabFocus('session-2', false), 'session-1');
  assert.equal(nextAgentWorkLabFocus('session-2', true), 'correct');
  assert.equal(nextAgentWorkLabFocus('correct', true), 'failed');
  assert.equal(nextAgentWorkLabFocus('failed', true), 'session-1');
});

test('completed modes coach the next Agent Work Lab step', () => {
  assert.equal(
    agentWorkLabNextModePrompt('offline-demo').title,
    'Offline complete · now test your real agent',
  );
  assert.match(
    agentWorkLabNextModePrompt('offline-demo').instruction,
    /Run \/same, or press Esc then x/,
  );
  assert.doesNotMatch(
    agentWorkLabNextModePrompt('offline-demo').instruction,
    /Press p/,
  );
  assert.match(
    agentWorkLabNextModePrompt('same-agent').instruction,
    /Run \/handoff.*press m/i,
  );
  assert.match(
    agentWorkLabNextModePrompt('cross-agent').instruction,
    /Open Correct or Failed/,
  );
});

test('Suite commands and Lab control keys share one action vocabulary', () => {
  assert.deepEqual(
    AGENT_WORK_LAB_QUICK_COMMANDS.map(({ command, action }) => ({
      command,
      action,
    })),
    [
      { command: '/demo', action: 'lab-demo' },
      { command: '/same', action: 'lab-same' },
      { command: '/handoff', action: 'lab-handoff' },
      { command: '/report', action: 'lab-report' },
      { command: '/new', action: 'lab-starter' },
      { command: '/focus', action: 'lab-focus-next' },
    ],
  );
  assert.equal(agentWorkLabActionReturnsToControls('lab-report'), true);
  assert.equal(agentWorkLabActionReturnsToControls('lab-starter'), true);
  assert.equal(agentWorkLabActionReturnsToControls('lab-demo'), false);
});

test('report details accept obvious return keys', () => {
  for (const input of [
    '\r',
    '\n',
    '\u001b',
    '\u007f',
    '\b',
    'b',
    'B',
    '\u001b[D',
  ]) {
    assert.equal(isAgentWorkLabReportReturnInput(input), true);
  }
  assert.equal(isAgentWorkLabReportReturnInput('q'), false);
  assert.equal(isAgentWorkLabReportReturnInput('\t'), false);
});

test('Starter receipt Enter opens the project while Esc only closes the receipt', () => {
  assert.equal(agentWorkLabStarterReceiptInput('\r', true, false), 'open');
  assert.equal(agentWorkLabStarterReceiptInput('\n', true, false), 'open');
  assert.equal(agentWorkLabStarterReceiptInput('\r', true, true), 'none');
  assert.equal(agentWorkLabStarterReceiptInput('\r', false, false), 'close');
  assert.equal(agentWorkLabStarterReceiptInput('\u001b', true, false), 'close');
  assert.equal(agentWorkLabStarterReceiptInput('x', true, false), 'none');
});

test('one creation confirmation automatically opens the selected Starter Project', async () => {
  const output = new CaptureOutput();
  const calls: string[] = [];
  const plan = {
    schema: 'kungfu.project-template.plan/v1',
    templateId: 'kungfu.agent-work-starter',
    templateVersion: '1',
    templateRoot: `sha256:${'1'.repeat(64)}`,
    templateSource: '/product/starter-project.json',
    destination: '/projects/agent-work-starter',
    files: [{ path: 'AGENTS.md', contentRoot: `sha256:${'2'.repeat(64)}` }],
    initialWork: {
      state: 'capture-pending',
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      title: 'Create launch brief',
      acceptanceChecks: ['Use evidence'],
    },
    effects: ['Create files'],
    skippedEffects: ['No overwrite'],
    confirmationRequired: true,
    writeOccurred: false,
    planRoot: `sha256:${'3'.repeat(64)}`,
  } satisfies ProjectTemplatePlan;
  const receipt = {
    schema: 'kungfu.project-template.creation-receipt/v1',
    status: 'created',
    templateId: plan.templateId,
    templateRoot: plan.templateRoot,
    planRoot: plan.planRoot,
    destination: plan.destination,
    actor: 'local-user',
    files: plan.files,
    verification: { ok: true, checks: [] },
    initialWork: {
      state: 'captured-pending-admission',
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      requestRoot: `sha256:${'4'.repeat(64)}`,
      receiptRoot: `sha256:${'5'.repeat(64)}`,
      requestPath: `${plan.destination}/.kungfu/inbox/request.json`,
    },
    openAction: {
      kind: 'select-project-workspace',
      label: 'Open Starter Project',
    },
    nonClaims: [],
    writeOccurred: true,
    receiptRoot: `sha256:${'6'.repeat(64)}`,
  } satisfies ProjectTemplateCreationReceipt;
  const workspace = {
    schema: 'kungfu.workspace.registry/v1',
    last_workspace_id: 'project:starter',
    recent: [],
    updated_at: '2026-07-29T00:00:00Z',
    registry_path: '/config/workspaces.json',
    selected: {
      schema: 'kungfu.workspace.identity/v1',
      workspace_id: 'project:starter',
      identity_root: `sha256:${'7'.repeat(64)}`,
      identity_state: 'qualified',
      workspace_kind: 'project',
      workspace_root: plan.destination,
      display_path: plan.destination,
      data_home: `${plan.destination}/.kungfu`,
      runtime_dir: `${plan.destination}/.kungfu/runtime`,
      initialized: false,
      state: 'uninitialized',
      resolution_reason: 'explicit-project',
      continuation: {},
      available: true,
      selected_at: '2026-07-29T00:00:00Z',
    },
  } satisfies ProjectTemplateWorkspaceSelection;
  let opened: ProjectTemplateWorkspaceSelection | undefined;
  const lab = {
    discoverAgents: async () => ({ configured: [], discovered: [] }),
    planStarterProject: async () => {
      calls.push('plan');
      return plan;
    },
    createStarterProject: async () => {
      calls.push('create');
      return receipt;
    },
    openStarterProject: async () => {
      calls.push('open');
      return workspace;
    },
  } as unknown as AgentWorkLab;
  const instance = render(
    React.createElement(AgentWorkLabHost, {
      lab,
      startup: {
        schema: 'kungfu.agent-work-lab.startup-route/v1',
        state: 'verified-empty',
        route: 'agent-work-lab',
        reasonCode: 'test',
        message: 'test',
        runtimeDir: '/tmp/runtime',
        workGraphPresent: false,
        evidence: [],
        writeOccurred: false,
      },
      dimensions: {
        get: () => ({ columns: 80, rows: 20 }),
        subscribe: () => () => undefined,
      },
      actionRequest: { id: 1, action: 'lab-starter' },
      onOpenStarterProject: (
        _receipt: ProjectTemplateCreationReceipt,
        selected: ProjectTemplateWorkspaceSelection,
      ) => {
        opened = selected;
      },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );

  try {
    await waitUntil(
      () => output.chunks.join('').includes('CREATE AGENT WORK STARTER?'),
      'the Starter Project confirmation panel',
    );
    process.stdin.emit('data', Buffer.from('\r'));
    await waitUntil(() => Boolean(opened), 'the opened Starter Project');
  } finally {
    instance.unmount();
    instance.cleanup();
    process.stdin.pause();
  }

  assert.equal(opened?.selected.workspace_root, plan.destination);
  assert.deepEqual(calls, ['plan', 'create', 'open']);
});

test('TUI host streams events and preserves the one-second rhythm', () => {
  const mainSource = readFileSync(
    new URL('./main.tsx', import.meta.url),
    'utf8',
  );
  const hostSource = readFileSync(
    new URL('./agent-work-lab-view.tsx', import.meta.url),
    'utf8',
  );
  const playbackSource = readFileSync(
    new URL('./profile-shell.tsx', import.meta.url),
    'utf8',
  );

  assert.match(mainSource, /execFileEvents:/);
  assert.match(playbackSource, /wait\(timing\.eventIntervalMs\)/);
  assert.match(playbackSource, /wait\(timing\.verdictIntervalMs\)/);
  assert.match(hostSource, /agentWorkLabRunProgressLabel/);
  assert.match(mainSource, /existingProjectWorkspaceRoot\(process\.cwd\(\)/);
  assert.match(
    mainSource,
    /firstLaunch\s*\? 'onboarding'\s*: emptyState\s*\? 'all-work'\s*: 'loading'/u,
  );
  assert.match(mainSource, /shouldShowKungfuOnboarding/);
  assert.match(mainSource, /startupIntroSettled/);
  assert.match(mainSource, /TerminalLoadingScene/);
  assert.match(mainSource, /surface !== 'lab'/);
  assert.match(hostSource, /quietProgressIntervalMs/);
  assert.match(hostSource, /recommendationDurationMs/);
  assert.match(hostSource, /nextAgentWorkLabFocus/);
  assert.match(hostSource, /isAgentWorkLabReportReturnInput/);
  assert.match(hostSource, /setReportDetail\(activeFocus\)/);
  assert.match(
    hostSource,
    /setReportDetail\(\s*value\.status === 'failed' \? 'failed' : 'correct',?\s*\)/,
  );
  assert.match(hostSource, /performSuiteAction\('lab-demo'\)/);
  assert.match(hostSource, /performSuiteAction\('lab-same'\)/);
  assert.match(hostSource, /performSuiteAction\('lab-handoff'\)/);
  assert.doesNotMatch(hostSource, /input === 'p'/);
  assert.doesNotMatch(hostSource, /lab\.planAgent/);
  assert.match(hostSource, /lab\.runDemo\(onEvent\)/);
  assert.match(hostSource, /lab\.runAgent\(source\.id, onEvent\)/);
  assert.match(hostSource, /lab\.runMigration\(/);
  assert.match(mainSource, /void lab\s*\.inspect\(\)/);
  assert.doesNotMatch(mainSource, /startup = lab\.inspectSync\(\)/);
  assert.match(mainSource, /Opening your Work control plane/);
  assert.doesNotMatch(
    mainSource,
    /setRunProgress|setNextPrompt|setReportDetail/,
  );
});

test('clicking a visible Lab action executes the same bounded action as its key', async () => {
  const output = new CaptureOutput();
  const calls: string[] = [];
  const lab = {
    discoverAgents: async () => ({ configured: [], discovered: [] }),
    runDemo: async () => {
      calls.push('demo');
      return qualifiedReport;
    },
  } as unknown as AgentWorkLab;
  const instance = render(
    React.createElement(AgentWorkLabHost, {
      lab,
      startup: {
        schema: 'kungfu.agent-work-lab.startup-route/v1',
        state: 'verified-empty',
        route: 'agent-work-lab',
        reasonCode: 'pointer-test',
        message: 'Pointer action test.',
        runtimeDir: '/tmp/kungfu-pointer-test',
        workGraphPresent: false,
        evidence: [],
        writeOccurred: false,
      },
      dimensions: {
        get: () => ({ columns: 80, rows: 20 }),
        subscribe: () => () => undefined,
      },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );

  try {
    await waitUntil(
      () => output.chunks.join('').includes('Ready · choose a test case'),
      'the clickable Lab action bar to become ready',
    );
    const clickDemo = Buffer.from('\u001b[<0;5;4M');
    await waitUntil(() => {
      if (!calls.includes('demo')) process.stdin.emit('data', clickDemo);
      return calls.includes('demo');
    }, 'the clicked Demo action');
  } finally {
    instance.unmount();
    instance.cleanup();
    process.stdin.pause();
  }

  assert.deepEqual(calls, ['demo']);
});

test('TUI autoplay runs the complete offline case once and settles with its report', async () => {
  const output = new CaptureOutput();
  const calls: string[] = [];
  const settled = new Promise<AgentWorkLabReport>((resolve, reject) => {
    const lab = {
      discoverAgents: async () => {
        calls.push('discover');
        return { configured: [], discovered: [] };
      },
      runDemo: async (onEvent?: (event: AgentWorkLabEvent) => void) => {
        calls.push('demo');
        onEvent?.({
          schema: 'kungfu.agent-work-lab.event/v1',
          step: 'session-1-start',
          status: 'running',
          root: `sha256:${'4'.repeat(64)}`,
        });
        onEvent?.({
          schema: 'kungfu.agent-work-lab.event/v1',
          step: 'session-2-start',
          status: 'running',
          root: `sha256:${'5'.repeat(64)}`,
        });
        onEvent?.({
          schema: 'kungfu.agent-work-lab.event/v1',
          step: 'assessment',
          status: 'qualified',
          root: `sha256:${'6'.repeat(64)}`,
        });
        return qualifiedReport;
      },
    } as unknown as AgentWorkLab;
    const instance = render(
      React.createElement(AgentWorkLabHost, {
        lab,
        startup: {
          schema: 'kungfu.agent-work-lab.startup-route/v1',
          state: 'verified-empty',
          route: 'agent-work-lab',
          reasonCode: 'autoplay',
          message: 'Autoplay owns the startup surface.',
          runtimeDir: '/tmp/kungfu-autoplay',
          workGraphPresent: false,
          evidence: [],
          writeOccurred: false,
        },
        dimensions: {
          get: () => ({ columns: 80, rows: 20 }),
          subscribe: () => () => undefined,
        },
        autoplay: {
          wait: async () => undefined,
          onSettled: (result) => {
            instance.unmount();
            instance.cleanup();
            process.stdin.pause();
            if (result.state === 'completed') resolve(result.report);
            else reject(new Error(result.message));
          },
        },
      }),
      {
        stdout: output as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
  });

  assert.equal(await settled, qualifiedReport);
  assert.deepEqual(calls, ['demo']);
});

test('state updates use incremental terminal painting instead of clearTerminal', async () => {
  const output = new CaptureOutput();
  const terminalOutput = new IncrementalTerminalOutput(output);
  const instance = render(React.createElement(AgentWorkLabView, viewProps), {
    stdout: terminalOutput as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      buffers: {
        1: [
          {
            session: 1,
            source: 'agent/live',
            text: 'Inspecting the admitted Work identity.',
            tone: 'running',
          },
        ],
        2: [],
      },
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const updates = output.chunks.slice(initialWrites);
  instance.unmount();
  instance.cleanup();
  assert.equal(output.chunks.join('').includes('\u001b[2J'), false);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /Inspecting the admit/);
  assert.doesNotMatch(updates[0].split('\u001b').join(''), /\[\d*A/);
});

test('the real Ink 80x24 Lab keeps both Session headers visible', async () => {
  const output = new CaptureOutput();
  const instance = render(React.createElement(AgentWorkLabView, viewProps), {
    stdout: output as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();
  assert.match(frame, /│> S1 · Bundled Demo Agent\s+READY│/);
  assert.match(frame, /S2 · Fresh Demo Agent\s+READY/);
  assert.match(frame, /AGENT WORK LAB/);
});

test('the real Ink 80x24 title bars show only the active running Session', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      busy: 'running two fresh demo sessions',
      progress: 'Still running · 2s elapsed · 4 admitted events',
      runningSession: 2,
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.equal(frame.match(/◐ RUNNING/g)?.length, 1);
  assert.match(frame, /> S1 · Bundled Demo Agent\s+READY/);
  assert.match(frame, /S2 · Fresh Demo Agent\s+◐ RUNNING/);
});

test('the spinner animation repaints only the shared title-bar row', async () => {
  const output = new CaptureOutput();
  const terminalOutput = new IncrementalTerminalOutput(output);
  const runningProps = {
    ...viewProps,
    busy: 'running two fresh demo sessions',
    progress: 'Still running · 2s elapsed · 4 admitted events',
    runningSession: 2 as const,
  };
  const instance = render(React.createElement(AgentWorkLabView, runningProps), {
    stdout: terminalOutput as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...runningProps,
      activityFrame: 1,
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const updates = output.chunks.slice(initialWrites);
  instance.unmount();
  instance.cleanup();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].split('\u001b[2K').length - 1, 1);
  assert.equal(updates[0].match(/◓ RUNNING/g)?.length, 1);
});

test('report cards, coaching popup and detail page are visible at 80x24', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      report: qualifiedReport,
      activeFocus: 'correct',
      nextPrompt: agentWorkLabNextModePrompt('offline-demo'),
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      report: qualifiedReport,
      activeFocus: 'correct',
      reportDetail: 'correct',
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const detailFrame = output.chunks.at(-1) ?? '';
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /> ✓ 3 CORRECT · click \/ Enter det/);
  assert.match(frame, /× 1 FAILED · click \/ Enter deta/);
  assert.match(frame, /WHAT TO TRY NEXT/);
  assert.match(frame, /Closes automatically in 5 seconds/);
  assert.match(frame, /║ WHAT TO TRY NEXT\s+║/);
  assert.match(detailFrame, /✓ CORRECT CHECKS · 3/);
  assert.match(detailFrame, /RETURN TO RESULT CARDS/);
  assert.match(detailFrame, /Esc \/ Enter \/ Backspace \/ b/);
  assert.match(detailFrame, /Two genuinely fresh processes/);
  assert.match(detailFrame, /Session 2 received no copied chat/);
});

test('Starter Project confirmation uses the opaque workbench guide panel', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      guideOverlay: {
        heading: 'START YOUR OWN WORK',
        title: 'CREATE AGENT WORK STARTER?',
        lines: [
          'Destination: /projects/agent-work-starter',
          'Existing folders are never overwritten. Git is not changed.',
        ],
        footer: 'Enter creates · Esc cancels.',
      },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /START YOUR OWN WORK/);
  assert.match(frame, /CREATE AGENT WORK STARTER/);
  assert.match(frame, /Existing folders are never overwritten/);
  assert.match(frame, /Enter creates · Esc cancels/);
});

test('autoplay explains the experiment, states the value, then opens its acceptance report', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      showHelp: true,
      autoplay: { introCountdown: 5, phase: 1 },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const introFrame = output.chunks.join('');
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      showHelp: true,
      report: qualifiedReport,
      activeFocus: 'correct',
      autoplay: { introCountdown: 0, phase: 4 },
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const finalFrame = output.chunks.at(-1) ?? '';
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      showHelp: true,
      report: qualifiedReport,
      activeFocus: 'correct',
      reportDetail: 'correct',
      autoplay: { introCountdown: 0, phase: 4 },
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const reportFrame = output.chunks.at(-1) ?? '';
  instance.unmount();
  instance.cleanup();

  assert.match(introFrame, /WHAT THIS DEMO PROVES/);
  assert.match(introFrame, /ONE WORK\. TWO FRESH SESSIONS\./);
  assert.match(introFrame, /without receiving the previous chat/i);
  assert.match(introFrame, /No action needed.*5 seconds/i);
  assert.match(finalFrame, /WORK CONTINUITY PROVED/);
  assert.match(finalFrame, /THE CHAT ENDED\. THE WORK DID NOT\./);
  assert.match(finalFrame, /STEP 4\/4/);
  assert.doesNotMatch(finalFrame, /WHAT TO TRY NEXT/);
  assert.doesNotMatch(finalFrame, /Enter details/);
  assert.match(reportFrame, /ACCEPTANCE REPORT · 3\/4 CHECKS PASSED/);
  assert.match(reportFrame, /Two genuinely fresh processes/);
  assert.match(reportFrame, /Session 2 received no copied chat/);
  assert.match(reportFrame, /This acceptance report closes automatically/);
  assert.doesNotMatch(reportFrame, /RETURN TO RESULT CARDS/);
});

test('Tab focus repaints only the shared title-bar row', async () => {
  const output = new CaptureOutput();
  const terminalOutput = new IncrementalTerminalOutput(output);
  const instance = render(React.createElement(AgentWorkLabView, viewProps), {
    stdout: terminalOutput as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(AgentWorkLabView, {
      ...viewProps,
      activeFocus: 'session-2',
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const updates = output.chunks.slice(initialWrites);
  instance.unmount();
  instance.cleanup();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].includes('\u001b[2J'), false);
  assert.match(updates[0], /> S2 · Fresh Demo Agent/);
  assert.equal(updates[0].split('\u001b[2K').length - 1, 1);
});
