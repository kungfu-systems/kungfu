// Shell state persistence: one JSON blob in the runtime home's ConfigStore
// (location system/shell/state/live). Journal-backed facts — the CLI and
// agent APIs read and write the same configuration the GUI shows; the GUI
// holds no private settings file.
import type { DomainState } from '@kungfu-tech/api/capability';
import type { ShellState } from '@kungfu-tech/kfx';

export const SHELL_STATE_LOCATION = {
  role: 'system',
  namespace: 'shell',
  name: 'state',
  mode: 'live',
} as const;

export const DEFAULT_STATE: ShellState = {
  profileId: 'default',
  disabledKfx: [],
  disabledSuites: [],
  sidebarCollapsed: false,
  settings: {},
};

export function loadShellState(domain: DomainState): ShellState {
  try {
    const entry = domain
      .configs()
      .find(
        (row) =>
          row.location.role === SHELL_STATE_LOCATION.role &&
          row.location.namespace === SHELL_STATE_LOCATION.namespace &&
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
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean'
          ? parsed.sidebarCollapsed
          : DEFAULT_STATE.sidebarCollapsed,
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
