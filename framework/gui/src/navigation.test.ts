// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileManifest, ShellState } from '@kungfu-tech/kfx';
import {
  accessibleEntries,
  availableProfiles,
  focusedProfile,
  navigationForRole,
  primaryNavigation,
  productRoleEntry,
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
  {
    id: 'work-dashboard',
    title: 'Mission Control',
    system: false,
    product: { roles: ['profile-view' as const], icon: '🧭', order: 10 },
  },
  {
    id: 'terminal',
    title: 'Agent Console',
    system: false,
    product: { roles: ['agent-console' as const], icon: '💬', order: 20 },
  },
  {
    id: 'kfx-manager',
    title: 'Profiles',
    system: true,
    product: {
      roles: ['system-management' as const, 'boot-critical' as const],
      icon: '🧩',
      order: 30,
    },
  },
  {
    id: 'skill-manager',
    title: 'Skills',
    system: true,
    product: {
      roles: ['system-management' as const, 'boot-critical' as const],
      icon: '🧠',
      order: 40,
    },
  },
  {
    id: 'fact-manager',
    title: 'Facts',
    system: false,
    product: { roles: ['tool' as const], icon: '🧾', order: 10 },
  },
  {
    id: 'config-manager',
    title: 'Config',
    system: false,
    product: { roles: ['devtool' as const], icon: '⚙️', order: 20 },
  },
  {
    id: 'journal-manager',
    title: 'Journal',
    system: false,
    product: { roles: ['devtool' as const], icon: '📓', order: 30 },
  },
  {
    id: 'rewind',
    title: 'Rewind',
    system: false,
    product: { roles: ['devtool' as const], icon: '⏪', order: 40 },
  },
  {
    id: 'system-status',
    title: 'Status',
    system: true,
    product: {
      roles: ['devtool' as const, 'boot-critical' as const],
      icon: '🩺',
      order: 10,
    },
  },
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
  const secondary = [
    ...navigationForRole(accessible, 'tool'),
    ...navigationForRole(accessible, 'devtool'),
  ];
  for (const item of secondary) {
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
  assert.equal(focusedProfile(profiles, 'default').defaultView, '');
  assert.equal(profileHomeId(profiles[0], entries), 'kfx-manager');
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

test('boot-critical preserves recovery availability without requiring system trust', () => {
  const recovery = {
    id: 'third-party-recovery',
    title: 'Recovery',
    system: false,
    product: { roles: ['boot-critical' as const] },
  };
  assert.deepEqual(
    accessibleEntries([recovery], {
      ...state,
      disabledKfx: [recovery.id],
    }),
    [recovery],
  );
});

test('replacement product surfaces compose without known KFX ids', () => {
  const replacements = [
    {
      id: 'example-home',
      title: 'Example',
      system: false,
      product: { roles: ['profile-view' as const], icon: '🏠', order: 10 },
    },
    {
      id: 'alternate-console',
      title: 'Alternate Console',
      system: false,
      product: { roles: ['agent-console' as const], icon: '⌨️', order: 20 },
    },
    {
      id: 'alternate-manager',
      title: 'Alternate Manager',
      system: false,
      product: {
        roles: ['system-management' as const, 'boot-critical' as const],
        icon: '🧰',
        order: 30,
      },
    },
    {
      id: 'alternate-devtool',
      title: 'Alternate DevTool',
      system: false,
      product: { roles: ['devtool' as const], icon: '🔬', order: 10 },
    },
  ];
  const profile = {
    id: 'example.profile',
    title: 'Example',
    kfx: ['example-home'],
    defaultView: 'example-home',
  };
  assert.deepEqual(
    primaryNavigation(profile, replacements).map((item) => item.id),
    ['example-home', 'alternate-console', 'alternate-manager'],
  );
  assert.equal(
    productRoleEntry(replacements, 'agent-console')?.id,
    'alternate-console',
  );
  assert.equal(
    profileHomeId({ ...profile, defaultView: 'missing' }, replacements),
    'alternate-manager',
  );
  assert.deepEqual(navigationForRole(replacements, 'devtool'), [
    {
      id: 'alternate-devtool',
      title: 'Alternate DevTool',
      icon: '🔬',
    },
  ]);
});
