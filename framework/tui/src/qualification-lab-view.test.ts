// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  QualificationLabEvent,
  QualificationLabReport,
} from '@kungfu-tech/api/capability';
import { render } from 'ink';
import React from 'react';
import {
  createIncrementalPlayback,
  nextWorkbenchFocus,
  sessionTitleBar,
} from './profile-shell.js';
import {
  AGENT_WORK_LAB_QUICK_COMMANDS,
  QualificationLabView,
  agentWorkLabActionReturnsToControls,
  isQualificationReportReturnInput,
  nextQualificationFocus,
  qualificationEventLines,
  qualificationEventRunningSession,
  qualificationNextModePrompt,
  qualificationPromptRows,
  qualificationSessionTitleBar,
} from './qualification-lab-view.js';
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
    /Agent Work Lab|offline-demo|same-agent|cross-agent|qualification-lab|oracle/i,
  );
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

const viewProps = {
  dimensions: { columns: 80, rows: 24 },
  mode: 'offline-demo' as const,
  sourceLabel: '',
  targetLabel: '',
  lines: [],
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

const qualifiedReport: QualificationLabReport = {
  schema: 'kungfu.qualification-lab.report/v1',
  status: 'qualified',
  suite: 'kungfu.agent-continuity.v1',
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
  evidenceDirectory: '/tmp/evidence',
  writeOccurred: true,
};

test('TUI renders admitted provider narration without raw commands', () => {
  const event: QualificationLabEvent = {
    schema: 'kungfu.qualification-lab.event/v1',
    step: 'session-2-activity',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
    publicActivity: {
      schema: 'kungfu.qualification-lab.public-activity/v1',
      source: 'provider-jsonl',
      kind: 'agent',
      phase: 'progress',
      text: 'I found Session 1’s partial result and the same Work identity.',
      rawOutputRedacted: true,
    },
  };

  assert.deepEqual(qualificationEventLines(event), [
    {
      session: 2,
      source: 'agent/live',
      text: 'I found Session 1’s partial result and the same Work identity.',
      tone: 'running',
    },
  ]);
});

test('TUI qualification layout keeps two Sessions and the verdict dock fixed', () => {
  const adapterSource = readFileSync(
    new URL('./qualification-lab-view.tsx', import.meta.url),
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
  assert.match(frameworkSource, /↑↓ scroll focused Session/);
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
  const running = qualificationSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 0,
  });
  const quarter = qualificationSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 1,
  });
  const half = qualificationSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 2,
  });
  const threeQuarter = qualificationSessionTitleBar({
    session: 1,
    title: 'Bundled Demo Agent',
    active: true,
    running: true,
    columns: 38,
    activityFrame: 3,
  });
  const ready = qualificationSessionTitleBar({
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
    qualificationEventRunningSession({
      schema: 'kungfu.qualification-lab.event/v1',
      step: 'session-1-activity',
      status: 'running',
      root: `sha256:${'a'.repeat(64)}`,
    }),
    1,
  );
  assert.equal(
    qualificationEventRunningSession({
      schema: 'kungfu.qualification-lab.event/v1',
      step: 'session-2-start',
      status: 'running',
      root: `sha256:${'b'.repeat(64)}`,
    }),
    2,
  );
  assert.equal(
    qualificationEventRunningSession({
      schema: 'kungfu.qualification-lab.event/v1',
      step: 'assessment',
      status: 'qualified',
      root: `sha256:${'c'.repeat(64)}`,
    }),
    undefined,
  );
});

test('coaching popup rows are bounded and fully paintable', () => {
  const rows = qualificationPromptRows(
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
  assert.equal(nextQualificationFocus('session-1', false), 'session-2');
  assert.equal(nextQualificationFocus('session-2', false), 'session-1');
  assert.equal(nextQualificationFocus('session-2', true), 'correct');
  assert.equal(nextQualificationFocus('correct', true), 'failed');
  assert.equal(nextQualificationFocus('failed', true), 'session-1');
});

test('completed modes coach the next qualification step', () => {
  assert.equal(
    qualificationNextModePrompt('offline-demo').title,
    'Offline complete · now test your real agent',
  );
  assert.match(
    qualificationNextModePrompt('offline-demo').instruction,
    /Run \/same, or press Esc then x/,
  );
  assert.doesNotMatch(
    qualificationNextModePrompt('offline-demo').instruction,
    /Press p/,
  );
  assert.match(
    qualificationNextModePrompt('same-agent').instruction,
    /Run \/handoff.*press m/i,
  );
  assert.match(
    qualificationNextModePrompt('cross-agent').instruction,
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
      { command: '/focus', action: 'lab-focus-next' },
    ],
  );
  assert.equal(agentWorkLabActionReturnsToControls('lab-report'), true);
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
    assert.equal(isQualificationReportReturnInput(input), true);
  }
  assert.equal(isQualificationReportReturnInput('q'), false);
  assert.equal(isQualificationReportReturnInput('\t'), false);
});

test('TUI host streams events and preserves the one-second rhythm', () => {
  const mainSource = readFileSync(
    new URL('./main.tsx', import.meta.url),
    'utf8',
  );
  const hostSource = readFileSync(
    new URL('./qualification-lab-view.tsx', import.meta.url),
    'utf8',
  );
  const playbackSource = readFileSync(
    new URL('./profile-shell.tsx', import.meta.url),
    'utf8',
  );

  assert.match(mainSource, /execFileEvents:/);
  assert.match(playbackSource, /wait\(timing\.eventIntervalMs\)/);
  assert.match(playbackSource, /wait\(timing\.verdictIntervalMs\)/);
  assert.match(hostSource, /qualificationRunProgressLabel/);
  assert.match(mainSource, /qualificationLabStartupSurface/);
  assert.match(hostSource, /quietProgressIntervalMs/);
  assert.match(hostSource, /recommendationDurationMs/);
  assert.match(hostSource, /nextQualificationFocus/);
  assert.match(hostSource, /isQualificationReportReturnInput/);
  assert.match(hostSource, /setReportDetail\(activeFocus\)/);
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
  assert.match(mainSource, /Terminal product is open/);
  assert.doesNotMatch(
    mainSource,
    /setRunProgress|setNextPrompt|setReportDetail/,
  );
});

test('state updates use incremental terminal painting instead of clearTerminal', async () => {
  const output = new CaptureOutput();
  const terminalOutput = new IncrementalTerminalOutput(output);
  const instance = render(
    React.createElement(QualificationLabView, viewProps),
    {
      stdout: terminalOutput as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(QualificationLabView, {
      ...viewProps,
      lines: [
        {
          session: 1,
          source: 'agent/live',
          text: 'Inspecting the admitted Work identity.',
          tone: 'running',
        },
      ],
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
  const instance = render(
    React.createElement(QualificationLabView, viewProps),
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
  assert.match(frame, /│> S1 · Bundled Demo Agent\s+READY│/);
  assert.match(frame, /S2 · Fresh Demo Agent\s+READY/);
  assert.match(frame, /AGENT WORK LAB/);
});

test('the real Ink 80x24 title bars show only the active running Session', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(QualificationLabView, {
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
  const instance = render(
    React.createElement(QualificationLabView, runningProps),
    {
      stdout: terminalOutput as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(QualificationLabView, {
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
    React.createElement(QualificationLabView, {
      ...viewProps,
      report: qualifiedReport,
      activeFocus: 'correct',
      nextPrompt: qualificationNextModePrompt('offline-demo'),
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
    React.createElement(QualificationLabView, {
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

  assert.match(frame, /> ✓ 3 CORRECT · Enter details/);
  assert.match(frame, /× 1 FAILED · Enter details/);
  assert.match(frame, /WHAT TO TRY NEXT/);
  assert.match(frame, /Closes automatically in 5 seconds/);
  assert.match(frame, /║ WHAT TO TRY NEXT\s+║/);
  assert.match(detailFrame, /✓ CORRECT CHECKS · 3/);
  assert.match(detailFrame, /RETURN TO RESULT CARDS/);
  assert.match(detailFrame, /Esc \/ Enter \/ Backspace \/ b/);
  assert.match(detailFrame, /Two genuinely fresh processes/);
  assert.match(detailFrame, /Session 2 received no copied chat/);
});

test('Tab focus repaints only the shared title-bar row', async () => {
  const output = new CaptureOutput();
  const terminalOutput = new IncrementalTerminalOutput(output);
  const instance = render(
    React.createElement(QualificationLabView, viewProps),
    {
      stdout: terminalOutput as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWrites = output.chunks.length;
  instance.rerender(
    React.createElement(QualificationLabView, {
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
