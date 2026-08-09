// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalCanvasRows } from './terminal-canvas.js';

test('keeps one physical terminal row outside the Ink canvas', () => {
  assert.equal(terminalCanvasRows(24), 23);
  assert.equal(terminalCanvasRows(36), 35);
  assert.equal(terminalCanvasRows(1), 1);
});
