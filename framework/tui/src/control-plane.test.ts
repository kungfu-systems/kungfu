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

test('opens Help, slash commands, and product search from the idle input bar', () => {
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '?', 0).state.mode,
    'help',
  );
  assert.deepEqual(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '/', QUICK_COMMANDS.length)
      .state,
    { mode: 'commands', query: '/', selected: 0 },
  );
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '\u000b', 0).state.mode,
    'search',
  );
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, 'j', 0).handled,
    false,
  );
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
    query: '',
    selected: 0,
  };
  const fence = createControlPlaneInputFence(() => state.mode !== 'closed');
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
  assert.equal(fence.isCaptured(), false);
});

test('keeps quick commands bounded to declared product actions', () => {
  assert.deepEqual(
    QUICK_COMMANDS.map((row) => row.action),
    ['help', 'search', 'work', 'lab', 'home', 'quit'],
  );
  assert.equal(quickCommandMatches('/rm -rf').length, 0);
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
        state: { mode: 'help', query: '', selected: 0 },
        searchResults: [],
        quickCommands: QUICK_COMMANDS,
        catalogStatus: 'catalog ready',
      }),
      React.createElement(ControlPlaneBar, {
        dimensions,
        state: { mode: 'help', query: '', selected: 0 },
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
  assert.match(frame, /The input bar runs bounded product actions/);
  assert.match(frame, /Help open · Esc return/);
  assert.doesNotMatch(frame, /UNDERLYING PRODUCT CONTENT/);
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
        state: { mode: 'search', query: 'help', selected: 11 },
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
