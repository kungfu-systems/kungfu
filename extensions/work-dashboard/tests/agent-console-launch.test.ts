import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedProfile,
  Profile,
  ProfileManagerProjection,
} from '@kungfu-tech/api/capability';
import {
  resolveAssignmentWorkspaceRoot,
  resolveWorkControlProfileRoot,
} from '../src/view/agent-console-launch.ts';

const ROOT = `sha256:${'a'.repeat(64)}`;

function managedProfile(
  overrides: Partial<ManagedProfile> = {},
): ManagedProfile {
  return {
    profileId: 'kungfu.work-control',
    profileVersion: '4.0.0',
    profileSuiteRoot: ROOT,
    profileRevision: 1,
    lifecycleState: 'activated',
    activated: true,
    removed: false,
    grantedPermissions: [],
    qualification: {},
    availableRoots: 1,
    source: '/tmp/work-control.profile.json',
    health: 'active',
    catalog: {
      schema: 'kungfu.profile-composition/v1',
      profileId: 'kungfu.work-control',
      profileVersion: '4.0.0',
      profileSuiteRoot: ROOT,
      profileRevision: 1,
      activeExactRoot: true,
      memberRoots: {},
      purposes: [],
      factSurfaces: [],
      claims: [],
      policies: [],
      views: [],
      diagnostics: [],
      catalogRoot: `sha256:${'b'.repeat(64)}`,
    },
    diagnostics: [],
    ...overrides,
  };
}

function profileWith(
  ...profiles: ManagedProfile[]
): Pick<Profile, 'managerAsync'> {
  const projection: ProfileManagerProjection = {
    schema: 'kungfu.profile-manager/v1',
    runtimeDir: '/tmp/profile-runtime',
    cutSystemTime: 1,
    profiles,
    count: profiles.length,
    knownLimits: [],
  };
  return { managerAsync: async () => projection };
}

test('Agent Console binds the current active exact Profile root without an assessment', async () => {
  assert.equal(
    await resolveWorkControlProfileRoot(profileWith(managedProfile())),
    ROOT,
  );
});

test('Agent Console refuses a Profile whose exact root is not active', async () => {
  const catalog = managedProfile().catalog;
  assert.ok(catalog);
  await assert.rejects(
    resolveWorkControlProfileRoot(
      profileWith(
        managedProfile({
          catalog: {
            ...catalog,
            activeExactRoot: false,
          },
        }),
      ),
    ),
    /update requires approval in Work Dashboard/,
  );
});

test('Agent Console reports missing Profile capability and installation', async () => {
  await assert.rejects(
    resolveWorkControlProfileRoot(undefined),
    /capability unavailable/,
  );
  await assert.rejects(
    resolveWorkControlProfileRoot(profileWith()),
    /not installed/,
  );
});

test('Agent Console prefers the Assignment-owned worktree as its cwd', () => {
  assert.equal(
    resolveAssignmentWorkspaceRoot({
      worktree_path: '/worktrees/kungfu/assignment-1',
    }),
    '/worktrees/kungfu/assignment-1',
  );
  assert.equal(resolveAssignmentWorkspaceRoot({ worktree_path: '  ' }), null);
  assert.equal(resolveAssignmentWorkspaceRoot({}), null);
});
