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
  view: QueryViewSpec;
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
  protocol:
    | {
        inspect: 'profile.intent.inspect';
        advise: 'profile.intent.advise';
        preview: 'profile.intent.plan';
        authorize: 'profile.decide';
        execute: 'profile.intent.apply';
        receipt: 'profile.intent.receipt';
        verify: 'profile.intent.verify';
      }
    | {
        mode: 'shared-api';
        apiId: string;
        guiMember: string;
        guiMethod: string;
      };
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
    current: boolean;
    status: 'qualified' | 'untested' | 'stale' | 'failed' | 'testing';
    reason?: string;
    receiptId?: string;
    witnessId?: string;
    evidenceScope?: string[];
    diagnosis?: Record<string, unknown>;
    qualificationSource?: 'local' | 'release';
    issuer?: { type: 'local' | 'release'; name: string };
    policyVersion?: string;
    runtimeContractRoot?: string;
    nextActions: Array<{ action: string; requiresApproval: boolean }>;
  };
};

export type ProfileKfd3Status =
  ProfileApplicationProjection['qualification'] & {
    schema: 'kungfu.profile-kfd3-status/v1';
    profileId: string;
    profileSuiteRoot: string;
    activeExactRoot: boolean;
  };

export type ProfileKfd3QualificationPlan = {
  schema: 'kungfu.profile-kfd3-qualification-plan/v1';
  planId: string;
  profileId: string;
  profileSuiteRoot: string;
  collaborationRoot: string;
  closureRoot: string;
  profileRevision: number;
  runtimeContractRoot: string;
  intentIds: string[];
  policyVersion: string;
  probes: string[];
  sideEffects: string[];
  requiresAuthorization: true;
  decisionCard: Record<string, unknown>;
};

export type ProfileKfd3QualificationReceipt = {
  schema: 'kungfu.profile-kfd3-qualification-receipt/v1';
  receiptId: string;
  profileId: string;
  profileSuiteRoot: string;
  collaborationRoot: string;
  closureRoot: string;
  profileRevision: number;
  runtimeContract: string;
  qualificationSource: 'local' | 'release';
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

export type ProfileMemberReceipt<TResult> = {
  schema: 'kungfu.profile-member-receipt/v1';
  profileId: string;
  profileSuiteRoot: string;
  memberId: string;
  memberRoot: string;
  operation: string;
  source: string;
  result: TResult;
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

export type ProfileQueryReceipt = {
  schema: 'kungfu.profile-query-receipt/v1';
  planId: string;
  profileSuiteRoot: string;
  catalogRoot: string;
  viewId: string;
  queryDefinitionRoot: string;
  queryProofRoot: string;
  result: unknown;
};

export type ProfileAssessmentPlan = {
  schema: 'kungfu.profile-assessment-plan/v1';
  planId: string;
  profileSuiteRoot: string;
  catalogRoot: string;
  decisionCard: Record<string, unknown>;
  [key: string]: unknown;
};

export type ProfileAssessmentReceipt = {
  schema: 'kungfu.profile-assessment-receipt/v1';
  planId: string;
  authorizationId: string;
  profileSuiteRoot: string;
  catalogRoot: string;
  [key: string]: unknown;
};

export type ProfileAssessmentRequest = {
  claimId: string;
  claimInstanceId?: string;
  policyId: string;
  purpose: string;
  workEpisodeId: number;
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
  kfd3Status: (source: string) => ProfileKfd3Status;
  kfd3StatusAsync: (source: string) => Promise<ProfileKfd3Status>;
  kfd3Plan: (source: string) => ProfileKfd3QualificationPlan;
  kfd3PlanAsync: (source: string) => Promise<ProfileKfd3QualificationPlan>;
  authorizeKfd3Async: (
    source: string,
    expectedPlanId: string,
    choice: 'approve' | 'deny',
    authorizedBy: string,
  ) => Promise<ProfileKfd3QualificationReceipt>;
  qualifyKfd3: (source: string) => ProfileKfd3QualificationReceipt;
  qualifyKfd3Async: (
    source: string,
  ) => Promise<ProfileKfd3QualificationReceipt>;
  verifyKfd3Async: (
    source: string,
    receiptPath: string,
  ) => Promise<ProfileKfd3Verification>;
  intentPlan: (
    source: string,
    intentId: string,
    input?: unknown,
  ) => ProfileIntentPlan;
  intentPlanAsync: (
    source: string,
    intentId: string,
    input?: unknown,
  ) => Promise<ProfileIntentPlan>;
  authorizeIntentAsync: (
    source: string,
    intentId: string,
    expectedPlanId: string,
    choice: 'approve' | 'deny',
    authorizedBy: string,
    input?: unknown,
  ) => Promise<ProfileIntentReceipt>;
  memberCall: <TResult>(
    source: string,
    memberId: string,
    operation: string,
    input?: unknown,
  ) => ProfileMemberReceipt<TResult>;
  memberCallAsync: <TResult>(
    source: string,
    memberId: string,
    operation: string,
    input?: unknown,
  ) => Promise<ProfileMemberReceipt<TResult>>;
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
  queryRun: (source: string, plan: ProfileQueryPlan) => ProfileQueryReceipt;
  queryRunAsync: (
    source: string,
    plan: ProfileQueryPlan,
  ) => Promise<ProfileQueryReceipt>;
  assessmentPlan: (
    source: string,
    queryReceipt: ProfileQueryReceipt,
    request: ProfileAssessmentRequest,
  ) => ProfileAssessmentPlan;
  assessmentPlanAsync: (
    source: string,
    queryReceipt: ProfileQueryReceipt,
    request: ProfileAssessmentRequest,
  ) => Promise<ProfileAssessmentPlan>;
  authorizeAssessmentAsync: (
    plan: ProfileAssessmentPlan,
    choice: 'approve' | 'deny',
    authorizedBy: string,
  ) => Promise<ProfileAssessmentReceipt>;
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
  const inputArgs = (input: unknown) =>
    input === undefined
      ? []
      : [
          '--input-base64',
          Buffer.from(JSON.stringify(input), 'utf8').toString('base64'),
        ];
  const encoded = (input: unknown) =>
    Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const assessmentArgs = (
    source: string,
    queryReceipt: ProfileQueryReceipt,
    request: ProfileAssessmentRequest,
  ) => [
    'assessment-plan',
    source,
    '--query-receipt-base64',
    encoded(queryReceipt),
    '--claim-id',
    request.claimId,
    ...(request.claimInstanceId
      ? ['--claim-instance-id', request.claimInstanceId]
      : []),
    '--policy-id',
    request.policyId,
    '--purpose',
    request.purpose,
    '--work-episode-id',
    String(request.workEpisodeId),
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
    kfd3Status: (source) => run<ProfileKfd3Status>(['kfd3-status', source]),
    kfd3StatusAsync: (source) =>
      runAsync<ProfileKfd3Status>(['kfd3-status', source]),
    kfd3Plan: (source) =>
      run<ProfileKfd3QualificationPlan>(['kfd3-plan', source]),
    kfd3PlanAsync: (source) =>
      runAsync<ProfileKfd3QualificationPlan>(['kfd3-plan', source]),
    authorizeKfd3Async: (source, expectedPlanId, choice, authorizedBy) =>
      runAsync<ProfileKfd3QualificationReceipt>([
        'kfd3-authorize',
        source,
        '--expected-plan-id',
        expectedPlanId,
        '--choice',
        choice,
        '--authorized-by',
        authorizedBy,
      ]),
    qualifyKfd3: (source) =>
      run<ProfileKfd3QualificationReceipt>(['kfd3-qualify', source]),
    qualifyKfd3Async: (source) =>
      runAsync<ProfileKfd3QualificationReceipt>(['kfd3-qualify', source]),
    verifyKfd3Async: (source, receiptPath) =>
      runAsync<ProfileKfd3Verification>(['kfd3-verify', source, receiptPath]),
    intentPlan: (source, intentId, input) =>
      run<ProfileIntentPlan>([
        'intent',
        'plan',
        source,
        intentId,
        ...inputArgs(input),
      ]),
    intentPlanAsync: (source, intentId, input) =>
      runAsync<ProfileIntentPlan>([
        'intent',
        'plan',
        source,
        intentId,
        ...inputArgs(input),
      ]),
    authorizeIntentAsync: (
      source,
      intentId,
      expectedPlanId,
      choice,
      authorizedBy,
      input,
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
        ...inputArgs(input),
      ]),
    memberCall: <TResult>(
      source: string,
      memberId: string,
      operation: string,
      input?: unknown,
    ) =>
      run<ProfileMemberReceipt<TResult>>([
        'member-call',
        source,
        memberId,
        operation,
        ...inputArgs(input),
      ]),
    memberCallAsync: <TResult>(
      source: string,
      memberId: string,
      operation: string,
      input?: unknown,
    ) =>
      runAsync<ProfileMemberReceipt<TResult>>([
        'member-call',
        source,
        memberId,
        operation,
        ...inputArgs(input),
      ]),
    catalog: (source, requireActive = false) =>
      run<ProfileCompositionCatalog>(catalogArgs(source, requireActive)),
    catalogAsync: (source, requireActive = false) =>
      runAsync<ProfileCompositionCatalog>(catalogArgs(source, requireActive)),
    queryPlan: (source, viewId) =>
      run<ProfileQueryPlan>(['query-plan', source, viewId]),
    queryPlanAsync: (source, viewId) =>
      runAsync<ProfileQueryPlan>(['query-plan', source, viewId]),
    queryRun: (source, plan) =>
      run<ProfileQueryReceipt>([
        'query-execute',
        source,
        '--plan-base64',
        encoded(plan),
      ]),
    queryRunAsync: (source, plan) =>
      runAsync<ProfileQueryReceipt>([
        'query-execute',
        source,
        '--plan-base64',
        encoded(plan),
      ]),
    assessmentPlan: (source, queryReceipt, request) =>
      run<ProfileAssessmentPlan>(assessmentArgs(source, queryReceipt, request)),
    assessmentPlanAsync: (source, queryReceipt, request) =>
      runAsync<ProfileAssessmentPlan>(
        assessmentArgs(source, queryReceipt, request),
      ),
    authorizeAssessmentAsync: (plan, choice, authorizedBy) =>
      runAsync<ProfileAssessmentReceipt>([
        'assessment-authorize',
        '--plan-base64',
        encoded(plan),
        '--choice',
        choice,
        '--authorized-by',
        authorizedBy,
      ]),
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
