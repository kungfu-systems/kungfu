// SPDX-License-Identifier: Apache-2.0

export const KUNGFU_ONBOARDING_VERSION = 1;

export type KungfuOnboardingStatus =
  | 'unseen'
  | 'started'
  | 'completed'
  | 'dismissed';
export type KungfuOnboardingRoute = 'none' | 'agent' | 'lab' | 'tour';

export type KungfuOnboardingState = {
  version: number;
  status: KungfuOnboardingStatus;
  route: KungfuOnboardingRoute;
  labCompleted: boolean;
  tourCompleted: boolean;
  completedAt: string;
};

export const DEFAULT_KUNGFU_ONBOARDING_STATE: KungfuOnboardingState = {
  version: KUNGFU_ONBOARDING_VERSION,
  status: 'unseen',
  route: 'none',
  labCompleted: false,
  tourCompleted: false,
  completedAt: '',
};

const STATUSES = new Set<KungfuOnboardingStatus>([
  'unseen',
  'started',
  'completed',
  'dismissed',
]);
const ROUTES = new Set<KungfuOnboardingRoute>(['none', 'agent', 'lab', 'tour']);

export function parseKungfuOnboardingState(
  value: unknown,
): KungfuOnboardingState {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
  const candidate = value as Partial<KungfuOnboardingState>;
  if (
    candidate.version !== KUNGFU_ONBOARDING_VERSION ||
    !STATUSES.has(candidate.status as KungfuOnboardingStatus) ||
    !ROUTES.has(candidate.route as KungfuOnboardingRoute)
  ) {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
  return {
    version: KUNGFU_ONBOARDING_VERSION,
    status: candidate.status as KungfuOnboardingStatus,
    route: candidate.route as KungfuOnboardingRoute,
    labCompleted: candidate.labCompleted === true,
    tourCompleted: candidate.tourCompleted === true,
    completedAt:
      typeof candidate.completedAt === 'string' ? candidate.completedAt : '',
  };
}

export function shouldShowKungfuOnboarding(
  state: KungfuOnboardingState,
): boolean {
  return state.status === 'unseen' || state.status === 'started';
}

export function beginKungfuOnboardingRoute(
  state: KungfuOnboardingState,
  route: Exclude<KungfuOnboardingRoute, 'none'>,
): KungfuOnboardingState {
  return { ...state, status: 'started', route, completedAt: '' };
}

export function finishKungfuOnboarding(
  state: KungfuOnboardingState,
  options: {
    route?: Exclude<KungfuOnboardingRoute, 'none'>;
    labCompleted?: boolean;
    tourCompleted?: boolean;
    completedAt?: string;
  } = {},
): KungfuOnboardingState {
  return {
    ...state,
    status: 'completed',
    route: options.route ?? state.route,
    labCompleted: options.labCompleted ?? state.labCompleted,
    tourCompleted: options.tourCompleted ?? state.tourCompleted,
    completedAt: options.completedAt ?? new Date().toISOString(),
  };
}

export function dismissKungfuOnboarding(
  state: KungfuOnboardingState,
): KungfuOnboardingState {
  return {
    ...state,
    status: 'dismissed',
    completedAt: new Date().toISOString(),
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function kungfuAgentBriefCommand(
  executable: string,
  argsPrefix: readonly string[] = [],
): string {
  return [executable, ...argsPrefix, 'agent', 'brief']
    .map(shellQuote)
    .join(' ');
}

export function kungfuAgentFirstPrompt(command: string): string {
  return `Run \`${command}\`, then guide me through my first Project and Work. Keep me in my current agent, and use Kungfu as the durable Work layer.`;
}
