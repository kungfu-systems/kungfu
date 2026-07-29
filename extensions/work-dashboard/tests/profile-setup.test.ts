import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedProfile,
  ProfileSourceDiscovery,
} from '@kungfu-tech/api/capability';
import { workControlProfileSetupStep } from '../src/view/profile-setup.ts';

const discovery: ProfileSourceDiscovery = {
  schema: 'kungfu.profile-source-discovery/v1',
  profileId: 'kungfu.work-control',
  profileSuiteRoot: 'sha256:source',
  memberRoots: {},
  source: '/product/extensions/work-control',
};

function managed(
  lifecycleState: ManagedProfile['lifecycleState'],
  overrides: Partial<ManagedProfile> = {},
): ManagedProfile {
  return {
    profileId: 'kungfu.work-control',
    profileVersion: '4.0.0',
    profileSuiteRoot: 'sha256:source',
    profileRevision: 1,
    lifecycleState,
    activated: lifecycleState === 'activated',
    removed: lifecycleState === 'removed',
    grantedPermissions: [],
    qualification: {},
    availableRoots: 1,
    source: '/product/extensions/work-control',
    health: lifecycleState === 'activated' ? 'active' : 'inactive',
    catalog: null,
    diagnostics: [],
    ...overrides,
  };
}

test('Work Control setup starts with the packaged public Profile source', () => {
  assert.deepEqual(workControlProfileSetupStep(null, discovery), {
    action: 'install',
    source: discovery.source,
  });
});

test('Work Control setup preserves explicit lifecycle gates', () => {
  assert.deepEqual(
    workControlProfileSetupStep(managed('installed'), discovery),
    { action: 'qualify', source: discovery.source },
  );
  assert.deepEqual(
    workControlProfileSetupStep(managed('qualified'), discovery),
    { action: 'activate', source: discovery.source },
  );
  assert.equal(
    workControlProfileSetupStep(managed('activated'), discovery),
    null,
  );
});

test('a promoted factory Profile exposes the exact upgrade gate', () => {
  assert.deepEqual(
    workControlProfileSetupStep(
      managed('activated', {
        health: 'inactive',
        catalog: {
          schema: 'kungfu.profile-composition/v1',
          profileId: 'kungfu.work-control',
          profileVersion: '4.0.0',
          profileSuiteRoot: 'sha256:promoted-source',
          profileRevision: 2,
          activeExactRoot: false,
          memberRoots: {},
          purposes: [],
          factSurfaces: [],
          claims: [],
          policies: [],
          views: [],
          diagnostics: [],
          catalogRoot: 'sha256:catalog',
        },
      }),
      discovery,
    ),
    { action: 'upgrade', source: discovery.source },
  );
});

test('removed Work Control can be explicitly reinstalled', () => {
  assert.deepEqual(
    workControlProfileSetupStep(
      managed('removed', { health: 'removed' }),
      discovery,
    ),
    { action: 'install', source: discovery.source },
  );
});
