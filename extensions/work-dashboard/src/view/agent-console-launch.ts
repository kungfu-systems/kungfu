import type { Profile } from '@kungfu-tech/api/capability';

const MISSION_CONTROL_PROFILE_ID = 'kungfu.mission-control';

export function resolveGoalWorkspaceRoot(goal: {
  worktree_path?: string;
}): string | null {
  const root = goal.worktree_path?.trim();
  return root || null;
}

export async function resolveMissionControlProfileRoot(
  profile: Pick<Profile, 'managerAsync'> | undefined,
): Promise<string> {
  if (!profile) {
    throw new Error('Profile capability unavailable');
  }

  const manager = await profile.managerAsync();
  const current = manager.profiles.find(
    (candidate) => candidate.profileId === MISSION_CONTROL_PROFILE_ID,
  );
  if (!current) {
    throw new Error('Mission Control Profile is not installed');
  }
  if (current.catalog && !current.catalog.activeExactRoot) {
    throw new Error(
      'Mission Control Profile update requires approval in Work Dashboard',
    );
  }
  if (
    current.health !== 'active' ||
    !current.catalog ||
    !current.profileSuiteRoot
  ) {
    throw new Error('Mission Control Profile setup is not complete');
  }
  return current.profileSuiteRoot;
}
