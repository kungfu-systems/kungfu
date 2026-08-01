// Shell state persistence: one JSON blob in the runtime home's ConfigStore
// (location system/shell/state/live). Journal-backed facts — the CLI and
// agent APIs read and write the same configuration the GUI shows; the GUI
// holds no private settings file.
import type { DomainState } from '@kungfu-tech/api/capability';
import type {
  ShellNotification,
  ShellState,
  StatusBarSeverity,
} from '@kungfu-tech/kfx';

import type { RuntimeStatusResult } from '../../runtime-status';

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

export function statusColor(severity: StatusBarSeverity | undefined): string {
  if (severity === 'ok') return '#4ec9b0';
  if (severity === 'warning') return '#dcdcaa';
  if (severity === 'error') return '#f48771';
  return '#cccccc';
}

export function trustStatusText(status: RuntimeStatusResult | null): string {
  const assessments = status?.payload?.assessments;
  if (!assessments) return 'trust unavailable';
  const counts = assessments.counts ?? {};
  const blocked =
    (counts.stale ?? 0) +
    (counts['insufficient-evidence'] ?? 0) +
    (counts.conflicted ?? 0) +
    (counts.unverifiable ?? 0) +
    (counts['failed-retryable'] ?? 0);
  if (blocked > 0) return `trust blocked ${String(blocked)}`;
  if ((counts.pending ?? 0) + (counts.running ?? 0) > 0)
    return `trust pending ${String((counts.pending ?? 0) + (counts.running ?? 0))}`;
  return `trust fresh ${String(counts.fresh ?? 0)}`;
}

export function trustTooltip(status: RuntimeStatusResult | null): string {
  const assessments = status?.payload?.assessments?.assessments;
  if (!assessments) return 'Assessment subscription is unavailable';
  if (assessments.length === 0) return 'No load-bearing claims assessed';
  return assessments
    .map((assessment) => {
      const request = assessment.request ?? {};
      const risks = assessment.report?.residual_risks?.join('; ') || '-';
      return `${assessment.state || '-'}: ${request.claim_id || '-'} for ${
        request.purpose || '-'
      }\nresidual risk: ${risks}\nproof: ${
        assessment.report?.query_proof_root || '-'
      }`;
    })
    .join('\n\n');
}

export function notificationColor(level: ShellNotification['level']): string {
  if (level === 'success') return '#4ec9b0';
  if (level === 'warning') return '#dcdcaa';
  if (level === 'error') return '#f48771';
  return '#9cdcfe';
}

let notificationSeq = 0;
export function notificationId(): string {
  notificationSeq += 1;
  return (
    globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${notificationSeq}`
  );
}
