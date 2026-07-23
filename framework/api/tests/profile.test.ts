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

test('Work Profile parity uses the same installed action contract', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: (_file, args) => {
      calls.push(args);
      return JSON.stringify({
        schema: 'kungfu.kfd7.profile-action-receipt/v1',
        actionId: 'continue-1',
        status: 'planned',
        failureCode: null,
      });
    },
  });
  const request = {
    schema: 'kungfu.kfd7.profile-action/v1',
    actionId: 'continue-1',
  };
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString(
    'base64',
  );

  profile.workCapabilities();
  profile.workInspect('profiles/work/main');
  profile.workAction(request);
  profile.workAction(request, true);

  assert.deepEqual(calls, [
    ['agent', 'work', 'capabilities', '--json'],
    ['agent', 'work', 'inspect', '--ref', 'profiles/work/main', '--json'],
    ['agent', 'work', 'action', '--input-base64', encoded, '--json'],
    [
      'agent',
      'work',
      'action',
      '--input-base64',
      encoded,
      '--execute',
      '--json',
    ],
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
  profile.application('/suite');
  profile.kfd3Status('/suite');
  profile.kfd3Plan('/suite');
  profile.qualifyKfd3('/suite');
  profile.intentPlan('/suite', 'complete-day');
  profile.lifecyclePlan('install', '/suite');

  assert.deepEqual(calls, [
    ['profile', 'catalog', '/suite', '--require-active', '--json'],
    ['profile', 'discover', 'kungfu.mission-control', '--json'],
    ['profile', 'query-plan', '/suite', 'week-table', '--json'],
    ['profile', 'application', '/suite', '--json'],
    ['profile', 'kfd3-status', '/suite', '--json'],
    ['profile', 'kfd3-plan', '/suite', '--json'],
    ['profile', 'kfd3-qualify', '/suite', '--json'],
    ['profile', 'intent', 'plan', '/suite', 'complete-day', '--json'],
    ['profile', 'plan', 'install', '/suite', '--json'],
  ]);
});

test('Profile member and intent calls carry the same typed JSON input', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: (_file, args) => {
      calls.push(args);
      return JSON.stringify({ result: { ok: true } });
    },
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify({ result: { ok: true } });
    },
  });
  const input = { dayId: 'day:1', complete: true };
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');

  profile.intentPlan('/suite', 'complete-day', input);
  await profile.memberCallAsync(
    '/suite',
    'example-week-day-actions',
    'week-state',
    input,
  );

  assert.deepEqual(calls, [
    [
      'profile',
      'intent',
      'plan',
      '/suite',
      'complete-day',
      '--input-base64',
      encoded,
      '--json',
    ],
    [
      'profile',
      'member-call',
      '/suite',
      'example-week-day-actions',
      'week-state',
      '--input-base64',
      encoded,
      '--json',
    ],
  ]);
});

test('Profile query and assessment use root-bound JSON receipts', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: (_file, args) => {
      calls.push(args);
      return '{}';
    },
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });
  const queryPlan = {
    schema: 'kungfu.profile-query-plan/v1' as const,
    planId: 'sha256:query',
    catalogRoot: 'sha256:catalog',
    profileSuiteRoot: 'sha256:profile',
    profileRevision: 7,
    view: {} as never,
    corePlan: {},
  };
  const queryReceipt = {
    schema: 'kungfu.profile-query-receipt/v1' as const,
    planId: queryPlan.planId,
    profileSuiteRoot: queryPlan.profileSuiteRoot,
    catalogRoot: queryPlan.catalogRoot,
    viewId: 'week-state',
    queryDefinitionRoot: 'sha256:definition',
    queryProofRoot: 'sha256:proof',
    result: [],
  };

  profile.queryRun('/suite', queryPlan);
  const assessment = profile.assessmentPlan('/suite', queryReceipt, {
    claimId: 'day-complete',
    policyId: 'week-policy',
    purpose: 'operator-review',
    workEpisodeId: 17,
  });
  await profile.authorizeAssessmentAsync(
    assessment,
    'approve',
    'workspace-owner',
  );

  assert.equal(calls[0][1], 'query-execute');
  assert.equal(calls[1][1], 'assessment-plan');
  assert.equal(calls[2][1], 'assessment-authorize');
  assert.equal(calls[0].at(-1), '--json');
  assert.equal(calls[1].at(-1), '--json');
  assert.equal(calls[2].at(-1), '--json');
});

test('Profile KFD-3 authorization binds the reviewed plan and actor', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: () => '{}',
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });

  await profile.authorizeKfd3Async(
    '/suite',
    'sha256:reviewed',
    'approve',
    'workspace-owner',
  );

  assert.deepEqual(calls[0], [
    'profile',
    'kfd3-authorize',
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

test('Profile KFD-3 verification uses the installed receipt verifier', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: () => '{}',
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });

  await profile.verifyKfd3Async('/suite', '/tmp/receipt.json');

  assert.deepEqual(calls[0], [
    'profile',
    'kfd3-verify',
    '/suite',
    '/tmp/receipt.json',
    '--json',
  ]);
});

test('Profile intent authorization re-plans the same shared application path', async () => {
  const calls: string[][] = [];
  const profile = openProfile({
    runtimeDir: '/runtime',
    execFileSync: () => '{}',
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });

  await profile.authorizeIntentAsync(
    '/suite',
    'complete-day',
    'sha256:reviewed',
    'approve',
    'workspace-owner',
  );

  assert.deepEqual(calls[0], [
    'profile',
    'intent',
    'authorize',
    '/suite',
    'complete-day',
    '--expected-plan-id',
    'sha256:reviewed',
    '--choice',
    'approve',
    '--authorized-by',
    'workspace-owner',
    '--json',
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
