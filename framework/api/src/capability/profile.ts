import type { QueryDefinition, QueryViewSpec } from './query.js';

// Agent-first Profile composition handle. The CLI/Core remain authoritative;
// this adapter only types their JSON receipts and injects process execution.

export type ProfileDiagnosis = {
  schema: 'kungfu.profile-diagnosis/v1';
  ok: boolean;
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  [key: string]: unknown;
};

export type ProfileView = {
  id: string;
  title: string;
  factSurfaces: string[];
  definition?: QueryDefinition;
  queryFamily?: {
    id: string;
    member: string;
    resolutionMode: 'member-resolved-definition';
    bindings: Array<{
      name: string;
      type: 'string' | 'integer' | 'boolean';
      required: boolean;
    }>;
  };
  view: Exclude<QueryViewSpec, { kind: 'mission-control' }>;
};

export type ProfileCompositionCatalog = {
  schema: 'kungfu.profile-composition/v1';
  profileId: string;
  profileVersion: string;
  profileSuiteRoot: string;
  profileRevision: number | null;
  activeExactRoot: boolean;
  memberRoots: Record<string, string>;
  purposes: string[];
  factSurfaces: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  views: ProfileView[];
  diagnostics: ProfileDiagnosis[];
  catalogRoot: string;
};

export type ManagedProfile = {
  profileId: string;
  profileVersion: string;
  profileSuiteRoot: string;
  profileRevision: number;
  lifecycleState: 'installed' | 'qualified' | 'activated' | 'removed';
  activated: boolean;
  removed: boolean;
  grantedPermissions: string[];
  qualification: Record<string, unknown>;
  availableRoots: number;
  source: string | null;
  health: 'active' | 'inactive' | 'degraded' | 'unavailable' | 'removed';
  catalog: ProfileCompositionCatalog | null;
  diagnostics: ProfileDiagnosis[];
};

export type ProfileManagerProjection = {
  schema: 'kungfu.profile-manager/v1';
  runtimeDir: string;
  cutSystemTime: number;
  profiles: ManagedProfile[];
  count: number;
  knownLimits: string[];
};

export type ProfileApplicationIntent = {
  id: string;
  title: string;
  actionId: string;
  inspectViewId: string;
  verifyViewId: string;
  requiredAuthority: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  material: true;
  action: Record<string, unknown>;
  inspectView: ProfileView;
  verifyView: ProfileView;
};

export type ProfileApplicationProjection = {
  schema: 'kungfu.profile-application/v1';
  profileId: string;
  profileSuiteRoot: string;
  collaborationRoot: string;
  closureRoot: string;
  source: string;
  activeExactRoot: boolean;
  profileRevision: number | null;
  grantedCapabilities: string[];
  value: {
    summary: string;
    participantBenefits: Array<Record<string, unknown>>;
  };
  participants: Array<{
    id: string;
    kind: 'human' | 'agent' | 'operator' | 'service';
    title: string;
    authorityClasses: string[];
  }>;
  constraints: Array<Record<string, unknown>>;
  knownLimits: Array<Record<string, unknown>>;
  intents: ProfileApplicationIntent[];
  presentation: { mode: 'generic' };
  protocol: string[];
  qualified: boolean;
  qualification: {
    qualified: boolean;
    status: 'not-qualified' | 'qualification-failed' | 'qualified';
    reason?: string;
    receiptId?: string;
    witnessId?: string;
    evidenceScope?: string[];
    diagnosis?: Record<string, unknown>;
  };
};

export type ProfileKfd3QualificationReceipt = {
  schema: 'kungfu.profile-kfd3-qualification-receipt/v1';
  receiptId: string;
  profileId: string;
  profileSuiteRoot: string;
  collaborationRoot: string;
  closureRoot: string;
  profileRevision: number;
  qualified: true;
  evidenceScope: string[];
  witness: {
    schema: 'kungfu.profile-kfd3-witness/v1';
    witnessId: string;
    qualificationReceiptId: string;
    qualified: true;
  };
};

export type ProfileKfd3Verification = {
  schema: 'kungfu.profile-kfd3-verification/v1';
  profileId: string;
  profileSuiteRoot: string;
  receiptId: string;
  witnessId: string;
  verified: true;
};

export type ProfileIntentPlan = {
  schema: 'kungfu.profile-intent-plan/v1';
  planId: string;
  profileSuiteRoot: string;
  collaborationRoot: string;
  closureRoot: string;
  intentId: string;
  actionPlanId: string;
  source: string;
  actionPlan: Record<string, unknown>;
  decisionCard: Record<string, unknown>;
  protocolStage: 'preview';
};

export type ProfileIntentReceipt = {
  schema: 'kungfu.profile-intent-receipt/v1';
  receiptId: string;
  planId: string;
  actionPlanId: string;
  intentId: string;
  verified: false;
  executionReceiptVerified: boolean;
  verification: {
    schema: 'kungfu.profile-intent-verification/v1';
    receiptId: string;
    verified: true;
  };
};

export type ProfileSourceDiscovery = {
  schema: 'kungfu.profile-source-discovery/v1';
  profileId: string;
  profileSuiteRoot: string;
  memberRoots: Record<string, string>;
  source: string;
};

export type ProfileLifecycleAction =
  | 'install'
  | 'qualify'
  | 'activate'
  | 'upgrade';

export type ProfileQueryPlan = {
  schema: 'kungfu.profile-query-plan/v1';
  planId: string;
  catalogRoot: string;
  profileSuiteRoot: string;
  profileRevision: number;
  view: ProfileView;
  corePlan: Record<string, unknown>;
};

export type ProfileLifecyclePlan = {
  schema: 'kungfu.profile-agent-plan/v1';
  action: string;
  corePlan: Record<string, unknown>;
  decisionCard: Record<string, unknown>;
  [key: string]: unknown;
};

export type ProfileLifecycleReceipt = {
  schema: 'kungfu.profile-lifecycle-receipt/v1';
  plan_id: string;
  authorization_id: string;
  profile_id: string;
  state: Record<string, unknown>;
  verified: boolean;
};

export type ProfileContractPlan = {
  schema: 'kungfu.profile-contract-plan/v1';
  planId: string;
  profileSuiteRoot: string;
  catalogRoot: string;
  operations: Array<Record<string, unknown>>;
  requiresAuthorization: boolean;
  decisionCard: Record<string, unknown>;
};

export type Profile = {
  runtimeDir: string;
  discover: (profileId: string) => ProfileSourceDiscovery;
  discoverAsync: (profileId: string) => Promise<ProfileSourceDiscovery>;
  manager: () => ProfileManagerProjection;
  managerAsync: () => Promise<ProfileManagerProjection>;
  application: (source: string) => ProfileApplicationProjection;
  applicationAsync: (source: string) => Promise<ProfileApplicationProjection>;
  qualifyKfd3: (source: string) => ProfileKfd3QualificationReceipt;
  qualifyKfd3Async: (
    source: string,
  ) => Promise<ProfileKfd3QualificationReceipt>;
  verifyKfd3Async: (
    source: string,
    receiptPath: string,
  ) => Promise<ProfileKfd3Verification>;
  intentPlan: (source: string, intentId: string) => ProfileIntentPlan;
  intentPlanAsync: (
    source: string,
    intentId: string,
  ) => Promise<ProfileIntentPlan>;
  authorizeIntentAsync: (
    source: string,
    intentId: string,
    expectedPlanId: string,
    choice: 'approve' | 'deny',
    authorizedBy: string,
  ) => Promise<ProfileIntentReceipt>;
  catalog: (
    source: string,
    requireActive?: boolean,
  ) => ProfileCompositionCatalog;
  catalogAsync: (
    source: string,
    requireActive?: boolean,
  ) => Promise<ProfileCompositionCatalog>;
  queryPlan: (source: string, viewId: string) => ProfileQueryPlan;
  queryPlanAsync: (source: string, viewId: string) => Promise<ProfileQueryPlan>;
  contractPlan: (source: string) => ProfileContractPlan;
  contractPlanAsync: (source: string) => Promise<ProfileContractPlan>;
  lifecyclePlan: (
    action: ProfileLifecycleAction,
    source: string,
  ) => ProfileLifecyclePlan;
  lifecyclePlanAsync: (
    action: ProfileLifecycleAction,
    source: string,
  ) => Promise<ProfileLifecyclePlan>;
  authorizeLifecycleAsync: (
    action: ProfileLifecycleAction,
    source: string,
    expectedPlanId: string,
    choice: 'approve' | 'deny',
    authorizedBy: string,
  ) => Promise<ProfileLifecycleReceipt>;
};

export type ProfileExecFileSync = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => string;

export type ProfileExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => Promise<string>;

export type OpenProfileOptions = {
  runtimeDir: string;
  execFileSync: ProfileExecFileSync;
  execFile?: ProfileExecFile;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openProfile(options: OpenProfileOptions): Profile {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const run = <T>(args: string[]): T =>
    JSON.parse(
      options.execFileSync(bin, ['profile', ...args, '--json'], {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as T;
  const runAsync = async <T>(args: string[]): Promise<T> => {
    if (!options.execFile) return run<T>(args);
    const text = await options.execFile(bin, ['profile', ...args, '--json'], {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(text) as T;
  };
  const catalogArgs = (source: string, requireActive: boolean) => [
    'catalog',
    source,
    ...(requireActive ? ['--require-active'] : []),
  ];
  return {
    runtimeDir: options.runtimeDir,
    discover: (profileId) =>
      run<ProfileSourceDiscovery>(['discover', profileId]),
    discoverAsync: (profileId) =>
      runAsync<ProfileSourceDiscovery>(['discover', profileId]),
    manager: () => run<ProfileManagerProjection>(['manager']),
    managerAsync: () => runAsync<ProfileManagerProjection>(['manager']),
    application: (source) =>
      run<ProfileApplicationProjection>(['application', source]),
    applicationAsync: (source) =>
      runAsync<ProfileApplicationProjection>(['application', source]),
    qualifyKfd3: (source) =>
      run<ProfileKfd3QualificationReceipt>(['kfd3-qualify', source]),
    qualifyKfd3Async: (source) =>
      runAsync<ProfileKfd3QualificationReceipt>(['kfd3-qualify', source]),
    verifyKfd3Async: (source, receiptPath) =>
      runAsync<ProfileKfd3Verification>(['kfd3-verify', source, receiptPath]),
    intentPlan: (source, intentId) =>
      run<ProfileIntentPlan>(['intent', 'plan', source, intentId]),
    intentPlanAsync: (source, intentId) =>
      runAsync<ProfileIntentPlan>(['intent', 'plan', source, intentId]),
    authorizeIntentAsync: (
      source,
      intentId,
      expectedPlanId,
      choice,
      authorizedBy,
    ) =>
      runAsync<ProfileIntentReceipt>([
        'intent',
        'authorize',
        source,
        intentId,
        '--expected-plan-id',
        expectedPlanId,
        '--choice',
        choice,
        '--authorized-by',
        authorizedBy,
      ]),
    catalog: (source, requireActive = false) =>
      run<ProfileCompositionCatalog>(catalogArgs(source, requireActive)),
    catalogAsync: (source, requireActive = false) =>
      runAsync<ProfileCompositionCatalog>(catalogArgs(source, requireActive)),
    queryPlan: (source, viewId) =>
      run<ProfileQueryPlan>(['query-plan', source, viewId]),
    queryPlanAsync: (source, viewId) =>
      runAsync<ProfileQueryPlan>(['query-plan', source, viewId]),
    contractPlan: (source) =>
      run<ProfileContractPlan>(['contract-plan', source]),
    contractPlanAsync: (source) =>
      runAsync<ProfileContractPlan>(['contract-plan', source]),
    lifecyclePlan: (action, source) =>
      run<ProfileLifecyclePlan>(['plan', action, source]),
    lifecyclePlanAsync: (action, source) =>
      runAsync<ProfileLifecyclePlan>(['plan', action, source]),
    authorizeLifecycleAsync: (
      action,
      source,
      expectedPlanId,
      choice,
      authorizedBy,
    ) =>
      runAsync<ProfileLifecycleReceipt>([
        'authorize-lifecycle',
        action,
        source,
        '--expected-plan-id',
        expectedPlanId,
        '--choice',
        choice,
        '--authorized-by',
        authorizedBy,
      ]),
  };
}
