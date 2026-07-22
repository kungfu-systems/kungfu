// Product-shell navigation is a projection over installed KFX. A focused
// Profile supplies the first screen; it does not activate/deactivate the rest
// of the installed capability surface.
import type {
  KfxProductDecl,
  KfxProductRole,
  ProfileManifest,
  ShellState,
} from '@kungfu-tech/kfx';

export type NavigationEntry = {
  id: string;
  title: string;
  system: boolean;
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
      entry.system ||
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
