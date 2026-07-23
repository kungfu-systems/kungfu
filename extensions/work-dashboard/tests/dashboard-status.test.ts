import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dashboardMetricVisuals,
  dashboardSnapshotVisual,
  missionControlProfileVisual,
  profileApprovalVisual,
} from '../src/view/dashboard-status.ts';

test('dashboard metrics use domain glyphs and unambiguous tooltips', () => {
  const metrics = dashboardMetricVisuals({
    missions: 4,
    goals: 393,
    markers: 731,
  });
  assert.deepEqual(
    metrics.map(({ glyph, value, title }) => [glyph, value, title]),
    [
      ['🧭', 4, '4 Missions'],
      ['🎯', 393, '393 Go cards'],
      ['📌', 731, '731 imported timeline markers'],
    ],
  );
  assert.deepEqual(
    metrics.map(({ width }) => width),
    [54, 62, 70],
  );
});

test('snapshot state changes glyph without exposing changing prose inline', () => {
  assert.equal(
    dashboardSnapshotVisual({ error: '', refreshing: true, cut: 'cut-1' })
      .glyph,
    '🔄',
  );
  assert.equal(
    dashboardSnapshotVisual({ error: '', refreshing: false, cut: 'cut-1' })
      .glyph,
    '✅',
  );
  assert.match(
    dashboardSnapshotVisual({
      error: '',
      refreshing: true,
      cut: 'cut-1',
    }).title,
    /current view remains interactive/,
  );
});

test('Profile lifecycle state is compact while preserving exact status in tooltip', () => {
  const setup = missionControlProfileVisual(
    'Mission Control setup required · install',
  );
  assert.equal(setup.glyph, '🧩⚠️');
  assert.equal(setup.title, 'Mission Control setup required · install');
});

test('approval remains actionable when actor identity is missing', () => {
  assert.deepEqual(profileApprovalVisual({ actor: '', busy: false }), {
    disabled: false,
    label: 'approve exact plan',
    title: 'Enter the workspace owner identity first',
  });
  assert.equal(
    profileApprovalVisual({ actor: 'dkr', busy: false }).disabled,
    false,
  );
  assert.equal(
    profileApprovalVisual({ actor: 'dkr', busy: true }).disabled,
    true,
  );
});
