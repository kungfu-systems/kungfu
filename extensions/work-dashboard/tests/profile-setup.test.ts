import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedProfile,
  ProfileSourceDiscovery,
} from '@kungfu-tech/api/capability';
import { missionControlProfileSetupStep } from '../src/view/profile-setup.ts';

const discovery: ProfileSourceDiscovery = {
  schema: 'kungfu.profile-source-discovery/v1',
  profileId: 'kungfu.mission-control',
  profileSuiteRoot: 'sha256:source',
  memberRoots: {},
  source: '/product/extensions/mission-control',
};

function managed(
  lifecycleState: ManagedProfile['lifecycleState'],
  overrides: Partial<ManagedProfile> = {},
): ManagedProfile {
  return {
    profileId: 'kungfu.mission-control',
    profileVersion: '3.0.0',
    profileSuiteRoot: 'sha256:source',
    profileRevision: 1,
    lifecycleState,
    activated: lifecycleState === 'activated',
    removed: lifecycleState === 'removed',
    grantedPermissions: [],
    qualification: {},
    availableRoots: 1,
    source: '/product/extensions/mission-control',
    health: lifecycleState === 'activated' ? 'active' : 'inactive',
    catalog: null,
    diagnostics: [],
    ...overrides,
  };
}

test('Mission Control setup starts with the packaged public Profile source', () => {
  assert.deepEqual(missionControlProfileSetupStep(null, discovery), {
    action: 'install',
    source: discovery.source,
  });
});

test('Mission Control setup preserves explicit lifecycle gates', () => {
  assert.deepEqual(
    missionControlProfileSetupStep(managed('installed'), discovery),
    { action: 'qualify', source: discovery.source },
  );
  assert.deepEqual(
    missionControlProfileSetupStep(managed('qualified'), discovery),
    { action: 'activate', source: discovery.source },
  );
  assert.equal(
    missionControlProfileSetupStep(managed('activated'), discovery),
    null,
  );
});

test('a promoted factory Profile exposes the exact upgrade gate', () => {
  assert.deepEqual(
    missionControlProfileSetupStep(
      managed('activated', {
        health: 'inactive',
        catalog: {
          schema: 'kungfu.profile-composition/v1',
          profileId: 'kungfu.mission-control',
          profileVersion: '3.0.0',
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

test('removed Mission Control can be explicitly reinstalled', () => {
  assert.deepEqual(
    missionControlProfileSetupStep(
      managed('removed', { health: 'removed' }),
      discovery,
    ),
    { action: 'install', source: discovery.source },
  );
});
