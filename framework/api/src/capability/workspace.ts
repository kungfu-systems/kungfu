// Workspace guidance capability over the `kungfu workspace` CLI.  GUI views
// and delegated agents share the same inspect -> advice -> preview -> explicit
// authorization -> action -> receipt -> verify contract.

export type WorkspaceGuidanceIntent =
  | 'create-project-workspace'
  | 'keep-home'
  | 'suppress-source';

export type WorkspaceIdentity = {
  workspace_id: string;
  workspace_kind: 'home' | 'project';
  workspace_root?: string | null;
  data_home: string;
  runtime_dir: string;
  state: string;
};

export type WorkspaceGuidanceInspection = {
  schema: 'kungfu.workspace.guidance-inspection/v1';
  workspace: WorkspaceIdentity;
  cut_id: string;
  source_root: string;
  project_candidate_root: string;
  git_repository: { present: boolean; root: string | null };
  unassigned_capture_count: number;
  evidence: Array<{ receipt_id?: string }>;
  suppression: Record<string, unknown> | null;
};

export type WorkspaceAdvice = {
  schema: 'kungfu.workspace.advice/v1';
  advice_id: string;
  state: 'recommended' | 'insufficient' | 'suppressed';
  selected_cut: string;
  source_root: string;
  project_candidate_root: string;
  reason_codes: string[];
  evidence_references: string[];
  recommended_intent: WorkspaceGuidanceIntent | null;
  options: WorkspaceGuidanceIntent[];
  proposed_effects: string[];
  skipped_effects: string[];
  risk: string;
  authorization_class: string;
};

export type WorkspaceActionPreview = {
  schema: 'kungfu.workspace.preview/v1';
  preview_id: string;
  advice_id: string;
  selected_cut: string;
  intent: WorkspaceGuidanceIntent;
  source_root: string;
  project_candidate_root: string;
  effects: Array<Record<string, unknown>>;
  skipped_effects: string[];
  authorization_class: string;
};

export type WorkspaceAuthorization = {
  schema: 'kungfu.workspace.authorization/v1';
  authorization_id: string;
  preview_id: string;
  intent: WorkspaceGuidanceIntent;
  decision: 'approve' | 'deny';
  authorized_by: string;
  recorded_at: string;
};

export type WorkspaceActionReceipt = {
  schema: 'kungfu.workspace.action-receipt/v1';
  receipt_id: string;
  authorization_id: string;
  preview_id: string;
  intent: WorkspaceGuidanceIntent;
  applied_effects: Array<Record<string, unknown>>;
  skipped_effects: string[];
  resulting_identities: WorkspaceIdentity[];
  reused: boolean;
};

export type WorkspaceActionVerification = {
  schema: 'kungfu.workspace.action-verification/v1';
  ok: boolean;
  receipt_id: string;
  authorization_id: string;
  intent: WorkspaceGuidanceIntent;
  errors: string[];
  verified_effects: Array<Record<string, unknown>>;
};

export type WorkspaceGuidance = {
  runtimeDir: string;
  workspaceKind: 'home' | 'project';
  workspaceRoot: string;
  inspect: (sourcePath: string) => WorkspaceGuidanceInspection;
  advise: (sourcePath: string) => WorkspaceAdvice;
  preview: (
    sourcePath: string,
    intent: WorkspaceGuidanceIntent,
  ) => WorkspaceActionPreview;
  authorize: (
    sourcePath: string,
    intent: WorkspaceGuidanceIntent,
    previewId: string,
    decision: 'approve' | 'deny',
    authorizedBy: string,
  ) => WorkspaceAuthorization;
  apply: (
    sourcePath: string,
    authorizationId: string,
  ) => WorkspaceActionReceipt;
  verify: (receiptId: string) => WorkspaceActionVerification;
};

export type WorkspaceExecFileSync = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; env: Record<string, string | undefined> },
) => string;

export type OpenWorkspaceGuidanceOptions = {
  runtimeDir: string;
  execFileSync: WorkspaceExecFileSync;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openWorkspaceGuidance(
  options: OpenWorkspaceGuidanceOptions,
): WorkspaceGuidance {
  const env = options.env ?? {};
  const runtimeDir = options.runtimeDir;
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const workspaceKind =
    env.KF_WORKSPACE_KIND === 'project' ? 'project' : 'home';
  const workspaceRoot = env.KF_WORKSPACE_ROOT || '';

  const runJson = <T>(args: string[]): T => {
    const out = options.execFileSync(bin, args, {
      encoding: 'utf8',
      env: { ...env, KF_RUNTIME_DIR: runtimeDir },
    });
    return JSON.parse(out) as T;
  };
  const guidanceArgs = (command: string, source?: string): string[] => {
    const args = ['workspace', command];
    if (workspaceKind === 'home') args.push('--home');
    else if (workspaceRoot) args.push(workspaceRoot);
    else throw new Error('project workspace root is unavailable');
    if (source) args.push('--source', source);
    return args;
  };

  return {
    runtimeDir,
    workspaceKind,
    workspaceRoot,
    inspect: (sourcePath) =>
      runJson<WorkspaceGuidanceInspection>([
        ...guidanceArgs('inspect-guidance', sourcePath),
        '--json',
      ]),
    advise: (sourcePath) =>
      runJson<WorkspaceAdvice>([
        ...guidanceArgs('advise', sourcePath),
        '--json',
      ]),
    preview: (sourcePath, intent) =>
      runJson<WorkspaceActionPreview>([
        ...guidanceArgs('preview', sourcePath),
        '--intent',
        intent,
        '--json',
      ]),
    authorize: (sourcePath, intent, previewId, decision, authorizedBy) =>
      runJson<WorkspaceAuthorization>([
        ...guidanceArgs('authorize', sourcePath),
        '--intent',
        intent,
        '--preview-id',
        previewId,
        '--decision',
        decision,
        '--authorized-by',
        authorizedBy,
        '--json',
      ]),
    apply: (sourcePath, authorizationId) =>
      runJson<WorkspaceActionReceipt>([
        ...guidanceArgs('apply', sourcePath),
        '--authorization-id',
        authorizationId,
        '--json',
      ]),
    verify: (receiptId) =>
      runJson<WorkspaceActionVerification>([
        ...guidanceArgs('verify'),
        '--receipt-id',
        receiptId,
        '--json',
      ]),
  };
}
