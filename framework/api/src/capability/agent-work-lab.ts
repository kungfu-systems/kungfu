// SPDX-License-Identifier: Apache-2.0

// Shared adapter over the Core Agent Work Lab. Hosts inject process
// execution; GUI and TUI receive the same startup route, plans, receipts,
// assessments and reports and own no private semantic state.
import type { AgentRuntimeCatalog } from './agent-runtime.js';

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

const ONBOARDING_STATUSES = new Set<KungfuOnboardingStatus>([
  'unseen',
  'started',
  'completed',
  'dismissed',
]);
const ONBOARDING_ROUTES = new Set<KungfuOnboardingRoute>([
  'none',
  'agent',
  'lab',
  'tour',
]);

export function parseKungfuOnboardingState(
  value: unknown,
): KungfuOnboardingState {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
  const candidate = value as Partial<KungfuOnboardingState>;
  if (
    candidate.version !== KUNGFU_ONBOARDING_VERSION ||
    !ONBOARDING_STATUSES.has(candidate.status as KungfuOnboardingStatus) ||
    !ONBOARDING_ROUTES.has(candidate.route as KungfuOnboardingRoute)
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

export type AgentWorkLabStartupRoute = {
  schema: 'kungfu.agent-work-lab.startup-route/v1';
  state: 'verified-empty' | 'existing-work' | 'diagnostic';
  route: 'agent-work-lab' | 'work-graph' | 'diagnostic';
  reasonCode: string;
  message: string;
  runtimeDir: string;
  workGraphPresent: boolean | null;
  evidence: string[];
  writeOccurred: false;
};

export type AgentWorkLabStartupSurface = 'work-graph' | 'agent-work-lab';

export function agentWorkLabStartupSurface(
  startup: AgentWorkLabStartupRoute,
): AgentWorkLabStartupSurface {
  return startup.state === 'existing-work' &&
    startup.route === 'work-graph' &&
    startup.workGraphPresent === true
    ? 'work-graph'
    : 'agent-work-lab';
}

export function agentWorkLabRunProgressLabel({
  elapsedMs,
  quietMs,
  eventCount,
  phase = 'running',
}: {
  elapsedMs: number;
  quietMs: number;
  eventCount: number;
  phase?: 'running' | 'assessing';
}): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const quietSeconds = Math.max(0, Math.floor(quietMs / 1000));
  if (phase === 'assessing') {
    return `Canonical run complete · emphasizing verdicts · ${eventCount} admitted events shown`;
  }
  if (eventCount === 0) {
    return `Still running · ${elapsedSeconds}s elapsed · waiting for first admitted event`;
  }
  return `Still running · ${elapsedSeconds}s elapsed · ${eventCount} admitted events shown · last update ${quietSeconds}s ago`;
}

export type AgentWorkLabCatalog = {
  schema: 'kungfu.agent-work-lab.catalog/v1';
  startup: AgentWorkLabStartupRoute;
  suite: {
    schema: 'kungfu.agent-work-lab.suite-catalog/v1';
    id: 'kungfu.agent-work-lab';
    version: string;
    title: string;
    collection: {
      id: 'work-continuity';
      title: string;
      description: string;
    };
    cases: Array<{
      id: 'offline-demo' | 'same-agent' | 'cross-agent';
      title: string;
      shortTitle: string;
      description: string;
      sourceRequirement: 'bundled' | 'configured';
      targetRequirement: 'fresh-demo' | 'same' | 'different';
      runLabel: string;
    }>;
    checks: Record<string, { title: string; meaning: string }>;
    recommendations: Record<
      'offline-demo' | 'same-agent' | 'cross-agent',
      {
        title: string;
        instruction: string;
        nextCase?: 'offline-demo' | 'same-agent' | 'cross-agent';
      }
    >;
    recoveryGuidance: Record<
      'agent-unavailable' | 'run-failed' | 'existing-work' | 'demo-retry',
      string
    >;
    timing: {
      autoplayIntroDurationMs: number;
      eventIntervalMs: number;
      verdictIntervalMs: number;
      recommendationDurationMs: number;
      quietProgressIntervalMs: number;
      reducedMotionIntervalMs: number;
    };
    capabilityDeclarations: ['agentRuntime', 'work'];
    claims: string[];
    nonClaims: string[];
    fixture: string;
    oracle: string;
    catalogRoot: string;
    catalogPath: string;
  };
  actions: Array<{
    id: string;
    mutation: string;
    resultSchema: string;
  }>;
  authority: {
    startup: string;
    actions: string;
    surfaces: ['cli', 'gui', 'tui'];
    uiPrivateWrites: false;
  };
};

export type AgentWorkLabEvent = {
  schema: 'kungfu.agent-work-lab.event/v1';
  step: string;
  status: string;
  root: string;
  publicActivity?: {
    schema: 'kungfu.agent-work-lab.public-activity/v1';
    source: 'provider-jsonl';
    kind: 'agent' | 'tool';
    phase: 'progress' | 'started' | 'completed';
    text: string;
    rawOutputRedacted: true;
  };
  publicOutput?: {
    schema: 'kungfu.agent-work-lab.public-output/v1';
    source: 'provider-stdout';
    admission: 'exact-agent-work-lab-marker';
    lines: string[];
    rawOutputRedacted: true;
  };
};

export type AgentWorkLabReport = {
  schema:
    | 'kungfu.agent-work-lab.report/v1'
    | 'kungfu.agent-work-lab.agent-report/v1';
  status: 'qualified' | 'qualified-with-residuals' | 'failed';
  suite: string;
  fixture: string;
  planRoot: string;
  reportRoot: string;
  identityRoot: string;
  workRef: Record<string, unknown>;
  sessionAttempts: Array<Record<string, unknown>>;
  assessment: Record<string, unknown>;
  events: AgentWorkLabEvent[];
  meaning: string;
  nonClaims: string[];
  receiptDependencies: string[];
  recoveryGuidance: Record<string, string>;
  evidenceDirectory: string;
  writeOccurred: boolean;
};

export type AgentWorkLabAgentPlan = {
  schema: 'kungfu.agent-work-lab.agent-plan/v1';
  suite: string;
  fixture: string;
  identity: Record<string, unknown>;
  identityRoot: string;
  planRoot: string;
  commandPreview: string[];
  verification: Record<string, unknown>;
  credentialContentsRead: false;
  writeOccurred: false;
};

export type ProjectTemplatePlan = {
  schema: 'kungfu.project-template.plan/v1';
  templateId: string;
  templateVersion: string;
  templateRoot: string;
  templateSource: string;
  destination: string;
  files: Array<{ path: string; contentRoot: string }>;
  initialWork: {
    state: 'capture-pending';
    initiativeId: string;
    assignmentId: string;
    title: string;
    acceptanceChecks: string[];
  };
  effects: string[];
  skippedEffects: string[];
  confirmationRequired: true;
  writeOccurred: false;
  planRoot: string;
};

export type ProjectTemplateCreationReceipt = {
  schema: 'kungfu.project-template.creation-receipt/v1';
  status: 'created' | 'resumed';
  templateId: string;
  templateRoot: string;
  planRoot: string;
  destination: string;
  actor: string;
  files: Array<{ path: string; contentRoot: string }>;
  verification: {
    ok: boolean;
    checks: Array<{
      path: string;
      expectedRoot: string;
      observedRoot: string | null;
      passed: boolean;
    }>;
  };
  initialWork: {
    state: 'captured-pending-admission';
    initiativeId: string;
    assignmentId: string;
    requestRoot: string;
    receiptRoot: string;
    requestPath: string;
  };
  activeWork?: ProjectWork;
  works?: ProjectWork[];
  openAction: {
    kind: 'select-project-workspace';
    label: string;
  };
  nonClaims: string[];
  writeOccurred: boolean;
  receiptRoot: string;
};

export type ProjectWork = {
  state: 'captured-pending-admission';
  initiativeId: string;
  assignmentId: string;
  title: string;
  objective: string;
  acceptanceChecks: string[];
  requestRoot: string;
  receiptRoot: string;
  requestPath: string;
  phase?: string;
  settled?: boolean;
  stateRoot?: string;
};

export type ProjectWorkReference = {
  destination: string;
  initialWork: {
    initiativeId: string;
    assignmentId: string;
    requestPath: string;
  };
};

export type ProjectTemplateWorkspaceSelection = {
  schema: 'kungfu.workspace.registry/v1';
  last_workspace_id: string;
  recent: Array<Record<string, unknown>>;
  updated_at: string;
  registry_path: string;
  selected: {
    schema: 'kungfu.workspace.identity/v1';
    workspace_id: string;
    identity_root: string;
    identity_state: 'qualified' | 'locator-candidate';
    workspace_kind: 'project';
    workspace_root: string;
    display_path: string;
    data_home: string;
    runtime_dir: string;
    initialized: boolean;
    state:
      | 'uninitialized'
      | 'shadow-only'
      | 'live-runtime'
      | 'evidence-degraded';
    resolution_reason: string;
    continuation: Record<string, unknown>;
    available: boolean;
    selected_at: string;
  };
};

export type WorkStartPlan = {
  schema: 'kungfu.work-start.plan/v1';
  workspace: {
    id: string;
    root: string;
    identityRoot: string;
    initialized: boolean;
  };
  work: {
    requestPath: string;
    requestRoot: string;
    initiativeId: string;
    assignmentId: string;
    title: string;
    objective: string;
    acceptanceChecks: string[];
  };
  agent: {
    id: string;
    label: string;
    provider: string;
    profileRoot: string;
    selection: string;
    verification: {
      ok: boolean;
      available: boolean;
      version: string | null;
      error: string | null;
    };
  };
  workControl: { profileId: string; profileRoot: string };
  admissionBinding: {
    ok: boolean;
    state: string;
    override: boolean;
    provenanceRoot: string;
    sourceRevision: string | null;
  };
  actor: string;
  effects: Array<{ stage: string; label: string }>;
  skippedEffects: string[];
  confirmationRequired: true;
  executable: boolean;
  writeOccurred: false;
  planRoot: string;
};

export type WorkStartEvent = {
  schema: 'kungfu.work-start.event/v1';
  index: number;
  stage: 'plan' | 'admit' | 'claim' | 'kickoff' | 'run';
  status: string;
  text: string;
  root: string | null;
  activity?: {
    schema: 'kungfu.agent-run.activity/v1';
    kind: 'agent' | 'tool';
    phase: 'started' | 'progress' | 'waiting' | 'completed' | 'failed';
    text: string;
    commandPreview?: string;
    rawToolArgumentsExposed: false;
  };
};

export type WorkStartReceipt = {
  schema: 'kungfu.work-start.receipt/v1';
  ok: boolean;
  status:
    | 'agent-finished'
    | 'agent-waiting'
    | 'agent-failed'
    | 'failed'
    | 'plan-drift'
    | 'confirmation-required'
    | 'not-executable';
  planRoot: string;
  receiptRoot: string;
  workPhase: string;
  failedAt?: string;
  message?: string;
  workspace?: ProjectTemplateWorkspaceSelection['selected'];
  workRef?: Record<string, unknown>;
  work?: WorkStartPlan['work'];
  agent?: WorkStartPlan['agent'];
  agentReport?: Record<string, unknown>;
  authorityReceipts?: Record<string, unknown>;
  nextActions: string[];
  nonClaims?: string[];
  writeOccurred: boolean;
};

export type StarterProjectResume = {
  project: {
    receipt: ProjectTemplateCreationReceipt;
    workspace: ProjectTemplateWorkspaceSelection;
    work?: ProjectWork;
    works: ProjectWork[];
  };
  workReceipt?: WorkStartReceipt;
  reviewReceipt?: WorkReviewReceipt;
  closeReceipt?: WorkCloseReceipt;
};

export type ProjectWorkResume = {
  workReceipt?: WorkStartReceipt;
  reviewReceipt?: WorkReviewReceipt;
  closeReceipt?: WorkCloseReceipt;
};

type WorkResumePreparation = {
  schema: 'kungfu.work.resume-prepare/v1';
  status: 'ready' | 'reconciled';
  profileId: string;
  previousProfileSuiteRoot: string | null;
  profileSuiteRoot: string;
  profileLifecycleReceiptCount: number;
  writeOccurred: boolean;
  workspace: ProjectTemplateWorkspaceSelection['selected'];
};

export type WorkReviewPlan = {
  schema: 'kungfu.work-review.plan/v1';
  workspace: { id: string; root: string; identityRoot: string };
  work: {
    initiativeId: string;
    assignmentId: string;
    phase: string;
    queryProofRoot: string;
    assignmentRoot: string;
    workDefinitionRoot: string;
    acceptanceChecks: string[];
  };
  deliverable: { path: string; root: string; content: string };
  inputs: Array<{ path: string; root: string }>;
  evidenceMode: 'project-files' | 'execution-report';
  execution: {
    reportPath: string;
    reportRoot: string;
    runId: string;
    episodeId: string;
    agent: Record<string, unknown>;
  };
  reviewer: {
    id: string;
    label: string;
    provider: string;
    profileRoot: string;
    selection: string;
    verification: WorkStartPlan['agent']['verification'];
    permissionMode: 'read-only' | 'unsupported';
    freshProcess: boolean;
    priorTranscriptBytes: 0;
  };
  reviewExecution: {
    mode: 'fresh-process' | 'retained-evidence';
    reportPath: string | null;
    reportRoot: string | null;
    runId: string | null;
    episodeId: string | null;
    reviewCut: string | null;
    assessmentRoot: string | null;
  };
  admissionBinding: WorkStartPlan['admissionBinding'];
  effects: Array<{ stage: string; label: string }>;
  skippedEffects: string[];
  confirmationRequired: true;
  executable: boolean;
  writeOccurred: false;
  planRoot: string;
};

export type WorkReviewEvent = {
  schema: 'kungfu.work-review.event/v1';
  index: number;
  stage: 'run' | 'reuse' | 'assess' | 'lease' | 'stage' | 'claim' | 'review';
  status: string;
  text: string;
  root: string | null;
  activity?: WorkStartEvent['activity'];
};

export type WorkReviewReceipt = {
  schema: 'kungfu.work-review.receipt/v1';
  ok: boolean;
  status:
    | 'review-passed'
    | 'review-needs-action'
    | 'revision-required'
    | 'reviewer-failed'
    | 'settlement-interrupted'
    | 'failed'
    | 'plan-drift'
    | 'confirmation-required'
    | 'not-executable';
  planRoot: string;
  receiptRoot: string;
  workPhase: string;
  message?: string;
  nativeVerdict?: string;
  assessment?: {
    verdict: 'fit' | 'revision-required';
    summary: string;
    criteria: Array<{
      criterion: string;
      passed: boolean;
      evidence: string;
    }>;
    evidenceRequests: string[];
  };
  reviewerReport?: Record<string, unknown>;
  authorityReceipts?: Record<string, unknown>;
  nextActions: string[];
  writeOccurred: boolean;
};

export type WorkClosePlan = {
  schema: 'kungfu.work-close.plan/v1';
  workspace: { id: string; root: string; identityRoot: string };
  work: {
    initiativeId: string;
    assignmentId: string;
    phase: string;
    queryProofRoot: string;
    assignmentRoot: string;
  };
  review: {
    id: string;
    root: string;
    verdict: string;
    continuationPlanRoot: string;
    allowedActions: string[];
  };
  decision: {
    mode: 'required' | 'retained';
    action: 'close';
    root: string | null;
  };
  effects: Array<{ stage: 'decide' | 'seal'; label: string }>;
  skippedEffects: string[];
  confirmationRequired: true;
  executable: boolean;
  writeOccurred: false;
  planRoot: string;
};

export type WorkCloseReceipt = {
  schema: 'kungfu.work-close.receipt/v1';
  ok: boolean;
  status:
    | 'completed'
    | 'settlement-interrupted'
    | 'plan-drift'
    | 'confirmation-required'
    | 'not-executable';
  planRoot: string;
  receiptRoot: string;
  workPhase: string;
  message?: string;
  decisionAction?: 'close';
  reviewRoot?: string;
  sealedState?: {
    schema: 'kungfu.assignment-orchestration.seal-receipt/v1';
    stateRoot: string;
    statePath: string;
    storageKind: string;
    portable: true;
    runtimeIndependentVerification: true;
    worktreeDeletionSafe: boolean;
  };
  authorityReceipts?: Record<string, unknown>;
  nextActions: string[];
  writeOccurred: boolean;
};

export function projectWorkspaceEnvironment(
  selection: ProjectTemplateWorkspaceSelection,
): Record<string, string> {
  const selected = selection.selected;
  return {
    KF_HOME: selected.data_home,
    KF_RUNTIME_DIR: selected.runtime_dir,
    KF_WORKSPACE_ID: selected.workspace_id,
    KF_WORKSPACE_KIND: selected.workspace_kind,
    KF_WORKSPACE_ROOT: selected.workspace_root,
    KF_WORKSPACE_DISPLAY_PATH: selected.display_path,
    KF_WORKSPACE_RESOLUTION_REASON: selected.resolution_reason,
    KF_WORKSPACE_STATE: selected.state,
    KF_WORKSPACE_DIAGNOSIS: '',
  };
}

export function applyProjectWorkspaceEnvironment(
  env: Record<string, string | undefined>,
  selection: ProjectTemplateWorkspaceSelection,
): void {
  Object.assign(env, projectWorkspaceEnvironment(selection));
}

export type AgentWorkLab = {
  inspect: () => Promise<AgentWorkLabStartupRoute>;
  inspectSync: () => AgentWorkLabStartupRoute;
  catalog: () => Promise<AgentWorkLabCatalog>;
  catalogSync: () => AgentWorkLabCatalog;
  discoverAgents: () => Promise<AgentRuntimeCatalog>;
  runDemo: (
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  planAgent: (profileId: string) => Promise<AgentWorkLabAgentPlan>;
  runAgent: (
    profileId: string,
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  runMigration: (
    sourceProfileId: string,
    targetProfileId: string,
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  planStarterProject: (destination?: string) => Promise<ProjectTemplatePlan>;
  createStarterProject: (
    plan: ProjectTemplatePlan,
    actor: string,
  ) => Promise<ProjectTemplateCreationReceipt>;
  openStarterProject: (
    receipt: ProjectTemplateCreationReceipt,
  ) => Promise<ProjectTemplateWorkspaceSelection>;
  planStarterWork: (
    receipt: ProjectWorkReference,
    profileId: string,
  ) => Promise<WorkStartPlan>;
  startStarterWork: (
    plan: WorkStartPlan,
    onEvent?: (event: WorkStartEvent) => void,
  ) => Promise<WorkStartReceipt>;
  planStarterReview: (
    workReceipt: WorkStartReceipt,
    reviewerProfileId: string,
  ) => Promise<WorkReviewPlan>;
  runStarterReview: (
    plan: WorkReviewPlan,
    onEvent?: (event: WorkReviewEvent) => void,
  ) => Promise<WorkReviewReceipt>;
  planStarterClose: (receipt: ProjectWorkReference) => Promise<WorkClosePlan>;
  closeStarterWork: (plan: WorkClosePlan) => Promise<WorkCloseReceipt>;
  resumeProjectWork: (
    receipt: ProjectWorkReference,
  ) => Promise<ProjectWorkResume>;
  resumeStarterProject: () => Promise<StarterProjectResume | null>;
};

type ExecOptions = {
  encoding: 'utf8';
  env: Record<string, string | undefined>;
  maxBuffer: number;
};

export type AgentWorkLabExecFile = (
  file: string,
  args: string[],
  options: ExecOptions,
) => Promise<string>;

export type AgentWorkLabExecFileSync = (
  file: string,
  args: string[],
  options: ExecOptions,
) => string;

export type AgentWorkLabExecFileEvents = (
  file: string,
  args: string[],
  options: ExecOptions,
  onLine: (line: string) => void,
) => Promise<void>;

export type OpenAgentWorkLabOptions = {
  runtimeDir: string;
  execFile: AgentWorkLabExecFile;
  execFileSync: AgentWorkLabExecFileSync;
  execFileEvents?: AgentWorkLabExecFileEvents;
  env?: Record<string, string | undefined>;
  bin?: string;
  allowForeignBinding?: boolean;
};

export function openAgentWorkLab(
  options: OpenAgentWorkLabOptions,
): AgentWorkLab {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const args = (command: string, extra: string[] = []) => [
    'agent-work-lab',
    command,
    ...extra,
    '--json',
  ];
  const parse = <T>(text: string): T => JSON.parse(text) as T;
  const runCli = async <T>(argv: string[]): Promise<T> =>
    parse<T>(
      await options.execFile(bin, argv, {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const run = async <T>(command: string, extra: string[] = []): Promise<T> =>
    runCli<T>(args(command, extra));
  const runSync = <T>(command: string): T =>
    parse<T>(
      options.execFileSync(bin, args(command), {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const selectStarterProject = async (
    receipt: ProjectTemplateCreationReceipt,
  ): Promise<ProjectTemplateWorkspaceSelection> => {
    if (receipt.openAction.kind !== 'select-project-workspace') {
      throw new Error(
        `Unsupported Starter Project open action: ${receipt.openAction.kind}`,
      );
    }
    const selection = await runCli<ProjectTemplateWorkspaceSelection>([
      'workspace',
      'select',
      receipt.destination,
      '--json',
    ]);
    if (
      selection.schema !== 'kungfu.workspace.registry/v1' ||
      selection.selected?.schema !== 'kungfu.workspace.identity/v1' ||
      selection.selected.workspace_kind !== 'project' ||
      selection.selected.workspace_root !== receipt.destination ||
      selection.selected.available !== true
    ) {
      throw new Error(
        'Kungfu did not select the exact available Starter Project workspace',
      );
    }
    applyProjectWorkspaceEnvironment(env, selection);
    return selection;
  };
  const resumeProjectWork = async (
    receipt: ProjectWorkReference,
  ): Promise<ProjectWorkResume> => {
    const work = receipt.initialWork;
    const resumed = await runCli<{
      schema: 'kungfu.work-start.resume/v1';
      status: 'retained-agent-run' | 'no-retained-agent-run';
      workReceipt: WorkStartReceipt | null;
      writeOccurred: false;
    }>([
      'work',
      'start-resume',
      '--workspace',
      receipt.destination,
      '--initiative-id',
      work.initiativeId,
      '--assignment-id',
      work.assignmentId,
    ]);
    const closeState = await runCli<{
      schema: 'kungfu.work-close.resume/v1';
      status: 'completed' | 'close-pending' | 'review-passed' | 'not-ready';
      reviewReceipt: WorkReviewReceipt | null;
      closeReceipt: WorkCloseReceipt | null;
      writeOccurred: false;
    }>([
      'work',
      'close-resume',
      '--workspace',
      receipt.destination,
      '--initiative-id',
      work.initiativeId,
      '--assignment-id',
      work.assignmentId,
    ]);
    return {
      ...(resumed.workReceipt ? { workReceipt: resumed.workReceipt } : {}),
      ...(closeState.reviewReceipt
        ? { reviewReceipt: closeState.reviewReceipt }
        : {}),
      ...(closeState.closeReceipt
        ? { closeReceipt: closeState.closeReceipt }
        : {}),
    };
  };
  const runWithEvents = async (
    command: string,
    extra: string[],
    onEvent?: (event: AgentWorkLabEvent) => void,
  ): Promise<AgentWorkLabReport> => {
    if (!onEvent) {
      return run<AgentWorkLabReport>(command, extra);
    }
    if (!options.execFileEvents) {
      const report = await run<AgentWorkLabReport>(command, extra);
      report.events.forEach(onEvent);
      return report;
    }
    let report: AgentWorkLabReport | null = null;
    await options.execFileEvents(
      bin,
      args(command, [...extra, '--events-json']),
      {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      },
      (line) => {
        const payload = parse<AgentWorkLabEvent | AgentWorkLabReport>(line);
        if (payload.schema === 'kungfu.agent-work-lab.event/v1') {
          onEvent(payload);
        } else {
          report = payload;
        }
      },
    );
    if (!report) {
      throw new Error(
        'Agent Work Lab event stream ended without a canonical report',
      );
    }
    return report;
  };
  return {
    inspect: () => run<AgentWorkLabStartupRoute>('inspect'),
    inspectSync: () => runSync<AgentWorkLabStartupRoute>('inspect'),
    catalog: () => run<AgentWorkLabCatalog>('catalog'),
    catalogSync: () => runSync<AgentWorkLabCatalog>('catalog'),
    discoverAgents: () => run<AgentRuntimeCatalog>('agents'),
    runDemo: (onEvent) => runWithEvents('demo', [], onEvent),
    planAgent: (profileId) =>
      run<AgentWorkLabAgentPlan>('agent-plan', [profileId]),
    runAgent: (profileId, onEvent) =>
      runWithEvents('agent-run', [profileId, '--execute'], onEvent),
    runMigration: (sourceProfileId, targetProfileId, onEvent) =>
      runWithEvents(
        'agent-run',
        [sourceProfileId, '--execute', '--target-profile', targetProfileId],
        onEvent,
      ),
    planStarterProject: (destination) =>
      run<ProjectTemplatePlan>(
        'starter-plan',
        destination ? ['--destination', destination] : [],
      ),
    createStarterProject: (plan, actor) =>
      run<ProjectTemplateCreationReceipt>('starter-create', [
        '--destination',
        plan.destination,
        '--expected-plan-root',
        plan.planRoot,
        '--actor',
        actor,
        '--execute',
      ]),
    openStarterProject: selectStarterProject,
    planStarterWork: (receipt, profileId) =>
      runCli<WorkStartPlan>([
        'work',
        'start-plan',
        receipt.initialWork.requestPath,
        '--workspace',
        receipt.destination,
        '--initiative-id',
        receipt.initialWork.initiativeId,
        '--assignment-id',
        receipt.initialWork.assignmentId,
        '--agent',
        profileId,
        '--actor',
        'local-user',
        ...(options.allowForeignBinding ? ['--allow-foreign-binding'] : []),
      ]),
    startStarterWork: async (plan, onEvent) => {
      const argv = [
        'work',
        'start',
        plan.work.requestPath,
        '--workspace',
        plan.workspace.root,
        '--initiative-id',
        plan.work.initiativeId,
        '--assignment-id',
        plan.work.assignmentId,
        '--agent',
        plan.agent.id,
        '--actor',
        plan.actor,
        '--expected-plan-root',
        plan.planRoot,
        '--execute',
        ...(options.allowForeignBinding ? ['--allow-foreign-binding'] : []),
      ];
      if (!onEvent || !options.execFileEvents) {
        return runCli<WorkStartReceipt>(argv);
      }
      let receipt: WorkStartReceipt | null = null;
      await options.execFileEvents(
        bin,
        [...argv, '--events-json'],
        {
          encoding: 'utf8',
          env,
          maxBuffer: 64 * 1024 * 1024,
        },
        (line) => {
          const payload = parse<WorkStartEvent | WorkStartReceipt>(line);
          if (payload.schema === 'kungfu.work-start.event/v1') {
            onEvent(payload);
          } else {
            receipt = payload;
          }
        },
      );
      if (!receipt) {
        throw new Error('Work start stream ended without a canonical receipt');
      }
      return receipt;
    },
    planStarterReview: (workReceipt, reviewerProfileId) => {
      const report = workReceipt.agentReport as
        | { episode?: { reportPath?: unknown } }
        | undefined;
      const reportPath = report?.episode?.reportPath;
      if (typeof reportPath !== 'string' || !reportPath) {
        throw new Error('Work start receipt has no retained Agent report path');
      }
      const workspaceRoot = workReceipt.workspace?.workspace_root;
      if (!workspaceRoot || !workReceipt.work) {
        throw new Error('Work start receipt has no exact workspace or WorkRef');
      }
      return runCli<WorkReviewPlan>([
        'work',
        'review-agent-plan',
        reportPath,
        '--workspace',
        workspaceRoot,
        '--initiative-id',
        workReceipt.work.initiativeId,
        '--assignment-id',
        workReceipt.work.assignmentId,
        '--reviewer',
        reviewerProfileId,
        ...(options.allowForeignBinding ? ['--allow-foreign-binding'] : []),
      ]);
    },
    runStarterReview: async (plan, onEvent) => {
      const argv = [
        'work',
        'review-agent-run',
        plan.execution.reportPath,
        '--workspace',
        plan.workspace.root,
        '--initiative-id',
        plan.work.initiativeId,
        '--assignment-id',
        plan.work.assignmentId,
        '--reviewer',
        plan.reviewer.id,
        '--expected-plan-root',
        plan.planRoot,
        '--execute',
        ...(options.allowForeignBinding ? ['--allow-foreign-binding'] : []),
      ];
      if (!onEvent || !options.execFileEvents) {
        return runCli<WorkReviewReceipt>(argv);
      }
      let receipt: WorkReviewReceipt | null = null;
      await options.execFileEvents(
        bin,
        [...argv, '--events-json'],
        {
          encoding: 'utf8',
          env,
          maxBuffer: 64 * 1024 * 1024,
        },
        (line) => {
          const payload = parse<WorkReviewEvent | WorkReviewReceipt>(line);
          if (payload.schema === 'kungfu.work-review.event/v1') {
            onEvent(payload);
          } else {
            receipt = payload;
          }
        },
      );
      if (!receipt) {
        throw new Error('Work review stream ended without a canonical receipt');
      }
      return receipt;
    },
    planStarterClose: (receipt) =>
      runCli<WorkClosePlan>([
        'work',
        'close-plan',
        '--workspace',
        receipt.destination,
        '--initiative-id',
        receipt.initialWork.initiativeId,
        '--assignment-id',
        receipt.initialWork.assignmentId,
      ]),
    closeStarterWork: (plan) =>
      runCli<WorkCloseReceipt>([
        'work',
        'close',
        '--workspace',
        plan.workspace.root,
        '--initiative-id',
        plan.work.initiativeId,
        '--assignment-id',
        plan.work.assignmentId,
        '--actor',
        'local-user',
        '--expected-plan-root',
        plan.planRoot,
        '--execute',
      ]),
    resumeProjectWork,
    resumeStarterProject: async () => {
      const registry = await runCli<{
        schema: 'kungfu.workspace.registry/v1';
        last_workspace_id: string | null;
        recent: ProjectTemplateWorkspaceSelection['selected'][];
      }>(['workspace', 'list', '--json']);
      const candidate = registry.recent.find(
        (row) =>
          row.workspace_id === registry.last_workspace_id &&
          row.workspace_kind === 'project' &&
          row.available,
      );
      if (!candidate) return null;
      let receipt: ProjectTemplateCreationReceipt;
      try {
        receipt = await run<ProjectTemplateCreationReceipt>('starter-resume', [
          '--workspace',
          candidate.workspace_root,
        ]);
      } catch {
        return null;
      }
      const workspace = await selectStarterProject(receipt);
      const preparation = await runCli<WorkResumePreparation>([
        'work',
        'resume-prepare',
        '--workspace',
        receipt.destination,
        '--actor',
        'kungfu-product-project-resume',
        '--execute',
      ]);
      if (
        preparation.schema !== 'kungfu.work.resume-prepare/v1' ||
        preparation.workspace.workspace_root !== receipt.destination ||
        preparation.profileId !== 'kungfu.work-control'
      ) {
        throw new Error(
          'Kungfu did not prepare the exact Work Control Profile for this Project',
        );
      }
      const activeWork = receipt.activeWork;
      const work = activeWork ?? receipt.initialWork;
      const workState = await resumeProjectWork({
        destination: receipt.destination,
        initialWork: {
          initiativeId: work.initiativeId,
          assignmentId: work.assignmentId,
          requestPath: work.requestPath,
        },
      });
      return {
        project: {
          receipt,
          workspace,
          ...(activeWork ? { work: activeWork } : {}),
          works:
            receipt.works && receipt.works.length > 0
              ? receipt.works
              : [
                  {
                    ...receipt.initialWork,
                    title: 'Create an evidence-backed launch brief',
                    objective:
                      'Turn the supplied product notes, customer feedback, and release facts into the launch brief without inventing unsupported claims.',
                    acceptanceChecks: [
                      'Names the product and target user',
                      'Includes three evidence-backed benefits',
                      'Separates confirmed facts from open questions',
                      'Proposes one next action',
                      'Does not invent quotes, dates, or metrics',
                    ],
                  },
                ],
        },
        ...workState,
      };
    },
  };
}
