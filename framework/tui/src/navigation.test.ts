// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedIndex, decodeShellKey } from './navigation.js';

test('decodes complete keyboard navigation without Ink raw-mode ownership', () => {
  assert.equal(decodeShellKey('q'), 'quit');
  assert.equal(decodeShellKey('\u0003'), 'quit');
  assert.equal(decodeShellKey('\u001b[A'), 'previous-card');
  assert.equal(decodeShellKey('\u001b[B'), 'next-card');
  assert.equal(decodeShellKey('\u001b[D'), 'previous-subject');
  assert.equal(decodeShellKey('\u001b[C'), 'next-subject');
  assert.equal(decodeShellKey('\t'), 'next-region');
  assert.equal(decodeShellKey('\u001b[Z'), 'previous-region');
  assert.equal(decodeShellKey('r'), 'refresh');
  assert.equal(decodeShellKey('x'), 'none');
});

test('wraps card, subject, and region indexes', () => {
  assert.equal(boundedIndex(0, -1, 5), 4);
  assert.equal(boundedIndex(4, 1, 5), 0);
  assert.equal(boundedIndex(0, 1, 0), 0);
});
