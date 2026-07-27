// Public narrow capability for the first-party KFX Control Suite. The binding
// owns bootstrap verification, Fact/Work settlement, CAS, and recovery state;
// hosts only carry exact plans and receipts.

import type { KfLocator, KfNativeBinding } from './types.js';
import { resolveRuntimeDir } from './types.js';

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
    operation('kfx_runtime', runtimeDir, {
      action,
      request,
    }) as T;
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
