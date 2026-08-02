import {
  type AgentWorkLabStartupRoute,
  type KungfuOnboardingState,
  finishKungfuOnboarding,
} from '@kungfu-tech/api/capability';
import type { ShellNotificationInput } from '@kungfu-tech/kfx';

type LabOnboardingRouteOptions = {
  state: KungfuOnboardingState;
  persist: (state: KungfuOnboardingState) => Promise<void>;
  notify: (input: ShellNotificationInput) => unknown;
  openPath: (root: string) => Promise<unknown>;
};

export function deferredAgentWorkStartup(
  surface: 'onboarding' | 'projects' | 'work',
  runtimeDir: string,
): AgentWorkLabStartupRoute {
  const descriptions = {
    onboarding: [
      'agent-first-onboarding',
      'Agent-first onboarding starts without runtime inspection.',
    ],
    projects: [
      'project-control-requested',
      'Project control starts without Agent Work Lab inspection.',
    ],
    work: [
      'core-work-requested',
      'Core Work starts without Agent Work Lab or KFX inspection.',
    ],
  } as const;
  const [reasonCode, message] = descriptions[surface];
  return {
    schema: 'kungfu.agent-work-lab.startup-route/v1',
    state: 'diagnostic',
    route: 'diagnostic',
    reasonCode,
    message,
    runtimeDir,
    workGraphPresent: null,
    evidence: [],
    writeOccurred: false,
  };
}

export function createLabOnboardingRoutes({
  state,
  persist,
  notify,
  openPath,
}: LabOnboardingRouteOptions) {
  const warn = (error: unknown) =>
    notify({
      level: 'warning',
      title: 'Getting Started state not saved',
      message: error instanceof Error ? error.message : String(error),
    });
  return {
    completeLab: () => {
      if (state.status === 'started' && state.route === 'tour') return;
      void persist(
        finishKungfuOnboarding(state, {
          route: state.route === 'agent' ? 'agent' : 'lab',
          labCompleted: true,
        }),
      ).catch(warn);
    },
    openStarterProject: (root: string) => {
      if (state.route !== 'tour' && state.route !== 'lab') {
        void openPath(root);
        return;
      }
      void persist(
        finishKungfuOnboarding(state, {
          route: state.route,
          labCompleted: state.route === 'lab' || state.labCompleted,
          tourCompleted: state.route === 'tour' || state.tourCompleted,
        }),
      )
        .then(() => openPath(root))
        .catch(warn);
    },
  };
}
