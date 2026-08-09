// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KUNGFU_CIRCULAR_STARTUP_PATTERN,
  KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN,
  KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
  KUNGFU_PROJECT_DISCOVERY_PATTERN,
  KUNGFU_STARTUP_NEBULA_PATTERN,
  KUNGFU_WORK_DISCOVERY_PATTERN,
  createCircularParticlePattern,
  createNebulaPattern,
  terminalAnimationPatternSize,
  terminalAnimationsEnabled,
} from './profile-shell.js';

test('circular animation patterns render bounded deterministic terminal frames', () => {
  const first = KUNGFU_CIRCULAR_STARTUP_PATTERN.render(0, {
    width: 21,
    height: 11,
  });
  const next = KUNGFU_CIRCULAR_STARTUP_PATTERN.render(12, {
    width: 21,
    height: 11,
  });

  assert.equal(first.length, 11);
  assert.ok(first.every((line) => line.length === 21));
  assert.equal(first[0]?.[0]?.glyph, ' ');
  assert.notDeepEqual(first, next);
  assert.ok(
    first.flat().some((cell) => cell.glyph === '●' && cell.color === '#facc15'),
  );
});

test('different scenes can supply independent circular animation schemes', () => {
  const pattern = createCircularParticlePattern({
    id: 'project-discovery',
    palette: ['#111111', '#222222', '#333333', '#444444', '#555555'],
    intervalMs: 120,
    seed: 19,
  });

  assert.equal(pattern.id, 'project-discovery');
  assert.equal(pattern.intervalMs, 120);
  assert.notDeepEqual(
    pattern.render(4, { width: 13, height: 7 }),
    KUNGFU_CIRCULAR_STARTUP_PATTERN.render(4, {
      width: 13,
      height: 7,
    }),
  );
});

test('nebula patterns form an irregular animated cloud with sparse stars', () => {
  const first = KUNGFU_PROJECT_DISCOVERY_PATTERN.render(0, {
    width: 21,
    height: 11,
  });
  const next = KUNGFU_PROJECT_DISCOVERY_PATTERN.render(16, {
    width: 21,
    height: 11,
  });
  const cells = first.flat();

  assert.equal(first.length, 11);
  assert.ok(first.every((line) => line.length === 21));
  assert.ok(cells.some((cell) => cell.glyph === ' '));
  assert.ok(cells.some((cell) => cell.glyph === '•' || cell.glyph === '●'));
  assert.notDeepEqual(first, next);
});

test('nebula scenes can choose an independent palette, cadence, and seed', () => {
  const pattern = createNebulaPattern({
    id: 'agent-launch-nebula',
    palette: ['#101010', '#202020', '#303030', '#404040', '#505050'],
    intervalMs: 150,
    seed: 47,
  });

  assert.equal(pattern.id, 'agent-launch-nebula');
  assert.equal(pattern.intervalMs, 150);
  assert.notDeepEqual(
    pattern.render(6, { width: 13, height: 7 }),
    KUNGFU_PROJECT_DISCOVERY_PATTERN.render(6, {
      width: 13,
      height: 7,
    }),
  );
});

test('startup, Project, and Work discovery use distinct nebula geometries', () => {
  const startup = KUNGFU_STARTUP_NEBULA_PATTERN.render(8, {
    width: 31,
    height: 13,
  });
  const projects = KUNGFU_PROJECT_DISCOVERY_PATTERN.render(8, {
    width: 31,
    height: 13,
  });
  const work = KUNGFU_WORK_DISCOVERY_PATTERN.render(8, {
    width: 31,
    height: 13,
  });

  assert.notDeepEqual(startup, projects);
  assert.notDeepEqual(projects, work);
  assert.notDeepEqual(startup, work);
  assert.ok(
    startup
      .flat()
      .some((cell) => cell.color === '#22d3ee' || cell.color === '#0891b2'),
  );
});

test('empty Work uses a subtle standalone nebula that can fill its panel', () => {
  const frame = KUNGFU_EMPTY_WORK_NEBULA_PATTERN.render(8, {
    width: 21,
    height: 9,
  });
  const laterFrame = KUNGFU_EMPTY_WORK_NEBULA_PATTERN.render(24, {
    width: 117,
    height: 15,
  });
  const earlierLargeFrame = KUNGFU_EMPTY_WORK_NEBULA_PATTERN.render(8, {
    width: 117,
    height: 15,
  });
  const colors = new Set(
    frame.flat().flatMap((cell) => (cell.color ? [cell.color] : [])),
  );

  assert.ok(colors.size > 1);
  assert.equal(colors.has('#facc15'), false);
  assert.notDeepEqual(earlierLargeFrame, laterFrame);
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 52, rows: 9 },
      KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
    ),
    { width: 41, height: 7 },
  );
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 18, rows: 10 },
      KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
    ),
    { width: 13, height: 7 },
  );
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 150, rows: 20 },
      KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
    ),
    { width: 117, height: 15 },
  );
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 50, rows: 36 },
      KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
    ),
    { width: 39, height: 27 },
  );
  const boundedLarge = terminalAnimationPatternSize(
    { columns: 260, rows: 70 },
    KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
  );
  assert.ok(boundedLarge.width * boundedLarge.height <= 6000);
});

test('empty Project navigation uses a cooler drifting nebula than the main panel', () => {
  const navigation = KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN.render(12, {
    width: 21,
    height: 11,
  });
  const main = KUNGFU_EMPTY_WORK_NEBULA_PATTERN.render(12, {
    width: 21,
    height: 11,
  });

  assert.notDeepEqual(navigation, main);
  assert.ok(navigation.flat().some((cell) => cell.color === '#38bdf8'));
  assert.equal(
    navigation.flat().some((cell) => cell.color === '#64748b'),
    false,
  );
});

test('terminal animation honors Kungfu and conventional reduced-motion controls', () => {
  assert.equal(terminalAnimationsEnabled({}), true);
  assert.equal(terminalAnimationsEnabled({ NO_ANIMATION: '1' }), false);
  assert.equal(
    terminalAnimationsEnabled({
      NO_ANIMATION: '1',
      KUNGFU_TUI_ANIMATION: '1',
    }),
    true,
  );
  assert.equal(
    terminalAnimationsEnabled({ KUNGFU_TUI_ANIMATION: 'off' }),
    false,
  );
});

test('terminal animation scales down without overflowing narrow terminals', () => {
  assert.deepEqual(terminalAnimationPatternSize({ columns: 32, rows: 10 }), {
    width: 9,
    height: 5,
  });
  assert.deepEqual(terminalAnimationPatternSize({ columns: 50, rows: 14 }), {
    width: 13,
    height: 7,
  });
  assert.deepEqual(terminalAnimationPatternSize({ columns: 80, rows: 24 }), {
    width: 21,
    height: 11,
  });
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 80, rows: 18 },
      KUNGFU_STARTUP_NEBULA_PATTERN,
    ),
    { width: 39, height: 13 },
  );
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 120, rows: 30 },
      KUNGFU_STARTUP_NEBULA_PATTERN,
    ),
    { width: 49, height: 17 },
  );
  assert.deepEqual(
    terminalAnimationPatternSize(
      { columns: 32, rows: 10 },
      KUNGFU_STARTUP_NEBULA_PATTERN,
    ),
    { width: 23, height: 9 },
  );
});
