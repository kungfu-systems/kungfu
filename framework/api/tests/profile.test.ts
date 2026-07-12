import assert from 'node:assert/strict';
import test from 'node:test';
import { openProfile } from '../src/capability/profile.ts';

test('Profile capability uses the installed Agent Profile CLI path', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: (_file, args, options) => {
      calls.push(args);
      assert.equal(options.env.KF_RUNTIME_DIR, '/runtime');
      return JSON.stringify({
        schema: 'kungfu.profile-manager/v1',
        profiles: [],
      });
    },
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify({
        schema: 'kungfu.profile-manager/v1',
        profiles: [],
      });
    },
  });

  profile.manager();
  await profile.managerAsync();

  assert.deepEqual(calls, [
    ['profile', 'manager', '--json'],
    ['profile', 'manager', '--json'],
  ]);
});

test('Profile plans preserve source and exact active-root intent', () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });

  profile.catalog('/suite', true);
  profile.discover('kungfu.mission-control');
  profile.queryPlan('/suite', 'week-table');
  profile.lifecyclePlan('install', '/suite');

  assert.deepEqual(calls, [
    ['profile', 'catalog', '/suite', '--require-active', '--json'],
    ['profile', 'discover', 'kungfu.mission-control', '--json'],
    ['profile', 'query-plan', '/suite', 'week-table', '--json'],
    ['profile', 'plan', 'install', '/suite', '--json'],
  ]);
});

test('Profile authorization binds the reviewed plan id and actor', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: () => '{}',
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });

  await profile.authorizeLifecycleAsync(
    'activate',
    '/suite',
    'sha256:reviewed',
    'approve',
    'workspace-owner',
  );

  assert.deepEqual(calls[0], [
    'profile',
    'authorize-lifecycle',
    'activate',
    '/suite',
    '--expected-plan-id',
    'sha256:reviewed',
    '--choice',
    'approve',
    '--authorized-by',
    'workspace-owner',
    '--json',
  ]);
});
