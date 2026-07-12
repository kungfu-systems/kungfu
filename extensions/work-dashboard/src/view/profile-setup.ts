import type {
  ManagedProfile,
  ProfileLifecycleAction,
  ProfileSourceDiscovery,
} from '@kungfu-tech/api/capability';

export type MissionControlProfileSetupStep = {
  action: Extract<ProfileLifecycleAction, 'install' | 'qualify' | 'activate'>;
  source: string;
};

export function missionControlProfileSetupStep(
  managed: ManagedProfile | null,
  discovery: ProfileSourceDiscovery | null,
): MissionControlProfileSetupStep | null {
  if (managed?.activated && managed.health === 'active') return null;
  const source = managed?.source ?? discovery?.source ?? '';
  if (!source) return null;
  if (!managed || managed.removed) return { action: 'install', source };
  if (managed.lifecycleState === 'installed') {
    return { action: 'qualify', source };
  }
  if (managed.lifecycleState === 'qualified') {
    return { action: 'activate', source };
  }
  return null;
}
