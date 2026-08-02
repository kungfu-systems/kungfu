// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { render } from 'ink';
import React from 'react';

import {
  TitledBorderWindow,
  titledBorderWindowLines,
} from './titled-border-window.js';

class CaptureOutput extends Writable {
  readonly isTTY = false;
  readonly chunks: string[] = [];
  readonly columns = 48;
  readonly rows = 12;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

test('titled border window embeds its title in the top border', () => {
  const lines = titledBorderWindowLines({
    columns: 48,
    title: 'PROJECT INPUT',
    content: ['Esc Controls · ? Help', '› '],
  });

  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.length === 48));
  assert.match(lines[0], /^╭─ PROJECT INPUT ─+╮$/u);
  assert.match(lines[1], /^│ Esc Controls/u);
  assert.match(lines[2], /^│ ›/u);
  assert.match(lines[3], /^╰─+╯$/u);
});

test('titled border window clips long titles without changing its width', () => {
  const [top] = titledBorderWindowLines({
    columns: 24,
    title: 'A TITLE THAT CANNOT FIT INSIDE THE WINDOW',
    content: [],
  });

  assert.equal(top?.length, 24);
  assert.match(top ?? '', /^╭─ A TITLE.*…╮$/u);
});

test('titled border window safely renders primitive padding rows', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(TitledBorderWindow, {
      columns: 48,
      title: 'FILES',
      rows: ['Creating Starter files…', ' ', '  '],
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  instance.cleanup();

  const rendered = output.chunks.join('');
  assert.match(rendered, /^╭─ FILES ─+╮/u);
  assert.match(rendered, /Creating Starter files…/u);
});
