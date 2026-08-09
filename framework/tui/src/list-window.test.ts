// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveListWindow,
  resolveMeasuredListWindow,
  scrollListSelection,
} from './list-window/index.js';

test('List Window follows selection without exceeding its viewport', () => {
  assert.deepEqual(
    resolveListWindow({ selected: 0, itemCount: 12, viewportRows: 4 }),
    { start: 0, end: 4, count: 4 },
  );
  assert.deepEqual(
    resolveListWindow({ selected: 6, itemCount: 12, viewportRows: 4 }),
    { start: 3, end: 7, count: 4 },
  );
  assert.deepEqual(
    resolveListWindow({ selected: 11, itemCount: 12, viewportRows: 4 }),
    { start: 8, end: 12, count: 4 },
  );
});

test('List Window wheel movement stops at both boundaries', () => {
  assert.equal(scrollListSelection({ current: 0, delta: -1, itemCount: 5 }), 0);
  assert.equal(scrollListSelection({ current: 2, delta: 1, itemCount: 5 }), 3);
  assert.equal(scrollListSelection({ current: 4, delta: 1, itemCount: 5 }), 4);
  assert.equal(scrollListSelection({ current: 0, delta: 1, itemCount: 0 }), 0);
});

test('measured List Window fills the row budget without splitting an item', () => {
  const costs = [3, 2, 3, 2, 2];
  const first = resolveMeasuredListWindow({
    selected: 0,
    itemCount: costs.length,
    viewportRows: 7,
    rowCost: (index) => costs[index] ?? 1,
  });
  assert.deepEqual(first, { start: 0, end: 2, count: 2 });

  const scrolled = resolveMeasuredListWindow({
    selected: 3,
    itemCount: costs.length,
    viewportRows: 7,
    rowCost: (index) => costs[index] ?? 1,
  });
  assert.deepEqual(scrolled, { start: 1, end: 4, count: 3 });
});
