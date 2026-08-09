import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PANE_LAYOUT,
  normalizePaneSizes,
  paneAxisForLayout,
  paneCountForLayout,
  resizeAdjacentPanes,
} from '../src/view/pane-layout.ts';

test('the Agent Console always starts as one full-size pane', () => {
  assert.equal(DEFAULT_PANE_LAYOUT, 'single');
  assert.equal(paneCountForLayout(DEFAULT_PANE_LAYOUT), 1);
  assert.deepEqual(normalizePaneSizes([], 1), [1]);
});

test('the standard layout choices map to the expected axis and pane count', () => {
  assert.deepEqual(
    ['columns-2', 'rows-2', 'columns-3', 'rows-3'].map((mode) => [
      paneAxisForLayout(mode as Parameters<typeof paneAxisForLayout>[0]),
      paneCountForLayout(mode as Parameters<typeof paneCountForLayout>[0]),
    ]),
    [
      ['columns', 2],
      ['rows', 2],
      ['columns', 3],
      ['rows', 3],
    ],
  );
});

test('invalid or stale pane sizes fall back to equal tracks', () => {
  assert.deepEqual(normalizePaneSizes([0.7, 0.3], 3), [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(normalizePaneSizes([Number.NaN, 1], 2), [0.5, 0.5]);
});

test('dragging a divider resizes only its adjacent panes', () => {
  const resized = resizeAdjacentPanes([0.3, 0.4, 0.3], 1, 0.1, 0.15);
  assert.equal(resized[0], 0.3);
  assert.ok(Math.abs(resized[1] - 0.5) < 1e-12);
  assert.ok(Math.abs(resized[2] - 0.2) < 1e-12);
  assert.ok(
    Math.abs(resized.reduce((sum, value) => sum + value, 0) - 1) < 1e-12,
  );
});

test('dragging cannot collapse either adjacent pane below its minimum', () => {
  const towardEnd = resizeAdjacentPanes([0.5, 0.5], 0, 0.8, 0.2);
  const towardStart = resizeAdjacentPanes([0.5, 0.5], 0, -0.8, 0.2);
  assert.ok(Math.abs(towardEnd[0] - 0.8) < 1e-12);
  assert.ok(Math.abs(towardEnd[1] - 0.2) < 1e-12);
  assert.ok(Math.abs(towardStart[0] - 0.2) < 1e-12);
  assert.ok(Math.abs(towardStart[1] - 0.8) < 1e-12);
});
