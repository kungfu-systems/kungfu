import assert from 'node:assert/strict';
import test from 'node:test';

import type { Profile } from '../../../framework/api/src/capability/profile.ts';
import {
  type WorkControlDashboardSnapshot,
  openWorkControlProfile,
} from '../src/view/work-control-profile.ts';

test('Work Control projection client cannot enter Assignment mutations', async () => {
  const source = '/profiles/work-control';
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
  const snapshot: WorkControlDashboardSnapshot = {
    schema: 'kungfu.work-control.dashboard-snapshot/v1',
    cut: { kind: 'system_time', system_time: '42' },
    freshness: { status: 'fresh', basis: 'request-cut' },
    projection_authority: {
      mode: 'native-fact-projection',
      source: 'kungfu-facts',
      profileSuiteRoot: 'sha256:profile-root',
      memberRoot: 'sha256:member-root',
      cutSystemTime: '42',
      writableAuthority: false,
    },
    authority: {
      schema: 'kungfu.work-control.authority-status/v1',
      state: 'native-only',
      write_authority: 'kungfu-native',
    },
    initiatives: [],
    assignments: [],
  };
  const calls: Array<{ operation: string; input?: unknown }> = [];
  const profile = {
    runtimeDir: '/runtime',
    discover: (profileId: string) => {
      assert.equal(profileId, 'kungfu.work-control');
      return { source };
    },
    memberCallAsync: async (
      memberSource: string,
      memberId: string,
      operation: string,
      memberInput?: unknown,
    ) => {
      assert.equal(memberSource, source);
      assert.equal(memberId, 'work-control-actions');
      calls.push({ operation, input: memberInput });
      return { result: snapshot };
    },
  } as unknown as Profile;

  const workControl = openWorkControlProfile(profile);
  const projected = await workControl.dashboard();
  const relationEventInput = {
    workspaceIdentityRoot: `sha256:${'a'.repeat(64)}`,
    relation: {
      schema: 'kungfu.assignment-graph.relation/v1' as const,
      relation_type: 'related-to',
      source: {
        schema: 'kungfu.assignment-graph.work-ref/v1' as const,
        workspace_identity_root: `sha256:${'a'.repeat(64)}`,
        object_kind: 'assignment' as const,
        subject: 'kungfu:assignment-a',
        version_root: `sha256:${'b'.repeat(64)}`,
        cut_root: `sha256:${'c'.repeat(64)}`,
      },
      target: {
        schema: 'kungfu.assignment-graph.work-ref/v1' as const,
        workspace_identity_root: `sha256:${'d'.repeat(64)}`,
        object_kind: 'assignment' as const,
        subject: 'kungfu:assignment-b',
        version_root: `sha256:${'e'.repeat(64)}`,
        cut_root: `sha256:${'f'.repeat(64)}`,
      },
      state: 'accepted' as const,
      evidence_roots: [],
      semantics: {},
      relation_root: `sha256:${'9'.repeat(64)}`,
    },
    eventType: 'delegation-offer' as const,
    actor: 'test-owner',
  };
  const mutations: Array<[string, () => Promise<unknown>]> = [
    [
      'createInitiative',
      () =>
        workControl.createInitiative('initiative-a', {
          title: initiativeInput.title,
          intent: initiativeInput.intent,
          actor: initiativeInput.actor,
        }),
    ],
    [
      'createAssignment',
      () =>
        workControl.createAssignment('initiative-a', {
          assignmentId: assignmentInput.assignmentId,
          title: assignmentInput.title,
          objective: assignmentInput.objective,
          actor: assignmentInput.actor,
        }),
    ],
    [
      'appendAssignmentRelationEvent',
      () => workControl.appendAssignmentRelationEvent(relationEventInput),
    ],
    [
      'claimAssignment',
      () =>
        workControl.claimAssignment('initiative-a', 'assignment-a', {
          owner: executionClaimInput.owner,
          agent: executionClaimInput.agent,
          slot: executionClaimInput.slot,
          leaseId: executionClaimInput.leaseId,
          leaseExpiresAt: executionClaimInput.leaseExpiresAt,
          authorizedBy: executionClaimInput.authorizedBy,
        }),
    ],
    [
      'advanceAssignment',
      () =>
        workControl.advanceAssignment('initiative-a', 'assignment-a', {
          toPhase: phaseTransitionInput.toPhase,
          expectedPhase: phaseTransitionInput.expectedPhase,
          actor: phaseTransitionInput.actor,
          reason: phaseTransitionInput.reason,
        }),
    ],
    [
      'reviewCompletion',
      () =>
        workControl.reviewCompletion('initiative-a', 'assignment-a', {
          reviewer: 'test-owner',
          reviewerSource: 'new-review-session',
        }),
    ],
    [
      'decideContinuation',
      () =>
        workControl.decideContinuation('initiative-a', 'assignment-a', {
          reviewId: 'review-a',
          expectedReviewRoot: 'sha256:review',
          expectedPlanRoot: 'sha256:plan-root',
          action: 'close',
          actor: 'test-owner',
          reason: 'the exact claim is fit',
        }),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await assert.rejects(mutate(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'authority-bypass', name);
      assert.match(
        error.message,
        /outside the projection client authority.*kungfu\.assignment-runtime\/v1/,
      );
      return true;
    });
  }

  assert.equal(projected.projection_authority.writableAuthority, false);
  assert.equal(workControl.currentDashboard(), projected);
  assert.deepEqual(calls, [{ operation: 'dashboard', input: {} }]);
});

test('KFD-3 application authority executes an exact verified Profile intent', async () => {
  const source = '/profiles/work-control';
  const calls: Array<Record<string, unknown>> = [];
  const profile = {
    runtimeDir: '/runtime',
    discover: () => ({ source }),
    intentPlan: (actualSource: string, intentId: string, input: unknown) => {
      calls.push({ stage: 'plan', actualSource, intentId, input });
      return { planId: 'plan:create-assignment' };
    },
    authorizeIntentAsync: async (
      actualSource: string,
      intentId: string,
      expectedPlanId: string,
      choice: string,
      authorizedBy: string,
      input: unknown,
    ) => {
      calls.push({
        stage: 'authorize',
        actualSource,
        intentId,
        expectedPlanId,
        choice,
        authorizedBy,
        input,
      });
      return {
        executionReceiptVerified: true,
        actionReceipt: {
          verified: true,
          coreReceipt: { assignment_id: 'assignment-a' },
        },
      };
    },
  } as unknown as Profile;

  const application = openWorkControlProfile(profile, '', {
    mutationAuthority: 'kfd3-application',
  });
  const input = {
    assignmentId: 'assignment-a',
    title: 'Assignment A',
    objective: 'Prove the release application boundary',
    actor: 'test-owner',
  };
  const receipt = await application.createAssignment('initiative-a', input);

  assert.deepEqual(receipt, { assignment_id: 'assignment-a' });
  assert.deepEqual(calls, [
    {
      stage: 'plan',
      actualSource: source,
      intentId: 'create-assignment',
      input: { initiativeId: 'initiative-a', ...input },
    },
    {
      stage: 'authorize',
      actualSource: source,
      intentId: 'create-assignment',
      expectedPlanId: 'plan:create-assignment',
      choice: 'approve',
      authorizedBy: 'test-owner',
      input: { initiativeId: 'initiative-a', ...input },
    },
  ]);
});
