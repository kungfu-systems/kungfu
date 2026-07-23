// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  ENTER_ALTERNATE_SCREEN,
  LEAVE_ALTERNATE_SCREEN,
  type TerminalInput,
  TerminalLifecycle,
  type TerminalOutput,
} from './terminal-lifecycle.js';

class FakeOutput extends EventEmitter implements TerminalOutput {
  isTTY = true;
  columns = 120;
  rows = 36;
  writes: string[] = [];
  write(value: string) {
    this.writes.push(value);
    return true;
  }
}

test('owns alternate screen, raw mode, resize, and idempotent restoration', () => {
  const output = new FakeOutput();
  const signals = new EventEmitter();
  const raw: boolean[] = [];
  const flow: string[] = [];
  const input: TerminalInput = {
    isTTY: true,
    isRaw: false,
    readableFlowing: null,
    setRawMode: (enabled) => raw.push(enabled),
    resume: () => flow.push('resume'),
    pause: () => flow.push('pause'),
  };
  const sizes: Array<{ columns: number; rows: number }> = [];
  const exits: Array<NodeJS.Signals | undefined> = [];
  const lifecycle = new TerminalLifecycle(input, output, signals);
  lifecycle.start({
    onExit: (signal) => {
      exits.push(signal);
      output.write('INK-UNMOUNTED');
    },
    onResize: (size) => sizes.push(size),
  });
  output.columns = 80;
  output.rows = 24;
  output.emit('resize');
  signals.emit('SIGTERM');
  lifecycle.restore();

  assert.deepEqual(output.writes, [
    ENTER_ALTERNATE_SCREEN,
    'INK-UNMOUNTED',
    LEAVE_ALTERNATE_SCREEN,
  ]);
  assert.deepEqual(raw, [true, false]);
  assert.deepEqual(flow, ['resume', 'pause']);
  assert.deepEqual(sizes, [{ columns: 80, rows: 24 }]);
  assert.deepEqual(exits, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(output.listenerCount('resize'), 0);
});

test('rejects non-TTY activation before changing terminal state', () => {
  const output = new FakeOutput();
  const lifecycle = new TerminalLifecycle(
    { isTTY: false },
    output,
    new EventEmitter(),
  );
  assert.throws(
    () =>
      lifecycle.start({ onExit: () => undefined, onResize: () => undefined }),
    /interactive terminal required/,
  );
  assert.deepEqual(output.writes, []);
});

test('restores terminal state when the wrapped task throws', async () => {
  const output = new FakeOutput();
  const raw: boolean[] = [];
  const lifecycle = new TerminalLifecycle(
    { isTTY: true, isRaw: false, setRawMode: (enabled) => raw.push(enabled) },
    output,
    new EventEmitter(),
  );
  await assert.rejects(
    lifecycle.run(
      { onExit: () => undefined, onResize: () => undefined },
      async () => {
        throw new Error('fixture boot failure');
      },
    ),
    /fixture boot failure/,
  );
  assert.deepEqual(raw, [true, false]);
  assert.equal(output.writes.at(-1), LEAVE_ALTERNATE_SCREEN);
});

test('restores alternate screen and input after partial startup failure', async () => {
  const output = new FakeOutput();
  const raw: boolean[] = [];
  const lifecycle = new TerminalLifecycle(
    {
      isTTY: true,
      isRaw: false,
      setRawMode: (enabled) => {
        raw.push(enabled);
        if (enabled) throw new Error('raw startup failure');
      },
    },
    output,
    new EventEmitter(),
  );
  await assert.rejects(
    lifecycle.run(
      { onExit: () => undefined, onResize: () => undefined },
      async () => undefined,
    ),
    /raw startup failure/,
  );
  assert.deepEqual(raw, [true, false]);
  assert.deepEqual(output.writes, [
    ENTER_ALTERNATE_SCREEN,
    LEAVE_ALTERNATE_SCREEN,
  ]);
});

test(
  'real PTY smoke observes balanced lifecycle sequences',
  { skip: process.platform === 'win32' },
  () => {
    const tsx = path.resolve('node_modules/.bin/tsx');
    const child = path.resolve('src/terminal-lifecycle-smoke.ts');
    const driver = path.resolve('src/terminal-lifecycle-pty-smoke.py');
    const result = spawnSync('python3', [driver, '/bin/sh', tsx, child], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = result.stdout;
    assert.ok(output.includes(ENTER_ALTERNATE_SCREEN));
    assert.ok(output.includes('\u001b[?25l'));
    assert.match(output, /PTY-LIFECYCLE-SMOKE/);
    assert.ok(output.includes('\u001b[?25h'));
    assert.ok(output.includes(LEAVE_ALTERNATE_SCREEN));
  },
);
