// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';

import {
  CLOSED_CONTROL_PLANE,
  ControlPlaneBar,
  ControlPlaneOverlay,
  type ControlPlaneState,
  QUICK_COMMANDS,
  createControlPlaneInputFence,
  quickCommandMatches,
  reduceControlPlaneInput,
} from './profile-shell.js';
import { AGENT_WORK_LAB_QUICK_COMMANDS } from './qualification-lab-view.js';

class CaptureOutput extends Writable {
  readonly isTTY = false;
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

test('opens Help, slash commands, and product search from the focused input', () => {
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '?', 0).state.mode,
    'help',
  );
  assert.deepEqual(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '/', QUICK_COMMANDS.length)
      .state,
    { mode: 'commands', focus: 'input', query: '/', selected: 0 },
  );
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '\u000b', 0).state.mode,
    'search',
  );
  const typed = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, 'hello', 0);
  assert.equal(typed.handled, true);
  assert.equal(typed.state.query, 'hello');
  assert.match(
    reduceControlPlaneInput(typed.state, '\r', 0).state.notice ?? '',
    /Free-form Agent conversation is coming soon/,
  );
});

test('Esc hands focus to workspace shortcuts and i returns to input', () => {
  const workspace = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    '\u001b',
    0,
  ).state;
  assert.equal(workspace.focus, 'workspace');
  assert.equal(reduceControlPlaneInput(workspace, 'j', 0).handled, false);
  const focused = reduceControlPlaneInput(workspace, 'i', 0);
  assert.equal(focused.handled, true);
  assert.equal(focused.state.focus, 'input');
});

test('Tab enters controls and requests one bounded focus move', () => {
  const update = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '\t', 0);
  assert.equal(update.handled, true);
  assert.equal(update.state.focus, 'workspace');
  assert.equal(update.workspaceNavigation, 'next-focus');

  const typed = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, 'd', 0);
  assert.equal(typed.state.query, 'd');
  assert.equal(typed.workspaceNavigation, undefined);
});

test('edits input, selects results, activates, and returns without leaking keys', () => {
  const opened = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    '/',
    QUICK_COMMANDS.length,
  ).state;
  const typed = reduceControlPlaneInput(
    opened,
    'wo',
    QUICK_COMMANDS.length,
  ).state;
  assert.equal(typed.query, '/wo');
  assert.deepEqual(
    quickCommandMatches(typed.query).map((row) => row.command),
    ['/work'],
  );
  assert.equal(reduceControlPlaneInput(typed, '\r', 1).activate, true);
  assert.equal(
    reduceControlPlaneInput(typed, '\u001b', 1).state.mode,
    'closed',
  );
});

test('keeps a closing key captured for the rest of its synchronous input emission', async () => {
  const input = new EventEmitter();
  let state: ControlPlaneState = {
    mode: 'help',
    focus: 'input',
    query: '',
    selected: 0,
  };
  const fence = createControlPlaneInputFence(
    () => state.mode !== 'closed' || state.focus === 'input',
  );
  let leaked = false;
  input.prependListener('data', (chunk: string) => {
    const update = reduceControlPlaneInput(state, chunk, 0);
    if (!update.handled) return;
    fence.captureCurrentEmission();
    state = update.state;
  });
  input.on('data', () => {
    leaked = !fence.isCaptured();
  });

  input.emit('data', '\u001b');
  assert.equal(state.mode, 'closed');
  assert.equal(leaked, false);
  await Promise.resolve();
  assert.equal(fence.isCaptured(), true);
  state = reduceControlPlaneInput(state, '\u001b', 0).state;
  assert.equal(fence.isCaptured(), false);
});

test('keeps quick commands bounded to declared product actions', () => {
  assert.deepEqual(
    QUICK_COMMANDS.map((row) => row.action),
    ['help', 'search', 'work', 'lab', 'home', 'quit'],
  );
  assert.equal(quickCommandMatches('/rm -rf').length, 0);
});

test('adds Suite actions only to the active Lab command catalog', () => {
  const labCommands = [...AGENT_WORK_LAB_QUICK_COMMANDS, ...QUICK_COMMANDS];
  assert.deepEqual(
    quickCommandMatches('/same', labCommands).map((row) => row.action),
    ['lab-same'],
  );
  assert.equal(quickCommandMatches('/same').length, 0);
  assert.deepEqual(
    AGENT_WORK_LAB_QUICK_COMMANDS.map((row) => row.command),
    ['/demo', '/same', '/handoff', '/report', '/focus'],
  );
});

test('the real Ink control plane covers the product canvas and keeps a fixed input bar', async () => {
  const output = new CaptureOutput();
  const dimensions = { columns: 80, rows: 24 };
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(Text, null, 'UNDERLYING PRODUCT CONTENT'),
      React.createElement(ControlPlaneOverlay, {
        dimensions: { columns: 80, rows: 22 },
        state: { mode: 'help', focus: 'input', query: '', selected: 0 },
        searchResults: [],
        quickCommands: QUICK_COMMANDS,
        catalogStatus: 'catalog ready',
      }),
      React.createElement(ControlPlaneBar, {
        dimensions,
        state: { mode: 'help', focus: 'input', query: '', selected: 0 },
        resultCount: 0,
      }),
    ),
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
  assert.match(frame, /KUNGFU · HELP/);
  assert.match(frame, /focused input accepts text/);
  assert.match(frame, /Help is open/);
  assert.match(frame, /╭/);
  assert.match(frame, /╰/);
  assert.doesNotMatch(frame, /UNDERLYING PRODUCT CONTENT/);
});

test('the idle input is a focused full panel and renders typed text', async () => {
  const output = new CaptureOutput();
  const typed = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    'continue work',
    0,
  ).state;
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: typed,
        resultCount: 0,
      }),
    ),
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
  assert.match(frame, /continue work/);
  assert.match(frame, /INPUT · Kungfu/);
  assert.match(frame, /Text entry is active · Esc Controls/);
  assert.match(frame, /╭/);
  assert.match(frame, /╰/);
});

test('the idle bar makes Lab controls visually explicit', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: { ...CLOSED_CONTROL_PLANE, focus: 'workspace' },
        resultCount: 0,
        surfaceLabel: 'Agent Work Lab',
        controlsLabel: 'LAB CONTROLS',
        controlsHint: 'd Demo · x Same · m Handoff · Tab Focus',
      }),
    ),
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

  assert.match(frame, /LAB CONTROLS · Agent Work Lab/);
  assert.match(frame, /d Demo · x Same · m Handoff · Tab Focus/);
  assert.match(frame, /i Input/);
});

test('search keeps the selected result visible beyond the first viewport', async () => {
  const output = new CaptureOutput();
  const searchResults = Array.from({ length: 12 }, (_, index) => ({
    id: `help.${index}`,
    kind: 'help' as const,
    title: `Help topic ${index}`,
    summary: `Summary ${index}`,
    action: { kind: 'show-help' as const, topicId: String(index) },
    score: 100 - index,
  }));
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 11, flexDirection: 'column' },
      React.createElement(ControlPlaneOverlay, {
        dimensions: { columns: 80, rows: 12 },
        state: {
          mode: 'search',
          focus: 'input',
          query: 'help',
          selected: 11,
        },
        searchResults,
        quickCommands: QUICK_COMMANDS,
        catalogStatus: 'catalog ready',
      }),
    ),
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
  assert.match(frame, /Help topic 11/);
  assert.doesNotMatch(frame, /Help topic 0/);
});
