// Product-shell navigation is a projection over installed KFX. A focused
// Profile supplies the first screen; it does not activate/deactivate the rest
// of the installed capability surface.
import type {
  KfxProductDecl,
  KfxProductRole,
  ProfileManifest,
  ShellState,
} from '@kungfu-tech/kfx';
import type { ShellNavigateRequest } from './sandbox/channels';

export type ShellSurface =
  | 'onboarding'
  | 'projects'
  | 'agent-work-lab'
  | 'core-work'
  | 'kfx';

export type ShellSurfaceFlags = {
  onboardingOpen: boolean;
  projectsOpen: boolean;
  labOpen: boolean;
  coreWorkOpen: boolean;
};

export type CoreShellSurface = 'projects' | 'agent-work-lab' | 'core-work';

export type ShellNavigationActions = Record<
  ShellNavigateRequest['target'],
  (request: ShellNavigateRequest) => void
>;

export function createShellNavigationHandler(actions: ShellNavigationActions) {
  return (_event: unknown, request: ShellNavigateRequest) => {
    const action = actions[request.target];
    action?.(request);
  };
}

export function initialShellSurface({
  onboardingOpen,
  projectsOpen,
  focusedProjectPath,
  agentWorkLabOpen,
}: {
  onboardingOpen: boolean;
  projectsOpen: boolean;
  focusedProjectPath: string;
  agentWorkLabOpen: boolean;
}): ShellSurface {
  if (onboardingOpen) return 'onboarding';
  if (projectsOpen) return focusedProjectPath ? 'core-work' : 'projects';
  if (agentWorkLabOpen) return 'agent-work-lab';
  return 'core-work';
}

export function shellSurfaceFlags(surface: ShellSurface): ShellSurfaceFlags {
  return {
    onboardingOpen: surface === 'onboarding',
    projectsOpen: surface === 'projects',
    labOpen: surface === 'agent-work-lab',
    coreWorkOpen: surface === 'core-work',
  };
}

export function visibleCoreSurface(
  surface: ShellSurface,
): CoreShellSurface | undefined {
  if (surface === 'projects' || surface === 'agent-work-lab') return surface;
  return surface === 'core-work' ? surface : undefined;
}

export function shellSurfaceTitle({
  surface,
  projectWorkOpen,
  currentProjectDisplayName,
  activeKfxTitle,
}: {
  surface: ShellSurface;
  projectWorkOpen: boolean;
  currentProjectDisplayName: string;
  activeKfxTitle?: string;
}): string {
  if (surface === 'onboarding') return 'Getting Started';
  if (surface === 'agent-work-lab') return 'Agent Work Lab';
  if (surface === 'projects') return 'Projects';
  if (surface !== 'core-work') return activeKfxTitle ?? 'Kungfu Episodes';
  return projectWorkOpen
    ? `Project · ${currentProjectDisplayName}`
    : 'All Work';
}

export function shellSurfaceActiveViewId({
  surface,
  projectWorkOpen,
  activeKfxId,
  workEntryId,
}: {
  surface: ShellSurface;
  projectWorkOpen: boolean;
  activeKfxId?: string;
  workEntryId?: string;
}): string | undefined {
  if (surface === 'onboarding') return 'onboarding';
  if (surface === 'agent-work-lab') return 'agent-work-lab';
  if (surface === 'projects') return 'projects';
  if (projectWorkOpen) return 'current-project';
  if (surface === 'core-work' || activeKfxId === workEntryId)
    return 'core-work';
  return activeKfxId;
}

export type NavigationEntry = {
  id: string;
  title: string;
  product?: KfxProductDecl;
  suite?: string;
};

export type NavigationItem = {
  id: string;
  title: string;
  icon: string;
};

export const FALLBACK_PROFILE: ProfileManifest = {
  id: 'system.profile-manager',
  title: 'Profiles',
  kfx: [],
  defaultView: '',
};

const PRIMARY_ROLES: readonly KfxProductRole[] = [
  'profile-view',
  'agent-console',
  'system-management',
];

function hasRole(
  entry: Pick<NavigationEntry, 'product'>,
  role: KfxProductRole,
): boolean {
  return entry.product?.roles.includes(role) ?? false;
}

function compareProductOrder(
  left: Pick<NavigationEntry, 'id' | 'product'>,
  right: Pick<NavigationEntry, 'id' | 'product'>,
): number {
  const order = (left.product?.order ?? 0) - (right.product?.order ?? 0);
  return order || left.id.localeCompare(right.id);
}

function navigationItem(entry: NavigationEntry): NavigationItem {
  return {
    id: entry.id,
    title: entry.title,
    icon: entry.product?.icon ?? '•',
  };
}

export function navigationForRole(
  entries: readonly NavigationEntry[],
  role: KfxProductRole,
): NavigationItem[] {
  return entries
    .filter((entry) => hasRole(entry, role))
    .sort(compareProductOrder)
    .map(navigationItem);
}

export function primaryProductNavigation(
  entries: readonly NavigationEntry[],
): NavigationItem[] {
  return entries
    .filter((entry) => PRIMARY_ROLES.some((role) => hasRole(entry, role)))
    .sort(compareProductOrder)
    .map(navigationItem);
}

export function productRoleEntry<T extends NavigationEntry>(
  entries: readonly T[],
  role: KfxProductRole,
): T | undefined {
  return entries
    .filter((entry) => hasRole(entry, role))
    .sort(compareProductOrder)[0];
}

export function recoveryViewId(entries: readonly NavigationEntry[]): string {
  return (
    entries
      .filter(
        (entry) =>
          hasRole(entry, 'boot-critical') &&
          hasRole(entry, 'system-management'),
      )
      .sort(compareProductOrder)[0]?.id ??
    productRoleEntry(entries, 'boot-critical')?.id ??
    productRoleEntry(entries, 'system-management')?.id ??
    entries[0]?.id ??
    ''
  );
}

export function availableProfiles(
  discovered: readonly ProfileManifest[],
): ProfileManifest[] {
  const unique = new Map<string, ProfileManifest>();
  for (const profile of discovered) {
    if (!unique.has(profile.id)) unique.set(profile.id, profile);
  }
  return unique.size ? [...unique.values()] : [FALLBACK_PROFILE];
}

export function focusedProfile(
  profiles: readonly ProfileManifest[],
  profileId: string,
  recommendedProfileId = '',
): ProfileManifest {
  const exact = profiles.find((profile) => profile.id === profileId);
  if (exact) return exact;
  if (profileId === 'default') {
    return (
      profiles.find((profile) => profile.id === recommendedProfileId) ??
      profiles[0] ??
      FALLBACK_PROFILE
    );
  }
  return FALLBACK_PROFILE;
}

export function accessibleEntries<T extends NavigationEntry>(
  entries: readonly T[],
  state: Pick<ShellState, 'disabledKfx' | 'disabledSuites'>,
): T[] {
  return entries.filter(
    (entry) =>
      hasRole(entry, 'boot-critical') ||
      (!state.disabledKfx.includes(entry.id) &&
        !(entry.suite && state.disabledSuites.includes(entry.suite))),
  );
}

export function profileHomeId(
  profile: ProfileManifest,
  entries: readonly Pick<NavigationEntry, 'id'>[],
): string {
  if (entries.some((entry) => entry.id === profile.defaultView)) {
    return profile.defaultView;
  }
  return recoveryViewId(entries as readonly NavigationEntry[]);
}

export function primaryNavigation(
  profile: ProfileManifest,
  entries: readonly NavigationEntry[],
): NavigationItem[] {
  const home = profileHomeId(profile, entries);
  const homeEntry = entries.find((entry) => entry.id === home);
  const candidates: NavigationItem[] = [
    ...(homeEntry
      ? [
          {
            ...navigationItem(homeEntry),
            title: profile.title,
            icon: '🧭',
          },
        ]
      : []),
    ...primaryProductNavigation(entries),
  ];
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
