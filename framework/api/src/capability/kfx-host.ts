import type { KfLocator, KfNativeBinding } from './types.js';
import { resolveRuntimeDir } from './types.js';

export type KfxHost = 'gui' | 'tui' | 'cli' | 'agent';
export type KfxNodeState = 'active' | 'dormant' | 'degraded';
export type KfxRuntimeHost =
  | 'gui'
  | 'wasm'
  | 'adapter-node'
  | 'adapter-python'
  | 'service-node'
  | 'service-python'
  | 'service-cpp'
  | 'profile';

export type KfxHostContribution = {
  state: KfxNodeState;
  contributionRoot: string;
  ownerProviderRoot: string;
  ownerTrustRoot: string;
  capabilityRoot: string;
  facetRoot: string;
  capabilities: string[];
  authorization: {
    schema: 'kungfu.kfx.host-authorization/v2';
    packageKey: string;
    packageRoot: string;
    manifestRoot: string;
    ownerProviderRoot: string;
    trustRoot: string;
    runtimeTier: 'isolated' | 'integrated-explicit' | 'metadata-only';
    admissionGrade:
      | 'unverified'
      | 'identity-verified'
      | 'kfd-attested'
      | 'product-system';
    productSystem: boolean;
    placement: string;
    requiredCapabilities: string[];
    grantedCapabilities: string[];
    reportRoot: string | null;
    admissionPlanRoot: string | null;
    corePolicyRoot: string | null;
    requestedPolicyRoot: string | null;
    policyRoot: string | null;
    authorizationPlanRoot: string | null;
    capabilityDeclarationRoot: string | null;
    capabilityGrantRoot: string | null;
    warrantRoot: string | null;
    cutRoot: string | null;
    revision: number;
    generationRoot: string;
    executionAllowed: boolean;
    authorizationRoot: string;
  };
  presentation?: {
    optional?: boolean;
    hosts?: KfxHost[];
  };
  [key: string]: unknown;
};

export type KfxExperienceFlowDescriptor = {
  schema: 'kungfu.kfx.experience-flow-host/v3';
  descriptorRoot: string;
  registryRoot: string;
  graphRoot: string;
  planRoot: string;
  receiptDependencyRoot: string;
  cutRoot: string | null;
  revision: number;
  generation: {
    schema: 'kungfu.kfx.host-generation/v2';
    registryRoot: string;
    graphRoot: string;
    cutRoot: string | null;
    revision: number;
  };
  generationRoot: string;
  admission: {
    schema: 'kungfu.kfx.host-admission/v2';
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
    runtimeAuthorizationRoots: string[];
  };
  runtimeAuthorizations: Array<
    KfxHostContribution['authorization'] & { host: KfxRuntimeHost }
  >;
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

// Rendering stays host-native. This adapter may annotate availability, but it
// cannot change Core graph, plan, capability, authorization, or receipt roots.
export function projectKfxExperienceFlowHost(
  descriptor: KfxExperienceFlowDescriptor,
  host: KfxHost,
): KfxHostProjection {
  if (descriptor.schema !== 'kungfu.kfx.experience-flow-host/v3') {
    throw new Error('unsupported KFX Experience/Flow host descriptor');
  }
  const exact = descriptor.admission;
  if (
    exact.schema !== 'kungfu.kfx.host-admission/v2' ||
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
    exact.runtimeAuthorizationRoots.length !==
      descriptor.runtimeAuthorizations.length ||
    descriptor.runtimeAuthorizations.some(
      (authorization, index) =>
        exact.runtimeAuthorizationRoots[index] !==
          authorization.authorizationRoot ||
        authorization.cutRoot !== descriptor.cutRoot ||
        authorization.revision !== descriptor.revision ||
        authorization.generationRoot !== descriptor.generationRoot,
    ) ||
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
        contribution.authorization.packageRoot.length === 0 ||
        contribution.authorization.cutRoot !== descriptor.cutRoot ||
        contribution.authorization.revision !== descriptor.revision ||
        contribution.authorization.generationRoot !==
          descriptor.generationRoot ||
        (exact.state === 'admitted' &&
          (contribution.authorization.capabilityDeclarationRoot === null ||
            contribution.authorization.capabilityGrantRoot === null ||
            contribution.authorization.corePolicyRoot === null ||
            contribution.authorization.requestedPolicyRoot === null ||
            contribution.authorization.policyRoot === null ||
            contribution.authorization.warrantRoot === null ||
            contribution.authorization.requiredCapabilities.some(
              (capability) =>
                !contribution.authorization.grantedCapabilities.includes(
                  capability,
                ),
            )))
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
          contribution.authorization.executionAllowed &&
          contribution.state === 'active' &&
          presentationState === 'active',
      };
    }),
  };
}

export function authorizeKfxHostLaunch(
  descriptor: KfxExperienceFlowDescriptor,
  packageKey: string,
  host: KfxRuntimeHost,
  expectedAuthorizationRoot: string,
): KfxHostContribution['authorization'] & { host: KfxRuntimeHost } {
  const authorization = descriptor.runtimeAuthorizations.find(
    (candidate) =>
      candidate.packageKey === packageKey && candidate.host === host,
  );
  if (
    !authorization ||
    descriptor.admission.state !== 'admitted' ||
    !descriptor.admission.runtimeAuthorizationRoots.includes(
      expectedAuthorizationRoot,
    ) ||
    authorization.authorizationRoot !== expectedAuthorizationRoot ||
    authorization.cutRoot !== descriptor.cutRoot ||
    authorization.revision !== descriptor.revision ||
    authorization.generationRoot !== descriptor.generationRoot ||
    authorization.capabilityDeclarationRoot === null ||
    authorization.capabilityGrantRoot === null ||
    authorization.corePolicyRoot === null ||
    authorization.requestedPolicyRoot === null ||
    authorization.policyRoot === null ||
    authorization.warrantRoot === null ||
    authorization.requiredCapabilities.some(
      (capability) => !authorization.grantedCapabilities.includes(capability),
    ) ||
    !authorization.executionAllowed
  ) {
    throw new Error('KFX host launch authorization does not match');
  }
  return authorization;
}

// Public narrow capability for the KFX Control Suite. Product roles identify
// assembly/distribution metadata only. Core owns Passport verification,
// capability grants, Work/Warrant settlement, CAS, and recovery state.
export type KfxControlRoot = {
  kind: 'product';
  path: string;
};

export type KfxControlAuthority = Record<string, unknown>;

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
  authorizationPlanRoot: string;
  capabilityGrantRoot: string;
  warrantRoot: string;
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
  authorizationPlanRoot: string;
  capabilityGrantRoot: string;
  warrantRoot: string;
  verified: true;
  status: KfxControlStatus;
  application: Record<string, unknown>;
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
  diagnostics: KfxControlStatus['diagnostics'];
};

export function projectKfxControlSuiteHost(
  status: KfxControlStatus,
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
    controllerId: status.controllerId,
    statusRoot: status.statusRoot,
    cutRoot: status.cutRoot,
    revision: status.revision,
    mode: status.mode,
    executionAllowed: status.executionAllowed,
    diagnostics: status.diagnostics,
  };
}

export type KfxControl = {
  status: () => KfxControlStatus;
  plan: (
    operation: 'install' | 'update',
    candidate: KfxControlRoot,
    authority: KfxControlAuthority,
  ) => KfxControlPlan;
  apply: (
    operation: 'install' | 'update',
    candidate: KfxControlRoot,
    plan: KfxControlPlan,
    authority: KfxControlAuthority,
    auditActor: string,
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
    authority: KfxControlAuthority,
  ) => ({
    ...authority,
    controller: 'kungfu-kfx-control-suite',
    packageKey: 'kfx-manager',
    operation: action,
    roots: [candidate],
  });
  return {
    status: () =>
      run<KfxControlStatus>('status', {
        controller: 'kungfu-kfx-control-suite',
      }),
    plan: (action, candidate, authority) =>
      run<KfxControlPlan>('plan', requestFor(action, candidate, authority)),
    apply: (action, candidate, plan, authority, auditActor) => {
      if (!auditActor.trim()) {
        throw new Error('KFX Control audit actor is required');
      }
      const member = plan.loadPlan.packages.find(
        (row) => row.key === 'kfx-manager',
      );
      if (!member) {
        throw new Error('KFX Control plan does not contain kfx-manager');
      }
      return run<KfxControlApplication>('apply', {
        ...requestFor(action, candidate, authority),
        expectedCutRoot: plan.loadPlan.cutRoot,
        expectedRevision: plan.loadPlan.revision,
        expectedRegistryRoot: plan.loadPlan.registryRoot,
        expectedGraphRoot: plan.loadPlan.graphRoot,
        expectedPlanRoot: plan.loadPlan.planRoot,
        expectedTrustRoot: member.trustRoot,
        expectedPackageRoot: member.packageRoot,
        expectedControlPlanRoot: plan.controlPlanRoot,
        expectedBootstrapPolicyRoot: plan.bootstrapPolicyRoot,
        expectedAuthorizationPlanRoot: plan.authorizationPlanRoot,
        expectedCapabilityGrantRoot: plan.capabilityGrantRoot,
        expectedWarrantRoot: plan.warrantRoot,
        actor: auditActor,
      });
    },
  };
}
