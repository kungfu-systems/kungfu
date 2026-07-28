import type { KfLocator, KfNativeBinding } from './types.js';
import { resolveRuntimeDir } from './types.js';

export type KfxHost = 'gui' | 'tui' | 'cli' | 'agent';
export type KfxNodeState = 'active' | 'dormant' | 'degraded';

export type KfxHostContribution = {
  state: KfxNodeState;
  contributionRoot: string;
  ownerProviderRoot: string;
  ownerTrustRoot: string;
  capabilityRoot: string;
  facetRoot: string;
  capabilities: string[];
  authorization: {
    schema: 'kungfu.kfx.host-authorization/v1';
    ownerProviderRoot: string;
    trustRoot: string;
    capabilityRoot: string;
    requiredCapabilities: string[];
    cutRoot: string | null;
    revision: number;
    authorizationRoot: string;
  };
  presentation?: {
    optional?: boolean;
    hosts?: KfxHost[];
  };
  [key: string]: unknown;
};

export type KfxExperienceFlowDescriptor = {
  schema: 'kungfu.kfx.experience-flow-host/v2';
  descriptorRoot: string;
  registryRoot: string;
  graphRoot: string;
  planRoot: string;
  receiptDependencyRoot: string;
  cutRoot: string | null;
  revision: number;
  generation: {
    schema: 'kungfu.kfx.host-generation/v1';
    registryRoot: string;
    graphRoot: string;
    cutRoot: string | null;
    revision: number;
  };
  generationRoot: string;
  admission: {
    schema: 'kungfu.kfx.host-admission/v1';
    state: 'admitted' | 'preview-only';
    exactRootRequired: true;
    registryRoot: string;
    graphRoot: string;
    planRoot: string;
    cutRoot: string | null;
    revision: number;
    generationRoot: string;
    contributionRoots: string[];
    facetRoots: string[];
    capabilityRoots: string[];
    authorizationRoots: string[];
  };
  contributions: KfxHostContribution[];
};

export type KfxHostProjection = {
  schema: 'kungfu.kfx.host-projection/v1';
  host: KfxHost;
  descriptorRoot: string;
  graphRoot: string;
  planRoot: string;
  receiptDependencyRoot: string;
  cutRoot: string | null;
  revision: number;
  generationRoot: string;
  admissionState: 'admitted' | 'preview-only';
  diagnostics: Array<{
    code: 'KF_KFX_HOST_NOT_ADMITTED' | 'KF_KFX_PRESENTATION_DORMANT';
    contributionRoot?: string;
    recoveryGuidance: string[];
  }>;
  contributions: Array<
    KfxHostContribution & {
      semanticState: KfxNodeState;
      presentationState: KfxNodeState;
      executionEligible: boolean;
    }
  >;
};

export type KfxControlHostProjection = {
  schema: 'kungfu.kfx.control-host-projection/v1';
  host: KfxHost;
  controllerId: 'kungfu-kfx-control-suite';
  statusRoot: string;
  cutRoot: string | null;
  revision: number;
  mode: 'active' | 'safe-mode';
  executionAllowed: boolean;
  diagnostics: Array<{
    code: 'KF_KFX_CONTROL_SAFE_MODE';
    recoveryGuidance: string[];
  }>;
};

export function projectKfxControlSuiteHost(
  status: {
    schema: string;
    controllerId: string;
    statusRoot: string;
    cutRoot: string | null;
    revision: number;
    mode: 'active' | 'safe-mode';
    executionAllowed: boolean;
    diagnostics: KfxControlHostProjection['diagnostics'];
  },
  host: KfxHost,
): KfxControlHostProjection {
  if (
    status.schema !== 'kungfu.kfx.control-suite-status/v1' ||
    status.controllerId !== 'kungfu-kfx-control-suite' ||
    !status.statusRoot.startsWith('sha256:') ||
    (status.mode === 'active') !== status.executionAllowed ||
    (status.cutRoot === null) !== (status.revision === 0)
  ) {
    throw new Error('KFX Control status identity does not match');
  }
  return {
    schema: 'kungfu.kfx.control-host-projection/v1',
    host,
    controllerId: 'kungfu-kfx-control-suite',
    statusRoot: status.statusRoot,
    cutRoot: status.cutRoot,
    revision: status.revision,
    mode: status.mode,
    executionAllowed: status.executionAllowed,
    diagnostics: status.diagnostics,
  };
}

// Rendering stays host-native. This adapter may annotate availability, but it
// cannot change Core graph, plan, capability, authorization, or receipt roots.
export function projectKfxExperienceFlowHost(
  descriptor: KfxExperienceFlowDescriptor,
  host: KfxHost,
): KfxHostProjection {
  if (descriptor.schema !== 'kungfu.kfx.experience-flow-host/v2') {
    throw new Error('unsupported KFX Experience/Flow host descriptor');
  }
  const exact = descriptor.admission;
  if (
    exact.schema !== 'kungfu.kfx.host-admission/v1' ||
    exact.exactRootRequired !== true ||
    exact.registryRoot !== descriptor.registryRoot ||
    exact.graphRoot !== descriptor.graphRoot ||
    exact.planRoot !== descriptor.planRoot ||
    exact.cutRoot !== descriptor.cutRoot ||
    exact.revision !== descriptor.revision ||
    exact.generationRoot !== descriptor.generationRoot ||
    descriptor.generation.registryRoot !== descriptor.registryRoot ||
    descriptor.generation.graphRoot !== descriptor.graphRoot ||
    descriptor.generation.cutRoot !== descriptor.cutRoot ||
    descriptor.generation.revision !== descriptor.revision ||
    (exact.state === 'admitted') !== (descriptor.cutRoot !== null)
  ) {
    throw new Error('KFX host descriptor admission identity does not match');
  }
  const diagnostics: KfxHostProjection['diagnostics'] = [];
  if (exact.state !== 'admitted') {
    diagnostics.push({
      code: 'KF_KFX_HOST_NOT_ADMITTED',
      recoveryGuidance: ['settle-exact-kfx-fact-cut'],
    });
  }
  return {
    schema: 'kungfu.kfx.host-projection/v1',
    host,
    descriptorRoot: descriptor.descriptorRoot,
    graphRoot: descriptor.graphRoot,
    planRoot: descriptor.planRoot,
    receiptDependencyRoot: descriptor.receiptDependencyRoot,
    cutRoot: descriptor.cutRoot,
    revision: descriptor.revision,
    generationRoot: descriptor.generationRoot,
    admissionState: exact.state,
    diagnostics,
    contributions: descriptor.contributions.map((contribution) => {
      const index = exact.contributionRoots.indexOf(
        contribution.contributionRoot,
      );
      if (
        index < 0 ||
        exact.facetRoots[index] !== contribution.facetRoot ||
        exact.capabilityRoots[index] !== contribution.capabilityRoot ||
        exact.authorizationRoots[index] !==
          contribution.authorization.authorizationRoot ||
        contribution.authorization.ownerProviderRoot !==
          contribution.ownerProviderRoot ||
        contribution.authorization.trustRoot !== contribution.ownerTrustRoot ||
        contribution.authorization.capabilityRoot !==
          contribution.capabilityRoot ||
        contribution.authorization.cutRoot !== descriptor.cutRoot ||
        contribution.authorization.revision !== descriptor.revision
      ) {
        throw new Error(
          'KFX host contribution admission identity does not match',
        );
      }
      const supported =
        contribution.presentation?.hosts?.includes(host) === true;
      const optional = contribution.presentation?.optional === true;
      const presentationState: KfxNodeState = supported
        ? 'active'
        : optional
          ? 'dormant'
          : 'degraded';
      if (presentationState === 'dormant') {
        diagnostics.push({
          code: 'KF_KFX_PRESENTATION_DORMANT',
          contributionRoot: contribution.contributionRoot,
          recoveryGuidance: [`install-optional-${host}-presentation`],
        });
      }
      return {
        ...contribution,
        semanticState: contribution.state,
        presentationState,
        executionEligible:
          exact.state === 'admitted' &&
          contribution.state === 'active' &&
          presentationState === 'active',
      };
    }),
  };
}

// Public narrow capability for the first-party KFX Control Suite. The binding
// owns bootstrap verification, Fact/Work settlement, CAS, and recovery state;
// hosts only carry exact plans and receipts.
export type KfxControlRoot = {
  kind: 'product';
  path: string;
};

export type KfxControlStatus = {
  schema: 'kungfu.kfx.control-suite-status/v1';
  controllerId: 'kungfu-kfx-control-suite';
  statusRoot: string;
  cutRoot: string | null;
  revision: number;
  mode: 'active' | 'safe-mode';
  executionAllowed: boolean;
  active: null | {
    packageRoot: string;
    manifestRoot: string;
    version: string;
  };
  lastKnownGood: null | {
    packageRoot: string;
    manifestRoot: string;
    version: string;
    sourcePath: string;
  };
  diagnostics: Array<{
    code: 'KF_KFX_CONTROL_SAFE_MODE';
    recoveryGuidance: string[];
  }>;
};

export type KfxControlPlan = {
  schema: 'kungfu.kfx.control-suite-plan/v1';
  controllerId: 'kungfu-kfx-control-suite';
  operation: 'install' | 'update';
  packageKey: 'kfx-manager';
  controlPlanRoot: string;
  bootstrapPolicyRoot: string;
  allowed: true;
  requiresAuthorization: true;
  candidate: {
    packageRoot: string;
    manifestRoot: string;
    version: string;
  };
  loadPlan: {
    cutRoot: string | null;
    revision: number;
    registryRoot: string;
    graphRoot: string;
    planRoot: string;
    packages: Array<{
      key: string;
      packageRoot: string;
      trustRoot: string;
    }>;
  };
};

export type KfxControlApplication = {
  schema: 'kungfu.kfx.control-suite-application/v1';
  controllerId: 'kungfu-kfx-control-suite';
  controlPlanRoot: string;
  bootstrapPolicyRoot: string;
  verified: true;
  status: KfxControlStatus;
  application: Record<string, unknown>;
};

export type KfxControl = {
  status: () => KfxControlStatus;
  plan: (
    operation: 'install' | 'update',
    candidate: KfxControlRoot,
  ) => KfxControlPlan;
  apply: (
    operation: 'install' | 'update',
    candidate: KfxControlRoot,
    plan: KfxControlPlan,
    authorizationId: string,
  ) => KfxControlApplication;
};

export type OpenKfxControlOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
};

export function openKfxControl(options: OpenKfxControlOptions): KfxControl {
  const operation = options.binding.runStorageServiceOperation;
  if (!operation) {
    throw new Error('native binding does not expose KFX Control operations');
  }
  const runtimeDir = resolveRuntimeDir(options.locator);
  const run = <T>(action: 'status' | 'plan' | 'apply', request: object): T =>
    operation('kfx_runtime', runtimeDir, { action, request }) as T;
  const requestFor = (
    action: 'install' | 'update',
    candidate: KfxControlRoot,
  ) => ({
    controller: 'kungfu-kfx-control-suite',
    packageKey: 'kfx-manager',
    operation: action,
    roots: [candidate],
    runtimeTiers: { 'kfx-manager': 'first-party-pinned' },
  });
  return {
    status: () =>
      run<KfxControlStatus>('status', {
        controller: 'kungfu-kfx-control-suite',
      }),
    plan: (action, candidate) =>
      run<KfxControlPlan>('plan', requestFor(action, candidate)),
    apply: (action, candidate, plan, authorizationId) => {
      if (!authorizationId.trim()) {
        throw new Error('KFX Control authorization identity is required');
      }
      const member = plan.loadPlan.packages.find(
        (row) => row.key === 'kfx-manager',
      );
      if (!member) {
        throw new Error('KFX Control plan does not contain kfx-manager');
      }
      return run<KfxControlApplication>('apply', {
        ...requestFor(action, candidate),
        expectedCutRoot: plan.loadPlan.cutRoot,
        expectedRevision: plan.loadPlan.revision,
        expectedRegistryRoot: plan.loadPlan.registryRoot,
        expectedGraphRoot: plan.loadPlan.graphRoot,
        expectedPlanRoot: plan.loadPlan.planRoot,
        expectedTrustRoot: member.trustRoot,
        expectedPackageRoot: member.packageRoot,
        expectedControlPlanRoot: plan.controlPlanRoot,
        expectedBootstrapPolicyRoot: plan.bootstrapPolicyRoot,
        authorizationId,
        actor: authorizationId,
      });
    },
  };
}
