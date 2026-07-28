// Public narrow capability for the KFX Control Suite. Product roles identify
// assembly/distribution metadata only. Core owns Passport verification,
// capability grants, Work/Warrant settlement, CAS, and recovery state.

import type { KfxHost } from './kfx-host.js';
import type { KfLocator, KfNativeBinding } from './types.js';
import { resolveRuntimeDir } from './types.js';

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
