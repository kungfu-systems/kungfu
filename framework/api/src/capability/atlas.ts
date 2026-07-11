// Mission Control capability handle over the `kungfu atlas` pre-release CLI.
// Atlas remains authority for imported facts; native Mission/Go/claim writes
// and portable bundle operations enter the same local Fact Library.

export type AtlasMission = {
  mission_id: string;
  title?: string;
  intent?: string;
  status?: string;
  horizon?: string;
  owner?: string;
  subject_key?: string;
  source_authority?: string;
  authority_mode?: string;
  active_lens?: string;
  stage_name?: string;
  next_review?: string;
  next_action?: string;
};

export type AtlasGoal = {
  goal_id: string;
  status?: string;
  title?: string;
  owner_agent?: string;
  mission_id?: string;
  lens?: string;
  mission_stage?: string;
  source_branch?: string;
  worktree_path?: string;
  external_repo_path?: string;
  external_branch?: string;
  external_head?: string;
  external_ready_ref?: string;
  latest_marker?: string;
  summary?: string;
  next_action?: string;
  archived?: boolean;
};

export type AtlasMarker = {
  branch: string;
  status?: string;
  ready?: boolean;
  ready_scope?: string;
  keep_source_worktree?: boolean;
  worktree_path?: string;
  summary?: string;
  risk?: string;
  marker_path?: string;
};

export type AtlasImportResult = {
  import_id: string;
  repo_root: string;
  missions: number;
  goals: number;
  markers: number;
  mission_control?: {
    status: string;
    authority_mode: string;
    admitted?: number;
    already_present?: number;
    import_episode_id?: number;
    import_episode_root?: string;
  };
  warnings: string[];
};

export type AtlasImportInfo = {
  import_id: string;
  repo_root: string;
  repo_head?: string;
  missions: number;
  goals: number;
  markers: number;
};

export type AtlasMissionDetail = {
  mission: AtlasMission;
  goals: AtlasGoal[];
};

export type AtlasMissionControlReport = {
  schema: 'kungfu.mission-control.trust-report/v1';
  fitness: string;
  findings: string[];
  known_limits: string[];
  assessment_key: string;
  report_hash?: string;
  query_definition_root: string;
  query_proof_root: string;
  assessment: {
    state: string;
    reused?: boolean;
    report?: { purpose?: string; residual_risks?: string[] };
  };
  profile: {
    schema: 'kungfu.profile.delegated-work-cost-state-proof/v1';
    profile_hash: string;
    profile: { id: string; version: string };
    mission_subject: string;
    go_subject?: string | null;
    cost: {
      status: 'missing' | 'ambiguous' | 'partial' | 'attributed';
      observation_count: number;
      linked_run_count: number;
      tokens: {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens: number;
        cache_creation_input_tokens: number;
        reasoning_tokens: number;
      };
      cost_usd?: number | null;
      cost_usd_known: boolean;
      attribution: {
        best: string;
        worst: string;
        ambiguous: boolean;
      };
      proof_episodes: Array<{
        run_id: string;
        episode_id: string;
        episode_root: string;
      }>;
      missing: {
        unsealed_runs: string[];
        unreadable_runs: Array<{ run_id: string; error: string }>;
        no_linked_cost_fact: boolean;
      };
    };
    state: {
      value: string;
      source_statuses: string[];
      mapping_policy: string;
      go_subjects: string[];
    };
    proof: {
      canonical_state: boolean;
      query_definition_root: string;
      query_proof_root: string;
      query_result_hash: string;
      cost_episode_roots: Array<{
        run_id: string;
        episode_id: string;
        episode_root: string;
      }>;
      assessment_state: string;
      assessment_report_hash?: string | null;
      conflicts: unknown[];
      unverifiable_inputs: unknown[];
    };
  };
  state: {
    mission_subject: string;
    canonical_state: boolean;
    cut: { declared?: unknown; resolved?: unknown };
    mission?: { payload?: { record?: AtlasMission } } | null;
    goals: Array<{ payload?: { record?: AtlasGoal } }>;
    claims?: Array<{
      payload?: {
        record?: {
          claim_id?: string;
          claim_type?: string;
          statement?: string;
          evidence_episodes?: Array<{
            episode_id: string;
            episode_root: string;
          }>;
        };
      };
    }>;
  };
};

export type AtlasGoWrite = {
  schema: 'kungfu.mission-control.go-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  go_subject: string;
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type AtlasMissionWrite = {
  schema: 'kungfu.mission-control.mission-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type AtlasMissionBundleExport = {
  schema: 'kungfu.mission-control.bundle-export/v1';
  status: 'portable' | 'degraded';
  mode: 'full' | 'thin';
  mission_subject: string;
  bundle_id: string;
  bundle_root: string;
  episode_count: number;
  out: string;
};

export type AtlasMissionBundleImport = {
  schema: 'kungfu.mission-control.bundle-import/v1';
  status: 'validated' | 'imported' | 'degraded';
  accepted: boolean;
  materialized: boolean;
  mode: 'full' | 'thin';
  mission_subject: string;
  bundle_id: string;
  bundle_root: string;
  episode_count: number;
  missing_material_count: number;
  diagnosis: string;
  state_verification?: {
    ok: boolean;
    query_definition_root_match: boolean;
    query_proof_root_match: boolean;
    result_hash_match: boolean;
    canonical_state: boolean;
  } | null;
};

export type AtlasCompletionClaimWrite = {
  schema: 'kungfu.mission-control.completion-claim-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  go_subject: string;
  claim: {
    claim_id: string;
    claim_type: 'task-completed';
    statement: string;
    evidence_episodes: Array<{ episode_id: string; episode_root: string }>;
  };
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type AtlasGoalFilter = {
  status?: string;
  missionId?: string;
};

export type Atlas = {
  runtimeDir: string;
  defaultRepoRoot: string;
  importRepo: (repoRoot: string) => AtlasImportResult;
  importInfo: () => AtlasImportInfo | null;
  missions: () => AtlasMission[];
  mission: (missionId: string) => AtlasMissionDetail | null;
  assessMission: (
    missionId: string,
    options?: { source?: string; purpose?: string },
  ) => AtlasMissionControlReport;
  createMission: (
    missionId: string,
    input: {
      title: string;
      intent: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'paused';
      horizon?: string;
    },
  ) => AtlasMissionWrite;
  exportMission: (
    missionId: string,
    outPath: string,
    options?: { mode?: 'full' | 'thin'; source?: string; purpose?: string },
  ) => AtlasMissionBundleExport;
  importMission: (
    fromPath: string,
    options?: { execute?: boolean },
  ) => AtlasMissionBundleImport;
  createGo: (
    missionId: string,
    input: {
      goalId: string;
      title: string;
      objective: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'blocked' | 'waiting-for-decision';
    },
  ) => AtlasGoWrite;
  claimCompletion: (
    missionId: string,
    goalId: string,
    input: {
      statement: string;
      actor: string;
      actorType?: 'user' | 'agent';
      evidenceEpisodeIds?: string[];
    },
  ) => AtlasCompletionClaimWrite;
  assessCompletion: (
    missionId: string,
    goalId: string,
    options?: { source?: string; purpose?: string },
  ) => AtlasMissionControlReport;
  goals: (filter?: AtlasGoalFilter) => AtlasGoal[];
  goal: (goalId: string) => AtlasGoal | null;
  markers: () => AtlasMarker[];
};

export type AtlasExecFileSync = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; env: Record<string, string | undefined> },
) => string;

export type OpenAtlasOptions = {
  runtimeDir: string;
  execFileSync: AtlasExecFileSync;
  env?: Record<string, string | undefined>;
  bin?: string;
};

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function cliEnv(
  base: Record<string, string | undefined>,
  runtimeDir: string,
): Record<string, string | undefined> {
  return {
    ...base,
    KF_RUNTIME_DIR: runtimeDir,
  };
}

function isNoCompletedImport(error: unknown): boolean {
  const stderr = String(
    (error as { stderr?: unknown; message?: unknown }).stderr ??
      (error as { message?: unknown }).message ??
      '',
  );
  return stderr.includes('no completed import');
}

export function openAtlas(options: OpenAtlasOptions): Atlas {
  const env = options.env ?? {};
  const runtimeDir = options.runtimeDir;
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const defaultRepoRoot = env.KUNGFU_ATLAS_REPO || env.ATLAS_REPO || '';

  const runJson = <T>(args: string[]): T => {
    const out = options.execFileSync(bin, args, {
      encoding: 'utf8',
      env: cliEnv(env, runtimeDir),
    });
    return parseJson<T>(out);
  };

  return {
    runtimeDir,
    defaultRepoRoot,
    importRepo: (repoRoot) =>
      runJson<AtlasImportResult>([
        'atlas',
        'import',
        '--repo',
        repoRoot,
        '--json',
      ]),
    importInfo: () => {
      try {
        return runJson<AtlasImportInfo>(['atlas', 'show', 'import', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return null;
        throw e;
      }
    },
    missions: () => {
      try {
        return runJson<AtlasMission[]>(['atlas', 'show', 'missions', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
    mission: (missionId) => {
      try {
        return runJson<AtlasMissionDetail>([
          'atlas',
          'show',
          'mission',
          missionId,
          '--json',
        ]);
      } catch {
        return null;
      }
    },
    assessMission: (missionId, assessment = {}) => {
      const args = ['atlas', 'assess-mission', missionId, '--json'];
      if (assessment.source) args.push('--source', assessment.source);
      if (assessment.purpose) args.push('--purpose', assessment.purpose);
      return runJson<AtlasMissionControlReport>(args);
    },
    createMission: (missionId, input) => {
      const args = [
        'atlas',
        'create-mission',
        missionId,
        '--title',
        input.title,
        '--intent',
        input.intent,
        '--actor',
        input.actor,
        '--actor-type',
        input.actorType ?? 'agent',
        '--status',
        input.status ?? 'active',
        '--horizon',
        input.horizon ?? 'long-term',
        '--json',
      ];
      return runJson<AtlasMissionWrite>(args);
    },
    exportMission: (missionId, outPath, transfer = {}) => {
      const args = [
        'atlas',
        'export-mission',
        missionId,
        '--out',
        outPath,
        '--mode',
        transfer.mode ?? 'full',
        '--json',
      ];
      if (transfer.source) args.push('--source', transfer.source);
      if (transfer.purpose) args.push('--purpose', transfer.purpose);
      return runJson<AtlasMissionBundleExport>(args);
    },
    importMission: (fromPath, transfer = {}) => {
      const args = ['atlas', 'import-mission', '--from', fromPath];
      if (transfer.execute) args.push('--execute');
      args.push('--json');
      return runJson<AtlasMissionBundleImport>(args);
    },
    createGo: (missionId, input) => {
      const args = [
        'atlas',
        'create-go',
        missionId,
        input.goalId,
        '--title',
        input.title,
        '--objective',
        input.objective,
        '--actor',
        input.actor,
        '--actor-type',
        input.actorType ?? 'agent',
        '--status',
        input.status ?? 'active',
        '--json',
      ];
      return runJson<AtlasGoWrite>(args);
    },
    claimCompletion: (missionId, goalId, input) => {
      const args = [
        'atlas',
        'claim-completion',
        missionId,
        goalId,
        '--statement',
        input.statement,
        '--actor',
        input.actor,
        '--actor-type',
        input.actorType ?? 'agent',
      ];
      for (const episodeId of input.evidenceEpisodeIds ?? []) {
        args.push('--evidence-episode', episodeId);
      }
      args.push('--json');
      return runJson<AtlasCompletionClaimWrite>(args);
    },
    assessCompletion: (missionId, goalId, assessment = {}) => {
      const args = ['atlas', 'assess-completion', missionId, goalId, '--json'];
      if (assessment.source) args.push('--source', assessment.source);
      if (assessment.purpose) args.push('--purpose', assessment.purpose);
      return runJson<AtlasMissionControlReport>(args);
    },
    goals: (filter = {}) => {
      const args = ['atlas', 'show', 'goals', '--json'];
      if (filter.status) args.push('--status', filter.status);
      if (filter.missionId) args.push('--mission', filter.missionId);
      try {
        return runJson<AtlasGoal[]>(args);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
    goal: (goalId) => {
      try {
        return runJson<AtlasGoal>(['atlas', 'show', 'goal', goalId, '--json']);
      } catch {
        return null;
      }
    },
    markers: () => {
      try {
        return runJson<AtlasMarker[]>(['atlas', 'show', 'markers', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
  };
}
