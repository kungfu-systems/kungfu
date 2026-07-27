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
import { IncrementalTerminalOutput } from './incremental-terminal-output.js';
import {
  QualificationLabView,
  isQualificationReportReturnInput,
  nextQualificationFocus,
  qualificationEventLines,
  qualificationEventRunningSession,
  qualificationNextModePrompt,
  qualificationPromptRows,
  qualificationSessionTitleBar,
} from './qualification-lab-view.js';

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
  const source = readFileSync(
    new URL('./qualification-lab-view.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /width="50%"/);
  assert.match(source, /PUBLIC STATUS/);
  assert.match(source, /PRIVATE REASONING \+ RAW OUTPUT HIDDEN/);
  assert.match(source, /CONTINUITY PROVED/);
  assert.match(source, /height=\{6\}/);
  assert.match(source, /↑↓ scroll focused Session/);
  assert.match(source, /borderColor="gray"/);
  assert.match(source, /color=\{active \? 'black' : 'white'\}/);
  assert.match(source, /backgroundColor=\{active \? 'cyan' : 'gray'\}/);
  assert.match(source, /qualificationSessionTitleBar/);
  assert.match(
    source,
    /running=\{Boolean\(progress\) && runningSession === 1\}/,
  );
  assert.match(
    source,
    /running=\{Boolean\(progress\) && runningSession === 2\}/,
  );
  assert.match(source, /Enter details/);
  assert.match(source, /WHAT TO TRY NEXT/);
  assert.match(source, /backgroundColor="blue"/);
  assert.match(source, /opaquePromptLine/);
  assert.doesNotMatch(source, /\[p\] prepare/);
  assert.match(source, /\[Tab\]\s*focus/);
  assert.match(source, /\[\?\] explain/);
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
  assert.deepEqual(qualificationNextModePrompt('offline-demo'), {
    title: 'Offline complete · now test your real agent',
    instruction:
      'Press x to test same-agent continuity with your selected agent.',
  });
  assert.doesNotMatch(
    qualificationNextModePrompt('offline-demo').instruction,
    /Press p/,
  );
  assert.match(
    qualificationNextModePrompt('same-agent').instruction,
    /press m to test handoff/i,
  );
  assert.match(
    qualificationNextModePrompt('cross-agent').instruction,
    /press Enter to open its details/,
  );
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
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

  assert.match(source, /execFileEvents:/);
  assert.match(source, /setTimeout\(resolve, 1000\)/);
  assert.match(source, /setTimeout\(resolve, 520\)/);
  assert.match(source, /qualificationRunProgressLabel/);
  assert.match(source, /qualificationLabStartupSurface/);
  assert.match(
    source,
    /setInterval\(\(\) => setProgressNow\(Date\.now\(\)\), 1000\)/,
  );
  assert.match(
    source,
    /setTimeout\(\(\) => setNextPrompt\(undefined\), 5000\)/,
  );
  assert.match(source, /nextQualificationFocus/);
  assert.match(source, /isQualificationReportReturnInput/);
  assert.match(source, /setReportDetail\(activeFocus\)/);
  assert.doesNotMatch(source, /input === 'p'/);
  assert.doesNotMatch(source, /lab\.planAgent/);
  assert.match(source, /lab\.runDemo\(onEvent\)/);
  assert.match(source, /lab\.runAgent\(profiles\[selected\]\.id, onEvent\)/);
  assert.match(source, /lab\.runMigration\(/);
  assert.match(source, /void lab\s*\.inspect\(\)/);
  assert.doesNotMatch(source, /startup = lab\.inspectSync\(\)/);
  assert.match(source, /Terminal product is open/);
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
  assert.match(frame, /AGENT QUALIFICATION LAB/);
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
