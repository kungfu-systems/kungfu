// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileManifest, ShellState } from '@kungfu-tech/kfx';
import {
  DEVELOPER_NAVIGATION,
  TOOLS_NAVIGATION,
  accessibleEntries,
  availableProfiles,
  focusedProfile,
  primaryNavigation,
  profileHomeId,
} from './navigation';

const state: ShellState = {
  profileId: 'default',
  disabledKfx: [],
  disabledSuites: [],
  sidebarCollapsed: false,
  settings: {},
};

const entries = [
  { id: 'work-dashboard', title: 'Mission Control', system: false },
  { id: 'terminal', title: 'Agent Console', system: false },
  { id: 'kfx-manager', title: 'Profiles', system: true },
  { id: 'skill-manager', title: 'Skills', system: true },
  { id: 'fact-manager', title: 'Facts', system: false },
  { id: 'config-manager', title: 'Config', system: false },
  { id: 'journal-manager', title: 'Journal', system: false },
  { id: 'rewind', title: 'Rewind', system: false },
  { id: 'system-status', title: 'Status', system: true },
];

const missionControl: ProfileManifest = {
  id: 'kungfu.mission-control',
  title: 'Mission Control',
  kfx: ['work-dashboard'],
  defaultView: 'work-dashboard',
};

test('primary navigation is the four high-frequency product surfaces', () => {
  assert.deepEqual(
    primaryNavigation(missionControl, entries).map(({ id, title, icon }) => ({
      id,
      title,
      icon,
    })),
    [
      { id: 'work-dashboard', title: 'Mission Control', icon: '🧭' },
      { id: 'terminal', title: 'Agent Console', icon: '💬' },
      { id: 'kfx-manager', title: 'Profiles', icon: '🧩' },
      { id: 'skill-manager', title: 'Skills', icon: '🧠' },
    ],
  );
});

test('low-frequency views remain accessible without entering primary navigation', () => {
  const accessible = accessibleEntries(entries, state);
  const primary = new Set(
    primaryNavigation(missionControl, accessible).map((item) => item.id),
  );
  for (const item of [...TOOLS_NAVIGATION, ...DEVELOPER_NAVIGATION]) {
    assert.ok(accessible.some((entry) => entry.id === item.id));
    assert.equal(primary.has(item.id), false);
  }
});

test('a custom Profile supplies its own first screen without shell edits', () => {
  const custom: ProfileManifest = {
    id: 'example.week-day',
    title: 'Week / Day',
    kfx: ['week-dashboard'],
    defaultView: 'week-dashboard',
  };
  const customEntries = [
    ...entries,
    { id: 'week-dashboard', title: 'Week / Day', system: false },
  ];
  assert.equal(profileHomeId(custom, customEntries), 'week-dashboard');
  assert.deepEqual(primaryNavigation(custom, customEntries)[0], {
    id: 'week-dashboard',
    title: 'Week / Day',
    icon: '🧭',
  });
});

test('missing Profile Home falls back visibly to Profiles', () => {
  const missing = { ...missionControl, defaultView: 'missing-dashboard' };
  assert.equal(profileHomeId(missing, entries), 'kfx-manager');
  assert.deepEqual(primaryNavigation(missing, entries)[0], {
    id: 'kfx-manager',
    title: 'Mission Control',
    icon: '🧭',
  });
});

test('default focus resolves to the first discovered Profile', () => {
  const custom: ProfileManifest = {
    id: 'example.week-day',
    title: 'Week / Day',
    kfx: ['week-dashboard'],
    defaultView: 'week-dashboard',
  };
  const profiles = availableProfiles([custom, missionControl]);
  assert.equal(focusedProfile(profiles, 'default').id, custom.id);
  assert.equal(
    focusedProfile(profiles, 'default', missionControl.id).id,
    missionControl.id,
  );
});

test('empty discovery resolves to the visible Profile Manager fallback', () => {
  const profiles = availableProfiles([]);
  assert.equal(profiles[0].id, 'system.profile-manager');
  assert.equal(focusedProfile(profiles, 'default').defaultView, 'kfx-manager');
});

test('a missing persisted Profile degrades to Profile Manager', () => {
  assert.equal(
    focusedProfile([missionControl], 'missing.profile').id,
    'system.profile-manager',
  );
});

test('focus does not deactivate KFX; explicit disable state does', () => {
  const disabled = accessibleEntries(entries, {
    ...state,
    disabledKfx: ['fact-manager'],
  });
  assert.equal(
    disabled.some((entry) => entry.id === 'fact-manager'),
    false,
  );
  assert.equal(
    disabled.some((entry) => entry.id === 'config-manager'),
    true,
  );
  assert.equal(
    disabled.some((entry) => entry.id === 'system-status'),
    true,
  );
});
