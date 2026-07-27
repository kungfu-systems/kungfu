import type {
  ManagedProfile,
  ProfileLifecycleAction,
  ProfileSourceDiscovery,
} from '@kungfu-tech/api/capability';

export type WorkControlProfileSetupStep = {
  action: Extract<
    ProfileLifecycleAction,
    'install' | 'qualify' | 'activate' | 'upgrade'
  >;
  source: string;
};

/** Explicit compatibility type alias for callers that have not migrated yet. */
export type MissionControlProfileSetupStep = WorkControlProfileSetupStep;

export function workControlProfileSetupStep(
  managed: ManagedProfile | null,
  discovery: ProfileSourceDiscovery | null,
): WorkControlProfileSetupStep | null {
  if (
    managed?.activated &&
    managed.health === 'active' &&
    managed.catalog?.activeExactRoot
  ) {
    return null;
  }
  const source = managed?.source ?? discovery?.source ?? '';
  if (!source) return null;
  if (!managed || managed.removed) return { action: 'install', source };
  if (
    managed.lifecycleState === 'activated' &&
    managed.catalog &&
    !managed.catalog.activeExactRoot
  ) {
    return { action: 'upgrade', source };
  }
  if (managed.lifecycleState === 'installed') {
    return { action: 'qualify', source };
  }
  if (managed.lifecycleState === 'qualified') {
    return { action: 'activate', source };
  }
  return null;
}

/** Explicit compatibility alias for callers that have not migrated yet. */
export const missionControlProfileSetupStep = workControlProfileSetupStep;
