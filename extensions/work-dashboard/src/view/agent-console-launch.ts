import type { Profile } from '@kungfu-tech/api/capability';

const MISSION_CONTROL_PROFILE_ID = 'kungfu.mission-control';

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
  if (
    current.health !== 'active' ||
    !current.catalog?.activeExactRoot ||
    !current.profileSuiteRoot
  ) {
    throw new Error('Mission Control Profile exact root is not active');
  }
  return current.profileSuiteRoot;
}
