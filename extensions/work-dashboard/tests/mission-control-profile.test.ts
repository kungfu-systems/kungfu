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
  const initiativeInput = {
    initiativeId: 'initiative-a',
    title: 'Initiative A',
    intent: 'Use the successor L3 vocabulary',
    actor: 'test-owner',
  };
  const assignmentInput = {
    initiativeId: 'initiative-a',
    assignmentId: 'assignment-a',
    title: 'Assignment A',
    objective: 'Prove the shared intent surface',
    actor: 'test-owner',
  };
  const executionClaimInput = {
    initiativeId: 'initiative-a',
    assignmentId: 'assignment-a',
    owner: 'test-owner',
    agent: 'agent-a',
    slot: 'slot-a',
    leaseId: 'lease-a',
    leaseExpiresAt: '2030-01-01T00:00:00Z',
    authorizedBy: 'test-owner',
  };
  const phaseTransitionInput = {
    initiativeId: 'initiative-a',
    assignmentId: 'assignment-a',
    toPhase: 'executing',
    expectedPhase: 'claimed',
    actor: 'test-owner',
    reason: 'begin the bounded execution stage',
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
    authority: {
      schema: 'kungfu.mission-control.authority-status/v1',
      state: 'pre-cutover',
      write_authority: 'atlas-adapter',
      legacy_mutation_path: 'available',
      migration_id: '',
      parity_root: '',
      transition_count: 0,
    },
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
  await missionControl.missionHome('mission-a', { source: 'atlas' });
  await missionControl.createInitiative('initiative-a', {
    title: initiativeInput.title,
    intent: initiativeInput.intent,
    actor: initiativeInput.actor,
  });
  await missionControl.createAssignment('initiative-a', {
    assignmentId: assignmentInput.assignmentId,
    title: assignmentInput.title,
    objective: assignmentInput.objective,
    actor: assignmentInput.actor,
  });
  await missionControl.claimAssignment('initiative-a', 'assignment-a', {
    owner: executionClaimInput.owner,
    agent: executionClaimInput.agent,
    slot: executionClaimInput.slot,
    leaseId: executionClaimInput.leaseId,
    leaseExpiresAt: executionClaimInput.leaseExpiresAt,
    authorizedBy: executionClaimInput.authorizedBy,
  });
  await missionControl.advanceAssignment('initiative-a', 'assignment-a', {
    toPhase: phaseTransitionInput.toPhase,
    expectedPhase: phaseTransitionInput.expectedPhase,
    actor: phaseTransitionInput.actor,
    reason: phaseTransitionInput.reason,
  });
  const receipt = await missionControl.createMission('mission-a', {
    title: input.title,
    intent: input.intent,
    actor: input.actor,
  });
  await missionControl.reviewCompletion('mission-a', 'goal-a', {
    reviewer: 'test-owner',
    reviewerSource: 'new-review-session',
  });
  await missionControl.decideContinuation('mission-a', 'goal-a', {
    reviewId: 'review-a',
    expectedReviewRoot: 'sha256:review',
    expectedPlanRoot: 'sha256:plan-root',
    action: 'close',
    actor: 'test-owner',
    reason: 'the exact claim is fit',
  });

  assert.equal(projected.projection_authority.writableAuthority, false);
  assert.equal(missionControl.currentDashboard(), projected);
  assert.deepEqual(receipt, { mission_subject: 'mission-a' });
  assert.deepEqual(calls, [
    { operation: 'dashboard', input: {} },
    {
      operation: 'mission-home',
      input: {
        missionId: 'mission-a',
        source: 'atlas',
        cutSystemTime: undefined,
      },
    },
    { operation: 'plan:create-initiative', input: initiativeInput },
    { operation: 'authorize:create-initiative', input: initiativeInput },
    { operation: 'plan:create-assignment', input: assignmentInput },
    { operation: 'authorize:create-assignment', input: assignmentInput },
    { operation: 'plan:claim-assignment', input: executionClaimInput },
    { operation: 'authorize:claim-assignment', input: executionClaimInput },
    { operation: 'plan:advance-assignment', input: phaseTransitionInput },
    {
      operation: 'authorize:advance-assignment',
      input: phaseTransitionInput,
    },
    { operation: 'plan:create-mission', input },
    { operation: 'authorize:create-mission', input },
    {
      operation: 'plan:review-completion',
      input: {
        missionId: 'mission-a',
        goalId: 'goal-a',
        reviewer: 'test-owner',
        reviewerSource: 'new-review-session',
      },
    },
    {
      operation: 'authorize:review-completion',
      input: {
        missionId: 'mission-a',
        goalId: 'goal-a',
        reviewer: 'test-owner',
        reviewerSource: 'new-review-session',
      },
    },
    {
      operation: 'plan:decide-continuation',
      input: {
        missionId: 'mission-a',
        goalId: 'goal-a',
        reviewId: 'review-a',
        expectedReviewRoot: 'sha256:review',
        expectedPlanRoot: 'sha256:plan-root',
        action: 'close',
        actor: 'test-owner',
        reason: 'the exact claim is fit',
      },
    },
    {
      operation: 'authorize:decide-continuation',
      input: {
        missionId: 'mission-a',
        goalId: 'goal-a',
        reviewId: 'review-a',
        expectedReviewRoot: 'sha256:review',
        expectedPlanRoot: 'sha256:plan-root',
        action: 'close',
        actor: 'test-owner',
        reason: 'the exact claim is fit',
      },
    },
  ]);
});
