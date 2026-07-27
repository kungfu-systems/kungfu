// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  IncrementalTerminalOutput,
  type WritableTerminal,
} from './terminal-canvas.js';

class FakeTerminal extends EventEmitter implements WritableTerminal {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}

test('writes the first complete frame once from terminal home', () => {
  const terminal = new FakeTerminal();
  const output = new IncrementalTerminalOutput(terminal);

  output.write('alpha\nbeta\ngamma');

  assert.deepEqual(terminal.writes, ['\u001b[Halpha\nbeta\ngamma']);
});

test('updates only changed physical lines in one terminal write', () => {
  const terminal = new FakeTerminal();
  const output = new IncrementalTerminalOutput(terminal);
  output.write('stable heading\nold status\nstable footer');
  terminal.writes = [];

  output.write('stable heading\nnew status\nstable footer');

  assert.deepEqual(terminal.writes, ['\u001b[2;1H\u001b[2Knew status']);
  assert.doesNotMatch(terminal.writes[0], /stable heading|stable footer/);
  assert.equal(terminal.writes[0].includes('\u001b[2J'), false);
  assert.doesNotMatch(terminal.writes[0].split('\u001b').join(''), /\[\d*A/);
});

test('erases lines removed by a shorter frame', () => {
  const terminal = new FakeTerminal();
  const output = new IncrementalTerminalOutput(terminal);
  output.write('alpha\nbeta\ngamma');
  terminal.writes = [];

  output.write('alpha');

  assert.deepEqual(terminal.writes, [
    '\u001b[2;1H\u001b[2K\u001b[3;1H\u001b[2K',
  ]);
});

test('suppresses identical frames', () => {
  const terminal = new FakeTerminal();
  const output = new IncrementalTerminalOutput(terminal);
  output.write('stable');
  terminal.writes = [];

  output.write('stable');

  assert.deepEqual(terminal.writes, []);
});

test('cursor visibility controls do not replace the cached frame', () => {
  const terminal = new FakeTerminal();
  const output = new IncrementalTerminalOutput(terminal);
  output.write('stable heading\nold status\nstable footer');
  output.write('\u001b[?25l');
  terminal.writes = [];

  output.write('stable heading\nnew status\nstable footer');

  assert.deepEqual(terminal.writes, ['\u001b[2;1H\u001b[2Knew status']);
});
