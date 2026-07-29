import type { Profile } from '@kungfu-tech/api/capability';

const WORK_CONTROL_PROFILE_ID = 'kungfu.work-control';

export function resolveAssignmentWorkspaceRoot(assignment: {
  worktree_path?: string;
}): string | null {
  const root = assignment.worktree_path?.trim();
  return root || null;
}

/** Explicit compatibility alias for callers that have not migrated yet. */
export const resolveGoalWorkspaceRoot = resolveAssignmentWorkspaceRoot;

export async function resolveWorkControlProfileRoot(
  profile: Pick<Profile, 'managerAsync'> | undefined,
): Promise<string> {
  if (!profile) {
    throw new Error('Profile capability unavailable');
  }

  const manager = await profile.managerAsync();
  const current = manager.profiles.find(
    (candidate) => candidate.profileId === WORK_CONTROL_PROFILE_ID,
  );
  if (!current) {
    throw new Error('Work Control Profile is not installed');
  }
  if (current.catalog && !current.catalog.activeExactRoot) {
    throw new Error(
      'Work Control Profile update requires approval in Work Dashboard',
    );
  }
  if (
    current.health !== 'active' ||
    !current.catalog ||
    !current.profileSuiteRoot
  ) {
    throw new Error('Work Control Profile setup is not complete');
  }
  return current.profileSuiteRoot;
}

/** Explicit compatibility alias for callers that have not migrated yet. */
