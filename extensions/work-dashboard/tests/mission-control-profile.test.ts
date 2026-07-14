import assert from 'node:assert/strict';
import test from 'node:test';

import type { Profile } from '../../../framework/api/src/capability/profile.ts';
import {
  type AtlasDashboardSnapshot,
  openMissionControlProfile,
} from '../src/view/mission-control-profile.ts';

test('Mission Control uses the exact-root Profile projection and intent surfaces', async () => {
  const source = '/profiles/mission-control';
  const input = {
    missionId: 'mission-a',
    title: 'Mission A',
    intent: 'Keep the domain in the Profile',
    actor: 'test-owner',
  };
  const snapshot: AtlasDashboardSnapshot = {
    schema: 'kungfu.mission-control.dashboard-snapshot/v1',
    cut: { kind: 'system_time', system_time: '42' },
    freshness: { status: 'fresh', basis: 'request-cut' },
    projection_authority: {
      mode: 'adapter-projection',
      source: 'atlas-and-kungfu-facts',
      profileSuiteRoot: 'sha256:profile-root',
      memberRoot: 'sha256:member-root',
      cutSystemTime: '42',
      writableAuthority: false,
    },
    import_info: null,
    missions: [],
    goals: [],
  };
  const calls: Array<{ operation: string; input?: unknown }> = [];
  const profile = {
    runtimeDir: '/runtime',
    discover: (profileId: string) => {
      assert.equal(profileId, 'kungfu.mission-control');
      return { source };
    },
    memberCallAsync: async (
      memberSource: string,
      memberId: string,
      operation: string,
      memberInput?: unknown,
    ) => {
      assert.equal(memberSource, source);
      assert.equal(memberId, 'mission-control-actions');
      calls.push({ operation, input: memberInput });
      return { result: snapshot };
    },
    intentPlan: (
      intentSource: string,
      intentId: string,
      intentInput?: unknown,
    ) => {
      assert.equal(intentSource, source);
      calls.push({ operation: `plan:${intentId}`, input: intentInput });
      return { planId: 'sha256:plan' };
    },
    authorizeIntentAsync: async (
      intentSource: string,
      intentId: string,
      planId: string,
      choice: string,
      authorizedBy: string,
      intentInput?: unknown,
    ) => {
      assert.equal(intentSource, source);
      assert.equal(planId, 'sha256:plan');
      assert.equal(choice, 'approve');
      assert.equal(authorizedBy, 'test-owner');
      calls.push({ operation: `authorize:${intentId}`, input: intentInput });
      return {
        executionReceiptVerified: true,
        actionReceipt: {
          verified: true,
          coreReceipt: { mission_subject: 'mission-a' },
        },
      };
    },
  } as unknown as Profile;

  const missionControl = openMissionControlProfile(profile);
  const projected = await missionControl.dashboard();
  const receipt = await missionControl.createMission('mission-a', {
    title: input.title,
    intent: input.intent,
    actor: input.actor,
  });

  assert.equal(projected.projection_authority.writableAuthority, false);
  assert.equal(missionControl.currentDashboard(), projected);
  assert.deepEqual(receipt, { mission_subject: 'mission-a' });
  assert.deepEqual(calls, [
    { operation: 'dashboard', input: {} },
    { operation: 'plan:create-mission', input },
    { operation: 'authorize:create-mission', input },
  ]);
});
