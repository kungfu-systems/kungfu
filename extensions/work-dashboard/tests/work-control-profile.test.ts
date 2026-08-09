import assert from 'node:assert/strict';
import test from 'node:test';

import type { Profile } from '../../../framework/api/src/capability/profile.ts';
import {
  type AtlasDashboardSnapshot,
  openWorkControlProfile,
} from '../src/view/work-control-profile.ts';

test('Work Control Profile compatibility is read-only in the GUI', async () => {
  const source = '/profiles/work-control';
  const snapshot = {
    schema: 'kungfu.work-control.dashboard-snapshot/v1',
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
      schema: 'kungfu.work-control.authority-status/v1',
      state: 'pre-cutover',
      write_authority: 'atlas-adapter',
      legacy_mutation_path: 'available',
      migration_id: '',
      parity_root: '',
      transition_count: 0,
    },
    missions: [],
    goals: [],
  } as AtlasDashboardSnapshot;
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
      return { result: snapshot };
    },
  } as unknown as Profile;

  const compatibility = openWorkControlProfile(profile);
  assert.equal((await compatibility.dashboard()).schema, snapshot.schema);
  const mutations: Array<[string, () => Promise<unknown>]> = [
    ['importRepo', () => compatibility.importRepo('/repo')],
    [
      'activateWorkControl',
      () => compatibility.activateWorkControl({ actor: 'test-owner' } as never),
    ],
    [
      'restoreAtlasAuthority',
      () =>
        compatibility.restoreAtlasAuthority({ actor: 'test-owner' } as never),
    ],
    ['assessMission', () => compatibility.assessMission('initiative-a')],
    [
      'assessInitiativeAsync',
      () => compatibility.assessInitiativeAsync('initiative-a'),
    ],
    [
      'createInitiative',
      () =>
        compatibility.createInitiative('initiative-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'exportInitiative',
      () => compatibility.exportInitiative('initiative-a', '/out'),
    ],
    ['importInitiative', () => compatibility.importInitiative('/in')],
    [
      'createAssignment',
      () =>
        compatibility.createAssignment('initiative-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'appendAssignmentRelationEvent',
      () =>
        compatibility.appendAssignmentRelationEvent({
          actor: 'test-owner',
        } as never),
    ],
    [
      'claimAssignment',
      () =>
        compatibility.claimAssignment('initiative-a', 'assignment-a', {
          authorizedBy: 'test-owner',
        } as never),
    ],
    [
      'advanceAssignment',
      () =>
        compatibility.advanceAssignment('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'claimCompletion',
      () =>
        compatibility.claimCompletion('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
    [
      'assessCompletion',
      () => compatibility.assessCompletion('initiative-a', 'assignment-a'),
    ],
    [
      'assessCompletionAsync',
      () => compatibility.assessCompletionAsync('initiative-a', 'assignment-a'),
    ],
    [
      'reviewCompletion',
      () =>
        compatibility.reviewCompletion('initiative-a', 'assignment-a', {
          reviewer: 'test-owner',
        } as never),
    ],
    [
      'decideContinuation',
      () =>
        compatibility.decideContinuation('initiative-a', 'assignment-a', {
          actor: 'test-owner',
        } as never),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await assert.rejects(mutate(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'authority-bypass', name);
      assert.match(
        error.message,
        /read-only compatibility.*kungfu\.assignment-runtime\/v1/,
      );
      return true;
    });
  }
  assert.deepEqual(calls, ['dashboard']);
});
