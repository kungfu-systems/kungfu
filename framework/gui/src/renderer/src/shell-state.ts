// Shell state persistence: one JSON blob in the runtime home's ConfigStore
// (location system/shell/state/live). Journal-backed facts — the CLI and
// agent APIs read and write the same configuration the GUI shows; the GUI
// holds no private settings file.
import type { DomainState } from '@kungfu-tech/api/capability';
import type { ProfileManifest, ShellState } from '@kungfu-tech/kfx';

export const SHELL_STATE_LOCATION = {
  category: 'system',
  group: 'shell',
  name: 'state',
  mode: 'live',
} as const;

// Built-in profiles. A profile is a selection of kfx plus a default first
// view; the default profile is the working surface, the forensics profile
// shows the same mechanism carrying a different selection. Opinionated
// workflow profiles arrive here without shell edits.
export const PROFILES: ProfileManifest[] = [
  {
    id: 'default',
    title: 'Default — work control plane',
    kfx: ['work-dashboard', 'rewind', 'journal-manager', 'config-manager'],
    defaultView: 'work-dashboard',
  },
  {
    id: 'forensics',
    title: 'Forensics — run diagnosis first',
    kfx: ['rewind', 'journal-manager'],
    defaultView: 'rewind',
  },
];

export const DEFAULT_STATE: ShellState = {
  profileId: 'default',
  disabledKfx: [],
  disabledSuites: [],
  settings: {},
};

export function profileById(profileId: string): ProfileManifest {
  return PROFILES.find((p) => p.id === profileId) ?? PROFILES[0];
}

export function loadShellState(domain: DomainState): ShellState {
  try {
    const entry = domain
      .configs()
      .find(
        (row) =>
          row.location.category === SHELL_STATE_LOCATION.category &&
          row.location.group === SHELL_STATE_LOCATION.group &&
          row.location.name === SHELL_STATE_LOCATION.name,
      );
    if (!entry) return DEFAULT_STATE;
    const parsed = JSON.parse(entry.value) as Partial<ShellState>;
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    return {
      profileId:
        typeof parsed.profileId === 'string'
          ? parsed.profileId
          : DEFAULT_STATE.profileId,
      disabledKfx: strings(parsed.disabledKfx),
      disabledSuites: strings(parsed.disabledSuites),
      settings:
        parsed.settings && typeof parsed.settings === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.settings).filter(
                ([, v]) => typeof v === 'string',
              ),
            )
          : {},
    };
  } catch {
    // unreadable state never blocks boot; the defaults always work
    return DEFAULT_STATE;
  }
}

export function saveShellState(domain: DomainState, state: ShellState): void {
  domain.setConfig(SHELL_STATE_LOCATION, JSON.stringify(state));
}
