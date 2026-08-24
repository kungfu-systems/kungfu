import assert from 'node:assert/strict';
import test from 'node:test';

import type { Profile } from '../../../framework/api/src/capability/profile.ts';
import {
  openKfd3ProfileApplication,
  openWorkControlProfile,
} from '../src/view/work-control-profile.ts';

test('Work Control Profile nativeClient is read-only in the GUI', async () => {
  const source = '/profiles/work-control';
  const inspection = {
    authority: {
      schema: 'kungfu.work-control.authority-status/v1',
      state: 'native-only',
      write_authority: 'kungfu-native',
      transition_count: 0,
    },
  };
  const calls: string[] = [];
  const profile = {
    runtimeDir: '/runtime',
    discover: () => ({ source }),
    memberCallAsync: async (
      _source: string,
      _member: string,
      operation: string,
    ) => {
      calls.push(operation);
      return { result: inspection };
    },
  } as unknown as Profile;

  const nativeClient = openWorkControlProfile(profile);
  assert.equal(
    (await nativeClient.authorityStatus()).authority.write_authority,
    'kungfu-native',
  );
  const mutations: Array<[string, () => Promise<unknown>]> = [
    ['assessInitiative', () => nativeClient.assessInitiative('initiative-a')],
    [
      'assessInitiativeAsync',
      () => nativeClient.assessInitiativeAsync('initiative-a'),
    ],
    [
      'createInitiative',
      () =>
        nativeClient.createInitiative('initiative-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'exportInitiative',
      () => nativeClient.exportInitiative('initiative-a', '/out'),
    ],
    ['importInitiative', () => nativeClient.importInitiative('/in')],
    [
      'createAssignment',
      () =>
        nativeClient.createAssignment('initiative-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'appendAssignmentRelationEvent',
      () =>
        nativeClient.appendAssignmentRelationEvent({
          actor: 'test-owner',
        } as never),
    ],
    [
      'claimAssignment',
      () =>
        nativeClient.claimAssignment('initiative-a', 'assignment-a', {
          authorizedBy: 'test-owner',
        } as never),
    ],
    [
      'advanceAssignment',
      () =>
        nativeClient.advanceAssignment('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'claimCompletion',
      () =>
        nativeClient.claimCompletion('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'assessCompletion',
      () => nativeClient.assessCompletion('initiative-a', 'assignment-a'),
    ],
    [
      'assessCompletionAsync',
      () => nativeClient.assessCompletionAsync('initiative-a', 'assignment-a'),
    ],
    [
      'reviewCompletion',
      () =>
        nativeClient.reviewCompletion('initiative-a', 'assignment-a', {
          reviewer: 'test-owner',
        } as never),
    ],
    [
      'decideContinuation',
      () =>
        nativeClient.decideContinuation('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'recordWorkInputSnapshot',
      () =>
        nativeClient.recordWorkInputSnapshot('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'recordWorkManagedRun',
      () =>
        nativeClient.recordWorkManagedRun('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'authorizeWorkEffect',
      () =>
        nativeClient.authorizeWorkEffect('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'recordWorkEffectAttempt',
      () =>
        nativeClient.recordWorkEffectAttempt('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'recordWorkEffectOutcome',
      () =>
        nativeClient.recordWorkEffectOutcome('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await assert.rejects(mutate(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'authority-bypass', name);
      assert.match(
        error.message,
        /read-only native client.*kungfu\.assignment-runtime\/v1/,
      );
      return true;
    });
  }
  assert.deepEqual(calls, ['authority-status']);
});

test('KFD-3 application projects every Work semantics intent through the shared API', async () => {
  const source = '/profiles/work-control';
  const calls: string[] = [];
  const profile = {
    runtimeDir: '/runtime',
    discover: () => ({ source }),
    intentPlan: (_source: string, intentId: string) => ({
      planId: `plan:${intentId}`,
    }),
    authorizeIntentAsync: async (
      _source: string,
      intentId: string,
      _planId: string,
      _choice: string,
      _authorizedBy: string,
      _input: unknown,
    ) => {
      calls.push(intentId);
      return {
        executionReceiptVerified: true,
        actionReceipt: {
          verified: true,
          coreReceipt: { schema: 'kungfu.work-semantics.write-receipt/v1' },
        },
      };
    },
  } as unknown as Profile;
  const application = openKfd3ProfileApplication(profile);
  const common = {
    attemptId: 'attempt-a',
    leaseId: 'lease-a',
    actor: 'test-owner',
  };

  await application.recordWorkInputSnapshot('initiative-a', 'assignment-a', {
    ...common,
    snapshotId: 'snapshot-a',
    inputRoot: 'sha256:input',
  });
  await application.recordWorkManagedRun('initiative-a', 'assignment-a', {
    ...common,
    runId: 'run-a',
    inputSnapshotRoot: 'sha256:snapshot',
    role: 'fixture',
    resultState: 'succeeded',
    resultRoot: 'sha256:result',
  });
  await application.authorizeWorkEffect('initiative-a', 'assignment-a', {
    ...common,
    authorizationId: 'authorization-a',
    effectId: 'effect-a',
    effectKind: 'fixture',
    inputSnapshotRoot: 'sha256:snapshot',
    scopeRoot: 'sha256:scope',
  });
  await application.recordWorkEffectAttempt('initiative-a', 'assignment-a', {
    ...common,
    effectAttemptId: 'effect-attempt-a',
    authorizationRoot: 'sha256:authorization',
    transportRequestRoot: 'sha256:request',
  });
  await application.recordWorkEffectOutcome('initiative-a', 'assignment-a', {
    ...common,
    effectAttemptRoot: 'sha256:effect-attempt',
    transportState: 'accepted',
    businessState: 'accepted',
    outcomeRoot: 'sha256:outcome',
  });

  assert.deepEqual(calls, [
    'work-input-snapshot',
    'work-managed-run',
    'work-effect-authorize',
    'work-effect-attempt',
    'work-effect-outcome',
  ]);
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
