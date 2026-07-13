// Product-shell navigation is a projection over installed KFX. A focused
// Profile supplies the first screen; it does not activate/deactivate the rest
// of the installed capability surface.
import type { ProfileManifest, ShellState } from '@kungfu-tech/kfx';

export type NavigationEntry = {
  id: string;
  title: string;
  system: boolean;
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
  defaultView: 'kfx-manager',
};

export const TOOLS_NAVIGATION: readonly NavigationItem[] = [
  { id: 'fact-manager', title: 'Facts', icon: '🧾' },
];

export const DEVELOPER_NAVIGATION: readonly NavigationItem[] = [
  { id: 'system-status', title: 'Runtime Status', icon: '🩺' },
  { id: 'config-manager', title: 'Config Store', icon: '⚙️' },
  { id: 'journal-manager', title: 'Journal Inspector', icon: '📓' },
  { id: 'rewind', title: 'Rewind Inspector', icon: '⏪' },
];

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
): ProfileManifest {
  const exact = profiles.find((profile) => profile.id === profileId);
  if (exact) return exact;
  if (profileId === 'default') {
    const missionControl = profiles.find(
      (profile) => profile.id === 'kungfu.mission-control',
    );
    if (missionControl) return missionControl;
  }
  return profiles[0] ?? FALLBACK_PROFILE;
}

export function accessibleEntries<T extends NavigationEntry>(
  entries: readonly T[],
  state: Pick<ShellState, 'disabledKfx' | 'disabledSuites'>,
): T[] {
  return entries.filter(
    (entry) =>
      entry.system ||
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
  return 'kfx-manager';
}

export function primaryNavigation(
  profile: ProfileManifest,
  entries: readonly NavigationEntry[],
): NavigationItem[] {
  const available = new Set(entries.map((entry) => entry.id));
  const home = profileHomeId(profile, entries);
  const candidates: NavigationItem[] = [
    { id: home, title: profile.title, icon: '🧭' },
    { id: 'terminal', title: 'Agent Console', icon: '💬' },
    { id: 'kfx-manager', title: 'Profiles', icon: '🧩' },
    { id: 'skill-manager', title: 'Skills', icon: '🧠' },
  ];
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (!available.has(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
